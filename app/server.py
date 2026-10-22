"""本地 HTTP 服务：REST API + 静态页面。

没有第三方依赖，用标准库起一个多线程服务器，只监听 127.0.0.1。
"""

from __future__ import annotations

import datetime as dt
import json
import mimetypes
import re
import socket
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR.parent))

from core import config, corpus, jobs, llm, sources, store  # noqa: E402

STATIC_DIR = APP_DIR / "static"
MAX_BODY = 120 * 1024 * 1024  # 120MB，够放下任何论文 PDF


class Handler(BaseHTTPRequestHandler):
    server_version = "NeuroStudy/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------ #
    # 基础工具
    # ------------------------------------------------------------------ #
    def log_message(self, fmt: str, *args) -> None:  # 静音默认日志
        if "error" in str(args).lower():
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, status: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json({"ok": False, "error": message}, status)

    # ---- 流式（SSE over chunked）-------------------------------------- #
    def _stream_start(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _chunk(self, data: bytes) -> None:
        self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def _sse(self, obj: dict) -> None:
        payload = f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")
        self._chunk(payload)

    def _stream_end(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(min(length, MAX_BODY))
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _raw_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > MAX_BODY:
            raise ValueError("文件过大")
        return self.rfile.read(length)

    # ------------------------------------------------------------------ #
    # 路由
    # ------------------------------------------------------------------ #
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                return self._api_get(path, parse_qs(parsed.query))
            return self._static(path)
        except BrokenPipeError:
            return
        except Exception as exc:
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            return self._api_post(path)
        except BrokenPipeError:
            return
        except Exception as exc:
            self._error(500, f"{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------ #
    # 静态资源
    # ------------------------------------------------------------------ #
    def _static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            return self._error(404, "not found")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype, cache="no-cache")

    # ------------------------------------------------------------------ #
    # GET /api/*
    # ------------------------------------------------------------------ #
    def _api_get(self, path: str, query: dict) -> None:
        if path == "/api/state":
            cfg = config.load()
            today = corpus.today()
            return self._json(
                {
                    "ok": True,
                    "today": {
                        "day": today["day"],
                        "total": today["total"],
                        "date": today["date"],
                        "paper": today["paper"],
                        "status": corpus.status_of(today["paper"]),
                    },
                    "config": config.public_view(cfg),
                    "stats": corpus.stats(),
                    "job": jobs.get_job(today["paper"]["pmid"]),
                }
            )

        if path == "/api/modules":
            return self._json({"ok": True, "modules": corpus.modules()})

        if path == "/api/plan":
            return self._json({"ok": True, "plan": corpus.plan_view()})

        m = re.fullmatch(r"/api/paper/([^/]+)", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            return self._json(
                {
                    "ok": True,
                    "paper": paper,
                    "status": corpus.status_of(paper),
                    "job": jobs.get_job(paper["pmid"]),
                }
            )

        m = re.fullmatch(r"/api/paper/([^/]+)/fulltext", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            data = store.read_json(paper["pmid"], "fulltext.json")
            if not data:
                data = sources.fetch_fulltext(paper)
            return self._json({"ok": True, **data})

        m = re.fullmatch(r"/api/paper/([^/]+)/translation", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            pmid = paper["pmid"]
            pages = store.read_json(pmid, "translation_pages.json")
            text = store.read_json(pmid, "translation_text.json")
            if pages:
                return self._json({"ok": True, "mode": "pdf", **pages})
            if text:
                return self._json({"ok": True, "mode": "text", **text})
            return self._json({"ok": True, "mode": "none"})

        m = re.fullmatch(r"/api/paper/([^/]+)/interpretation", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            data = store.read_json(paper["pmid"], "interpretation.json")
            return self._json({"ok": True, "interpretation": data})

        m = re.fullmatch(r"/api/paper/([^/]+)/chat", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            history = store.read_json(paper["pmid"], "chat.json") or []
            return self._json({"ok": True, "history": history})

        m = re.fullmatch(r"/api/paper/([^/]+)/job", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            return self._json({"ok": True, "job": jobs.get_job(paper["pmid"])})

        m = re.fullmatch(r"/api/paper/([^/]+)/page/(\d+)\.png", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            mode = (query.get("mode") or ["translated"])[0]
            mode = "original" if mode == "original" else "translated"
            img = store.page_image(paper["pmid"], int(m.group(2)), mode)
            if not img:
                return self._error(404, "这一页还没有生成")
            return self._send(200, img.read_bytes(), "image/png", cache="max-age=86400")

        m = re.fullmatch(r"/api/pdf/([^/]+)/(original|translated)\.pdf", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            name = "translated.pdf" if m.group(2) == "translated" else "paper.pdf"
            f = store.path(paper["pmid"], name)
            if not f.exists():
                return self._error(404, "文件不存在")
            return self._send(200, f.read_bytes(), "application/pdf", cache="no-cache")

        if path == "/api/config":
            return self._json({"ok": True, "config": config.public_view()})

        return self._error(404, "unknown endpoint")

    # ------------------------------------------------------------------ #
    # POST /api/*
    # ------------------------------------------------------------------ #
    def _api_post(self, path: str) -> None:
        if path == "/api/config":
            body = self._body()
            cfg = config.load()
            llm_cfg = cfg["llm"]
            if "api_key" in body and body["api_key"]:
                llm_cfg["api_key"] = str(body["api_key"]).strip()
            if body.get("clear_key"):
                llm_cfg["api_key"] = ""
            for key in ("base_url", "model"):
                if body.get(key):
                    llm_cfg[key] = str(body[key]).strip()
            if "mock" in body:
                llm_cfg["mock"] = bool(body["mock"])
            if body.get("start_date"):
                cfg["schedule"]["start_date"] = str(body["start_date"])
            if body.get("push_time"):
                cfg["schedule"]["push_time"] = str(body["push_time"])
            config.save(cfg)
            return self._json({"ok": True, "config": config.public_view(cfg)})

        m = re.fullmatch(r"/api/paper/([^/]+)/prepare", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            body = self._body()
            job = jobs.start(
                paper,
                do_translate=body.get("translate", True),
                do_interpret=body.get("interpret", True),
            )
            return self._json({"ok": True, "job": job})

        m = re.fullmatch(r"/api/paper/([^/]+)/pdf", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            data = self._raw_body()
            try:
                store.save_pdf(paper["pmid"], data)
            except ValueError as exc:
                return self._error(400, str(exc))
            return self._json({"ok": True, "status": corpus.status_of(paper)})

        m = re.fullmatch(r"/api/paper/([^/]+)/autopdf", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            ok, msg = sources.try_fetch_oa_pdf(paper)
            return self._json({"ok": ok, "message": msg, "status": corpus.status_of(paper)})

        m = re.fullmatch(r"/api/paper/([^/]+)/chat", path)
        if m:
            return self._chat_stream(corpus.get(m.group(1)))

        m = re.fullmatch(r"/api/paper/([^/]+)/chat/clear", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            store.write_json(paper["pmid"], "chat.json", [])
            return self._json({"ok": True})

        m = re.fullmatch(r"/api/paper/([^/]+)/read", path)
        if m:
            paper = corpus.get(m.group(1))
            if not paper:
                return self._error(404, "没有这一篇")
            body = self._body()
            corpus.mark_read(paper["id"], bool(body.get("read", True)))
            return self._json({"ok": True, "stats": corpus.stats()})

        return self._error(404, "unknown endpoint")


    # ------------------------------------------------------------------ #
    # 对话（流式）
    # ------------------------------------------------------------------ #
    def _chat_stream(self, paper: dict | None) -> None:
        if not paper:
            return self._error(404, "没有这一篇")
        body = self._body()
        question = (body.get("message") or "").strip()
        if not question:
            return self._error(400, "问题不能为空")
        if len(question) > 4000:
            question = question[:4000]

        cfg = config.load()
        pmid = paper["pmid"]

        fulltext = store.read_json(pmid, "fulltext.json")
        if not fulltext:
            try:
                fulltext = sources.fetch_fulltext(paper)
            except Exception as exc:  # 抓不到全文也要能对话（退化为摘要）
                fulltext = {
                    "items": [{"kind": "para", "text": paper.get("abstract", "")}],
                    "source": "abstract",
                    "note": str(exc),
                }
        interpretation = store.read_json(pmid, "interpretation.json")
        context = llm.build_chat_context(paper, fulltext.get("items", []), interpretation)
        history = store.read_json(pmid, "chat.json") or []
        messages = llm.chat_messages(context, history, question)

        self._stream_start()
        answer_parts: list[str] = []
        try:
            for delta in llm.chat_stream(messages, cfg, question):
                answer_parts.append(delta)
                self._sse({"delta": delta})
        except (BrokenPipeError, ConnectionResetError):
            return  # 用户中途关页面，不记录半截回答
        except llm.LLMError as exc:
            self._sse({"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._sse({"error": f"{type(exc).__name__}: {exc}"})

        try:
            self._sse({"done": True})
            self._stream_end()
        except (BrokenPipeError, ConnectionResetError):
            return

        answer = "".join(answer_parts).strip()
        if answer:
            stamp = dt.datetime.now().isoformat(timespec="seconds")
            history.append({"role": "user", "content": question, "ts": stamp})
            history.append({"role": "assistant", "content": answer, "ts": stamp})
            store.write_json(pmid, "chat.json", history[-200:])


def _pick_port(host: str, preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


def _already_running(url: str) -> bool:
    """一键启动时先探一下：服务已经在跑就只把浏览器叫出来，不再起第二个。"""
    try:
        import urllib.request

        with urllib.request.urlopen(url + "api/state", timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def main() -> None:
    cfg = config.load()
    host = cfg["server"]["host"]
    want_open = "--open" in sys.argv

    if want_open:
        configured = f"http://{host}:{int(cfg['server']['port'])}/"
        if _already_running(configured):
            webbrowser.open(configured)
            print(f"服务已在运行：{configured}")
            return

    port = _pick_port(host, int(cfg["server"]["port"]))
    url = f"http://{host}:{port}/"

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True

    print("=" * 56)
    print("  神经生物学学习 · 本地服务已启动")
    print(f"  {url}")
    print("  关闭此窗口即停止服务")
    print("=" * 56)

    if want_open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
