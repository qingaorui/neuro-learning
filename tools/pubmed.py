"""PubMed E-utilities 客户端：带限流、重试、磁盘缓存。

不依赖第三方库（只用标准库），因为本机 Python 走 OpenSSL 可以联网，
而 shell 的 schannel 通道在沙箱下取不到证书，curl / Invoke-WebRequest 都会失败。
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"

EMAIL = "learner@example.com"
TOOL = "neurolearn"

# 无 API key 时 NCBI 限制 3 请求/秒；留足余量。
_MIN_INTERVAL = 0.40
_last_call = 0.0


def _cache_path(kind: str, params: dict) -> Path:
    key = json.dumps(params, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    return CACHE_DIR / f"{kind}-{digest}.txt"


def _get(kind: str, endpoint: str, params: dict, use_cache: bool = True) -> str:
    global _last_call

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(kind, params)
    if use_cache and path.exists():
        return path.read_text(encoding="utf-8")

    params = {
        **params,
        "tool": TOOL,
        "email": EMAIL,
        "retmode": params.get("retmode", "json"),
    }
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"

    last_err = None
    for attempt in range(6):
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                text = resp.read().decode("utf-8")
            _last_call = time.time()
            path.write_text(text, encoding="utf-8")
            return text
        except Exception as exc:  # 429 / 5xx / 网络抖动
            last_err = exc
            _last_call = time.time()
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"PubMed 请求失败: {endpoint} {params}\n{last_err}")


# --------------------------------------------------------------------------- #
# 检索
# --------------------------------------------------------------------------- #
def esearch(term: str, retmax: int = 50, sort: str = "relevance") -> list[str]:
    """返回 PMID 列表。"""
    text = _get(
        "esearch",
        "esearch.fcgi",
        {"db": "pubmed", "term": term, "retmax": retmax, "sort": sort},
    )
    payload = json.loads(text)
    return payload.get("esearchresult", {}).get("idlist", [])


def esearch_count(term: str) -> int:
    text = _get("esearch", "esearch.fcgi", {"db": "pubmed", "term": term, "retmax": 0})
    return int(json.loads(text)["esearchresult"]["count"])


# --------------------------------------------------------------------------- #
# 题录
# --------------------------------------------------------------------------- #
def esummary(pmids: list[str]) -> dict[str, dict]:
    """批量取题录。返回 {pmid: 精简后的字典}。"""
    out: dict[str, dict] = {}
    for i in range(0, len(pmids), 100):
        chunk = pmids[i : i + 100]
        text = _get(
            "esummary",
            "esummary.fcgi",
            {"db": "pubmed", "id": ",".join(chunk), "retmode": "json"},
        )
        result = json.loads(text).get("result", {})
        for pmid in chunk:
            raw = result.get(pmid)
            if not raw or "error" in raw:
                continue
            out[pmid] = {
                "pmid": pmid,
                "title": _clean(raw.get("title", "")),
                "journal": raw.get("source", ""),
                "journal_full": raw.get("fulljournalname", ""),
                "year": _year(raw.get("pubdate", "")),
                "pubdate": raw.get("pubdate", ""),
                "authors": [a.get("name", "") for a in raw.get("authors", [])],
                "pubtype": raw.get("pubtype", []),
                "doi": raw.get("doi", ""),
                "pmcid": _pmcid(raw),
            }
        time.sleep(0.05)
    return out


def efetch(pmids: list[str]) -> dict[str, dict]:
    """取完整记录（含摘要、语言、MeSH）。"""
    out: dict[str, dict] = {}
    for i in range(0, len(pmids), 50):
        chunk = pmids[i : i + 50]
        text = _get(
            "efetch",
            "efetch.fcgi",
            {"db": "pubmed", "id": ",".join(chunk), "retmode": "xml"},
        )
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            continue
        for art in root.iter("PubmedArticle"):
            rec = _parse_article(art)
            if rec:
                out[rec["pmid"]] = rec
        time.sleep(0.05)
    return out


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #
def _clean(s: str) -> str:
    s = s.replace("<i>", "").replace("</i>", "")
    s = s.replace("<sup>", "").replace("</sup>", "")
    s = s.replace("<sub>", "").replace("</sub>", "")
    s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return " ".join(s.split())


def _year(pubdate: str) -> int:
    for token in pubdate.split():
        if token.isdigit() and len(token) == 4:
            return int(token)
    return 0


def _pmcid(raw: dict) -> str:
    for item in raw.get("articleids", []):
        if item.get("idtype") == "pmc":
            return item.get("value", "")
    return ""


def _parse_article(art: ET.Element) -> dict | None:
    citation = art.findtext("MedlineCitation/PMID")
    if not citation:
        return None

    article = art.find("MedlineCitation/Article")
    if article is None:
        return None

    title = _clean("".join(article.find("ArticleTitle").itertext())) if article.find("ArticleTitle") is not None else ""

    journal = article.findtext("Journal/ISOAbbreviation") or article.findtext("Journal/Title") or ""
    year = article.findtext("Journal/JournalIssue/PubDate/Year")
    if not year:
        medline_date = article.findtext("Journal/JournalIssue/PubDate/MedlineDate") or ""
        year = medline_date[:4]
    try:
        year_int = int(year)
    except (TypeError, ValueError):
        year_int = 0

    abstract_parts = []
    for node in article.findall("Abstract/AbstractText"):
        label = node.get("Label")
        body = _clean("".join(node.itertext()))
        abstract_parts.append(f"{label}: {body}" if label else body)
    abstract = "\n\n".join(p for p in abstract_parts if p)

    authors = []
    for node in article.findall("AuthorList/Author"):
        last = node.findtext("LastName") or ""
        initials = node.findtext("Initials") or ""
        collective = node.findtext("CollectiveName")
        if last:
            authors.append(f"{last} {initials}".strip())
        elif collective:
            authors.append(collective)

    doi = ""
    for node in art.findall("PubmedData/ArticleIdList/ArticleId"):
        if node.get("IdType") == "doi":
            doi = (node.text or "").strip()

    pmcid = ""
    for node in art.findall("PubmedData/ArticleIdList/ArticleId"):
        if node.get("IdType") == "pmc":
            pmcid = (node.text or "").strip()

    pubtypes = [pt.text or "" for pt in art.findall("MedlineCitation/Article/PublicationTypeList/PublicationType")]
    langs = [lang.text or "" for lang in article.findall("Language")]
    mesh = [m.findtext("DescriptorName") or "" for m in art.findall("MedlineCitation/MeshHeadingList/MeshHeading")]

    return {
        "pmid": citation,
        "title": title,
        "journal": journal,
        "year": year_int,
        "authors": authors,
        "abstract": abstract,
        "doi": doi,
        "pmcid": pmcid,
        "pubtypes": pubtypes,
        "languages": langs,
        "mesh": mesh,
    }


if __name__ == "__main__":
    ids = esearch("hippocampus engram review[pt]", retmax=5)
    print("检索到:", ids)
    info = esummary(ids)
    for pmid, rec in info.items():
        print(f"  {pmid}  {rec['year']}  {rec['journal']:26s}  {rec['title'][:90]}")
