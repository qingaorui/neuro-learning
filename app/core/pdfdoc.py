"""PDF 逐页对照引擎。

思路：
1. 用 PyMuPDF 把每页的文本块连同 bbox 抽出来（这是「保留排版」的坐标系）；
2. 交给模型逐块翻译；
3. 原文块先做 redaction 抹掉，再在原 bbox 内重排中文，字号自动缩小直到塞得下；
4. 页面上非文本的部分（插图、表格线、公式位图）完全不动 —— 图片和版式因此天然保留。
"""

from __future__ import annotations

import re
import statistics
from functools import lru_cache
from pathlib import Path

import pymupdf

from . import store

# 图注/表题：即使落在图形区域内也要翻译
CAPTION_RE = re.compile(r"^(figure|fig\.?|table|scheme|box)\s*\d", re.I)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

LINE_SPACING = 1.30
DPI = 130
# 低于这个长度的文本块视为图内标签/刻度，不翻译
MIN_TRANSLATE_CHARS = 15


@lru_cache(maxsize=1)
def cjk_font() -> str:
    for cand in FONT_CANDIDATES:
        if Path(cand).exists():
            return cand
    raise RuntimeError("找不到可用的中文字体，请把字体路径填进 config.json")


def open_doc(pmid: str) -> "pymupdf.Document":
    return pymupdf.open(store.pdf_path(pmid))


def analyze(pmid: str) -> dict:
    """快速体检：页数、是否有文本层、正文块数量。"""
    doc = open_doc(pmid)
    total_blocks = 0
    for page in doc:
        total_blocks += len([b for b in page.get_text("blocks") if b[6] == 0])
    result = {
        "page_count": doc.page_count,
        "text_blocks": total_blocks,
        "has_text_layer": total_blocks >= doc.page_count,
    }
    doc.close()
    return result


def _is_furniture(blocks_per_page: list[list[dict]]) -> set[str]:
    """跨页高频重复的短文本视为页眉页脚，不翻译。"""
    from collections import Counter

    counter: Counter[str] = Counter()
    for blocks in blocks_per_page:
        seen = {b["text"].strip().lower() for b in blocks if len(b["text"]) < 90}
        counter.update(seen)
    threshold = max(2, int(len(blocks_per_page) * 0.3))
    return {text for text, n in counter.items() if n >= threshold}


def _drawing_clusters(page: "pymupdf.Page", min_paths: int = 3) -> list["pymupdf.Rect"]:
    """把页面上密集的矢量图元聚成「图形区域」。

    论文的插图常常是矢量绘制（坐标轴、示意图、曲线），没有位图可查，
    但图里的标签文字是文本块，不排除掉就会被译成中文把图撑坏。
    """
    try:
        rects = [d["rect"] for d in page.get_drawings() if d.get("rect")]
    except Exception:
        return []
    rects = [r for r in rects if r.width > 0 and r.height > 0]
    if not rects:
        return []

    clusters: list[list["pymupdf.Rect"]] = []
    for rect in rects:
        placed = False
        for cluster in clusters:
            hull = cluster[0]
            for member in cluster[1:]:
                hull = hull | member
            near = hull + (-8, -8, 8, 8)
            if near.intersects(rect):
                cluster.append(rect)
                placed = True
                break
        if not placed:
            clusters.append([rect])

    out: list["pymupdf.Rect"] = []
    for cluster in clusters:
        if len(cluster) < min_paths:
            continue
        hull = cluster[0]
        for member in cluster[1:]:
            hull = hull | member
        if hull.width * hull.height < 2000:
            continue
        out.append(hull)
    return out


def extract_blocks(pmid: str, skip_furniture: bool = True) -> tuple[list[list[dict]], list[float]]:
    """返回 (每页的块列表, 每页平均字号)。块里带 bbox，供之后写回。

    同时做三件事，都是为了避免「把图翻译坏」：
    - 跳过极短文本（图内标签、坐标轴刻度、子图编号 a/b/c）；
    - 跳过落在位图区域内的文本；
    - 给每个块算出可向下扩展的空间（bottom），供译文排不下时借用。
    """
    doc = open_doc(pmid)
    pages: list[list[dict]] = []
    for pno, page in enumerate(doc):
        image_rects: list["pymupdf.Rect"] = []
        try:
            for info in page.get_image_info():
                image_rects.append(pymupdf.Rect(info["bbox"]))
        except Exception:
            pass
        figure_rects = image_rects + _drawing_clusters(page)

        raw = [b for b in page.get_text("blocks") if b[6] == 0]
        items: list[dict] = []
        for bi, (x0, y0, x1, y1, text, _n, _t) in enumerate(raw):
            clean = " ".join(text.split())
            if len(clean) < MIN_TRANSLATE_CHARS:
                continue
            if not any(ch.isalpha() for ch in clean):
                continue

            rect = pymupdf.Rect(x0, y0, x1, y1)
            center = pymupdf.Point((x0 + x1) / 2, (y0 + y1) / 2)
            if any(r.contains(center) for r in image_rects):
                continue
            # 落在图形区域里的短文本多半是图内标签；图注要保留（它值得翻译）
            is_caption = bool(CAPTION_RE.match(clean))
            if (
                not is_caption
                and len(clean) <= 60
                and any(r.contains(center) for r in figure_rects)
            ):
                continue

            sizes: list[float] = []
            try:
                for line in page.get_text("dict")["blocks"][bi].get("lines", []):
                    for span in line.get("spans", []):
                        if span["text"].strip():
                            sizes.append(round(span["size"], 1))
            except (IndexError, KeyError):
                pass
            size = statistics.median(sizes) if sizes else 10.0
            items.append(
                {
                    "id": f"p{pno + 1}b{len(items) + 1}",
                    "page": pno + 1,
                    "bbox": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                    "text": clean,
                    "size": size,
                }
            )

        items.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))

        # 计算每块可向下扩展到的位置：到下一个块的上边缘为止
        page_bottom = page.rect.y1 - 34
        for idx, block in enumerate(items):
            y1 = block["bbox"][3]
            limit = page_bottom
            for other in items[idx + 1:]:
                ox0, oy0, ox1, _oy1 = other["bbox"]
                overlapped = not (ox1 < block["bbox"][0] or ox0 > block["bbox"][2])
                if oy0 >= y1 - 0.5 and overlapped:
                    limit = min(limit, oy0 - 2.0)
                    break
            block["bottom"] = round(max(limit, y1), 1)
            block["id"] = f"p{pno + 1}b{idx + 1}"

        pages.append(items)

    if skip_furniture:
        furniture = _is_furniture(pages)
        for blocks in pages:
            blocks[:] = [b for b in blocks if b["text"].strip().lower() not in furniture]

    avg_sizes = [statistics.median([b["size"] for b in blk]) if blk else 10.0 for blk in pages]
    doc.close()
    return pages, avg_sizes


