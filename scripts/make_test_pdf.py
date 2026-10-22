"""生成一份「仿真论文 PDF」，用于在没有真实付费 PDF 时验证逐页对照引擎。

版式刻意做成论文的样子：双栏标题区、摘要框、分节标题、正文段落、一张插图 +
图注、以及页眉页脚。这些正是覆盖译文时最容易出问题的地方。

用法: python scripts/make_test_pdf.py [输出路径]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

TITLE = "Structure and Function of a Synaptic Release Machine"
AUTHORS = "A. Author, B. Author, and C. Author  |  Neuron 80, 1-18 (2013)"

ABSTRACT = (
    "Synaptic transmission requires the precise coupling of calcium entry to vesicle fusion. "
    "Here we review the architecture of the presynaptic release machinery, the energetics of "
    "membrane fusion, and the molecular choreography that underlies transmitter release on the "
    "sub-millisecond timescale."
)

SECTIONS = [
    ("1. Introduction", [
        "During an action potential, calcium entering a presynaptic terminal triggers synaptic vesicle "
        "fusion with remarkable speed and reliability. The release machinery must be assembled long "
        "before the calcium signal arrives, and it must remain poised for action without firing "
        "spontaneously. Understanding how this is achieved has been a central question in cellular "
        "neuroscience for several decades.",
        "The core of the machinery is a set of proteins that mediate membrane fusion: the SNARE "
        "proteins, the SM protein Munc18-1, and the calcium sensor synaptotagmin. Together these "
        "components form a minimal catalytic unit that can be reconstituted in vitro, which has "
        "allowed the field to dissect their individual contributions.",
    ]),
    ("2. Organization of the release site", [
        "The active zone is a specialized region of the presynaptic plasma membrane where vesicles "
        "dock and fuse. Its structure is organized by scaffold proteins, and its size correlates with "
        "the number of release sites. Electron tomography has revealed that vesicles are tethered at "
        "defined distances from the membrane.",
        "Functional imaging further shows that calcium channels are concentrated near release sites, "
        "forming nanodomains in which the local calcium concentration can exceed that of the bulk "
        "cytosol by more than an order of magnitude.",
    ]),
    ("3. Energetics of fusion", [
        "Membrane fusion is energetically unfavorable and requires the SNARE complex to provide the "
        "driving force. SNARE assembly proceeds through a zippering mechanism that pulls the two "
        "membranes together. The energy released is estimated to be sufficient to overcome the "
        "hydration repulsion between lipid bilayers, but the exact efficiency in vivo is debated.",
    ]),
    ("4. Conclusion", [
        "The field has converged on a model in which assembly of the machinery, localization of "
        "calcium channels, and the biophysical properties of the calcium sensor jointly determine the "
        "speed and fidelity of release. Remaining questions concern the dynamics of assembly in "
        "living terminals and the role of modulatory proteins.",
    ]),
]


def build(out_path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)  # A4

    cjk_ok = None
    for cand in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simsun.ttc"):
        if Path(cand).exists():
            cjk_ok = cand
            break

    # 页眉
    page.insert_text((56, 40), "Neuron 80, 1-18, October 2013", fontsize=7.5, fontname="helv")
    page.insert_text((470, 40), "Review", fontsize=7.5, fontname="helv")

    # 标题区
    y = 90
    page.insert_textbox(
        pymupdf.Rect(56, y, 539, y + 60), TITLE, fontsize=17, fontname="hebo", align=0
    )
    y += 52
    page.insert_text((56, y), AUTHORS, fontsize=8.5, fontname="helv", color=(0.25, 0.25, 0.25))
    y += 20

    # 摘要
    page.draw_rect(pymupdf.Rect(56, y, 539, y + 74), color=(0.6, 0.6, 0.6), width=0.6)
    page.insert_text((64, y + 14), "SUMMARY", fontsize=8, fontname="hebo")
    page.insert_textbox(pymupdf.Rect(64, y + 20, 531, y + 70), ABSTRACT, fontsize=8.8, fontname="helv")
    y += 88

    # 正文与插图：图放右侧，左侧留一段正文，模拟真实双栏混排
    fig_rect = pymupdf.Rect(360, y, 539, y + 150)
    page.draw_rect(fig_rect, color=(0.4, 0.4, 0.4), width=0.8)
    page.draw_circle(pymupdf.Point(410, y + 60), 22, color=(0.2, 0.3, 0.6), fill=(0.85, 0.9, 1))
    page.draw_circle(pymupdf.Point(470, y + 90), 16, color=(0.6, 0.2, 0.2), fill=(1, 0.9, 0.85))
    page.insert_text((372, y + 20), "Presynaptic terminal", fontsize=7.5, fontname="helv")
    page.insert_text((392, y + 132), "Ca2+", fontsize=8, fontname="helv")

    left = pymupdf.Rect(56, y, 344, y + 150)
    page.insert_textbox(left, SECTIONS[0][1][0], fontsize=9, fontname="helv")
    y += 162
    page.insert_text((360, y - 8), "Figure 1. Architecture of the release site.", fontsize=7.5,
                     fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(360, y - 2, 539, y + 24),
        "Schematic of a presynaptic terminal showing vesicles, calcium channels and the active zone.",
        fontsize=7.2, fontname="helv",
    )
    y += 28

    # 其余正文
    for heading, paras in SECTIONS:
        if y > 720:
            page = doc.new_page(width=595, height=842)
            y = 70
            page.insert_text((56, 40), "Neuron 80, 1-18, October 2013", fontsize=7.5, fontname="helv")
        page.insert_text((56, y), heading, fontsize=10.5, fontname="hebo")
        y += 15
        for para in paras:
            box = pymupdf.Rect(56, y, 539, y + 200)
            used = page.insert_textbox(box, para, fontsize=9, fontname="helv", align=0,
                                       lineheight=1.35)
            y += max(30, 200 - used) if used > 0 else 60
            y += 10
        y += 6

    # 页脚
    for pno, page in enumerate(doc):
        page.insert_text((290, 815), str(pno + 1), fontsize=8, fontname="helv")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    doc.close()
    if cjk_ok:
        pass
    print(f"已生成 {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/test_paper.pdf")
    build(target)
