/* GameBuddy API client.
   Все запросы автоматически отправляют Telegram WebApp initData в заголовке X-Init-Data.
   Если запущено вне Telegram — initData пустой и сервер ответит 401, ловим и работаем
   в demo-режиме (баланс из localStorage, лидерборд недоступен).
*/
(() => {
"use strict";

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || "";

const isTelegram = !!initData;

async function http(method, path, body) {
  const headers = { "X-Init-Data": initData };
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
