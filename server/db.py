"""Postgres backend (asyncpg). Pool + миграции + домен-функции."""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import asyncpg

log = logging.getLogger("gamebuddy.db")

_pool: Optional[asyncpg.Pool] = None

# Стартовый бонус новому игроку
SIGNUP_BONUS = 1000

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,                       -- telegram user id
    username       TEXT,
    first_name     TEXT,
    last_name      TEXT,
    photo_url      TEXT,
    balance        BIGINT NOT NULL DEFAULT 0,
    total_wagered  BIGINT NOT NULL DEFAULT 0,
    total_won      BIGINT NOT NULL DEFAULT 0,
    biggest_win    BIGINT NOT NULL DEFAULT 0,
    spins          BIGINT NOT NULL DEFAULT 0,
    wins           BIGINT NOT NULL DEFAULT 0,
    losses         BIGINT NOT NULL DEFAULT 0,
    cases_opened   BIGINT NOT NULL DEFAULT 0,
    streak_now     INT    NOT NULL DEFAULT 0,
    streak_best    INT    NOT NULL DEFAULT 0,
    last_daily_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind    TEXT   NOT NULL,                    -- bet, win, daily, signup, gift_buy, refund, ...
    game    TEXT,                               -- slots/roulette/crash/...
    delta   BIGINT NOT NULL,                    -- знаковая дельта баланса
    meta    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tx_user_idx ON transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gift_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_id     TEXT   NOT NULL,
    gift_name   TEXT   NOT NULL,
    gift_emoji  TEXT   NOT NULL,
    stars       INT    NOT NULL,
    coins       BIGINT NOT NULL,
    status      TEXT   NOT NULL DEFAULT 'pending',  -- pending / sent / cancelled
    admin_msg_chat_id BIGINT,
    admin_msg_id      BIGINT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gift_orders_user_idx ON gift_orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quiz_progress (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT  NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    correct     BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, question_id)
);

-- кэш AI-сгенерированных вопросов: чтобы не дёргать модель каждый раз
CREATE TABLE IF NOT EXISTS quiz_ai_pool (
    id          BIGSERIAL PRIMARY KEY,
    question_id TEXT UNIQUE NOT NULL,
    category    TEXT NOT NULL,
    payload     JSONB NOT NULL,                  -- {q, options[], answer}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


# ---------- pool ----------
async def init(database_url: str) -> None:
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=database_url,
        min_size=1,
        max_size=5,
        command_timeout=30,
    )
    async with _pool.acquire() as con:
        await con.execute(SCHEMA_SQL)
    log.info("DB pool initialised (Postgres)")


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB not initialised. Call db.init(DATABASE_URL) first.")
    return _pool


# ---------- users ----------
async def upsert_user(
    user_id: int,
    *,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    photo_url: Optional[str] = None,
) -> dict:
    """Создаёт юзера если новый (с приветственным бонусом), иначе обновляет профиль."""
    async with pool().acquire() as con:
        existing = await con.fetchrow("SELECT id FROM users WHERE id = $1", user_id)
        if existing is None:
            row = await con.fetchrow(
                """
                INSERT INTO users (id, username, first_name, last_name, photo_url, balance)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
                """,
                user_id, username, first_name, last_name, photo_url, SIGNUP_BONUS,
            )
            await con.execute(
                "INSERT INTO transactions (user_id, kind, delta) VALUES ($1, 'signup', $2)",
                user_id, SIGNUP_BONUS,
            )
            log.info("New user %s registered, +%s coins signup", user_id, SIGNUP_BONUS)
        else:
            row = await con.fetchrow(
                """
                UPDATE users SET
                    username = COALESCE($2, username),
                    first_name = COALESCE($3, first_name),
                    last_name = COALESCE($4, last_name),
                    photo_url = COALESCE($5, photo_url),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
                """,
                user_id, username, first_name, last_name, photo_url,
            )
        return dict(row)


async def get_user(user_id: int) -> Optional[dict]:
    async with pool().acquire() as con:
        row = await con.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
        return dict(row) if row else None


# ---------- balance / bets ----------
async def adjust_balance(
    user_id: int,
    delta: int,
    kind: str,
    *,
    game: Optional[str] = None,
    meta: Optional[dict] = None,
    allow_negative: bool = False,
) -> int:
    """Атомарно меняет баланс и пишет транзакцию. Возвращает новый баланс.
    Если allow_negative=False и баланс уйдёт в минус — кидает ValueError."""
    async with pool().acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT balance FROM users WHERE id = $1 FOR UPDATE", user_id
            )
            if row is None:
                raise ValueError(f"user {user_id} not found")
            new_balance = int(row["balance"]) + int(delta)
            if not allow_negative and new_balance < 0:
                raise ValueError("insufficient_funds")
            await con.execute(
                "UPDATE users SET balance = $2, updated_at = NOW() WHERE id = $1",
                user_id, new_balance,
            )
            import json as _json
            await con.execute(
                """INSERT INTO transactions (user_id, kind, game, delta, meta)
                   VALUES ($1, $2, $3, $4, $5::jsonb)""",
                user_id, kind, game, delta,
                _json.dumps(meta) if meta else None,
            )
            return new_balance


