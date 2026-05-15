FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# зависимости отдельным слоем для кеширования
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# код
COPY . .

# Render/любой PaaS пробросит свой порт через $PORT
EXPOSE 8080

CMD ["python", "main.py"]
