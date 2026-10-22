"""配置读写。纯标准库，配置落在 app/config.json。"""

from __future__ import annotations

import datetime as dt
import json
import threading
from pathlib import Path
from typing import Any

APP_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = APP_DIR / "config.json"

_lock = threading.RLock()

DEFAULTS: dict[str, Any] = {
    "llm": {
        # 任何 OpenAI 兼容接口都能用；默认 DeepSeek
        "base_url": "https://api.deepseek.com",
        "api_key": "",
        "model": "deepseek-chat",
        "temperature": 0.2,
        "timeout": 180,
        # 没有 key 时打开它，可跑通整条流水线（译文处显示占位）
        "mock": False,
    },
    "schedule": {
        "start_date": "",       # 首次启动时自动填今天
        "push_time": "08:30",   # 每日推送时间，供定时任务使用
        "total_days": None,     # 由语料库决定，不手填
    },
    "server": {"port": 8765, "host": "127.0.0.1"},
    "translation": {
        "blocks_per_request": 14,   # 每次送给模型的文本块数
        "max_parallel": 3,          # 并发请求数
        "min_font_size": 6.5,       # 译文自动缩字到此为止
        "target_font_ratio": 0.92,  # 相对原文字号的初始比例
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load() -> dict:
    with _lock:
        raw: dict = {}
        if CONFIG_PATH.exists():
            try:
                raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raw = {}
        cfg = _deep_merge(DEFAULTS, raw)

        if not cfg["schedule"]["start_date"]:
            cfg["schedule"]["start_date"] = dt.date.today().isoformat()
            save(cfg)
        return cfg


def save(cfg: dict) -> None:
    with _lock:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def update(patch: dict) -> dict:
    """局部更新并落盘（用于设置页）。"""
    cfg = load()
    cfg = _deep_merge(cfg, patch)
    save(cfg)
    return cfg


def public_view(cfg: dict | None = None) -> dict:
    """给前端的配置视图：绝不外传 api_key 原文。"""
    cfg = cfg or load()
    llm = cfg["llm"]
    key = llm.get("api_key", "")
    masked = (key[:4] + "…" + key[-4:]) if len(key) > 8 else ("已设置" if key else "")
    return {
        "llm": {
            "base_url": llm["base_url"],
            "model": llm["model"],
            "has_key": bool(key),
            "key_hint": masked,
            "mock": bool(llm.get("mock")),
        },
        "schedule": cfg["schedule"],
        "server": cfg["server"],
    }
