"""大模型接入：逐块翻译 + 论文详细解读。

默认接 DeepSeek（OpenAI 兼容协议）；换 base_url/model 即可接其它兼容接口。
没有 key 时打开 llm.mock，整条流水线照跑，只是译文变成占位文本——
这样界面和排版能在没配 key 的情况下先验证通。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import config

SYSTEM_TRANSLATE = (
    "你是神经科学领域的专业学术翻译，任务是把英文文献译成简体中文。必须遵守：\n"
    "1. 术语使用学界通行译法；关键术语首次出现时可在括号内保留英文原词。\n"
    "2. 完整保留数字、单位、基因/蛋白/通道名称、缩写、统计符号与文献引用标记（如 [12]、(Fig. 2)）。\n"
    "3. 不增删内容，不加译者注，不做解释，不总结。\n"
    "4. 保持原句的信息密度与学术语气，不要口语化。\n"
    "5. 只输出译文本身，不要任何前后缀说明。"
)

SYSTEM_INTERPRET = (
    "你是资深神经科学研究者，正在带一名生物学背景但缺神经科学训练的学生精读文献。\n"
    "你的解读必须紧扣原文，不许编造原文没有的数据或结论；不确定的地方要明说「原文未明确」。\n"
    "输出必须是严格的 JSON，不要 Markdown 代码块，不要额外文字。"
)

INTERPRET_SCHEMA = {
    "one_liner": "一句话结论（30 字以内）",
    "question": "这篇要回答什么问题，为什么值得问",
    "background": "读它之前需要的前置知识（2-4 条）",
    "methods": [{"name": "方法名", "what": "具体做了什么", "why": "为什么用这个方法"}],
    "findings": [{"point": "关键结果", "evidence": "支撑它的图/数据/实验"}],
    "figures": [{"label": "图号", "caption_zh": "图注中文", "read_this": "这张图该怎么看"}],
    "caveats": "局限、争议或作者自己承认的问题",
    "connection": "它在整套课程里的位置，与哪些篇目呼应",
    "glossary": [{"term": "英文术语", "zh": "中文", "note": "一句话解释"}],
    "quiz": ["自测问题 1", "自测问题 2", "自测问题 3"],
}


class LLMError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# 底层调用
# --------------------------------------------------------------------------- #
def _post(url: str, payload: dict, api_key: str, timeout: int) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise LLMError(f"接口返回 {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"连接模型接口失败：{exc.reason}") from exc


def chat(messages: list[dict], cfg: dict, force_json: bool = False) -> str:
    llm = cfg["llm"]
    url = llm["base_url"].rstrip("/") + "/chat/completions"
    payload: dict = {
        "model": llm["model"],
        "messages": messages,
        "temperature": llm.get("temperature", 0.2),
        "stream": False,
    }
    if force_json:
        payload["response_format"] = {"type": "json_object"}
    data = _post(url, payload, llm.get("api_key", ""), int(llm.get("timeout", 180)))
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise LLMError(f"接口返回格式异常：{str(data)[:300]}") from exc


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    raise LLMError("模型没有返回可解析的 JSON")


# --------------------------------------------------------------------------- #
# 对话（流式）
# --------------------------------------------------------------------------- #
SYSTEM_CHAT = (
    "你是这位学习者的神经科学导师。他/她有生物学背景（分子、细胞、遗传学扎实），"
    "但缺少神经科学的系统训练，正在每天精读一篇文献。\n"
    "回答要求：\n"
    "1. 优先依据提供的论文内容回答；引用时指明是哪个章节、第几张图或哪段数据。\n"
    "2. 论文里没有写的内容，必须明说「这篇没提到」。如果你补充的是领域常识，"
    "用「（领域常识）」标出来，不要和论文内容混为一谈。\n"
    "3. 不要编造数据、图号、统计值。不确定就说不确定。\n"
    "4. 用中文回答，术语保留英文原词。简明直接，不要客套和总结段。\n"
    "5. 对方问的是概念问题时，可以脱开论文讲清楚，但要指出这属于背景补充。"
)


def build_chat_context(paper: dict, items: list[dict], interpretation: dict | None, limit: int = 18000) -> str:
    parts = [
        f"当前论文：{paper['title']}",
        f"期刊年份：{paper['journal']} {paper['year']}",
        f"类型：{paper['type_name']}；难度：{paper['level_name']}",
        f"课程位置：{paper['module']} 第 {paper['id']} 天",
        f"编者导读：{paper['note']}",
    ]

    if interpretation and not interpretation.get("mock"):
        if interpretation.get("one_liner"):
            parts.append(f"已有解读·一句话结论：{interpretation['one_liner']}")
        if interpretation.get("caveats"):
            parts.append(f"已有解读·局限：{interpretation['caveats']}")

    body_lines: list[str] = []
    used = sum(len(p) for p in parts)
    for it in items:
        if not it.get("text"):
            continue
        label = it.get("label") or it["kind"]
        line = f"[{label}] {it['text']}"
        if used + len(line) > limit:
            body_lines.append("[正文过长，后续内容已截断]")
            break
        body_lines.append(line)
        used += len(line)

    parts.append("论文正文：\n" + "\n\n".join(body_lines))
    return "\n\n".join(parts)


def chat_messages(context: str, history: list[dict], question: str) -> list[dict]:
    messages = [
        {"role": "system", "content": SYSTEM_CHAT},
        {"role": "system", "content": "以下是本次对话要依据的论文材料：\n\n" + context},
    ]
    for turn in history[-12:]:  # 只带最近 6 轮，控制上下文
        role = "assistant" if turn.get("role") == "assistant" else "user"
        content = str(turn.get("content", ""))[:4000]
        if content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": question})
    return messages


def _mock_stream(question: str):
    reply = (
        "【未配置模型，这是占位回答】\n\n"
        f"你问的是：{question}\n\n"
        "在设置里填入 DeepSeek API Key 之后，这里会基于当前论文的正文、图表和解读来回答，"
        "并标明引用的章节或图号。"
    )
    for i in range(0, len(reply), 12):
        yield reply[i : i + 12]


def chat_stream(messages: list[dict], cfg: dict, fallback_question: str = ""):
    """逐块产出模型输出。无 key / mock 时走占位流，保证前端链路可验证。"""
    if cfg["llm"].get("mock") or not cfg["llm"].get("api_key"):
        yield from _mock_stream(fallback_question or "（未提供问题）")
        return

    llm_cfg = cfg["llm"]
    url = llm_cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": llm_cfg["model"],
        "messages": messages,
        "temperature": 0.3,
        "stream": True,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm_cfg.get('api_key','')}",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=int(llm_cfg.get("timeout", 180))) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    obj = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise LLMError(f"对话接口返回 {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"连接对话接口失败：{exc.reason}") from exc


# --------------------------------------------------------------------------- #
# 翻译
# --------------------------------------------------------------------------- #
def _mock_translation(text: str) -> str:
    head = text[:24].strip()
    return f"【未配置模型，此处为占位译文】{head}……"


def translate_batch(pairs: list[tuple[str, str]], cfg: dict) -> dict[str, str]:
    """pairs: [(block_id, english)] -> {block_id: 中文}"""
    if not pairs:
        return {}
    if cfg["llm"].get("mock") or not cfg["llm"].get("api_key"):
        return {bid: _mock_translation(txt) for bid, txt in pairs}

    listing = "\n".join(
        f'<seg id="{bid}">{txt}</seg>' for bid, txt in pairs
    )
    user = (
        "把下面每个 <seg> 段落的英文译成中文。严格按这个 JSON 结构返回：\n"
        '{"segments": [{"id": "原样照抄的 id", "zh": "中文译文"}]}\n'
        "每个输入段落都必须有对应输出，id 不许改动或遗漏。\n\n"
        f"{listing}"
    )
    raw = chat(
        [
            {"role": "system", "content": SYSTEM_TRANSLATE},
            {"role": "user", "content": user},
        ],
        cfg,
        force_json=True,
    )
    parsed = _extract_json(raw)
    out: dict[str, str] = {}
    for item in parsed.get("segments", []):
        bid = str(item.get("id", "")).strip()
        zh = str(item.get("zh", "")).strip()
        if bid and zh:
            out[bid] = zh

    missing = [bid for bid, _ in pairs if bid not in out]
    if missing:  # 补一次逐个重试，宁可多花一次请求也别留空洞
        for bid, txt in pairs:
            if bid in out:
                continue
            try:
                single = chat(
                    [
                        {"role": "system", "content": SYSTEM_TRANSLATE},
                        {"role": "user", "content": f"只翻译这一段，直接输出译文：\n{txt}"},
                    ],
                    cfg,
                )
                if single.strip():
                    out[bid] = single.strip()
            except LLMError:
                continue
    return out


def translate_blocks(
    blocks: list[dict], cfg: dict, progress=None
) -> dict[str, str]:
    """并发翻译文本块。blocks 需含 id / text。"""
    tcfg = cfg["translation"]
    batch_size = max(1, int(tcfg.get("blocks_per_request", 14)))
    workers = max(1, int(tcfg.get("max_parallel", 3)))

    pairs = [(b["id"], b["text"]) for b in blocks if b.get("text")]
    batches = [pairs[i : i + batch_size] for i in range(0, len(pairs), batch_size)]

    result: dict[str, str] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(translate_batch, batch, cfg): batch for batch in batches}
        for future in as_completed(futures):
            batch = futures[future]
            try:
                result.update(future.result())
            except LLMError as exc:
                # 单批失败不拖垮整体
                if progress:
                    progress(f"有一批翻译失败：{exc}")
                for bid, txt in batch:
                    result.setdefault(bid, _mock_translation(txt))
            done += len(batch)
            if progress:
                progress(f"已翻译 {done}/{len(pairs)} 个文本块")
    return result


# --------------------------------------------------------------------------- #
# 解读
# --------------------------------------------------------------------------- #
def _mock_interpretation(paper: dict) -> dict:
    return {
        "one_liner": "（未配置模型）这是一段占位解读。",
        "question": f"占位：本文《{paper['title'][:60]}》试图回答的问题。",
        "background": ["配置 DeepSeek API Key 后，这里会给出真实的前置知识清单。"],
        "methods": [{"name": "占位", "what": "—", "why": "—"}],
        "findings": [{"point": "占位", "evidence": "—"}],
        "figures": [
            {"label": "Figure 1", "caption_zh": "占位图注", "read_this": "配置后会逐图给出读法。"}
        ],
        "caveats": "占位。",
        "connection": "占位。",
        "glossary": [{"term": "placeholder", "zh": "占位", "note": "—"}],
        "quiz": ["配置模型后这里会生成自测问题。"],
        "mock": True,
    }


def interpret(paper: dict, items: list[dict], cfg: dict) -> dict:
    if cfg["llm"].get("mock") or not cfg["llm"].get("api_key"):
        return _mock_interpretation(paper)

    body = "\n\n".join(
        f"[{it['kind']}] {it['text']}" for it in items if it.get("text")
    )
    # 控制上下文：摘要类文献本来就短，全文则截断到合理长度
    if len(body) > 24000:
        body = body[:24000] + "\n\n[正文过长已截断]"

    figures = [it for it in items if it["kind"] in ("figure", "table")]
    fig_hint = "\n".join(f"{f.get('label','Figure')}: {f['text']}" for f in figures) or "（无图表信息）"

    meta = (
        f"标题：{paper['title']}\n"
        f"期刊：{paper['journal']} ({paper['year']})\n"
        f"类型：{paper['type_name']}；难度：{paper['level_name']}\n"
        f"课程位置：{paper['module']}，第 {paper['id']} 天\n"
        f"编者为它写的导读：{paper['note']}\n\n"
        f"图表清单：\n{fig_hint}\n\n"
        f"正文/摘要：\n{body}"
    )
    user = (
        "请按下面的 JSON 结构输出对这篇文献的详细解读。字段必须齐全，"
        "数组里每一项都要是对象（结构如下），没有内容就给空数组。\n\n"
        f"{json.dumps(INTERPRET_SCHEMA, ensure_ascii=False, indent=1)}\n\n"
        f"文献信息：\n{meta}"
    )
    raw = chat(
        [
            {"role": "system", "content": SYSTEM_INTERPRET},
            {"role": "user", "content": user},
        ],
        cfg,
        force_json=True,
    )
    data = _extract_json(raw)
    data.setdefault("mock", False)
    return data