def _wrap(text: str, font: "pymupdf.Font", size: float, max_width: float) -> list[str]:
    """按像素宽度逐字断行（译文是中文，逐字断行即可）。"""
    lines: list[str] = []
    current = ""
    for ch in text:
        if ch == "\n":
            lines.append(current)
            current = ""
            continue
        candidate = current + ch
        if current and font.text_length(candidate, size) > max_width:
            lines.append(current)
            current = ch
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _layout(
    text: str, font: "pymupdf.Font", rect: "pymupdf.Rect", start_size: float, min_size: float
) -> tuple[float, list[str]]:
    """在 rect 内找到能塞下的最大字号。"""
    width = max(rect.width - 1.0, 8.0)
    size = start_size
    while size >= min_size:
        lines = _wrap(text, font, size, width)
        if len(lines) * size * LINE_SPACING <= rect.height + 0.5:
            return size, lines
        size -= 0.4
    lines = _wrap(text, font, min_size, width)
    return min_size, lines


def render_translated(
    pmid: str, translations: dict[str, str], min_size: float = 6.5, target_ratio: float = 0.92
) -> dict:
    """写出译文版 PDF 与逐页 PNG。返回统计信息。"""
    fontfile = cjk_font()
    font = pymupdf.Font(fontfile=fontfile)

    doc = open_doc(pmid)
    page_blocks, avg_sizes = extract_blocks(pmid)

    total, placed, overflow = 0, 0, 0
    for pno, page in enumerate(doc):
        blocks = page_blocks[pno] if pno < len(page_blocks) else []
        pending: list[tuple["pymupdf.Rect", float, list[str], "pymupdf.Rect"]] = []
        for block in blocks:
            total += 1
            zh = translations.get(block["id"], "").strip()
            if not zh:
                continue
            cover = pymupdf.Rect(*block["bbox"])
            box = pymupdf.Rect(
                block["bbox"][0], block["bbox"][1], block["bbox"][2],
                max(block.get("bottom", block["bbox"][3]), block["bbox"][3]),
            )
            try:
                page.add_redact_annot(cover, fill=(1, 1, 1))
            except Exception:
                continue
            start = min(max(block["size"] * target_ratio, min_size), 11.0)
            size, lines = _layout(zh, font, box, start, min_size)
            needed = len(lines) * size * LINE_SPACING
            if needed > box.height + 0.5:
                overflow += 1
            pending.append((box, size, lines, cover))
            placed += 1

        if pending:
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
            for box, size, lines, _cover in pending:
                y = box.y0 + size
                for line in lines:
                    if y > box.y1 + size * 0.8:
                        break
                    page.insert_text(
                        pymupdf.Point(box.x0, y),
                        line,
                        fontname="cjk",
                        fontfile=fontfile,
                        fontsize=size,
                        color=(0, 0, 0),
                    )
                    y += size * LINE_SPACING

    out_pdf = store.path(pmid, "translated.pdf")
    # 不做子集化的话，中文字体会整包嵌入，两页文档就能涨到十几 MB
    try:
        doc.subset_fonts()
    except Exception:
        pass
    doc.save(str(out_pdf), deflate=True, garbage=4)

    pages_dir = store.path(pmid, "pages")
    pages_dir.mkdir(exist_ok=True)
    matrix = pymupdf.Matrix(DPI / 72, DPI / 72)
    for pno, page in enumerate(doc):
        pix = page.get_pixmap(matrix=matrix)
        pix.save(str(pages_dir / f"translated-{pno + 1:03d}.png"))

    # 原文页也一并出图，方便切换对照
    orig = open_doc(pmid)
    for pno, page in enumerate(orig):
        pix = page.get_pixmap(matrix=matrix)
        pix.save(str(pages_dir / f"original-{pno + 1:03d}.png"))

    page_count = doc.page_count
    doc.close()
    orig.close()

    return {
        "page_count": page_count,
        "blocks_total": total,
        "blocks_translated": placed,
        "blocks_overflow": overflow,
        "pdf": str(out_pdf),
    }


def blocks_for_translation(pmid: str) -> tuple[list[list[dict]], list[float]]:
    """给翻译任务用的块列表（已剔除页眉页脚）。"""
    return extract_blocks(pmid)