async def record_bet_result(
    user_id: int,
    *,
    game: str,
    wager: int,
    win: int,
) -> dict:
    """Атомарно: списывает ставку, начисляет выигрыш, апдейтит статистику.
    Возвращает {balance, biggest_win, ...}."""
    if wager < 0 or win < 0:
        raise ValueError("wager/win must be non-negative")

    async with pool().acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT balance, biggest_win FROM users WHERE id = $1 FOR UPDATE", user_id
            )
            if row is None:
                raise ValueError("user not found")
            cur = int(row["balance"])
            if cur < wager:
                raise ValueError("insufficient_funds")

            new_balance = cur - wager + win
            new_biggest = max(int(row["biggest_win"] or 0), win)
            won = win > 0

            await con.execute(
                """
                UPDATE users SET
                    balance = $2,
                    total_wagered = total_wagered + $3,
                    total_won     = total_won + $4,
                    biggest_win   = $5,
                    spins  = spins + 1,
                    wins   = wins   + CASE WHEN $6 THEN 1 ELSE 0 END,
                    losses = losses + CASE WHEN $6 THEN 0 ELSE 1 END,
                    updated_at = NOW()
                WHERE id = $1
                """,
                user_id, new_balance, wager, win, new_biggest, won,
            )
            # пишем две транзакции (списание и зачисление) для аудита
            if wager > 0:
                await con.execute(
                    "INSERT INTO transactions (user_id, kind, game, delta) VALUES ($1, 'bet', $2, $3)",
                    user_id, game, -wager,
                )
            if win > 0:
                await con.execute(
                    "INSERT INTO transactions (user_id, kind, game, delta) VALUES ($1, 'win', $2, $3)",
                    user_id, game, win,
                )
            return {"balance": new_balance, "biggest_win": new_biggest}


# ---------- daily ----------
async def claim_daily(user_id: int, amount: int = 500, cooldown_hours: int = 22) -> Optional[dict]:
    """Выдаёт дейли-бонус если кулдаун прошёл. Возвращает {balance, granted} или None."""
    async with pool().acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT balance, last_daily_at FROM users WHERE id = $1 FOR UPDATE",
                user_id,
            )
            if row is None:
                raise ValueError("user not found")
            from datetime import datetime, timedelta, timezone
            now = datetime.now(timezone.utc)
            last = row["last_daily_at"]
            if last is not None and now - last < timedelta(hours=cooldown_hours):
                return None
            new_balance = int(row["balance"]) + amount
            await con.execute(
                """UPDATE users SET balance=$2, last_daily_at=$3, updated_at=NOW()
                   WHERE id=$1""",
                user_id, new_balance, now,
            )
            await con.execute(
                "INSERT INTO transactions (user_id, kind, delta) VALUES ($1, 'daily', $2)",
                user_id, amount,
            )
            return {"balance": new_balance, "granted": amount}


