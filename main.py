"""
GameBuddy — Telegram-бот с мини-играми и Web App казино.
Игры: крестики-нолики, КНБ, угадай число, виселица,
викторина, города, загадки + Web App Casino с магазином подарков.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv is optional

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

# ---------- конфиг ----------
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))  # ID админа для уведомлений о покупках
WEB_PORT = int(os.getenv("WEB_PORT", "8080"))
PUBLIC_URL = os.getenv("PUBLIC_URL", "")  # подставится во время запуска

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN environment variable is required! Set it in .env or environment.")

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
    await msg.answer(
        f"<b>Привет, {msg.from_user.first_name}!</b> 👋\n\n"
        "Я <b>GameBuddy</b> — твой компаньон для развлечений.\n\n"
        "🎁 <b>«Открыть Казино»</b> — Web App: слоты, рулетка, crash, "
        "mines, кейсы, магазин подарков, лидерборд и кликер.\n\n"
        "🛍 <b>Магазин</b> — обменивай виртуальные монеты на реальные "
        "подарки для Telegram (мишки, сердечки, звёзды)!\n\n"
        "🎮 <b>«Игры»</b> — мини-игры в чате.\n"
        "🤖 <b>«Поболтать»</b> — AI чат на любые темы.\n\n"
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
        "• ❓ Викторина — общие знания\n"
        "• 🤔 Загадки\n"
        "• 🎲 Кубик / монетка / дартс\n"
        "• 🤖 Свободный чат с AI\n"
        "• 😂 Шутки, 💡 факты, 🌒 страшилки\n\n"
        "<b>В Web App «Казино»:</b>\n"
        "• 🎰 Слоты, 🎯 Рулетка, 🚀 Crash, 💣 Mines, 🎡 Колесо, 🪙 Coinflip\n"
        "• 📦 8 видов кейсов, multi-open x1/x5/x10\n"
        "• 🔧 Контракты улучшения (5→1)\n"
        "• 👆 Кликер с прокачкой, GameCoins, инвентарь\n\n"
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
        await ask_quiz(cb.message)
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


# ---------- викторина ----------
QUIZ_CURRENT: dict[int, dict[str, Any]] = {}      # текущий вопрос chat_id -> q
QUIZ_CATEGORY: dict[int, str] = {}                # выбранная категория chat_id -> code
QUIZ_SCORE: dict[int, dict[str, int]] = {}        # счёт chat_id -> {right, wrong, streak, best_streak}


def quiz_categories_keyboard() -> InlineKeyboardMarkup:
    rows = []
    items = list(quiz.CATEGORIES.items())
    for i in range(0, len(items), 2):
        row = []
        for code, name in items[i:i + 2]:
            row.append(InlineKeyboardButton(text=name, callback_data=f"quizcat:{code}"))
        rows.append(row)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _quiz_score_line(chat_id: int) -> str:
    s = QUIZ_SCORE.get(chat_id, {"right": 0, "wrong": 0, "streak": 0, "best_streak": 0})
    return (f"📊 {s['right']} ✅ / {s['wrong']} ❌ · "
            f"серия {s['streak']} (рекорд {s['best_streak']})")


async def ask_quiz(message: Message) -> None:
    chat_id = message.chat.id
    cat = QUIZ_CATEGORY.get(chat_id, "any")
    q = quiz.random_question(cat, chat_id)
    QUIZ_CURRENT[chat_id] = q
    cat_label = quiz.CATEGORIES.get(cat, "🎲 Случайные")
    await message.answer(
        f"{cat_label}\n"
        f"❓ <b>{q['q']}</b>\n\n"
        f"<i>{_quiz_score_line(chat_id)}</i>",
        reply_markup=quiz_keyboard(q["options"]),
    )


@router.message(Command("quiz"))
@router.message(F.text == "❓ Викторина")
async def quiz_cmd(msg: Message) -> None:
    await msg.answer(
        "❓ <b>Викторина</b>\nВыбери категорию:",
        reply_markup=quiz_categories_keyboard(),
    )


@router.callback_query(F.data.startswith("quizcat:"))
async def quiz_choose_cat(cb: CallbackQuery) -> None:
    code = cb.data.split(":", 1)[1]
    if code not in quiz.CATEGORIES:
        code = "any"
    QUIZ_CATEGORY[cb.message.chat.id] = code
    # обнулять счёт не будем — пусть копится за сессию
    QUIZ_SCORE.setdefault(cb.message.chat.id, {"right": 0, "wrong": 0, "streak": 0, "best_streak": 0})
    await ask_quiz(cb.message)
    await cb.answer()


@router.callback_query(F.data.startswith("quiz:"))
async def quiz_answer(cb: CallbackQuery) -> None:
    payload = cb.data.split(":", 1)[1]
    chat_id = cb.message.chat.id
    if payload == "next":
        await ask_quiz(cb.message)
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
    correct = q["answer"]
    score = QUIZ_SCORE.setdefault(chat_id, {"right": 0, "wrong": 0, "streak": 0, "best_streak": 0})
    if pick == correct:
        score["right"] += 1
        score["streak"] += 1
        if score["streak"] > score["best_streak"]:
            score["best_streak"] = score["streak"]
    else:
        score["wrong"] += 1
        score["streak"] = 0

    if pick == correct:
        await cb.answer("✅ Верно!", show_alert=False)
        await cb.message.edit_text(
            f"❓ {q['q']}\n\n"
            f"✅ <b>{q['options'][correct]}</b> — правильно!\n\n"
            f"<i>{_quiz_score_line(chat_id)}</i>",
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
            f"<i>{_quiz_score_line(chat_id)}</i>",
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
    # показываем «печатает...»
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


# ---------- web app data ----------
# Биг-вины теперь показываются модалкой ВНУТРИ Web App, не выкидывают пользователя.
# Здесь обрабатываем только legacy «catch_star» и любые ручные отправки.


@router.message(F.web_app_data)
async def webapp_data(msg: Message) -> None:
    try:
        data = json.loads(msg.web_app_data.data)
    except Exception:
        await msg.answer(f"Данные из WebApp: <code>{msg.web_app_data.data}</code>")
        return

    # ========== SHOP PURCHASE ==========
    if data.get("action") == "shop_purchase":
        item_name = data.get("item_name", "Подарок")
        item_ico = data.get("item_ico", "🎁")
        item_id = data.get("item_id", "unknown")
        price = data.get("price", 0)

        user = msg.from_user
        username = f"@{user.username}" if user.username else f"id:{user.id}"
        user_link = f'<a href="tg://user?id={user.id}">{user.first_name}</a>'

        # Подтверждение пользователю
        await msg.answer(
            f"🎁 <b>Покупка подтверждена!</b>\n\n"
            f"{item_ico} <b>{item_name}</b>\n"
            f"💰 Списано: <b>{price:,}</b> GameCoins\n\n"
            f"Мы скоро свяжемся с тобой для отправки подарка! 🚀"
        )

        # Уведомление админу
        if ADMIN_ID:
            admin_msg = (
                f"🛒 <b>НОВАЯ ПОКУПКА!</b>\n\n"
                f"👤 Покупатель: {user_link} ({username})\n"
                f"🆔 User ID: <code>{user.id}</code>\n"
                f"{item_ico} Товар: <b>{item_name}</b> (id: {item_id})\n"
                f"💰 Цена: <b>{price:,}</b> GameCoins\n"
                f"⏰ Время: сейчас\n\n"
                f"Нужно отправить подарок!"
            )
            try:
                await msg.bot.send_message(ADMIN_ID, admin_msg)
                log.info("Admin notified about purchase from user %s: %s", user.id, item_id)
            except Exception as e:
                log.error("Failed to notify admin: %s", e)

        return

    # legacy: catch_star
    if data.get("game") == "catch_star":
        score = data.get("score", 0)
        comment = (
            "🌟 Космический ас!" if score >= 30
            else "💫 Хороший улов!" if score >= 15
            else "✨ Тренируйся, всё впереди!"
        )
        await msg.answer(f"⭐ Твой результат: <b>{score}</b>\n{comment}")
        return

    # любой другой payload — игнорируем
    return


# ---------- aiohttp: отдаём webapp ----------
WEBAPP_DIR = Path(__file__).parent / "webapp"


async def serve_index(_request: web.Request) -> web.Response:
    return web.FileResponse(WEBAPP_DIR / "index.html")


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "service": "gamebuddy"})


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", serve_index)
    app.router.add_get("/health", health)
    app.router.add_static("/static/", WEBAPP_DIR, show_index=False)
    return app


# ---------- main ----------
async def main() -> None:
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)

    web_app = build_web_app()
    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    log.info("Web server started on :%s", WEB_PORT)

    me = await bot.get_me()
    log.info("Bot started: @%s (id=%s). PUBLIC_URL=%s", me.username, me.id, PUBLIC_URL or "—")

    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        await runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
