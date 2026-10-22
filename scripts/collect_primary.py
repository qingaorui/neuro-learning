"""按模块采集「原始研究论文」候选：被引排序 + 近年被引排序。

输出 data/primary_candidates.txt 供人工筛选。
用法: python scripts/collect_primary.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools.europepmc import search  # noqa: E402

# 每个模块给 2-3 组标题检索词，全部限定：PubMed 收录、非综述、有摘要
MODULE_QUERIES: dict[str, list[str]] = {
    "M01": ['TITLE:"dendritic"', 'TITLE:"action potential"', 'TITLE:"axon initial segment"'],
    "M02": ['TITLE:"synaptic plasticity"', 'TITLE:"AMPA receptor"', 'TITLE:"synaptic vesicle"'],
    "M03": ['TITLE:"adult neurogenesis"', 'TITLE:"axon guidance"', 'TITLE:"cortical development"'],
    "M04": ['TITLE:"olfactory receptor"', 'TITLE:"visual cortex"', 'TITLE:"orientation selectivity"'],
    "M05": ['TITLE:"basal ganglia"', 'TITLE:"motor cortex"', 'TITLE:"cerebellar"'],
    "M06": ['TITLE:"engram"', 'TITLE:"long-term potentiation"', 'TITLE:"place cell"',
            'TITLE:"reconsolidation"'],
    "M07": ['TITLE:"amygdala"', 'TITLE:"fear conditioning"', 'TITLE:"glucocorticoid"'],
    "M08": ['TITLE:"orexin"', 'TITLE:"sleep" AND TITLE:"memory"', 'TITLE:"circadian" AND TITLE:"clock"'],
    "M09": ['TITLE:"dopamine"', 'TITLE:"reward prediction error"', 'TITLE:"ventral tegmental area"'],
    "M10": ['TITLE:"microglia"', 'TITLE:"astrocyte"', 'TITLE:"myelin"'],
    "M11": ['TITLE:"amyloid"', 'TITLE:"alpha-synuclein"', 'TITLE:"Alzheimer"'],
    "M12": ['TITLE:"channelrhodopsin"', 'TITLE:"GCaMP" OR TITLE:"calcium indicator"',
            'TITLE:"connectome"', 'TITLE:"CLARITY" OR TITLE:"tissue clearing"'],
    "M13": ['TITLE:"working memory"', 'TITLE:"consciousness"', 'TITLE:"predictive coding"'],
}

SUFFIX = ' AND SRC:MED AND NOT PUB_TYPE:"review" AND HAS_ABSTRACT:Y'
RECENT = " AND (PUB_YEAR:[2018 TO 2025])"


def main() -> None:
    lines: list[str] = []
    collected: dict[str, dict] = {}

    for module, queries in MODULE_QUERIES.items():
        lines.append(f"\n{'='*100}\n## {module}\n{'='*100}")
        for q in queries:
            for tag, extra, size in (("经典", "", 8), ("近年", RECENT, 6)):
                try:
                    recs = search(f"({q}){SUFFIX}{extra}", size=size)
                except RuntimeError as exc:
                    lines.append(f"[ERR] {q} {extra}: {exc}")
                    continue
                if not recs:
                    continue
                lines.append(f"\n-- {q}  [{tag}]")
                for r in recs:
                    collected.setdefault(r["pmid"], r)
                    lines.append(
                        f"{r['pmid']} | {r['cites']:>5} | {r['year']} | "
                        f"{r['journal'][:22]:22s} | {r['title'][:92]}"
                    )

    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    (data_dir / "primary_candidates.txt").write_text("\n".join(lines), encoding="utf-8")

    existing = data_dir / "primary_lookup.json"
    prior = json.loads(existing.read_text(encoding="utf-8")) if existing.exists() else {}
    prior.update(collected)
    existing.write_text(json.dumps(prior, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"候选 {len(collected)} 篇，累计 {len(prior)} 篇 → data/primary_candidates.txt")


if __name__ == "__main__":
    main()
