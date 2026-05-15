"""Каталог подарков. Цена в монетах = stars × 15 000."""
from __future__ import annotations

STAR_TO_COIN = 15_000

# Реальные ТГ-подарки. id — стабильный slug, не меняется
GIFTS_CATALOG: list[dict] = [
    {"id": "bear",     "emoji": "🧸", "name": "Плюшевый мишка", "stars": 15},
    {"id": "heart",    "emoji": "💝", "name": "Сердечко",       "stars": 15},
    {"id": "rose",     "emoji": "🌹", "name": "Роза",           "stars": 25},
    {"id": "cake",     "emoji": "🎂", "name": "Торт",           "stars": 50},
    {"id": "rocket",   "emoji": "🚀", "name": "Ракета",         "stars": 50},
    {"id": "trophy",   "emoji": "🏆", "name": "Кубок",          "stars": 100},
    {"id": "ring",     "emoji": "💍", "name": "Кольцо",         "stars": 100},
    {"id": "diamond",  "emoji": "💎", "name": "Бриллиант",      "stars": 100},
]


def gift_by_id(gift_id: str) -> dict | None:
    for g in GIFTS_CATALOG:
        if g["id"] == gift_id:
            return g
    return None


def public_catalog() -> list[dict]:
    """Каталог для отдачи во фронт: добавляем посчитанную цену в монетах."""
    return [
        {**g, "coins": g["stars"] * STAR_TO_COIN}
        for g in GIFTS_CATALOG
    ]
