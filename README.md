# GameBuddy

Telegram-бот на aiogram 3 + Telegram Web App «Казино». В чате — мини-игры
(крестики-нолики, виселица, города, викторина, AI-чат и т.д.). По кнопке
**«Открыть Казино»** запускается полноценное Web App: слоты, рулетка, crash,
mines, кейсы, рогалик, 2048, змейка, кликер с прокачкой.

## Структура

```
main.py            # бот + aiohttp-сервер для webapp
games/             # модули игр для чата
webapp/            # фронт казино (HTML/CSS/JS, статика)
requirements.txt
Dockerfile
render.yaml        # one-click деплой на Render
.env.example
```

## Конфиг (env-переменные)

| Переменная     | Обязательно | Что это                                                      |
| -------------- | ----------- | ------------------------------------------------------------ |
| `BOT_TOKEN`    | да          | Токен из [@BotFather](https://t.me/BotFather)                |
| `PUBLIC_URL`   | для WebApp  | Публичный **HTTPS** адрес сервера. Без него кнопка казино не появится в меню. |
| `WEB_PORT`     | нет         | Порт веб-сервера (по умолчанию 8080)                         |
| `PORT`         | —           | Render проставит сам, перебивает `WEB_PORT`                  |
| `RENDER_EXTERNAL_URL` | —    | Render проставит сам, используется как `PUBLIC_URL`          |

> ⚠️ Telegram открывает Web App только по **HTTPS**. Локальный `http://localhost:8080`
> в кнопке работать не будет — нужен ngrok / cloudflared / нормальный хостинг.

## Деплой на Render (рекомендую)

1. Залогинься на [render.com](https://render.com), привяжи GitHub.
2. **New → Blueprint** → выбери этот репозиторий → Render найдёт `render.yaml`.
3. В шаге настройки впиши `BOT_TOKEN` (значение из BotFather).
4. Жми **Apply**. Через ~2-3 минуты сервис будет жив, Render выдаст URL вида
   `https://gamebuddy.onrender.com` — он автоматически подставится как `PUBLIC_URL`.
5. Открой бота в Telegram, нажми `/start` — увидишь кнопку **«Открыть Казино»**.

> Free-план Render усыпляет сервис через 15 минут простоя. Первый запрос после сна
> просыпается ~30 секунд. Для постоянной работы — апгрейд плана или другой хост.

## Запуск локально

Нужен Python 3.11+.

```bash
git clone https://github.com/gerainnn/Kok.git
cd Kok
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# отредактируй .env: впиши BOT_TOKEN

# вариант А: только бот в чате (без веб-казино)
python main.py

# вариант Б: с веб-казино, через ngrok
# в одном терминале:
python main.py
# во втором:
ngrok http 8080
# скопируй https://...ngrok-free.app, положи в .env как PUBLIC_URL,
# перезапусти main.py
```

Если в `.env` нет `PUBLIC_URL` — бот стартует, но кнопка **«Открыть Казино»**
не показывается. Все остальные игры в чате работают как обычно.

## Деплой на свой VPS (через Docker)

```bash
docker build -t gamebuddy .
docker run -d --restart unless-stopped \
  -e BOT_TOKEN=твой_токен \
  -e PUBLIC_URL=https://твой.домен \
  -p 8080:8080 \
  --name gamebuddy gamebuddy
```

За HTTPS обычно ставят nginx + certbot перед контейнером.

## Безопасность

- **Никогда не коммить `.env`** — он в `.gitignore`.
- Если токен бота когда-либо попал в публичный репозиторий, **отзови его** в
  BotFather (`/revoke`) и создай новый.
- Webhook не используется — бот работает по long polling.

## Команды бота

`/start /games /quiz /chat /city /joke /fact /riddle /story /dice /help`
