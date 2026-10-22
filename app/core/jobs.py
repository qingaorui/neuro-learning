"""后台任务：把「抓全文 → 翻译 → 生成对照页 → 写解读」串成一条流水线。

前端轮询状态即可，不搞 WebSocket——本地单人工具，没必要。
"""

from __future__ import annotations

import datetime as dt
import threading
import traceback
from typing import Callable

from . import config, corpus, llm, pdfdoc, sources, store

_JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def get_job(pmid: str) -> dict:
    with _lock:
        job = _JOBS.get(pmid)
    if job:
        return dict(job)
    return {"status": "idle", "stage": "", "progress": 0.0, "message": ""}


def _set(pmid: str, **patch) -> None:
    with _lock:
        job = _JOBS.setdefault(pmid, {})
        job.update(patch)


def _progress(pmid: str, stage: str, frac: float, message: str) -> None:
    _set(pmid, status="running", stage=stage, progress=round(frac, 3), message=message)


def start(paper: dict, do_translate: bool = True, do_interpret: bool = True) -> dict:
    pmid = paper["pmid"]
    with _lock:
        current = _JOBS.get(pmid)
        if current and current.get("status") == "running":
            return dict(current)

    _JOBS[pmid] = {
        "status": "running",
        "stage": "准备",
        "progress": 0.0,
        "message": "任务已排队",
        "started": dt.datetime.now().isoformat(timespec="seconds"),
    }
    thread = threading.Thread(
        target=_run, args=(paper, do_translate, do_interpret), daemon=True
    )
    thread.start()
    return get_job(pmid)


# --------------------------------------------------------------------------- #
# 流水线
# --------------------------------------------------------------------------- #
def _run(paper: dict, do_translate: bool, do_interpret: bool) -> None:
    pmid = paper["pmid"]
    cfg = config.load()
    try:
        _progress(pmid, "获取全文", 0.05, "正在拉取 PMC 全文…")
        fulltext = sources.fetch_fulltext(paper)
        items = fulltext.get("items", [])
        _set(pmid, fulltext_source=fulltext.get("source", ""), fulltext_note=fulltext.get("note", ""))

        use_pdf = store.has_pdf(pmid)
        if use_pdf:
            _prepare_pdf(pmid, paper, cfg, do_translate)
        else:
            _prepare_text(pmid, paper, cfg, items, do_translate)

        if do_interpret:
            _progress(pmid, "生成解读", 0.85, "正在生成详细解读…")
            data = llm.interpret(paper, items, cfg)
            store.write_json(pmid, "interpretation.json", data)

        _set(
            pmid,
            status="done",
            stage="完成",
            progress=1.0,
            message="译文与解读已就绪",
            finished=dt.datetime.now().isoformat(timespec="seconds"),
        )
    except Exception as exc:  # 任何异常都要让前端看到，而不是静默失败
        _set(
            pmid,
            status="error",
            stage="失败",
            message=f"{type(exc).__name__}: {exc}",
            trace=traceback.format_exc()[-1500:],
        )


def _prepare_text(pmid: str, paper: dict, cfg: dict, items: list[dict], do_translate: bool) -> None:
    if not do_translate or not items:
        return
    _progress(pmid, "翻译全文", 0.2, f"共 {len(items)} 段，开始翻译…")

    translatable = [
        {"id": f"t{i}", "text": it["text"]}
        for i, it in enumerate(items)
        if it.get("text") and it["kind"] in ("heading", "para", "figure", "table")
    ]
    zh_map = llm.translate_blocks(
        translatable,
        cfg,
        progress=lambda msg: _progress(pmid, "翻译全文", 0.5, msg),
    )

    aligned = []
    for i, it in enumerate(items):
        aligned.append(
            {
                "kind": it["kind"],
                "level": it.get("level", 1),
                "label": it.get("label", ""),
                "en": it.get("text", ""),
                "zh": zh_map.get(f"t{i}", ""),
            }
        )
    store.write_json(
        pmid,
        "translation_text.json",
        {"source": "text", "items": aligned, "note": store.read_json(pmid, "fulltext.json") or {}},
    )
    _progress(pmid, "翻译全文", 0.75, "文字翻译完成")


def _prepare_pdf(pmid: str, paper: dict, cfg: dict, do_translate: bool) -> None:
    if not do_translate:
        return
    _progress(pmid, "解析 PDF", 0.15, "正在提取文本块与版面…")
    pages, _sizes = pdfdoc.blocks_for_translation(pmid)
    blocks = [b for page in pages for b in page]
    if not blocks:
        raise llm.LLMError("这个 PDF 没有可提取的文本层（可能是扫描件），无法逐块翻译")

    _progress(pmid, "翻译 PDF", 0.25, f"共 {len(blocks)} 个文本块，开始翻译…")
    zh_map = llm.translate_blocks(
        blocks,
        cfg,
        progress=lambda msg: _progress(pmid, "翻译 PDF", 0.6, msg),
    )

    _progress(pmid, "重排译文", 0.75, "正在把译文写回版面…")
    meta = pdfdoc.render_translated(
        pmid,
        zh_map,
        min_size=float(cfg["translation"].get("min_font_size", 6.5)),
        target_ratio=float(cfg["translation"].get("target_font_ratio", 0.92)),
    )

    pages_payload = []
    for page_no, page_blocks in enumerate(pages, start=1):
        pages_payload.append(
            {
                "page": page_no,
                "blocks": [
                    {
                        "id": b["id"],
                        "bbox": b["bbox"],
                        "en": b["text"],
                        "zh": zh_map.get(b["id"], ""),
                    }
                    for b in page_blocks
                ],
            }
        )
    store.write_json(
        pmid,
        "translation_pages.json",
        {"page_count": meta["page_count"], "pages": pages_payload, "meta": meta},
    )
