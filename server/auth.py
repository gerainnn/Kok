"""Проверка Telegram WebApp initData по подписи бота.
https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

Поддержка форк-клиентов:
  Некоторые форки (AyuGram, Nagram, ...) не передают валидную подпись initData
  (или вовсе не передают initData). Если на сервере включена переменная
  окружения ALLOW_UNSIGNED_INITDATA=1, то сервер ПРИ ОТСУТСТВИИ/НЕВАЛИДНОЙ
  подписи попробует взять user-данные из заголовка X-TG-User (JSON), который
  фронт собирает из initDataUnsafe. Это понижает безопасность (теоретически
  можно подделать user_id, зная публичный URL казино), поэтому по умолчанию
  выключено.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Optional
from urllib.parse import parse_qsl, unquote

log = logging.getLogger("gamebuddy.auth")


def parse_init_data(init_data: str, bot_token: str, max_age_sec: int = 0) -> Optional[dict]:
    """Возвращает dict с user/auth_date/etc если подпись валидна, иначе None.

    max_age_sec=0 (по умолчанию) означает "не проверять время". Telegram WebApp
    передаёт актуальный initData при каждом открытии; срок жизни контролируется
    самим клиентом.

    Поддерживает оба формата Telegram:
      - Классический (hash-based): ключи отсортированы, HMAC-SHA256
      - Новый (signature-based, Telegram v7.x+): если есть поле signature
    """
    if not init_data:
        log.debug("parse_init_data: empty init_data")
        return None

    # Некоторые клиенты отправляют initData дополнительно URL-encoded
    # Если видим %xx — декодируем один раз
    if "%25" in init_data or "%3D" in init_data or "%26" in init_data:
        init_data = unquote(init_data)

    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception as e:
        log.warning("parse_init_data: parse_qsl failed: %s (init_data_len=%d)", e, len(init_data))
        return None

    if not pairs:
        log.warning(
            "parse_init_data: parse_qsl returned empty dict. init_data_len=%d first_50=%r",
            len(init_data), init_data[:50],
        )
        return None

    log.debug(
        "parse_init_data: parsed keys=%s init_data_len=%d",
        sorted(pairs.keys()), len(init_data),
    )

    received_hash = pairs.pop("hash", None)
    # Также убираем signature если есть (новый формат TG) — он не участвует в проверке hash
    pairs.pop("signature", None)

    if not received_hash:
        log.warning(
            "parse_init_data: no 'hash' field in init_data (keys=%s, init_data_len=%d, first_80=%r)",
            list(pairs.keys()), len(init_data), init_data[:80],
        )
        return None

    # data_check_string = key=value\n... отсортировано по ключу
    data_check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs.keys()))

    # HMAC: secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, received_hash):
        # Подробный лог для дебага
        log.warning(
            "parse_init_data: SIGNATURE MISMATCH. "
            "keys=%s auth_date=%s hash_len=%d "
            "expected_prefix=%s received_prefix=%s "
            "data_check_len=%d bot_token_len=%d",
            sorted(pairs.keys()),
            pairs.get("auth_date", "?"),
            len(received_hash),
            expected[:12] + "...",
            received_hash[:12] + "...",
            len(data_check),
            len(bot_token),
        )
        # Дополнительно логируем первые 100 символов data_check для отладки
        log.debug(
            "parse_init_data: data_check_first_100=%r",
            data_check[:100],
        )
        return None

    auth_date = int(pairs.get("auth_date", "0") or 0)
    if max_age_sec and auth_date:
        age = time.time() - auth_date
        if age > max_age_sec:
            log.warning(
                "parse_init_data: EXPIRED. auth_date=%d age=%.0fs max=%ds",
                auth_date, age, max_age_sec,
            )
            return None
        if age < -300:
            # Часы на сервере отстают от клиента больше чем на 5 мин — подозрительно,
            # но пропускаем (доверяем подписи).
            log.info(
                "parse_init_data: clock skew detected. auth_date=%d server_time=%.0f diff=%.0fs",
                auth_date, time.time(), age,
            )

    user = None
    if "user" in pairs:
        try:
            user = json.loads(pairs["user"])
        except Exception as e:
            log.warning("parse_init_data: failed to parse 'user' JSON: %s", e)
            user = None

    if user:
        log.info(
            "parse_init_data: OK user_id=%s username=%s",
            user.get("id"), user.get("username"),
        )
    else:
        log.warning("parse_init_data: signature OK but no 'user' field in init_data")

    return {**pairs, "user": user}


def parse_unsigned_user(raw_user_json: str) -> Optional[dict]:
    """Парсит user dict из заголовка X-TG-User (для форк-клиентов).

    Возвращает только если есть валидный числовой id. Это НЕ подтверждает
    подлинность — использовать только при ALLOW_UNSIGNED_INITDATA=1.
    """
    if not raw_user_json:
        return None
    try:
        u = json.loads(raw_user_json)
    except Exception:
        return None
    if not isinstance(u, dict):
        return None
    try:
        uid = int(u.get("id"))
    except (TypeError, ValueError):
        return None
    if uid <= 0:
        return None
    return {
        "id": uid,
        "username":   (u.get("username") or None),
        "first_name": (u.get("first_name") or None),
        "last_name":  (u.get("last_name") or None),
        "photo_url":  (u.get("photo_url") or None),
    }
