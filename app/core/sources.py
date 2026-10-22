"""全文获取：优先 PMC 的 JATS XML（走 PubMed E-utilities，稳定），
PDF 只做尽力而为的 OA 尝试——实测绝大多数综述期刊是付费的，拿不到就等用户拖入。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from . import store

UA = {
    "User-Agent": "NeuroStudy/1.0 (personal learning tool; contact: local)"
}
EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
OPENALEX = "https://api.openalex.org/works/doi:"


def _http(url: str, timeout: int = 60, max_bytes: int = 12_000_000) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.headers.get("Content-Type", ""), resp.read(max_bytes)


def _tag(el: ET.Element) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _text(el: ET.Element) -> str:
    return " ".join("".join(el.itertext()).split())


def _href(el: ET.Element) -> str:
    for key, value in el.attrib.items():
        if key.rsplit("}", 1)[-1] == "href":
            return value
    return ""


# --------------------------------------------------------------------------- #
# JATS 解析：把正文拍平成有序的 items
# --------------------------------------------------------------------------- #
def _parse_jats(xml_text: str) -> dict:
    root = ET.fromstring(xml_text)

    title = ""
    abstract_items: list[dict] = []
    body_items: list[dict] = []

    front = next((c for c in root.iter() if _tag(c) == "front"), None)
    if front is not None:
        for el in front.iter():
            if _tag(el) == "article-title" and not title:
                title = _text(el)
        for el in front.iter():
            if _tag(el) == "abstract":
                for para in el.iter():
                    if _tag(para) == "p":
                        t = _text(para)
                        if t:
                            abstract_items.append({"kind": "para", "text": t})
                break

    body = next((c for c in root.iter() if _tag(c) == "body"), None)
    if body is not None:
        _walk(body, body_items, level=1)

    # PMC 常把图、表集中在 <body> 之外的 <floats-group>
    for floats in root.iter():
        if _tag(floats) == "floats-group":
            _walk(floats, body_items, level=1)

    return {"title": title, "abstract": abstract_items, "body": body_items}


def _walk(el: ET.Element, out: list[dict], level: int) -> None:
    for child in el:
        name = _tag(child)
        if name == "sec":
            heading = ""
            for sub in child:
                if _tag(sub) == "title":
                    heading = _text(sub)
                    break
            if heading:
                out.append({"kind": "heading", "level": min(level, 4), "text": heading})
            _walk(child, out, level + 1)
        elif name == "p":
            t = _text(child)
            if len(t) > 1:
                out.append({"kind": "para", "text": t})
        elif name == "fig":
            label = ""
            caption = ""
            graphic = ""
            for sub in child:
                if _tag(sub) == "label":
                    label = _text(sub)
                elif _tag(sub) == "caption":
                    caption = _text(sub)
                elif _tag(sub) == "graphic":
                    graphic = _href(sub)
            out.append(
                {
                    "kind": "figure",
                    "level": level,
                    "label": label or "Figure",
                    "text": caption,
                    "href": graphic,
                }
            )
        elif name == "table-wrap":
            label = ""
            caption = ""
            for sub in child:
                if _tag(sub) == "label":
                    label = _text(sub)
                elif _tag(sub) == "caption":
                    caption = _text(sub)
            out.append(
                {
                    "kind": "table",
                    "level": level,
                    "label": label or "Table",
                    "text": caption,
                }
            )
        elif name in ("title", "table", "xref", "graphic", "supplementary-material"):
            continue
        else:
            _walk(child, out, level)


# --------------------------------------------------------------------------- #
# 对外接口
# --------------------------------------------------------------------------- #
def fetch_fulltext(paper: dict) -> dict:
    """返回 {"source": "jats"|"abstract", "items": [...], "title": ...}，并落盘。"""
    cached = store.read_json(paper["pmid"], "fulltext.json")
    if cached:
        return cached

    result: dict = {"source": "abstract", "title": paper["title"], "items": [], "note": ""}
    pmcid = (paper.get("pmcid") or "").strip()

    if pmcid:
        numeric = re.sub(r"^PMC", "", pmcid, flags=re.I)
        url = f"{EFETCH}?db=pmc&id={numeric}&retmode=xml"
        try:
            status, _ctype, body = _http(url)
            if status == 200 and b"<article" in body[:4000]:
                parsed = _parse_jats(body.decode("utf-8", "replace"))
                items = list(parsed["abstract"])
                if parsed["body"]:
                    if items:
                        items.append({"kind": "heading", "level": 1, "text": "正文"})
                    items.extend(parsed["body"])
                if parsed["body"]:
                    result = {
                        "source": "jats",
                        "title": parsed["title"] or paper["title"],
                        "items": items,
                        "note": "全文来自 PMC 的 JATS XML（PubMed E-utilities）。",
                    }
        except (urllib.error.URLError, TimeoutError, ET.ParseError, ValueError) as exc:
            result["note"] = f"PMC 全文抓取失败：{exc}"

    if not result["items"]:
        abstract = (paper.get("abstract") or "").strip()
        result["source"] = "abstract"
        result["items"] = (
            [{"kind": "para", "text": t} for t in abstract.split("\n\n") if t.strip()]
            if abstract
            else []
        )
        result["note"] = (
            "该篇没有 PMC 全文，仅能翻译摘要。把 PDF 拖进来可以做逐页对照译文。"
        )

    store.write_json(paper["pmid"], "fulltext.json", result)
    return result


def try_fetch_oa_pdf(paper: dict) -> tuple[bool, str]:
    """尽力而为：多数综述期刊无 OA 版，失败是常态，不算错误。"""
    doi = (paper.get("doi") or "").strip()
    if not doi:
        return False, "该文献没有 DOI，无法查询开放获取版本"
    try:
        status, _ctype, body = _http(OPENALEX + urllib.parse.quote(doi), timeout=30)
        meta = json.loads(body.decode("utf-8", "replace"))
    except Exception as exc:  # 网络或解析问题都不该中断流程
        return False, f"开放获取查询失败：{exc}"

    location = meta.get("best_oa_location") or {}
    pdf_url = location.get("pdf_url")
    if not pdf_url:
        return False, "没有开放获取的 PDF 版本，请手动下载后拖入"

    try:
        status, ctype, data = _http(pdf_url, timeout=60)
        if status == 200 and data.startswith(b"%PDF"):
            store.save_pdf(paper["pmid"], data)
            return True, "已自动下载开放获取 PDF"
        return False, f"该链接返回的不是 PDF（{ctype or '未知类型'}），请手动下载"
    except Exception as exc:
        return False, f"PDF 下载被拒绝或失败（{exc}），请手动下载后拖入"
