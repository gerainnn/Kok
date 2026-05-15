"""Проверка Telegram WebApp initData по подписи бота.
https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Optional
from urllib.parse import parse_qsl


def parse_init_data(init_data: str, bot_token: str, max_age_sec: int = 86400) -> Optional[dict]:
    """Возвращает dict с user/auth_date/etc если подпись валидна, иначе None."""
    if not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception:
        return None

    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    # data_check_string = key=value\n... отсортировано по ключу
    data_check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs.keys()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        return None

    auth_date = int(pairs.get("auth_date", "0") or 0)
    if max_age_sec and auth_date and (time.time() - auth_date) > max_age_sec:
        return None

    user = None
    if "user" in pairs:
        try:
            user = json.loads(pairs["user"])
        except Exception:
            user = None

    return {**pairs, "user": user}
