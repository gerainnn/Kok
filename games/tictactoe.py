"""Крестики-нолики с непобедимым ИИ (минимакс)."""
from __future__ import annotations
import math
from typing import List, Optional, Tuple

PLAYER = "X"
BOT = "O"
EMPTY = " "

WIN_LINES = [
    (0, 1, 2), (3, 4, 5), (6, 7, 8),
    (0, 3, 6), (1, 4, 7), (2, 5, 8),
    (0, 4, 8), (2, 4, 6),
]


def new_board() -> List[str]:
    return [EMPTY] * 9


def winner(board: List[str]) -> Optional[str]:
    for a, b, c in WIN_LINES:
        if board[a] != EMPTY and board[a] == board[b] == board[c]:
            return board[a]
    if EMPTY not in board:
        return "draw"
    return None


def _minimax(board: List[str], is_bot: bool) -> Tuple[int, int]:
    w = winner(board)
    if w == BOT:
        return 1, -1
    if w == PLAYER:
        return -1, -1
    if w == "draw":
        return 0, -1

    best_score = -math.inf if is_bot else math.inf
    best_move = -1
    mark = BOT if is_bot else PLAYER

    for i in range(9):
        if board[i] == EMPTY:
            board[i] = mark
            score, _ = _minimax(board, not is_bot)
            board[i] = EMPTY
            if is_bot and score > best_score:
                best_score, best_move = score, i
            elif not is_bot and score < best_score:
                best_score, best_move = score, i
    return best_score, best_move


def bot_move(board: List[str]) -> int:
    _, move = _minimax(board, True)
    return move


def render(board: List[str]) -> str:
    cells = [c if c != EMPTY else "·" for c in board]
    rows = [" | ".join(cells[i:i + 3]) for i in range(0, 9, 3)]
    return "\n---------\n".join(rows)
