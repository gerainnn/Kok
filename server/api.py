"""HTTP API для Web App. Все запросы аутентифицируются через Telegram initData
(заголовок X-Init-Data или query/body параметр init_data).

GET  /api/me                — профиль + баланс
POST /api/daily             — забрать ежедневный бонус
POST /api/bet               — записать результат раунда казино
POST /api/cases/open        — открыть кейс
GET  /api/leaderboard       — топ
GET  /api/shop/list         — каталог подарков
POST /api/shop/buy          — купить подарок (создаёт заявку, шлёт админу)
GET  /api/shop/orders       — мои заявки
GET  /api/quiz/next         — следующий неотвеченный вопрос
POST /api/quiz/answer       — записать ответ + апдейт стрика
"""
from __future__ import annotations

import json
import logging
import secrets
from typing import Any, Optional

from aiohttp import web

from . import db, gifts
from .auth import parse_init_data

log = logging.getLogger("gamebuddy.api")


# ---------- хелперы ----------
async def _read_init_data(request: web.Request) -> Optional[str]:
    init = request.headers.get("X-Init-Data")
    if init:
        return init
    if request.method == "GET":
        return request.query.get("init_data")
    try:
        body = await request.json()
    except Exception:
        body = None
    if isinstance(body, dict) and body.get("init_data"):
        request["_json_body"] = body
        return body.get("init_data")
    request["_json_body"] = body if isinstance(body, dict) else {}
    return None


async def _auth(request: web.Request) -> Optional[dict]:
    bot_token = request.app["bot_token"]
    init_data = await _read_init_data(request)
    if not init_data:
        return None
    parsed = parse_init_data(init_data, bot_token)
    if not parsed or not parsed.get("user"):
        return None
    user_tg = parsed["user"]
    user_db = await db.upsert_user(
        user_id=int(user_tg["id"]),
        username=user_tg.get("username"),
        first_name=user_tg.get("first_name"),
        last_name=user_tg.get("last_name"),
        photo_url=user_tg.get("photo_url"),
    )
    return user_db


def _need_auth(handler):
    async def wrapped(request: web.Request) -> web.Response:
        user = await _auth(request)
        if user is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        request["user"] = user
        return await handler(request)
    return wrapped


def _public_user(u: dict) -> dict:
    """Что отдаём наружу из user-row."""
    return {
        "id": u["id"],
        "username": u.get("username"),
        "first_name": u.get("first_name"),
        "photo_url": u.get("photo_url"),
        "balance": int(u.get("balance") or 0),
        "stats": {
            "total_wagered": int(u.get("total_wagered") or 0),
            "total_won":     int(u.get("total_won") or 0),
            "biggest_win":   int(u.get("biggest_win") or 0),
            "spins":  int(u.get("spins") or 0),
            "wins":   int(u.get("wins") or 0),
            "losses": int(u.get("losses") or 0),
            "streak_now":  int(u.get("streak_now") or 0),
            "streak_best": int(u.get("streak_best") or 0),
        },
    }


async def _body(request: web.Request) -> dict:
    if "_json_body" in request:
        return request["_json_body"] or {}
    try:
        return await request.json()
    except Exception:
        return {}


# ---------- handlers ----------
@_need_auth
async def me(request: web.Request) -> web.Response:
    return web.json_response({"user": _public_user(request["user"])})


@_need_auth
async def daily(request: web.Request) -> web.Response:
    user_id = request["user"]["id"]
    res = await db.claim_daily(user_id, amount=500)
    if res is None:
        return web.json_response({"error": "cooldown"}, status=429)
    return web.json_response({"ok": True, **res})


@_need_auth
async def bet(request: web.Request) -> web.Response:
    """Body: {game, wager, win}. Сервер только записывает результат — RNG на клиенте.
    Это сделано осознанно: казино должно быть интерактивным (анимации). Защита есть:
    нельзя сделать win > балансовый максимум, нельзя поставить больше чем есть."""
    body = await _body(request)
    user_id = request["user"]["id"]
    try:
        game = str(body.get("game", ""))[:32]
        wager = int(body.get("wager") or 0)
        win = int(body.get("win") or 0)
    except (TypeError, ValueError):
        return web.json_response({"error": "bad_payload"}, status=400)
    if not game or wager < 0 or win < 0 or wager > 10_000_000 or win > 10_000_000_000:
        return web.json_response({"error": "bad_payload"}, status=400)
    try:
        res = await db.record_bet_result(user_id, game=game, wager=wager, win=win)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True, **res})


