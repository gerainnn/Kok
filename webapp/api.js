/* GameBuddy API client.
   Все запросы автоматически отправляют Telegram WebApp initData в заголовке X-Init-Data.
   Если запущено вне Telegram — initData пустой и сервер ответит 401, ловим и работаем
   в demo-режиме (баланс из localStorage, лидерборд недоступен).

   Поддержка форк-клиентов (AyuGram и т.п.):
     Часть форков не пробрасывает подписанный initData, но даёт initDataUnsafe.user.
     В этом случае мы дополнительно шлём заголовок X-TG-User с JSON-описанием юзера
     и считаем себя «в Telegram». Сервер примет такой логин, только если на нём
     включена переменная ALLOW_UNSIGNED_INITDATA=1.
*/
(() => {
"use strict";

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || "";
const unsafeUser = tg?.initDataUnsafe?.user || null;

// Считаем, что мы внутри Telegram, если есть подписанный initData ЛИБО
// форк-клиент дал нам хотя бы initDataUnsafe.user.id.
const hasUnsafeUser = !!(unsafeUser && (unsafeUser.id || unsafeUser.user_id));
const isTelegram = !!initData || hasUnsafeUser;

// Заголовок для форк-фолбека. Сервер использует его, только если нет валидной
// подписи и включён ALLOW_UNSIGNED_INITDATA. Безопаснее всегда — тогда сервер
// сам выберет: подпись приоритетнее.
let unsafeUserHeader = "";
if (hasUnsafeUser) {
  try {
    unsafeUserHeader = JSON.stringify({
      id:         unsafeUser.id || unsafeUser.user_id,
      username:   unsafeUser.username || null,
      first_name: unsafeUser.first_name || null,
      last_name:  unsafeUser.last_name || null,
      photo_url:  unsafeUser.photo_url || null,
    });
  } catch (e) { unsafeUserHeader = ""; }
}

async function http(method, path, body) {
  const headers = { "X-Init-Data": initData };
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

const API = {
  isTelegram,
  initData,

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