# ---------- gifts ----------
async def create_gift_order(
    user_id: int,
    *,
    gift_id: str,
    gift_name: str,
    gift_emoji: str,
    stars: int,
    coins: int,
) -> dict:
    """Атомарно: списывает coins, создаёт заявку pending. Возвращает {order, balance}."""
    async with pool().acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT balance FROM users WHERE id = $1 FOR UPDATE", user_id
            )
            if row is None:
                raise ValueError("user not found")
            cur = int(row["balance"])
            if cur < coins:
                raise ValueError("insufficient_funds")
            new_balance = cur - coins
            await con.execute(
                "UPDATE users SET balance = $2, updated_at = NOW() WHERE id = $1",
                user_id, new_balance,
            )
            order = await con.fetchrow(
                """INSERT INTO gift_orders
                   (user_id, gift_id, gift_name, gift_emoji, stars, coins)
                   VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
                user_id, gift_id, gift_name, gift_emoji, stars, coins,
            )
            await con.execute(
                """INSERT INTO transactions (user_id, kind, delta, meta)
                   VALUES ($1, 'gift_buy', $2, $3::jsonb)""",
                user_id, -coins,
                f'{{"gift_id":"{gift_id}","order_id":{order["id"]}}}',
            )
            return {"order": dict(order), "balance": new_balance}


async def get_gift_order(order_id: int) -> Optional[dict]:
    async with pool().acquire() as con:
        row = await con.fetchrow("SELECT * FROM gift_orders WHERE id = $1", order_id)
        return dict(row) if row else None


async def set_gift_order_admin_msg(order_id: int, chat_id: int, msg_id: int) -> None:
    async with pool().acquire() as con:
        await con.execute(
            "UPDATE gift_orders SET admin_msg_chat_id=$2, admin_msg_id=$3, updated_at=NOW() WHERE id=$1",
            order_id, chat_id, msg_id,
        )


async def mark_gift_sent(order_id: int) -> Optional[dict]:
    async with pool().acquire() as con:
        async with con.transaction():
            row = await con.fetchrow(
                "SELECT * FROM gift_orders WHERE id = $1 FOR UPDATE", order_id
            )
            if row is None or row["status"] != "pending":
                return None
            updated = await con.fetchrow(
                "UPDATE gift_orders SET status='sent', updated_at=NOW() WHERE id=$1 RETURNING *",
                order_id,
            )
            return dict(updated)


async def cancel_gift_order(order_id: int) -> Optional[dict]:
    """Отмена + возврат coins на баланс юзера. Идемпотентно."""
    async with pool().acquire() as con:
        async with con.transaction():
            order = await con.fetchrow(
                "SELECT * FROM gift_orders WHERE id = $1 FOR UPDATE", order_id
            )
            if order is None or order["status"] != "pending":
                return None
            user_id = int(order["user_id"])
            refund = int(order["coins"])
            updated = await con.fetchrow(
                "UPDATE gift_orders SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *",
                order_id,
            )
            row = await con.fetchrow(
                "SELECT balance FROM users WHERE id = $1 FOR UPDATE", user_id
            )
            new_balance = int(row["balance"]) + refund
            await con.execute(
                "UPDATE users SET balance=$2, updated_at=NOW() WHERE id=$1",
                user_id, new_balance,
            )
            await con.execute(
                """INSERT INTO transactions (user_id, kind, delta, meta)
                   VALUES ($1, 'refund', $2, $3::jsonb)""",
                user_id, refund,
                f'{{"order_id":{order_id}}}',
            )
            return dict(updated)


async def list_user_orders(user_id: int, limit: int = 30) -> list[dict]:
    async with pool().acquire() as con:
        rows = await con.fetch(
            "SELECT * FROM gift_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
            user_id, limit,
        )
        return [dict(r) for r in rows]


# ---------- leaderboard ----------
async def leaderboard(metric: str = "balance", limit: int = 50) -> list[dict]:
    """metric ∈ {balance, total_won, biggest_win, streak_best}."""
    column_map = {
        "balance": "balance",
        "total_won": "total_won",
        "biggest_win": "biggest_win",
        "streak_best": "streak_best",
    }
    col = column_map.get(metric, "balance")
    async with pool().acquire() as con:
        rows = await con.fetch(
            f"""SELECT id, username, first_name, photo_url,
                       balance, total_won, biggest_win, streak_best
                FROM users ORDER BY {col} DESC NULLS LAST LIMIT $1""",
            limit,
        )
        return [dict(r) for r in rows]


# ---------- quiz progress ----------
async def quiz_seen_ids(user_id: int) -> set[str]:
    async with pool().acquire() as con:
        rows = await con.fetch(
            "SELECT question_id FROM quiz_progress WHERE user_id = $1", user_id,
        )
        return {r["question_id"] for r in rows}


async def quiz_record_answer(user_id: int, question_id: str, correct: bool) -> dict:
    """Записывает ответ. Если верно — апдейтит streak_now / streak_best."""
    async with pool().acquire() as con:
        async with con.transaction():
            await con.execute(
                """INSERT INTO quiz_progress (user_id, question_id, correct)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (user_id, question_id) DO NOTHING""",
                user_id, question_id, correct,
            )
            row = await con.fetchrow(
                "SELECT streak_now, streak_best FROM users WHERE id = $1 FOR UPDATE",
                user_id,
            )
            if row is None:
                return {"streak_now": 0, "streak_best": 0}
            streak_now = int(row["streak_now"] or 0)
            best = int(row["streak_best"] or 0)
            if correct:
                streak_now += 1
                if streak_now > best:
                    best = streak_now
            else:
                streak_now = 0
            await con.execute(
                "UPDATE users SET streak_now=$2, streak_best=$3, updated_at=NOW() WHERE id=$1",
                user_id, streak_now, best,
            )
            return {"streak_now": streak_now, "streak_best": best}


async def quiz_reset_progress(user_id: int) -> None:
    async with pool().acquire() as con:
        await con.execute("DELETE FROM quiz_progress WHERE user_id = $1", user_id)


# ---------- AI quiz cache ----------
async def quiz_ai_save(question_id: str, category: str, payload: dict) -> None:
    import json as _json
    async with pool().acquire() as con:
        await con.execute(
            """INSERT INTO quiz_ai_pool (question_id, category, payload)
               VALUES ($1, $2, $3::jsonb) ON CONFLICT (question_id) DO NOTHING""",
            question_id, category, _json.dumps(payload),
        )


async def quiz_ai_pick_unseen(user_id: int, category: Optional[str] = None) -> Optional[dict]:
    async with pool().acquire() as con:
        if category and category != "any":
            row = await con.fetchrow(
                """SELECT * FROM quiz_ai_pool
                   WHERE category = $1
                     AND question_id NOT IN (SELECT question_id FROM quiz_progress WHERE user_id=$2)
                   ORDER BY RANDOM() LIMIT 1""",
                category, user_id,
            )
        else:
            row = await con.fetchrow(
                """SELECT * FROM quiz_ai_pool
                   WHERE question_id NOT IN (SELECT question_id FROM quiz_progress WHERE user_id=$1)
                   ORDER BY RANDOM() LIMIT 1""",
                user_id,
            )
        return dict(row) if row else None