@_need_auth
async def case_open(request: web.Request) -> web.Response:
    """Body: {price, value}. Списывает price, начисляет value. Считаем как ставку."""
    body = await _body(request)
    user_id = request["user"]["id"]
    try:
        price = int(body.get("price") or 0)
        value = int(body.get("value") or 0)
    except (TypeError, ValueError):
        return web.json_response({"error": "bad_payload"}, status=400)
    if price < 0 or value < 0 or price > 10_000_000 or value > 10_000_000_000:
        return web.json_response({"error": "bad_payload"}, status=400)
    try:
        res = await db.record_bet_result(user_id, game="case", wager=price, win=value)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True, **res})


@_need_auth
async def leaderboard(request: web.Request) -> web.Response:
    metric = request.query.get("metric", "balance")
    try:
        limit = min(int(request.query.get("limit") or 50), 100)
    except ValueError:
        limit = 50
    rows = await db.leaderboard(metric=metric, limit=limit)
    me_id = request["user"]["id"]
    out = []
    for r in rows:
        out.append({
            "id":         r["id"],
            "username":   r.get("username"),
            "first_name": r.get("first_name"),
            "photo_url":  r.get("photo_url"),
            "balance":      int(r.get("balance") or 0),
            "total_won":    int(r.get("total_won") or 0),
            "biggest_win":  int(r.get("biggest_win") or 0),
            "streak_best":  int(r.get("streak_best") or 0),
            "is_me":        r["id"] == me_id,
        })
    return web.json_response({"items": out, "metric": metric})


# ---------- shop ----------
@_need_auth
async def shop_list(request: web.Request) -> web.Response:
    return web.json_response({"items": gifts.public_catalog()})


@_need_auth
async def shop_buy(request: web.Request) -> web.Response:
    body = await _body(request)
    user_id = request["user"]["id"]
    gift_id = str(body.get("gift_id", ""))[:32]
    g = gifts.gift_by_id(gift_id)
    if not g:
        return web.json_response({"error": "unknown_gift"}, status=400)

    coins = g["stars"] * gifts.STAR_TO_COIN
    try:
        res = await db.create_gift_order(
            user_id,
            gift_id=g["id"],
            gift_name=g["name"],
            gift_emoji=g["emoji"],
            stars=g["stars"],
            coins=coins,
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    # уведомляем админа в фоне
    notifier = request.app.get("admin_notify")
    if notifier:
        request.app.loop.create_task(
            notifier(order=res["order"], user=request["user"])
        )

    return web.json_response({
        "ok": True,
        "balance": res["balance"],
        "order": _serialize_order(res["order"]),
    })


@_need_auth
async def shop_orders(request: web.Request) -> web.Response:
    user_id = request["user"]["id"]
    rows = await db.list_user_orders(user_id, limit=30)
    return web.json_response({"items": [_serialize_order(r) for r in rows]})


def _serialize_order(o: dict) -> dict:
    return {
        "id":         int(o["id"]),
        "gift_id":    o["gift_id"],
        "gift_name":  o["gift_name"],
        "gift_emoji": o["gift_emoji"],
        "stars":      int(o["stars"]),
        "coins":      int(o["coins"]),
        "status":     o["status"],
        "created_at": o["created_at"].isoformat() if o.get("created_at") else None,
    }


# ---------- quiz ----------
@_need_auth
async def quiz_next(request: web.Request) -> web.Response:
    """Возвращает следующий неотвеченный вопрос. Если штатный пул кончился —
    пытается достать AI-сгенерированный из кэша. Если и его нет — клиент должен
    показать 'все вопросы пройдены, начинаем заново'.
    """
    from games import quiz as quizmod

    user_id = request["user"]["id"]
    category = request.query.get("category", "any")

    seen = await db.quiz_seen_ids(user_id)

    # 1) сначала из штатного пула
    pool = quizmod.QUESTIONS
    if category != "any":
        pool = [q for q in pool if q.get("cat") == category]

    unseen = []
    for q in pool:
        qid = quizmod.question_id(q)
        if qid not in seen:
            unseen.append(q)

    if unseen:
        import random as _rnd
        q = _rnd.choice(unseen)
        return web.json_response({
            "question": {
                "id":       quizmod.question_id(q),
                "q":        q["q"],
                "options":  q["options"],
                "category": q.get("cat", "any"),
                "source":   "core",
            },
            "remaining": len(unseen),
        })

    # 2) AI-кэш
    ai_q = await db.quiz_ai_pick_unseen(user_id, category)
    if ai_q:
        payload = ai_q["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return web.json_response({
            "question": {
                "id":       ai_q["question_id"],
                "q":        payload["q"],
                "options":  payload["options"],
                "category": ai_q.get("category", "any"),
                "source":   "ai",
            },
            "remaining": 0,
        })

    # 3) совсем кончилось
    return web.json_response({"question": None, "remaining": 0, "exhausted": True})


