"""Europe PMC 客户端：按被引次数排序检索文献。

PubMed 的 E-utilities 能筛选「是不是综述」，但不提供引用量；
而挑原始研究论文时，被引次数是最省事的分量信号——上面再叠一层我的判断。

接口不强制限流，但仍保持礼貌间隔。
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"

_last_call = 0.0
_MIN_INTERVAL = 0.25


def search(query: str, size: int = 12, sort: str = "CITED desc") -> list[dict]:
    """返回精简后的结果列表，按 sort 指定的顺序。"""
    global _last_call
    wait = _MIN_INTERVAL - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)

    params = {
        "query": query,
        "format": "json",
        "pageSize": size,
        "sort": sort,
        "resultType": "lite",
    }
    url = f"{BASE}?{urllib.parse.urlencode(params)}"

    last_err = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            _last_call = time.time()
            break
        except Exception as exc:
            last_err = exc
            _last_call = time.time()
            time.sleep(1.2 * (attempt + 1))
    else:
        raise RuntimeError(f"Europe PMC 请求失败: {query}\n{last_err}")

    out = []
    for rec in payload.get("resultList", {}).get("result", []):
        pmid = rec.get("pmid")
        if not pmid:  # 只保留 PubMed 收录的，保证与你要求的「pubmed 可查」一致
            continue
        out.append(
            {
                "pmid": pmid,
                "title": rec.get("title", "").rstrip("."),
                "journal": rec.get("journalTitle", ""),
                "year": int(rec["pubYear"]) if rec.get("pubYear", "").isdigit() else 0,
                "cites": rec.get("citedByCount", 0),
                "authors": rec.get("authorString", ""),
                "doi": rec.get("doi", ""),
            }
        )
    return out


if __name__ == "__main__":
    for rec in search('(TITLE:engram) AND SRC:MED AND NOT PUB_TYPE:"review"', size=5):
        print(f"{rec['cites']:>5}  {rec['year']}  {rec['journal'][:22]:22s} {rec['title'][:70]}")
