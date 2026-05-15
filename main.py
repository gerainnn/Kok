"""
GameBuddy — Telegram-бот + Web App «Казино».
Игры в чате: крестики-нолики (минимакс), КНБ, угадай число, виселица,
викторина (без повторов), города, загадки, кубик/монетка, AI-чат.
В WebApp — казино, кейсы, аркады, магазин ТГ-подарков, лидерборд.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    WebAppInfo,
)
from aiohttp import web

from games import ai_chat, cities, fun, hangman, quiz, tictactoe
from server import api as srv_api
from server import db, quiz_ai

# ---------- конфиг ----------
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
if not BOT_TOKEN:
    raise RuntimeError(
        "BOT_TOKEN env-переменная не задана. "
        "Создай .env (см. .env.example) или задай переменную окружения."
    )

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL env-переменная не задана. "
        "Возьми бесплатный Postgres на neon.tech и положи connection string."
    )

ADMIN_ID = int(os.getenv("ADMIN_ID", "0") or 0)

# Render выставляет PORT, локально можно задать WEB_PORT, иначе 8080
WEB_PORT = int(os.getenv("PORT") or os.getenv("WEB_PORT") or "8080")

# Публичный URL: Render автоматически кладёт его в RENDER_EXTERNAL_URL.
PUBLIC_URL = (
    os.getenv("PUBLIC_URL")
    or os.getenv("RENDER_EXTERNAL_URL")
    or ""
).rstrip("/")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("gamebuddy")

router = Router()


# ---------- FSM ----------
class GameStates(StatesGroup):
    guess_number = State()
    hangman = State()
    cities = State()
    riddle = State()
    ai_chat = State()


# ---------- клавиатуры ----------
def main_menu(public_url: str | None) -> ReplyKeyboardMarkup:
    rows = [
        [KeyboardButton(text="🎮 Игры"), KeyboardButton(text="🤖 Поболтать")],
        [KeyboardButton(text="🌆 Города"), KeyboardButton(text="😂 Шутка"), KeyboardButton(text="💡 Факт")],
        [KeyboardButton(text="🤔 Загадка"), KeyboardButton(text="🌒 Страшилка"), KeyboardButton(text="🎲 Случайное")],
        [KeyboardButton(text="❓ Викторина"), KeyboardButton(text="ℹ️ О боте")],
    ]
    if public_url:
        rows.insert(
            0,
            [KeyboardButton(text="🎰 Открыть Казино", web_app=WebAppInfo(url=public_url))],
        )
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def games_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="❌⭕ Крестики-нолики", callback_data="game:ttt")],
            [InlineKeyboardButton(text="✊✋✌️ Камень-ножницы-бумага", callback_data="game:rps")],
            [InlineKeyboardButton(text="🔢 Угадай число", callback_data="game:guess")],
            [InlineKeyboardButton(text="🪢 Виселица", callback_data="game:hangman")],
            [InlineKeyboardButton(text="🌆 Города", callback_data="game:cities")],
            [InlineKeyboardButton(text="🤔 Загадки", callback_data="game:riddle")],
            [InlineKeyboardButton(text="❓ Викторина", callback_data="game:quiz")],
            [InlineKeyboardButton(text="🎲 Кубик / 🪙 Монетка", callback_data="game:dice")],
        ]
    )


def rps_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text="✊ Камень", callback_data="rps:rock"),
            InlineKeyboardButton(text="✋ Бумага", callback_data="rps:paper"),
            InlineKeyboardButton(text="✌️ Ножницы", callback_data="rps:scissors"),
        ]]
    )


def ttt_keyboard(board: list[str]) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    for r in range(3):
        row: list[InlineKeyboardButton] = []
        for c in range(3):
            i = r * 3 + c
            cell = board[i]
            text = cell if cell != " " else "·"
            row.append(InlineKeyboardButton(text=text, callback_data=f"ttt:{i}"))
        rows.append(row)
    rows.append([InlineKeyboardButton(text="🔄 Новая игра", callback_data="ttt:new")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def quiz_keyboard(options: list[str]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=opt, callback_data=f"quiz:{i}")]
            for i, opt in enumerate(options)
        ] + [[
            InlineKeyboardButton(text="➡️ Следующий", callback_data="quiz:next"),
            InlineKeyboardButton(text="📁 Категория", callback_data="quiz:menu"),
        ]]
    )


def dice_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text="🎲 Кубик", callback_data="rng:dice"),
            InlineKeyboardButton(text="🪙 Монетка", callback_data="rng:coin"),
            InlineKeyboardButton(text="🎯 Дартс", callback_data="rng:darts"),
        ]]
    )


# ---------- /start, меню ----------
@router.message(CommandStart())
async def start_cmd(msg: Message, state: FSMContext) -> None:
    await state.clear()
    # Регистрируем юзера в БД (и выдаём бонус, если первый раз)
    try:
        await db.upsert_user(
            user_id=msg.from_user.id,
            username=msg.from_user.username,
            first_name=msg.from_user.first_name,
            last_name=msg.from_user.last_name,
        )
    except Exception as e:
        log.warning("upsert_user failed: %s", e)

    await msg.answer(
        f"<b>Привет, {msg.from_user.first_name}!</b> 👋\n\n"
        "Я <b>GameBuddy</b> — твой компаньон по убиванию времени.\n\n"
        "🎰 <b>«Открыть Казино»</b> — Web App: слоты, рулетка, "
        "crash, mines, кейсы, магазин ТГ-подарков, лидерборд, "
        "виртуальная валюта <b>GameCoins</b>.\n\n"
        "🎮 <b>«Игры»</b> — мини-игры в чате (крестики-нолики, виселица, "
        "города, викторина без повторов).\n\n"
        "🤖 <b>«Поболтать»</b> — могу просто поболтать с тобой на любую тему.\n\n"
        "Команды: /games /quiz /chat /city /joke /fact /riddle /story /help",
        reply_markup=main_menu(PUBLIC_URL),
    )


@router.message(Command("help"))
@router.message(F.text == "ℹ️ О боте")
async def help_cmd(msg: Message) -> None:
    await msg.answer(
        "<b>Что я умею:</b>\n\n"
        "<b>В чате:</b>\n"
        "• ❌⭕ Крестики-нолики — играю минимаксом, проиграть мне нельзя 😏\n"
        "• ✊✋✌️ Камень-ножницы-бумага — счёт ведётся\n"
        "• 🔢 Угадай число (1..100)\n"
        "• 🪢 Виселица — слова на русском\n"
        "• 🌆 Города — играем в города по буквам\n"
        "• ❓ Викторина — без повторов, бонус +coins за серию\n"
        "• 🤔 Загадки\n"
        "• 🎲 Кубик / монетка / дартс\n"
        "• 🤖 Свободный чат с AI\n\n"
        "<b>В Web App «Казино»:</b>\n"
        "• 🎰 Слоты, 🎯 Рулетка, 🚀 Crash, 💣 Mines, 🎡 Колесо, 🪙 Coinflip\n"
        "• 📦 Кейсы, multi-open x1/x5/x10, инвентарь, контракты\n"
        "• 🛍 Магазин — обменять GameCoins на реальные ТГ-подарки\n"
        "• 🏆 Лидерборд — топ по балансу, выигрышу и серии\n\n"
        "Команды: /start /games /quiz /chat /city /joke /fact /riddle /story /dice"
    )


@router.message(Command("games"))
@router.message(F.text == "🎮 Игры")
async def games_cmd(msg: Message) -> None:
    await msg.answer("Выбирай игру:", reply_markup=games_menu())


@router.callback_query(F.data.startswith("game:"))
async def game_pick(cb: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    kind = cb.data.split(":", 1)[1]
    if kind == "ttt":
        await start_ttt(cb)
    elif kind == "rps":
        await cb.message.answer("Выбирай:", reply_markup=rps_keyboard())
    elif kind == "guess":
        await start_guess(cb, state)
    elif kind == "hangman":
        await start_hangman(cb, state)
    elif kind == "cities":
        await start_cities(cb.message, state)
    elif kind == "riddle":
        await start_riddle(cb.message, state)
    elif kind == "quiz":
        await ask_quiz(cb.message, user_id=cb.from_user.id)
    elif kind == "dice":
        await cb.message.answer("Что бросаем?", reply_markup=dice_keyboard())
    await cb.answer()


# ---------- крестики-нолики ----------
TTT_BOARDS: dict[int, list[str]] = {}


async def start_ttt(cb: CallbackQuery) -> None:
    board = tictactoe.new_board()
    TTT_BOARDS[cb.from_user.id] = board
    await cb.message.answer(
        "❌⭕ <b>Крестики-нолики</b>\nТы — X, я — O. Нажимай на клетку.",
        reply_markup=ttt_keyboard(board),
    )


@router.callback_query(F.data.startswith("ttt:"))
async def ttt_step(cb: CallbackQuery) -> None:
    payload = cb.data.split(":", 1)[1]
    uid = cb.from_user.id

    if payload == "new":
        TTT_BOARDS[uid] = tictactoe.new_board()
        await cb.message.edit_text(
            "❌⭕ Новая игра. Ходи!",
            reply_markup=ttt_keyboard(TTT_BOARDS[uid]),
        )
        await cb.answer()
        return

    board = TTT_BOARDS.get(uid)
    if board is None:
        board = tictactoe.new_board()
        TTT_BOARDS[uid] = board

    idx = int(payload)
    if board[idx] != " ":
        await cb.answer("Занято!", show_alert=False)
        return

    board[idx] = tictactoe.PLAYER
    w = tictactoe.winner(board)
    if w is None:
        bm = tictactoe.bot_move(board)
        if bm >= 0:
            board[bm] = tictactoe.BOT
            w = tictactoe.winner(board)

    if w == tictactoe.PLAYER:
        text = "❌⭕ Невероятно — ты выиграл! 🏆"
    elif w == tictactoe.BOT:
        text = "❌⭕ Я победил 😎"
    elif w == "draw":
        text = "❌⭕ Ничья 🤝"
    else:
        text = "❌⭕ Твой ход:"

    await cb.message.edit_text(text, reply_markup=ttt_keyboard(board))
    await cb.answer()


# ---------- камень-ножницы-бумага ----------
RPS_SCORE: dict[int, dict[str, int]] = {}
RPS_BEATS = {"rock": "scissors", "paper": "rock", "scissors": "paper"}
RPS_EMOJI = {"rock": "✊", "paper": "✋", "scissors": "✌️"}
RPS_NAME = {"rock": "Камень", "paper": "Бумага", "scissors": "Ножницы"}


@router.callback_query(F.data.startswith("rps:"))
async def rps_step(cb: CallbackQuery) -> None:
    user = cb.data.split(":", 1)[1]
    bot_choice = random.choice(list(RPS_BEATS))
    score = RPS_SCORE.setdefault(cb.from_user.id, {"w": 0, "l": 0, "d": 0})

    if user == bot_choice:
        verdict, key = "Ничья 🤝", "d"
    elif RPS_BEATS[user] == bot_choice:
        verdict, key = "Ты выиграл! 🎉", "w"
    else:
        verdict, key = "Я выиграл 😎", "l"
    score[key] += 1

    text = (
        f"Ты: {RPS_EMOJI[user]} {RPS_NAME[user]}\n"
        f"Я:  {RPS_EMOJI[bot_choice]} {RPS_NAME[bot_choice]}\n\n"
        f"<b>{verdict}</b>\n\n"
        f"Счёт — победы: {score['w']} | поражения: {score['l']} | ничьи: {score['d']}"
    )
    await cb.message.answer(text, reply_markup=rps_keyboard())
    await cb.answer()


# ---------- угадай число ----------
async def start_guess(cb: CallbackQuery, state: FSMContext) -> None:
    n = random.randint(1, 100)
    await state.set_state(GameStates.guess_number)
    await state.update_data(n=n, tries=0)
    await cb.message.answer(
        "🔢 <b>Угадай число от 1 до 100</b>\nПросто пиши числа в чат."
    )


@router.message(GameStates.guess_number, F.text.regexp(r"^-?\d+$"))
async def guess_step(msg: Message, state: FSMContext) -> None:
    data = await state.get_data()
    n: int = data["n"]
    tries: int = data["tries"] + 1
    guess = int(msg.text)

    if guess == n:
        await state.clear()
        await msg.answer(f"🎯 Точно! Это <b>{n}</b>. Угадал за {tries} попыт(ок). Ещё разок? /games")
    elif guess < n:
        await state.update_data(tries=tries)
        await msg.answer("📈 Больше")
    else:
        await state.update_data(tries=tries)
        await msg.answer("📉 Меньше")


# ---------- виселица ----------
async def start_hangman(cb: CallbackQuery, state: FSMContext) -> None:
    word = hangman.random_word()
    await state.set_state(GameStates.hangman)
    await state.update_data(word=word, opened=set(), mistakes=0)
    await cb.message.answer(
        "🪢 <b>Виселица</b>\nЯ загадал слово на русском. Присылай по одной букве.\n\n"
        f"<code>{hangman.STAGES[0]}</code>\n"
        f"Слово: <code>{hangman.render_word(word, set())}</code>"
    )


@router.message(GameStates.hangman)
async def hangman_step(msg: Message, state: FSMContext) -> None:
    text = (msg.text or "").strip().lower()
    if len(text) != 1 or not text.isalpha():
        await msg.answer("Пришли ровно одну букву.")
        return

    data = await state.get_data()
    word: str = data["word"]
    opened: set = set(data["opened"])
    mistakes: int = data["mistakes"]

    if text in opened:
        await msg.answer("Эту букву уже называл.")
        return

    opened.add(text)
    if text not in word:
        mistakes += 1

    if all(ch in opened for ch in word):
        await state.clear()
        await msg.answer(f"🏆 Победа! Слово было: <b>{word.upper()}</b>")
        return

    if mistakes >= hangman.MAX_MISTAKES:
        await state.clear()
        await msg.answer(
            f"<code>{hangman.STAGES[-1]}</code>\n"
            f"💀 Проиграл. Слово было: <b>{word.upper()}</b>"
        )
        return

    await state.update_data(opened=opened, mistakes=mistakes)
    await msg.answer(
        f"<code>{hangman.STAGES[mistakes]}</code>\n"
        f"Слово: <code>{hangman.render_word(word, opened)}</code>\n"
        f"Ошибок: {mistakes}/{hangman.MAX_MISTAKES}"
    )


# ---------- викторина (без повторов через БД) ----------
QUIZ_CURRENT: dict[int, dict[str, Any]] = {}      # текущий вопрос chat_id -> q (с question_id)
QUIZ_CATEGORY: dict[int, str] = {}                # выбранная категория chat_id -> code


def quiz_categories_keyboard() -> InlineKeyboardMarkup:
    rows = []
    items = list(quiz.CATEGORIES.items())
    for i in range(0, len(items), 2):
        row = []
        for code, name in items[i:i + 2]:
            row.append(InlineKeyboardButton(text=name, callback_data=f"quizcat:{code}"))
        rows.append(row)
    rows.append([InlineKeyboardButton(text="♻️ Сбросить прогресс", callback_data="quizcat:_reset")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def _user_quiz_score_line(user_id: int) -> str:
    try:
        u = await db.get_user(user_id)
    except Exception:
        u = None
    if not u:
        return "📊 0 ✅ / 0 ❌"
    return f"📊 серия {u.get('streak_now') or 0} (рекорд {u.get('streak_best') or 0})"


async def ask_quiz(message: Message, user_id: int) -> None:
    cat = QUIZ_CATEGORY.get(message.chat.id, "any")

    seen = await db.quiz_seen_ids(user_id)
    q = quiz.pick_unseen(cat, seen)

    if q is None:
        # Пробуем AI-кэш
        ai_q = await db.quiz_ai_pick_unseen(user_id, cat)
        if ai_q:
            payload = ai_q["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            q = {
                "q": payload["q"],
                "options": payload["options"],
                "answer": int(payload["answer"]),
                "cat": ai_q.get("category", "any"),
                "_id": ai_q["question_id"],
            }
            # форсим фоновую догенерацию
            asyncio.create_task(quiz_ai.background_replenish(cat))
        else:
            asyncio.create_task(quiz_ai.background_replenish(cat))
            await message.answer(
                "🎉 Ты прошёл все вопросы в этой категории!\n"
                "Я уже генерирую новые — попробуй через минуту, или жми «♻️ Сбросить прогресс».",
                reply_markup=quiz_categories_keyboard(),
            )
            return

    if "_id" not in q:
        q = {**q, "_id": quiz.question_id(q)}

    QUIZ_CURRENT[message.chat.id] = q
    cat_label = quiz.CATEGORIES.get(cat, "🎲 Случайные")
    await message.answer(
        f"{cat_label}\n"
        f"❓ <b>{q['q']}</b>\n\n"
        f"<i>{await _user_quiz_score_line(user_id)}</i>",
        reply_markup=quiz_keyboard(q["options"]),
    )


@router.message(Command("quiz"))
@router.message(F.text == "❓ Викторина")
async def quiz_cmd(msg: Message) -> None:
    await msg.answer(
        "❓ <b>Викторина</b>\nВопросы не повторяются — за каждый правильный +coins.\nВыбери категорию:",
        reply_markup=quiz_categories_keyboard(),
    )


@router.callback_query(F.data.startswith("quizcat:"))
async def quiz_choose_cat(cb: CallbackQuery) -> None:
    code = cb.data.split(":", 1)[1]
    if code == "_reset":
        await db.quiz_reset_progress(cb.from_user.id)
        await cb.answer("Прогресс сброшен", show_alert=False)
        await ask_quiz(cb.message, user_id=cb.from_user.id)
        return
    if code not in quiz.CATEGORIES:
        code = "any"
    QUIZ_CATEGORY[cb.message.chat.id] = code
    await ask_quiz(cb.message, user_id=cb.from_user.id)
    await cb.answer()


@router.callback_query(F.data.startswith("quiz:"))
async def quiz_answer(cb: CallbackQuery) -> None:
    payload = cb.data.split(":", 1)[1]
    chat_id = cb.message.chat.id
    if payload == "next":
        await ask_quiz(cb.message, user_id=cb.from_user.id)
        await cb.answer()
        return
    if payload == "menu":
        await cb.message.answer(
            "❓ Выбери категорию:",
            reply_markup=quiz_categories_keyboard(),
        )
        await cb.answer()
        return

    q = QUIZ_CURRENT.get(chat_id)
    if not q:
        await cb.answer("Вопрос устарел, жми «следующий».", show_alert=False)
        return

    pick = int(payload)
    correct = int(q["answer"])
    is_correct = pick == correct
    qid = q.get("_id") or quiz.question_id(q)

    streak = await db.quiz_record_answer(cb.from_user.id, qid, is_correct)
    reward_text = ""
    if is_correct:
        reward = 20 + 5 * min(streak["streak_now"], 30)
        try:
            await db.adjust_balance(cb.from_user.id, reward, kind="quiz")
            reward_text = f"\n💰 +{reward} GameCoins"
        except Exception:
            pass

    score_line = await _user_quiz_score_line(cb.from_user.id)
    if is_correct:
        await cb.answer("✅ Верно!", show_alert=False)
        await cb.message.edit_text(
            f"❓ {q['q']}\n\n"
            f"✅ <b>{q['options'][correct]}</b> — правильно!{reward_text}\n\n"
            f"<i>{score_line}</i>",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="➡️ Следующий", callback_data="quiz:next"),
                InlineKeyboardButton(text="📁 Категория", callback_data="quiz:menu"),
            ]]),
        )
    else:
        await cb.answer("❌ Мимо", show_alert=False)
        await cb.message.edit_text(
            f"❓ {q['q']}\n\n"
            f"❌ Ты выбрал: <b>{q['options'][pick]}</b>\n"
            f"✅ Правильно: <b>{q['options'][correct]}</b>\n\n"
            f"<i>{score_line}</i>",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="➡️ Следующий", callback_data="quiz:next"),
                InlineKeyboardButton(text="📁 Категория", callback_data="quiz:menu"),
            ]]),
        )


# ---------- кубик / монетка / дартс ----------
@router.message(Command("dice"))
@router.message(F.text == "🎲 Случайное")
async def dice_cmd(msg: Message) -> None:
    await msg.answer("Что бросаем?", reply_markup=dice_keyboard())


@router.callback_query(F.data.startswith("rng:"))
async def rng_step(cb: CallbackQuery) -> None:
    kind = cb.data.split(":", 1)[1]
    if kind == "dice":
        await cb.message.answer_dice(emoji="🎲")
    elif kind == "coin":
        result = random.choice(["Орёл 🦅", "Решка 🪙"])
        await cb.message.answer(f"Бросаю монетку... <b>{result}</b>")
    elif kind == "darts":
        await cb.message.answer_dice(emoji="🎯")
    await cb.answer()


# ---------- 🌆 Города ----------
async def start_cities(message: Message, state: FSMContext) -> None:
    bot_word = cities.bot_pick_city("м", set()) or "москва"
    used = {bot_word}
    await state.set_state(GameStates.cities)
    await state.update_data(used=list(used), last_letter=cities.last_letter(bot_word))
    await message.answer(
        f"🌆 <b>Игра «Города»!</b>\n\n"
        f"Я начинаю: <b>{bot_word.capitalize()}</b>\n"
        f"Ты называешь город на букву <b>«{cities.last_letter(bot_word).upper()}»</b>.\n\n"
        f"Чтобы выйти — пиши /stop"
    )


@router.message(Command("city"))
@router.message(F.text == "🌆 Города")
async def cities_cmd(msg: Message, state: FSMContext) -> None:
    await state.clear()
    await start_cities(msg, state)


@router.message(GameStates.cities)
async def cities_step(msg: Message, state: FSMContext) -> None:
    text = (msg.text or "").strip().lower()
    if text in {"/stop", "стоп", "сдаюсь", "хватит"}:
        await state.clear()
        await msg.answer("Окей, выходим из «Городов» 🚶")
        return
    if not text or not text[0].isalpha():
        await msg.answer("Пришли название города одним сообщением.")
        return

    data = await state.get_data()
    used = set(data.get("used", []))
    expected = data.get("last_letter")

    if expected and cities.first_alpha(text) != expected:
        await msg.answer(f"Город должен начинаться на букву <b>«{expected.upper()}»</b>")
        return
    if text in used:
        await msg.answer("Этот город уже называли. Попробуй другой.")
        return
    if not cities.is_known_city(text):
        await msg.answer(
            f"Не знаю такой город 🤔 Если он реально существует — извини, мой словарь конечен. "
            f"Попробуй другой на «{expected.upper() if expected else '?'}»."
        )
        return

    used.add(text)
    next_l = cities.last_letter(text)
    bot_word = cities.bot_pick_city(next_l, used)
    if not bot_word:
        await state.clear()
        await msg.answer(
            f"🏆 <b>Сдаюсь!</b> Не знаю города на «{next_l.upper()}». Ты победил!"
        )
        return
    used.add(bot_word)
    await state.update_data(used=list(used), last_letter=cities.last_letter(bot_word))
    await msg.answer(
        f"Окей, <b>{text.capitalize()}</b> ✅\n"
        f"Мой ход: <b>{bot_word.capitalize()}</b>\n"
        f"Тебе на «{cities.last_letter(bot_word).upper()}»"
    )


# ---------- 🤔 Загадки ----------
async def start_riddle(message: Message, state: FSMContext) -> None:
    r = fun.random_riddle()
    await state.set_state(GameStates.riddle)
    await state.update_data(answer=r["a"], tries=0)
    await message.answer(
        f"🤔 <b>Загадка:</b>\n\n{r['q']}\n\nПиши ответ в чат. Можно «сдаюсь» или /stop"
    )


@router.message(Command("riddle"))
async def riddle_cmd(msg: Message, state: FSMContext) -> None:
    await state.clear()
    await start_riddle(msg, state)


@router.message(F.text == "🤔 Загадка")
async def riddle_btn(msg: Message, state: FSMContext) -> None:
    await state.clear()
    await start_riddle(msg, state)


@router.message(GameStates.riddle)
async def riddle_step(msg: Message, state: FSMContext) -> None:
    text = (msg.text or "").strip().lower()
    data = await state.get_data()
    answer = data["answer"].lower()
    tries = data.get("tries", 0) + 1

    if text in {"/stop", "сдаюсь", "не знаю", "не догадаюсь"}:
        await state.clear()
        await msg.answer(f"Ответ был: <b>{answer.upper()}</b> 🙃 Хочешь ещё? /riddle")
        return

    if answer in text or text in answer:
        await state.clear()
        await msg.answer(f"🎯 Точно! <b>{answer.upper()}</b> Угадал с {tries}-й попытки.\n\nЕщё одну? /riddle")
        return

    if tries >= 3:
        await state.clear()
        await msg.answer(f"😅 Ответ: <b>{answer.upper()}</b>. Ещё разок? /riddle")
        return

    await state.update_data(tries=tries)
    await msg.answer(f"❌ Не то. Попыток осталось: {3 - tries}")


# ---------- одноразовый контент ----------
@router.message(Command("joke"))
@router.message(F.text == "😂 Шутка")
async def joke_cmd(msg: Message) -> None:
    await msg.answer("😂 " + fun.random_joke())


@router.message(Command("fact"))
@router.message(F.text == "💡 Факт")
async def fact_cmd(msg: Message) -> None:
    await msg.answer(fun.random_fact())


@router.message(Command("story"))
@router.message(F.text == "🌒 Страшилка")
async def story_cmd(msg: Message) -> None:
    await msg.answer(fun.random_story())


@router.message(Command("advice"))
async def advice_cmd(msg: Message) -> None:
    await msg.answer(fun.random_advice())


# ---------- 🤖 AI чат ----------
AI_HISTORY: dict[int, list[dict]] = {}


@router.message(Command("chat"))
@router.message(F.text == "🤖 Поболтать")
async def ai_chat_start(msg: Message, state: FSMContext) -> None:
    await state.set_state(GameStates.ai_chat)
    AI_HISTORY[msg.from_user.id] = []
    await msg.answer(
        "🤖 <b>Свободный чат включён.</b>\n"
        "Спрашивай что угодно или просто болтай. Чтобы выйти — /stop"
    )


@router.message(Command("stop"))
async def stop_any(msg: Message, state: FSMContext) -> None:
    await state.clear()
    await msg.answer("Остановил. Что дальше? /games /chat /quiz")


@router.message(GameStates.ai_chat)
async def ai_chat_step(msg: Message, state: FSMContext) -> None:
    text = (msg.text or "").strip()
    if not text:
        return
    if text.lower() in {"/stop", "стоп", "хватит"}:
        await state.clear()
        await msg.answer("Хорошо, болтаем в другой раз 👋")
        return

    history = AI_HISTORY.setdefault(msg.from_user.id, [])
    try:
        await msg.bot.send_chat_action(msg.chat.id, action="typing")
    except Exception:
        pass

    reply = await ai_chat.ask_ai(text, history)
    if not reply:
        await msg.answer("Связь с моим разумом ненадолго потерялась 🛰️ Попробуй ещё раз.")
        return

    history.append({"role": "user", "content": text})
    history.append({"role": "assistant", "content": reply})
    if len(history) > 12:
        del history[: len(history) - 12]

    await msg.answer(reply)


# ---------- legacy webapp data (catch_star) ----------
@router.message(F.web_app_data)
async def webapp_data(msg: Message) -> None:
    try:
        data = json.loads(msg.web_app_data.data)
    except Exception:
        await msg.answer(f"Данные из WebApp: <code>{msg.web_app_data.data}</code>")
        return
    if data.get("game") == "catch_star":
        score = data.get("score", 0)
        await msg.answer(f"⭐ Твой результат: <b>{score}</b>")


# ---------- 🛍 уведомления о покупках в магазине ----------
def gift_admin_keyboard(order_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text="✅ Отправил", callback_data=f"gift:sent:{order_id}"),
            InlineKeyboardButton(text="❌ Отменить и вернуть", callback_data=f"gift:cancel:{order_id}"),
        ]]
    )


def _user_link_html(user: dict) -> str:
    uname = user.get("username")
    fn = user.get("first_name") or "Игрок"
    if uname:
        return f"<a href='https://t.me/{uname}'>@{uname}</a> ({fn})"
    # фолбэк: tg://user?id=...
    return f"<a href='tg://user?id={user['id']}'>{fn}</a> (id <code>{user['id']}</code>)"


async def admin_notify_purchase(order: dict, user: dict) -> None:
    """Шлёт уведомление администратору. Идёт через app['bot']."""
    if not ADMIN_ID:
        log.warning("ADMIN_ID не задан — пропускаю уведомление о покупке")
        return
    bot: Bot = _BOT_GLOBAL
    if bot is None:
        log.warning("Bot ещё не инициализирован, не могу отправить уведомление")
        return

    text = (
        "🛍 <b>Новая покупка в магазине</b>\n\n"
        f"Покупатель: {_user_link_html(user)}\n"
        f"Подарок: <b>{order['gift_emoji']} {order['gift_name']}</b>\n"
        f"Стоимость: <b>{order['stars']} ⭐</b> ({order['coins']:,} GameCoins)\n"
        f"Заявка #<code>{order['id']}</code>\n\n"
        "Когда отправишь подарок в Telegram — нажми <b>«✅ Отправил»</b>.\n"
        "Если не получается — нажми <b>«❌ Отменить»</b>, монеты вернутся."
    ).replace(",", " ")

    try:
        sent = await bot.send_message(
            chat_id=ADMIN_ID,
            text=text,
            reply_markup=gift_admin_keyboard(int(order["id"])),
        )
        try:
            await db.set_gift_order_admin_msg(int(order["id"]), sent.chat.id, sent.message_id)
        except Exception as e:
            log.warning("set_gift_order_admin_msg failed: %s", e)
    except Exception as e:
        log.exception("Не удалось отправить уведомление админу: %s", e)


@router.callback_query(F.data.startswith("gift:"))
async def gift_admin_action(cb: CallbackQuery) -> None:
    if cb.from_user.id != ADMIN_ID:
        await cb.answer("Только администратор может это делать.", show_alert=True)
        return
    parts = cb.data.split(":")
    if len(parts) != 3:
        await cb.answer("Bad payload", show_alert=False)
        return
    _, action, oid_str = parts
    try:
        order_id = int(oid_str)
    except ValueError:
        await cb.answer("Bad order id", show_alert=False)
        return

    order = await db.get_gift_order(order_id)
    if not order:
        await cb.answer("Заявка не найдена", show_alert=True)
        return

    if action == "sent":
        updated = await db.mark_gift_sent(order_id)
        if updated is None:
            await cb.answer("Заявка уже обработана", show_alert=False)
            return
        new_text = (cb.message.html_text or cb.message.text or "") + "\n\n✅ <b>Отправлено</b>"
        try:
            await cb.message.edit_text(new_text, reply_markup=None)
        except Exception:
            pass
        # уведомляем покупателя
        try:
            await _BOT_GLOBAL.send_message(
                chat_id=int(order["user_id"]),
                text=(
                    f"🎁 Твой подарок <b>{order['gift_emoji']} {order['gift_name']}</b> отправлен!\n"
                    "Проверь Telegram — он уже у тебя в подарках."
                ),
            )
        except Exception as e:
            log.warning("notify buyer failed: %s", e)
        await cb.answer("Отправлено")

    elif action == "cancel":
        updated = await db.cancel_gift_order(order_id)
        if updated is None:
            await cb.answer("Заявка уже обработана", show_alert=False)
            return
        new_text = (cb.message.html_text or cb.message.text or "") + "\n\n❌ <b>Отменено, монеты возвращены</b>"
        try:
            await cb.message.edit_text(new_text, reply_markup=None)
        except Exception:
            pass
        try:
            await _BOT_GLOBAL.send_message(
                chat_id=int(order["user_id"]),
                text=(
                    f"😔 Заявка на <b>{order['gift_emoji']} {order['gift_name']}</b> отменена.\n"
                    f"Монеты ({int(order['coins']):,}) вернулись на баланс."
                ).replace(",", " "),
            )
        except Exception as e:
            log.warning("notify buyer cancel failed: %s", e)
        await cb.answer("Отменено, возврат сделан")
    else:
        await cb.answer("Unknown action", show_alert=False)


# ---------- aiohttp: отдаём webapp + API ----------
WEBAPP_DIR = Path(__file__).parent / "webapp"
_BOT_GLOBAL: Bot | None = None  # для использования из api.py


async def serve_index(_request: web.Request) -> web.Response:
    return web.FileResponse(WEBAPP_DIR / "index.html")


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "service": "gamebuddy"})


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", serve_index)
    app.router.add_get("/health", health)

    # API
    srv_api.setup(app, bot_token=BOT_TOKEN, admin_notify=admin_notify_purchase)

    app.router.add_static("/static/", WEBAPP_DIR, show_index=False)
    return app


# ---------- main ----------
async def main() -> None:
    global _BOT_GLOBAL
    # БД
    await db.init(DATABASE_URL)

    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    _BOT_GLOBAL = bot

    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)

    web_app = build_web_app()
    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    log.info("Web server started on :%s", WEB_PORT)

    me = await bot.get_me()
    log.info("Bot started: @%s (id=%s). PUBLIC_URL=%s ADMIN_ID=%s",
             me.username, me.id, PUBLIC_URL or "—", ADMIN_ID or "—")

    # фоновое тёплое наполнение AI-кэша при старте (не критично)
    asyncio.create_task(quiz_ai.background_replenish("any"))

    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        await runner.cleanup()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
