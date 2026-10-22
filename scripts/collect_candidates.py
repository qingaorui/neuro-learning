"""按课程模块 + 核心概念从 PubMed 拉候选综述。

与上一版相比的关键改动：概念词限定在 [ti]（标题）字段。
标题就叫「The action potential」的综述，几乎一定是概念级、适合入门的；
而 [tiab] 检索会把「ion channel」在心脏电生理里的用法一起捞进来。

用法: python scripts/collect_candidates.py
输出: data/candidates.json, data/candidates.md, data/shortlist.txt
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools.pubmed import esearch, esummary  # noqa: E402

WHITELIST = (
    '"Nat Rev Neurosci"[ta] OR "Trends Neurosci"[ta] OR "Neuron"[ta] '
    'OR "Annu Rev Neurosci"[ta] OR "Physiol Rev"[ta] OR "Nat Neurosci"[ta] '
    'OR "Nat Rev Neurol"[ta] OR "Brain"[ta] OR "Neuroscientist"[ta] '
    'OR "Curr Biol"[ta] OR "Nat Hum Behav"[ta] OR "J Neurosci"[ta]'
)

MODULES: list[dict] = [
    {
        "id": "M01",
        "name": "神经元与电信号",
        "en": "Neurons and electrical signalling",
        "concepts": [
            "action potential", "membrane potential", "ion channel", "voltage-gated",
            "dendritic computation", "neuronal excitability", "axon initial segment",
            "patch clamp", "neuron doctrine", "electrical synapse",
        ],
    },
    {
        "id": "M02",
        "name": "突触传递",
        "en": "Synaptic transmission",
        "concepts": [
            "synaptic transmission", "synaptic vesicle", "neurotransmitter release",
            "glutamate receptor", "GABA receptor", "synaptic plasticity",
            "long-term depression", "inhibitory synapse", "neuromuscular junction",
            "dendritic spine",
        ],
    },
    {
        "id": "M03",
        "name": "神经发育与解剖",
        "en": "Development and organization",
        "concepts": [
            "neural development", "axon guidance", "synapse formation",
            "cortical development", "neural stem cell", "adult neurogenesis",
            "brain evolution", "neural crest", "cortical column",
        ],
    },
    {
        "id": "M04",
        "name": "感觉系统",
        "en": "Sensory systems",
        "concepts": [
            "visual cortex", "retina", "somatosensory", "olfaction", "auditory",
            "sensory coding", "predictive coding", "pain perception", "perception",
        ],
    },
    {
        "id": "M05",
        "name": "运动系统",
        "en": "Motor systems",
        "concepts": [
            "motor cortex", "basal ganglia", "cerebellum", "motor learning",
            "locomotion", "sensorimotor", "striatum", "action selection",
        ],
    },
    {
        "id": "M06",
        "name": "学习与记忆",
        "en": "Learning and memory",
        "concepts": [
            "long-term potentiation", "memory consolidation", "engram", "hippocampus",
            "spatial memory", "working memory", "fear memory", "place cell",
            "grid cell", "memory reconsolidation",
        ],
    },
    {
        "id": "M07",
        "name": "情绪与应激",
        "en": "Emotion and stress",
        "concepts": [
            "amygdala", "emotion", "fear", "stress", "HPA axis", "anxiety",
            "interoception", "emotion regulation",
        ],
    },
    {
        "id": "M08",
        "name": "睡眠与昼夜节律",
        "en": "Sleep and circadian rhythms",
        "concepts": [
            "sleep", "circadian", "suprachiasmatic", "slow-wave sleep",
            "REM sleep", "sleep spindle", "chronobiology",
        ],
    },
    {
        "id": "M09",
        "name": "神经调质与奖赏",
        "en": "Neuromodulation and reward",
        "concepts": [
            "dopamine", "reward", "serotonin", "noradrenaline", "acetylcholine",
            "addiction", "reinforcement learning", "neuromodulation",
        ],
    },
    {
        "id": "M10",
        "name": "胶质、血管与神经免疫",
        "en": "Glia, vasculature and neuroimmunology",
        "concepts": [
            "astrocyte", "microglia", "oligodendrocyte", "myelin",
            "neuroinflammation", "blood-brain barrier", "glymphatic", "neuroimmune",
        ],
    },
    {
        "id": "M11",
        "name": "神经疾病",
        "en": "Neurological and psychiatric disorders",
        "concepts": [
            "Alzheimer", "Parkinson", "epilepsy", "depression", "schizophrenia",
            "autism", "multiple sclerosis", "stroke", "amyotrophic lateral sclerosis",
        ],
    },
    {
        "id": "M12",
        "name": "方法与前沿",
        "en": "Methods and frontiers",
        "concepts": [
            "optogenetics", "connectome", "functional MRI", "computational neuroscience",
            "brain-computer interface", "organoid", "calcium imaging",
            "deep learning", "single-cell", "neural manifold",
        ],
    },
]

# 注意：PubMed 不接受 `"短语"[ti]` 这种带引号的字段组合（返回 0 条），
# 所以下面用不带引号的词项，再用 expect 校验标题。
CLASSICS: list[dict] = [
    {
        "query": "quantitative description of membrane current[ti] AND 1952[dp]",
        "expect": "quantitative description of membrane current",
        "note": "Hodgkin & Huxley 1952。动作电位的数学模型，全书最硬的一篇，可以放到最后当硬骨头。",
    },
    {
        "query": "receptive fields of single neurones[ti] AND 1959[dp]",
        "expect": "receptive fields of single neurones",
        "note": "Hubel & Wiesel 1959。猫视觉皮层单个神经元的感受野，读起来意外地顺。",
    },
    {
        "query": "long-lasting potentiation of synaptic transmission in the dentate[ti]",
        "expect": "long-lasting potentiation",
        "note": "Bliss & Lømo 1973。LTP 的首次报道。建议先读 M06 里那篇 LTP 历史综述。",
    },
    {
        "query": "hippocampus as a spatial map[ti]",
        "expect": "spatial map",
        "note": "O'Keefe & Dostrovsky 1971。位置细胞，认知地图的起点。",
    },
    {
        "query": "loss of recent memory after bilateral hippocampal lesions[ti]",
        "expect": "loss of recent memory",
        "note": "Scoville & Milner 1957。H.M. 病例：记忆与海马的双分离。",
    },
    {
        "query": "positive reinforcement produced by electrical stimulation of septal[ti]",
        "expect": "positive reinforcement",
        "note": "Olds & Milner 1954。颅内自我刺激，奖赏回路的起点。",
    },
    {
        "query": "neural substrate of prediction and reward[ti]",
        "expect": "neural substrate of prediction and reward",
        "note": "Schultz, Dayan & Montague 1997。多巴胺与奖励预测误差。",
    },
    {
        "query": "genetically targeted optical control of neural activity[ti]",
        "expect": "genetically targeted optical control",
        "note": "Boyden et al. 2005。光遗传学奠基之作。",
    },
    {
        "query": "brain stem reticular formation and activation[ti]",
        "expect": "reticular formation",
        "note": "Moruzzi & Magoun 1949。网状激活系统与觉醒。",
    },
]

PRIOR = {
    "Nat Rev Neurosci": 0,
    "Trends Neurosci": 1,
    "Annu Rev Neurosci": 2,
    "Neuron": 3,
    "Nat Neurosci": 4,
    "Physiol Rev": 5,
    "Neuroscientist": 6,
    "Curr Biol": 7,
    "Brain": 8,
    "Nat Rev Neurol": 9,
    "J Neurosci": 10,
    "Nat Hum Behav": 11,
}


def collect() -> dict:
    pool: dict[str, dict] = {}
    by_module: dict[str, list[str]] = {}

    for mod in MODULES:
        ids: list[str] = []
        for concept in mod["concepts"]:
            term = f"{concept}[ti] AND review[pt] AND 2008:2026[dp]"
            for pmid in esearch(term, retmax=12):
                if pmid not in ids:
                    ids.append(pmid)
        # 白名单期刊内的模块级检索，兜住标题写法奇特的好综述
        join = " OR ".join(f"{c}[ti]" for c in mod["concepts"])
        term_white = f"({join}) AND review[pt] AND ({WHITELIST}) AND 2005:2026[dp]"
        for pmid in esearch(term_white, retmax=60):
            if pmid not in ids:
                ids.append(pmid)

        by_module[mod["id"]] = ids
        print(f"{mod['id']} {mod['name']}: {len(ids)} 篇候选")

    all_ids = sorted({i for ids in by_module.values() for i in ids})
    print(f"\n唯一候选 {len(all_ids)} 条，取题录…")
    info = esummary(all_ids)
    print(f"取回 {len(info)} 条")

    for mod in MODULES:
        for pmid in by_module.get(mod["id"], []):
            rec = info.get(pmid)
            if not rec:
                continue
            if pmid not in pool:
                pool[pmid] = {**rec, "modules": []}
            if mod["id"] not in pool[pmid]["modules"]:
                pool[pmid]["modules"].append(mod["id"])

    classics: list[dict] = []
    print("\n定位历史原典…")
    for spec in CLASSICS:
        hits = esearch(spec["query"], retmax=5, sort="relevance")
        recs = esummary(hits)
        picked = None
        for pmid in hits:
            rec = recs.get(pmid)
            if rec and spec["expect"].lower() in rec["title"].lower():
                picked = rec
                break
        if not picked:
            print(f"  ✗ 未命中: {spec['expect']}")
            continue
        classics.append({**picked, "note": spec["note"]})
        pool.setdefault(picked["pmid"], {**picked, "modules": []})
        print(f"  ✓ {picked['year']} {picked['journal'][:24]:24s} {picked['title'][:60]} [{picked['pmid']}]")

    out = {
        "modules": [
            {"id": m["id"], "name": m["name"], "en": m["en"], "concepts": m["concepts"],
             "candidates": by_module.get(m["id"], [])}
            for m in MODULES
        ],
        "classics": classics,
        "papers": pool,
    }

    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    (data_dir / "candidates.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 人工筛选用的紧凑清单
    lines: list[str] = []
    for mod in MODULES:
        recs = [(p, pool[p]) for p in by_module.get(mod["id"], []) if p in pool]
        recs.sort(key=lambda kv: (PRIOR.get(kv[1]["journal"], 90), -kv[1]["year"]))
        lines.append(f"### {mod['id']} {mod['name']}  (n={len(recs)})")
        for pmid, rec in recs[:26]:
            lines.append(f"{pmid} | {rec['year']} | {rec['journal'][:22]:22s} | {rec['title'][:100]}")
        lines.append("")
    (data_dir / "shortlist.txt").write_text("\n".join(lines), encoding="utf-8")

    print("\n完成 → data/candidates.json, data/shortlist.txt")
    return out


if __name__ == "__main__":
    collect()
