/* GameBuddy API client.
   Все запросы автоматически отправляют Telegram WebApp initData в заголовке X-Init-Data.
   Если запущено вне Telegram — initData пустой и сервер ответит 401, ловим и работаем
   в demo-режиме (баланс из localStorage, лидерборд недоступен).

   Поддержка форк-клиентов (AyuGram и т.п.):
     Часть форков не пробрасывает подписанный initData, но даёт initDataUnsafe.user.
     В этом случае мы дополнительно шлём заголовок X-TG-User с JSON-описанием юзера
     и считаем себя «в Telegram». Сервер примет такой логин, только если на нём
     включена переменная ALLOW_UNSIGNED_INITDATA=1.

   ВАЖНО: initData читается при КАЖДОМ запросе (а не один раз при загрузке),
   потому что некоторые клиенты Telegram инициализируют SDK с задержкой.
*/
(() => {
"use strict";

// --- Вспомогательные функции для получения актуальных данных SDK ---

function _getTg() {
  return window.Telegram?.WebApp || null;
}

function _getInitData() {
  const tg = _getTg();
  return tg?.initData || "";
}

function _getUnsafeUser() {
  const tg = _getTg();
  return tg?.initDataUnsafe?.user || null;
}

function _buildUnsafeUserHeader() {
  const unsafeUser = _getUnsafeUser();
  if (!unsafeUser) return "";
  const uid = unsafeUser.id || unsafeUser.user_id;
  if (!uid) return "";
  try {
    return JSON.stringify({
      id:         uid,
      username:   unsafeUser.username || null,
      first_name: unsafeUser.first_name || null,
      last_name:  unsafeUser.last_name || null,
      photo_url:  unsafeUser.photo_url || null,
    });
  } catch (e) { return ""; }
}

function _checkIsTelegram() {
  const initData = _getInitData();
  if (initData) return true;
  const unsafeUser = _getUnsafeUser();
  if (unsafeUser && (unsafeUser.id || unsafeUser.user_id)) return true;
  return false;
}

// --- HTTP-обёртка: initData берётся свежий при каждом запросе ---

async function http(method, path, body) {
  const initData = _getInitData();
  const unsafeUserHeader = _buildUnsafeUserHeader();

  const headers = {};
  // Отправляем X-Init-Data только если он не пустой (избегаем мусорных заголовков)
  if (initData) headers["X-Init-Data"] = initData;
  if (unsafeUserHeader) headers["X-TG-User"] = unsafeUserHeader;

  let payload = undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    return { ok: false, error: "network", status: 0 };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    return { ok: false, error: data?.error || "http_" + res.status, status: res.status, data };
  }
  return { ok: true, status: res.status, data: data ?? {} };
}

// --- Public API ---

const API = {
  // isTelegram теперь — геттер, проверяет актуальное состояние SDK
  get isTelegram() { return _checkIsTelegram(); },
  get initData()   { return _getInitData(); },

  // Метод для ожидания готовности SDK (вызывается из app.js при старте)
  waitForSdk(timeoutMs = 3000) {
    return new Promise((resolve) => {
      // Если уже есть данные — сразу
      if (_getInitData() || _checkIsTelegram()) {
        resolve(true);
        return;
      }
      const start = Date.now();
      const interval = setInterval(() => {
        if (_getInitData() || _checkIsTelegram()) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(false); // таймаут — SDK так и не дал данные
        }
      }, 100);
    });
  },

  me:               ()      => http("GET",  "/api/me"),
  daily:            ()      => http("POST", "/api/daily"),
  bet:              (b)     => http("POST", "/api/bet", b),
  caseOpen:         (b)     => http("POST", "/api/cases/open", b),
  leaderboard:      (m, l)  => http("GET",  `/api/leaderboard?metric=${encodeURIComponent(m||"balance")}&limit=${l||50}`),

  shopList:         ()      => http("GET",  "/api/shop/list"),
  shopBuy:          (giftId)=> http("POST", "/api/shop/buy", { gift_id: giftId }),
  shopOrders:       ()      => http("GET",  "/api/shop/orders"),

  quizNext:         (cat)   => http("GET",  `/api/quiz/next?category=${encodeURIComponent(cat||"any")}`),
  quizAnswer:       (qid, p)=> http("POST", "/api/quiz/answer", { question_id: qid, picked: p }),
  quizReset:        ()      => http("POST", "/api/quiz/reset"),
};

window.GameBuddyAPI = API;
})();
