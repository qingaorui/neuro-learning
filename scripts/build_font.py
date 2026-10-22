"""构建在线版使用的简体中文子集字体（OFL 授权，可随站点分发）。

为什么需要这一步：
- 浏览器读不到系统字体，写 PDF 文字层必须自带一份字库；
- 系统里的微软雅黑等字体授权不允许随仓库分发；
- Noto Sans SC 是 OFL，可以自由分发，但完整可变字体有 17 MB。

所以：取可变字体 → 固定字重 400 → 裁到「ASCII + GB2312 全区间 + 常用符号」。

踩过的两个坑（改了会出问题）：
1. `--layout-features=` 必须是**空**。保留 GSUB 时，排版会把数字替换成字形变体，
   pdf-lib 反向查表失败，写进 PDF 的编码会错乱（数字变成别的字符）。
2. 字符集必须包含 GB2312 的 **A1–A9 符号区**，只取 B0–F7 汉字区会导致
   中文标点（，。、；：）在导出的 PDF 里整片消失。

用法:
    python scripts/build_font.py
输出:
    docs/vendor/NotoSansSC.ttf
"""

from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_VAR = ROOT / "data" / "fonts" / "NotoSansSC-var.ttf"
STATIC = ROOT / "data" / "fonts" / "_static.ttf"
OUT = ROOT / "docs" / "vendor" / "NotoSansSC.ttf"

URL_VF = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf"
URL_OFL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt"


def ensure_source() -> None:
    import urllib.request

    SRC_VAR.parent.mkdir(parents=True, exist_ok=True)
    for url, path in ((URL_VF, SRC_VAR), (URL_OFL, SRC_VAR.parent / "OFL.txt")):
        if path.exists():
            continue
        print(f"下载 {path.name} …")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            path.write_bytes(resp.read())
        print(f"  {path.stat().st_size / 1024 / 1024:.1f} MB")


def instance_weight(src: pathlib.Path, dst: pathlib.Path, weight: int = 400) -> None:
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    print("固定字重…")
    font = TTFont(str(src))
    inst = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    inst.save(str(dst))


def charset() -> str:
    chars = {chr(c) for c in range(0x20, 0x7F)}
    # A1–A9 符号区 + B0–F7 汉字区
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except Exception:
                pass
    chars |= set(
        "　！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠"
        "［＼］＾＿｀｛｜｝～“”‘’—…·×÷±≤≥≠≈∞→←↑↓√∑∏∫∂°′″‰№℃"
        "αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ〇"
    )
    return "".join(sorted(c for c in chars if c))


def subset(src: pathlib.Path, dst: pathlib.Path, text: str) -> None:
    from fontTools import subset as ft_subset

    print("裁剪字符集…")
    ft_subset.main(
        [
            str(src),
            f"--text={text}",
            f"--output-file={dst}",
            "--layout-features=",       # 必须为空，见文件头说明
            "--no-hinting",
            "--desubroutinize",
        ]
    )


def main() -> int:
    ensure_source()
    if not STATIC.exists():
        instance_weight(SRC_VAR, STATIC)

    text = charset()
    print(f"字符集 {len(text)} 个")
    subset(STATIC, OUT, text)

    size = OUT.stat().st_size / 1024 / 1024
    print(f"输出 {OUT.relative_to(ROOT)}  {size:.2f} MB")

    from fontTools.ttLib import TTFont

    font = TTFont(str(OUT), lazy=True)
    cmap = font.getBestCmap()
    missing = [ch for ch in "，。、；“”《》—…·±≤→α" if ord(ch) not in cmap]
    font.close()
    if missing:
        print(f"❌ 缺少常用标点: {missing}", file=sys.stderr)
        return 1
    print("✓ 标点与符号校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