@_need_auth
async def quiz_answer(request: web.Request) -> web.Response:
    """Body: {question_id, picked}. Сервер сравнивает с ответом — клиенту не доверяем."""
    from games import quiz as quizmod

    body = await _body(request)
    user_id = request["user"]["id"]
    qid = str(body.get("question_id", ""))[:64]
    try:
        picked = int(body.get("picked"))
    except (TypeError, ValueError):
        return web.json_response({"error": "bad_payload"}, status=400)

    # ищем вопрос: сначала в штатном пуле
    correct_idx: Optional[int] = None
    for q in quizmod.QUESTIONS:
        if quizmod.question_id(q) == qid:
            correct_idx = int(q["answer"])
            break

    if correct_idx is None:
        # AI-кэш
        async with db.pool().acquire() as con:
            row = await con.fetchrow(
                "SELECT payload FROM quiz_ai_pool WHERE question_id = $1", qid,
            )
        if row:
            payload = row["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            correct_idx = int(payload.get("answer", -1))

    if correct_idx is None:
        return web.json_response({"error": "unknown_question"}, status=400)

    is_correct = picked == correct_idx
    streak = await db.quiz_record_answer(user_id, qid, is_correct)

    # лёгкий бонус за правильные: +20 + 5*streak
    reward = 0
    new_balance = None
    if is_correct:
        reward = 20 + 5 * min(streak["streak_now"], 30)
        try:
            new_balance = await db.adjust_balance(
                user_id, reward, kind="quiz", meta={"qid": qid, "streak": streak["streak_now"]}
            )
        except Exception:
            new_balance = None

    return web.json_response({
        "ok": True,
        "correct": is_correct,
        "correct_idx": correct_idx,
        "streak": streak,
        "reward": reward,
        "balance": new_balance,
    })


@_need_auth
async def quiz_reset(request: web.Request) -> web.Response:
    user_id = request["user"]["id"]
    await db.quiz_reset_progress(user_id)
    return web.json_response({"ok": True})


# ---------- регистрация ----------
def setup(app: web.Application, *, bot_token: str, admin_notify) -> None:
    app["bot_token"] = bot_token
    app["admin_notify"] = admin_notify
    app.router.add_get("/api/me", me)
    app.router.add_post("/api/daily", daily)
    app.router.add_post("/api/bet", bet)
    app.router.add_post("/api/cases/open", case_open)
    app.router.add_get("/api/leaderboard", leaderboard)
    app.router.add_get("/api/shop/list", shop_list)
    app.router.add_post("/api/shop/buy", shop_buy)
    app.router.add_get("/api/shop/orders", shop_orders)
    app.router.add_get("/api/quiz/next", quiz_next)
    app.router.add_post("/api/quiz/answer", quiz_answer)
    app.router.add_post("/api/quiz/reset", quiz_reset)
