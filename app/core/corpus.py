"""课程语料与「今日该学哪篇」的调度。"""

from __future__ import annotations

import datetime as dt
import json
from functools import lru_cache
from pathlib import Path

from . import config, store

CORPUS_PATH = store.DATA / "papers.json"


@lru_cache(maxsize=1)
def corpus() -> dict:
    payload = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    payload["by_id"] = {p["id"]: p for p in payload["papers"]}
    payload["by_pmid"] = {p["pmid"]: p for p in payload["papers"]}
    return payload


def modules() -> list[dict]:
    mods = corpus()["modules"]
    counts: dict[str, int] = {}
    for p in corpus()["papers"]:
        counts[p["module"]] = counts.get(p["module"], 0) + 1
    return [{**m, "count": counts.get(m["id"], 0)} for m in mods]


def papers() -> list[dict]:
    return corpus()["papers"]


def get(day_or_id: str | int) -> dict | None:
    """接受 D007 / 7 / "7" 三种写法。"""
    key = str(day_or_id).strip()
    if key.isdigit():
        day = int(key)
        if 1 <= day <= len(papers()):
            return papers()[day - 1]
        return None
    if not key.upper().startswith("D"):
        key = f"D{int(key):03d}" if key.isdigit() else key
    return corpus()["by_id"].get(key.upper())


def start_date() -> dt.date:
    raw = config.load()["schedule"]["start_date"]
    try:
        return dt.date.fromisoformat(raw)
    except (ValueError, TypeError):
        return dt.date.today()


def day_for(d: dt.date | None = None) -> int:
    """第几天。超出总天数则夹到末篇，避免空窗。"""
    d = d or dt.date.today()
    total = len(papers())
    idx = (d - start_date()).days + 1
    return max(1, min(idx, total))


def today() -> dict:
    day = day_for()
    paper = papers()[day - 1]
    total = len(papers())
    return {
        "day": day,
        "total": total,
        "date": dt.date.today().isoformat(),
        "paper": paper,
        "finished": day >= total and progress_flag(paper["id"]),
    }


def progress_flag(pid: str) -> bool:
    return pid in set(store.read_progress().get("read", []))


def status_of(paper: dict) -> dict:
    """这篇论文的产出现状，供前端决定显示什么。"""
    pmid = paper["pmid"]
    pdf = store.has_pdf(pmid)
    pages = store.read_json(pmid, "translation_pages.json")
    text = store.read_json(pmid, "translation_text.json")
    interp = store.read_json(pmid, "interpretation.json")
    fulltext = store.read_json(pmid, "fulltext.json")
    return {
        "has_pdf": pdf,
        "page_count": (pages or {}).get("page_count", 0),
        "translated_pages": len((pages or {}).get("pages", [])),
        "has_text_translation": bool(text),
        "has_interpretation": bool(interp),
        "fulltext_available": bool(fulltext),
        "fulltext_source": (fulltext or {}).get("source", ""),
        "read": progress_flag(paper["id"]),
    }


def plan_view() -> list[dict]:
    """给侧边目录用的精简视图。"""
    prog = set(store.read_progress().get("read", []))
    return [
        {
            "id": p["id"],
            "pmid": p["pmid"],
            "title": p["title"],
            "journal": p["journal"],
            "year": p["year"],
            "module": p["module"],
            "type_name": p["type_name"],
            "level": p["level"],
            "level_name": p["level_name"],
            "read": p["id"] in prog,
        }
        for p in papers()
    ]


def stats() -> dict:
    prog = store.read_progress()
    read = set(prog.get("read", []))
    total = len(papers())
    by_module: dict[str, dict] = {}
    for p in papers():
        m = by_module.setdefault(p["module"], {"total": 0, "read": 0})
        m["total"] += 1
        if p["id"] in read:
            m["read"] += 1
    return {
        "total": total,
        "read": len(read),
        "percent": round(len(read) * 100 / total, 1) if total else 0,
        "by_module": by_module,
        "streak": _streak(prog),
    }


def _streak(prog: dict) -> int:
    dates = sorted({r.get("date") for r in prog.get("history", []) if r.get("date")})
    if not dates:
        return 0
    streak = 1
    for newer, older in zip(reversed(dates), reversed(dates[:-1])):
        if (dt.date.fromisoformat(newer) - dt.date.fromisoformat(older)).days == 1:
            streak += 1
        else:
            break
    return streak


def mark_read(pid: str, read: bool = True) -> dict:
    prog = store.read_progress()
    read_set = set(prog.get("read", []))
    history = prog.get("history", [])
    if read:
        if pid not in read_set:
            history.append({"id": pid, "date": dt.date.today().isoformat()})
        read_set.add(pid)
    else:
        read_set.discard(pid)
    prog["read"] = sorted(read_set)
    prog["history"] = history[-500:]
    store.write_progress(prog)
    return prog
