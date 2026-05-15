"""Простой AI-собеседник через бесплатный Pollinations API (без ключа)."""
from __future__ import annotations

import asyncio
import urllib.parse
from typing import Optional

import aiohttp

POLLINATIONS_URL = "https://text.pollinations.ai/{prompt}"
SYSTEM_PROMPT = (
    "Ты дружелюбный собеседник в Telegram-боте GameBuddy. Отвечай по-русски, "
    "коротко (3-6 предложений), с лёгким юмором и эмодзи. Не упоминай, что ты AI. "
    "Не пиши код. Если просят сыграть — предложи /games."
)


async def ask_ai(user_message: str, history: list[dict] | None = None) -> Optional[str]:
    """Делает запрос к Pollinations через GET. history — список {role, content}."""
    history = history or []
    convo_lines = [f"[Система]: {SYSTEM_PROMPT}"]
    for h in history[-6:]:
        role = "Пользователь" if h["role"] == "user" else "Бот"
        convo_lines.append(f"[{role}]: {h['content']}")
    convo_lines.append(f"[Пользователь]: {user_message}")
    convo_lines.append("[Бот]:")
    prompt = "\n".join(convo_lines)

    encoded = urllib.parse.quote(prompt, safe="")
    url = POLLINATIONS_URL.format(prompt=encoded)
    params = {"model": "openai", "seed": "42"}

    timeout = aiohttp.ClientTimeout(total=25)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, params=params) as resp:
                if resp.status != 200:
                    return None
                text = (await resp.text()).strip()
                # отрезаем потенциальные роле-метки
                for tag in ("[Бот]:", "Бот:", "[Пользователь]:"):
                    if text.startswith(tag):
                        text = text[len(tag):].strip()
                return text[:2000] or None
    except (asyncio.TimeoutError, aiohttp.ClientError, Exception):
        return None
