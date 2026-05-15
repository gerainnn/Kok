"""AI-догенерация вопросов для викторины через Pollinations (бесплатно, без ключа).

Когда штатный пул кончается у юзера — фоновая задача дозаполняет quiz_ai_pool
свежими вопросами. На случай, если AI отдаст невалидный JSON, парсер пропускает.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import urllib.parse

import aiohttp

from . import db

log = logging.getLogger("gamebuddy.quiz_ai")

POLLINATIONS_URL = "https://text.pollinations.ai/{prompt}"

CAT_DESCR = {
    "geo":   "география (страны, столицы, реки, горы, континенты)",
    "sci":   "наука (физика, химия, биология, астрономия)",
    "his":   "история (мировая, российская, древние цивилизации)",
    "art":   "искусство и литература (картины, книги, музыка, авторы)",
    "it":    "IT и технологии (программирование, интернет, гаджеты)",
    "sport": "спорт (футбол, олимпиада, известные атлеты)",
    "pop":   "поп-культура (фильмы, сериалы, актёры, игры)",
    "lang":  "язык, слова, фразеологизмы, грамматика",
    "nature": "природа, животные, растения",
    "food":  "еда, кулинария, кухни мира",
}


PROMPT_TEMPLATE = """Сгенерируй ровно 5 уникальных вопросов для викторины.
Тематика: {topic}
Каждый вопрос должен иметь 4 варианта ответа, ровно 1 правильный.
Формат ответа — строго валидный JSON-массив, без пояснений, без markdown.
Структура каждого элемента:
{{"q": "вопрос?", "options": ["A","B","C","D"], "answer": 0}}
где answer — индекс правильного ответа (0..3).
Вопросы по-русски. Не повторяй банальные/уже всем известные факты, придумай интересные.
"""


def _question_hash(text: str) -> str:
    return "ai_" + hashlib.sha1(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def _extract_json_array(text: str) -> list[dict] | None:
    """Pollinations иногда оборачивает JSON в текст / markdown-блок. Достанем массив."""
    if not text:
        return None
    # быстрый путь
    try:
        return json.loads(text)
    except Exception:
        pass
    # ищем первый [...] с балансом скобок
    m = re.search(r"\[\s*\{.*\}\s*\]", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _validate(item: dict) -> bool:
    if not isinstance(item, dict):
        return False
    q = item.get("q")
    options = item.get("options")
    answer = item.get("answer")
    if not isinstance(q, str) or len(q) < 4 or len(q) > 240:
        return False
    if not isinstance(options, list) or len(options) != 4:
        return False
    if not all(isinstance(o, str) and 1 <= len(o) <= 120 for o in options):
        return False
    if not isinstance(answer, int) or not (0 <= answer <= 3):
        return False
    return True


async def generate_for_category(category: str, seed: int | None = None) -> int:
    """Дёргает Pollinations, парсит, кладёт валидные в БД. Возвращает кол-во сохранённых."""
    topic = CAT_DESCR.get(category, "общие знания")
    prompt = PROMPT_TEMPLATE.format(topic=topic)
    encoded = urllib.parse.quote(prompt, safe="")
    url = POLLINATIONS_URL.format(prompt=encoded)
    params = {"model": "openai", "seed": str(seed or 0)}

    timeout = aiohttp.ClientTimeout(total=40)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.get(url, params=params) as r:
                if r.status != 200:
                    log.warning("AI quiz: pollinations status %s", r.status)
                    return 0
                text = await r.text()
    except (asyncio.TimeoutError, aiohttp.ClientError) as e:
        log.warning("AI quiz: network error %s", e)
        return 0
    except Exception as e:
        log.exception("AI quiz: unexpected error: %s", e)
        return 0

    arr = _extract_json_array(text)
    if not arr:
        log.info("AI quiz: failed to parse JSON, raw=%s", text[:200])
        return 0

    saved = 0
    for item in arr:
        if not _validate(item):
            continue
        qid = _question_hash(item["q"])
        try:
            await db.quiz_ai_save(qid, category, {
                "q": item["q"],
                "options": item["options"],
                "answer": int(item["answer"]),
            })
            saved += 1
        except Exception as e:
            log.warning("AI quiz: save failed: %s", e)
    log.info("AI quiz: saved %s new questions for %s", saved, category)
    return saved


async def background_replenish(category: str = "any", seed: int | None = None) -> None:
    """Фоновая задача — пытается несколько категорий, чтобы пополнить кэш."""
    cats = [category] if category and category != "any" else list(CAT_DESCR.keys())
    for c in cats:
        try:
            await generate_for_category(c, seed=seed)
        except Exception as e:
            log.exception("AI quiz background error: %s", e)
