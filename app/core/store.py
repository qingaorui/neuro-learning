"""磁盘布局：每篇论文一个工件目录，所有中间产物都落盘，重开不重算。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent   # 项目根 = 学习/
DATA = ROOT / "data"
ARTIFACTS = DATA / "artifacts"
PROGRESS_PATH = DATA / "progress.json"


def paper_dir(pmid: str) -> Path:
    return ARTIFACTS / str(pmid)


def _ensure(pmid: str) -> Path:
    d = paper_dir(pmid)
    d.mkdir(parents=True, exist_ok=True)
    return d


def path(pmid: str, name: str) -> Path:
    """只拼路径，不建目录——读操作不该有副作用。"""
    return paper_dir(pmid) / name


def read_json(pmid: str, name: str) -> Any | None:
    p = path(pmid, name)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_json(pmid: str, name: str, obj: Any) -> Path:
    _ensure(pmid)
    p = path(pmid, name)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def pdf_path(pmid: str) -> Path:
    return path(pmid, "paper.pdf")


def has_pdf(pmid: str) -> bool:
    p = pdf_path(pmid)
    if not (p.exists() and p.stat().st_size > 1_500):
        return False
    try:
        with p.open("rb") as fh:
            return fh.read(5).startswith(b"%PDF")
    except OSError:
        return False


def save_pdf(pmid: str, data: bytes) -> Path:
    """校验并落盘 PDF。"""
    if not data.startswith(b"%PDF"):
        raise ValueError("上传的文件不是 PDF（缺少 %PDF 文件头）")
    _ensure(pmid)
    target = pdf_path(pmid)
    tmp = target.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    # PDF 变了，旧的页面图与译文全部作废
    for name in ("pages", "translation_pages.json", "interpretation.json"):
        p = path(pmid, name)
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()
    return target


def page_image(pmid: str, page: int, mode: str) -> Path | None:
    p = path(pmid, f"pages/{mode}-{page:03d}.png")
    return p if p.exists() else None


def read_progress() -> dict:
    if PROGRESS_PATH.exists():
        try:
            return json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"read": [], "notes": {}, "bookmark": None}


def write_progress(prog: dict) -> None:
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text(
        json.dumps(prog, ensure_ascii=False, indent=2), encoding="utf-8"
    )
