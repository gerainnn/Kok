/* ============================================================
   GameBuddy Casino — игровой движок
   ============================================================ */
(() => {
"use strict";

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready(); tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch (e) {}
}

// ---------- утилиты ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmt = (n) => Math.floor(n).toLocaleString("ru-RU");
const haptic = (kind = "light") => {
  try {
    if (kind === "win") tg?.HapticFeedback?.notificationOccurred?.("success");
    else if (kind === "lose") tg?.HapticFeedback?.notificationOccurred?.("error");
    else if (kind === "warn") tg?.HapticFeedback?.notificationOccurred?.("warning");
    else tg?.HapticFeedback?.impactOccurred?.(kind);
  } catch (e) {}
};
const rand = (a, b) => Math.random() * (b - a) + a;
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pickWeighted = (items) => {
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
};

// ---------- состояние ----------
const DEFAULT_STATE = {
  balance: 1000,
  taps: 0,
  earnedFromTaps: 0,
  perTap: 1,
  upgrades: { tap: 0, lucky: 0, vault: 0 },
  stats: {
    spins: 0, wins: 0, losses: 0,
    biggestWin: 0, totalWagered: 0, totalWon: 0,
    casesOpened: 0,
  },
  inventory: [],
  lastDaily: 0,
  bigWinThreshold: 1000,
};
const STORAGE_KEY = "gamebuddy_casino_v1";
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Object.assign({}, DEFAULT_STATE, JSON.parse(raw),
                                   { upgrades: Object.assign({}, DEFAULT_STATE.upgrades, JSON.parse(raw).upgrades || {}),
                                     stats: Object.assign({}, DEFAULT_STATE.stats, JSON.parse(raw).stats || {}) });
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

// ---------- общие UI ----------
const balanceEl = $("#balance");
const toastEl = $("#toast");

function refreshBalance() {
  balanceEl.textContent = fmt(state.balance);
  $$("[data-balance]").forEach(el => el.textContent = fmt(state.balance));
}
function toast(msg, type = "info", ms = 1800) {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.classList.remove("show"); }, ms);
}
function confettiBurst(n = 60) {
  const colors = ["#ffd966", "#ff66c4", "#66e0ff", "#a78bfa", "#4ade80", "#fb923c"];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("div");
    el.className = "confetti";
    el.style.left = (Math.random() * 100) + "vw";
    el.style.background = colors[i % colors.length];
    el.style.animationDelay = (Math.random() * 0.5) + "s";
    el.style.animationDuration = (2 + Math.random() * 1.5) + "s";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
}
function bigWinNotify(amount, game) {
  if (!tg || amount < state.bigWinThreshold) return;
  try {
    tg.sendData(JSON.stringify({ type: "big_win", game, amount: Math.floor(amount), balance: Math.floor(state.balance) }));
  } catch (e) {}
}
function adjustBalance(delta) {
  state.balance = Math.max(0, state.balance + delta);
  refreshBalance();
  save();
}
function tryWager(amount, max) {
  amount = Math.floor(amount);
  if (!Number.isFinite(amount) || amount <= 0) { toast("Некорректная ставка", "lose"); return 0; }
  if (max && amount > max) amount = max;
  if (amount > state.balance) { toast("Недостаточно средств", "lose"); return 0; }
  return amount;
}
function recordResult(game, wager, win) {
  state.stats.spins++;
  state.stats.totalWagered += wager;
  state.stats.totalWon += win;
  if (win > 0) state.stats.wins++; else state.stats.losses++;
  if (win > state.stats.biggestWin) state.stats.biggestWin = win;
  if (win >= state.bigWinThreshold) bigWinNotify(win, game);
  save();
}

// ---------- навигация ----------
$$(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.nav;
    $$(".nav-item").forEach(b => b.classList.toggle("active", b === btn));
    $$(".page").forEach(p => p.classList.toggle("active", p.dataset.page === target));
    haptic("light");
    if (target === "profile") renderProfile();
    if (target === "cases") renderCases();
  });
});

// ---------- screens ----------
function openScreen(id) {
  $("#screen-" + id).classList.add("open");
  haptic("light");
  refreshBalance();
}
function closeScreen() {
  $$(".screen.open").forEach(s => s.classList.remove("open"));
}
$$("[data-open]").forEach(el => el.addEventListener("click", () => openScreen(el.dataset.open)));
$$("[data-close]").forEach(el => el.addEventListener("click", closeScreen));

// quick bet chips
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip[data-bet]");
  if (!chip) return;
  const target = $("#" + chip.dataset.betTarget);
  if (!target) return;
  const v = chip.dataset.bet;
  target.value = (v === "max") ? Math.max(0, state.balance) : v;
  haptic("light");
});

// ---------- TAP / CLICKER ----------
const tapCoin = $("#tapCoin");
const tapPerClickEl = $("#tapPerClick");
const tapCountEl = $("#tapCount");
const tapEarnedEl = $("#tapEarned");

const UPGRADES = [
  { id: "tap", name: "Сильный палец", desc: "+1 к доходу за тап", baseCost: 100,
    apply: () => { state.perTap = 1 + state.upgrades.tap; } },
  { id: "lucky", name: "Удача", desc: "5% шанс x10 при тапе", baseCost: 500,
    apply: () => {} },
  { id: "vault", name: "Сейф", desc: "+5% к выигрышам в играх", baseCost: 1000,
    apply: () => {} },
];
function upgradeCost(u) { return Math.floor(u.baseCost * Math.pow(1.6, state.upgrades[u.id])); }
function applyAllUpgrades() { UPGRADES.forEach(u => u.apply()); }

function renderUpgrades() {
  const list = $("#upgradeList");
  list.innerHTML = "";
  for (const u of UPGRADES) {
    const lvl = state.upgrades[u.id];
    const cost = upgradeCost(u);
    const row = document.createElement("div");
    row.className = "upgrade";
    row.innerHTML = `
      <div class="upgrade-info">
        <div class="upgrade-name">${u.name} <span style="color:var(--text-dim); font-weight:600;">Lv.${lvl}</span></div>
        <div class="upgrade-desc">${u.desc}</div>
      </div>
      <button class="upgrade-buy">${fmt(cost)} 🪙</button>
    `;
    const btn = row.querySelector(".upgrade-buy");
    btn.disabled = state.balance < cost;
    btn.addEventListener("click", () => {
      if (state.balance < cost) { toast("Не хватает", "lose"); return; }
      adjustBalance(-cost);
      state.upgrades[u.id]++;
      applyAllUpgrades();
      tapPerClickEl.textContent = "+" + state.perTap + " за тап";
      renderUpgrades();
      haptic("medium");
      toast("Прокачано!", "win");
    });
    list.appendChild(row);
  }
}

function tapHandler(e) {
  let earn = state.perTap;
  let lucky = false;
  if (state.upgrades.lucky > 0 && Math.random() < 0.05 * state.upgrades.lucky) {
    earn *= 10;
    lucky = true;
  }
  state.balance += earn;
  state.taps++;
  state.earnedFromTaps += earn;
  refreshBalance();
  tapCountEl.textContent = fmt(state.taps);
  tapEarnedEl.textContent = fmt(state.earnedFromTaps);
  tapCoin.classList.remove("pulse"); void tapCoin.offsetWidth; tapCoin.classList.add("pulse");
  haptic(lucky ? "heavy" : "light");

  // floating +N
  const rect = tapCoin.getBoundingClientRect();
  const x = (e.touches?.[0]?.clientX ?? e.clientX ?? rect.left + rect.width / 2);
  const y = (e.touches?.[0]?.clientY ?? e.clientY ?? rect.top + rect.height / 2);
  const float = document.createElement("div");
  float.className = "coin-float";
  float.textContent = (lucky ? "🍀 +" : "+") + earn;
  float.style.left = x + "px";
  float.style.top = (y - 20) + "px";
  document.body.appendChild(float);
  setTimeout(() => float.remove(), 1100);

  // throttled save
  if (state.taps % 10 === 0) save();
}
tapCoin.addEventListener("pointerdown", tapHandler);

// ---------- DAILY BONUS ----------
const dailyBtn = $("#dailyBtn");
function refreshDaily() {
  const ms = 22 * 60 * 60 * 1000; // 22h
  const ready = Date.now() - state.lastDaily >= ms;
  if (ready) {
    dailyBtn.disabled = false;
    dailyBtn.textContent = "🎁 +500";
  } else {
    const left = ms - (Date.now() - state.lastDaily);
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    dailyBtn.disabled = true;
    dailyBtn.textContent = `⏳ ${h}ч ${m}м`;
  }
}
dailyBtn.addEventListener("click", () => {
  const ms = 22 * 60 * 60 * 1000;
  if (Date.now() - state.lastDaily < ms) return;
  const reward = 500;
  adjustBalance(reward);
  state.lastDaily = Date.now();
  save();
  refreshDaily();
  confettiBurst(40);
  toast("Бонус +" + fmt(reward), "win");
  haptic("win");
});
setInterval(refreshDaily, 60000);

// ---------- SLOTS ----------
const SLOT_SYMBOLS = [
  { s: "🍋", w: 30 },
  { s: "🍒", w: 25 },
  { s: "🍀", w: 18 },
  { s: "⭐", w: 12 },
  { s: "💎", w: 8 },
  { s: "7️⃣", w: 4 },
];
const SLOT_PAYOUT = { "🍋": 3, "🍒": 5, "🍀": 7, "⭐": 10, "💎": 20, "7️⃣": 50 };

function renderReelStrip(reelEl, finalSym) {
  const seq = [];
  for (let i = 0; i < 25; i++) seq.push(pickWeighted(SLOT_SYMBOLS).s);
  seq.push(finalSym);
  reelEl.style.transition = "none";
  reelEl.style.transform = "translateY(0)";
  reelEl.innerHTML = seq.map(s => `<div>${s}</div>`).join("");
  // force reflow
  void reelEl.offsetWidth;
}
function spinReel(reelEl, finalSym, duration) {
  return new Promise((resolve) => {
    renderReelStrip(reelEl, finalSym);
    const total = reelEl.children.length;
    const offset = -(total - 1) * 110;
    reelEl.style.transition = `transform ${duration}ms cubic-bezier(0.15, 0.7, 0.3, 1)`;
    requestAnimationFrame(() => {
      reelEl.style.transform = `translateY(${offset}px)`;
    });
    setTimeout(resolve, duration + 50);
  });
}

$("#slotsSpin").addEventListener("click", async () => {
  const bet = tryWager(parseInt($("#slotsBet").value, 10), state.balance);
  if (!bet) return;
  const btn = $("#slotsSpin");
  btn.disabled = true;
  $("#slotsResult").innerHTML = "";
  adjustBalance(-bet);
  haptic("light");

  const result = [
    pickWeighted(SLOT_SYMBOLS).s,
    pickWeighted(SLOT_SYMBOLS).s,
    pickWeighted(SLOT_SYMBOLS).s,
  ];

  await Promise.all([
    spinReel($("#reel0"), result[0], 2200),
    spinReel($("#reel1"), result[1], 3000),
    spinReel($("#reel2"), result[2], 3800),
  ]);

  let win = 0;
  let label = "";
  if (result[0] === result[1] && result[1] === result[2]) {
    const m = SLOT_PAYOUT[result[0]];
    win = bet * m;
    label = `${result.join(" ")} — x${m} ДЖЕКПОТ!`;
  } else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
    win = Math.floor(bet * 1.5);
    label = `${result.join(" ")} — пара x1.5`;
  } else {
    label = `${result.join(" ")} — мимо`;
  }
  if (win > 0 && state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));

  recordResult("slots", bet, win);
  if (win > 0) {
    adjustBalance(win);
    $("#slotsResult").innerHTML = `<div class="result-banner win">+${fmt(win)} · ${label}</div>`;
    toast("Выигрыш +" + fmt(win), "win");
    haptic("win");
    if (win >= bet * 10) confettiBurst(80);
  } else {
    $("#slotsResult").innerHTML = `<div class="result-banner lose">${label}</div>`;
    haptic("lose");
  }
  btn.disabled = false;
});

// ---------- ROULETTE ----------
const RED_NUMS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function rouletteColor(n) {
  if (n === 0) return "green";
  return RED_NUMS.has(n) ? "red" : "black";
}
let roulSelectedBet = "red";
$$("#roulBets .roul-bet").forEach(b => {
  b.addEventListener("click", () => {
    $$("#roulBets .roul-bet").forEach(x => x.classList.remove("selected"));
    b.classList.add("selected");
    roulSelectedBet = b.dataset.rbet;
    haptic("light");
  });
});
$$("#roulBets .roul-bet")[0].classList.add("selected");

function checkRouletteWin(num, betKey) {
  if (num === 0) return betKey === "zero" ? 36 : 0;
  switch (betKey) {
    case "red": return rouletteColor(num) === "red" ? 2 : 0;
    case "black": return rouletteColor(num) === "black" ? 2 : 0;
    case "zero": return 0;
    case "even": return num % 2 === 0 ? 2 : 0;
    case "odd": return num % 2 === 1 ? 2 : 0;
    case "low": return num <= 18 ? 2 : 0;
    case "high": return num >= 19 ? 2 : 0;
    case "d1": return num <= 12 ? 3 : 0;
    case "d2": return num >= 13 && num <= 24 ? 3 : 0;
    default: return 0;
  }
}

let roulCurrentRotation = 0;
$("#roulSpin").addEventListener("click", () => {
  const bet = tryWager(parseInt($("#roulBet").value, 10), state.balance);
  if (!bet) return;
  const btn = $("#roulSpin");
  btn.disabled = true;
  adjustBalance(-bet);
  haptic("light");

  const num = randInt(0, 36);
  // позиция числа в европейской последовательности (упрощённо: 0 сверху, дальше по часовой)
  const order = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const idx = order.indexOf(num);
  const segDeg = 360 / 37;
  const targetAngle = -(idx * segDeg + segDeg / 2); // указатель сверху
  roulCurrentRotation += 360 * 6 + (targetAngle - (roulCurrentRotation % 360));
  $("#roulWheel").style.transform = `rotate(${roulCurrentRotation}deg)`;
  $("#roulResult").textContent = "...";

  setTimeout(() => {
    const mult = checkRouletteWin(num, roulSelectedBet);
    let win = bet * mult;
    if (win > 0 && state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
    const color = rouletteColor(num);
    const colorEmoji = color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";
    $("#roulResult").innerHTML = `${colorEmoji} <b>${num}</b> · ${win > 0 ? `+${fmt(win)}` : "мимо"}`;
    recordResult("roulette", bet, win);
    if (win > 0) {
      adjustBalance(win);
      toast("+" + fmt(win), "win");
      haptic("win");
      if (mult >= 10) confettiBurst(80);
    } else {
      haptic("lose");
    }
    btn.disabled = false;
  }, 5100);
});

// ---------- CRASH ----------
const crashHistory = [];
function pickCrashPoint() {
  // тяжёлый хвост, RTP ~95%
  const r = Math.random();
  if (r < 0.05) return 1.00;
  // обратный экспоненциальный
  const e = Math.random();
  let v = 0.95 / (1 - e);
  if (v > 50) v = 50;
  return Math.max(1.01, parseFloat(v.toFixed(2)));
}
let crashAnim = null;
$("#crashStart").addEventListener("click", () => {
  if (crashAnim) return;
  const bet = tryWager(parseInt($("#crashBet").value, 10), state.balance);
  if (!bet) return;
  const btn = $("#crashStart");
  adjustBalance(-bet);
  haptic("light");

  const target = pickCrashPoint();
  let mult = 1.00;
  let cashed = false;
  const start = performance.now();
  const multEl = $("#crashMult");
  const rocketEl = $("#crashRocket");
  multEl.classList.remove("crashed");

  btn.textContent = "💰 Забрать";
  btn.classList.add("btn-danger");
  btn.disabled = false;
  btn.classList.remove("btn-primary");

  const onCash = () => {
    if (cashed) return;
    cashed = true;
    let win = Math.floor(bet * mult);
    if (state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
    adjustBalance(win);
    recordResult("crash", bet, win);
    toast(`Забрал на x${mult.toFixed(2)} · +${fmt(win)}`, "win");
    haptic("win");
    if (mult >= 5) confettiBurst(80);
  };
  btn.onclick = onCash;

  function frame(now) {
    const t = (now - start) / 1000;
    mult = parseFloat((1 + Math.pow(t, 1.4) * 0.45).toFixed(2));
    if (mult >= target) {
      multEl.textContent = `${target.toFixed(2)}x · CRASH`;
      multEl.classList.add("crashed");
      rocketEl.textContent = "💥";
      crashHistory.unshift(target);
      if (crashHistory.length > 8) crashHistory.pop();
      renderCrashHistory();
      if (!cashed) {
        recordResult("crash", bet, 0);
        haptic("lose");
        toast(`Упал на x${target.toFixed(2)}`, "lose");
      }
      crashAnim = null;
      btn.onclick = null;
      btn.textContent = "🚀 Старт";
      btn.classList.remove("btn-danger");
      btn.classList.add("btn-primary");
      btn.addEventListener("click", arguments.callee, { once: true }); // no-op safety
      btn.disabled = false;
      // restore default handler
      setTimeout(() => {
        rocketEl.textContent = "🚀";
        rocketEl.style.transform = "translate(0,0)";
      }, 1200);
      return;
    }
    multEl.textContent = mult.toFixed(2) + "x";
    // rocket parametric
    const dx = Math.min(280, t * 60);
    const dy = -Math.min(180, t * 40);
    rocketEl.style.transform = `translate(${dx}px, ${dy}px) rotate(-30deg)`;
    crashAnim = requestAnimationFrame(frame);
  }
  crashAnim = requestAnimationFrame(frame);
});

function renderCrashHistory() {
  const c = $("#crashHistory");
  c.innerHTML = crashHistory.map(v =>
    `<span class="crash-h-item ${v >= 2 ? "high" : "low"}">x${v.toFixed(2)}</span>`
  ).join("");
}

// reset crash button on close
$("#screen-crash [data-close]").addEventListener("click", () => {
  if (crashAnim) cancelAnimationFrame(crashAnim);
  crashAnim = null;
  const btn = $("#crashStart");
  btn.textContent = "🚀 Старт"; btn.classList.remove("btn-danger"); btn.classList.add("btn-primary");
  btn.onclick = null; btn.disabled = false;
  $("#crashMult").textContent = "1.00x"; $("#crashMult").classList.remove("crashed");
  $("#crashRocket").textContent = "🚀"; $("#crashRocket").style.transform = "";
});

// ---------- MINES ----------
const minesState = { active: false, bet: 0, bombs: 5, opened: 0, mult: 1, bombSet: null, finished: false };
const MINES_TOTAL = 25;

function minesPayout(open, bombs) {
  // RTP ~96% по формуле гипергеометрии
  const safe = MINES_TOTAL - bombs;
  let p = 1;
  for (let i = 0; i < open; i++) p *= (safe - i) / (MINES_TOTAL - i);
  return p > 0 ? 0.96 / p : 0;
}
function buildMinesGrid() {
  const grid = $("#minesGrid");
  grid.innerHTML = "";
  for (let i = 0; i < MINES_TOTAL; i++) {
    const cell = document.createElement("div");
    cell.className = "mine-cell";
    cell.dataset.i = i;
    cell.addEventListener("click", () => onMineClick(i, cell));
    grid.appendChild(cell);
  }
}
function onMineClick(i, cell) {
  if (!minesState.active || minesState.finished || cell.classList.contains("opened")) return;
  if (minesState.bombSet.has(i)) {
    cell.classList.add("bomb", "opened");
    cell.textContent = "💣";
    // показать остальные
    minesState.bombSet.forEach(b => {
      if (b !== i) {
        const c = $(`.mine-cell[data-i="${b}"]`);
        c.classList.add("bomb", "opened");
        c.textContent = "💣";
      }
    });
    $$("#minesGrid .mine-cell").forEach(c => c.classList.add("disabled"));
    minesState.finished = true;
    minesState.active = false;
    recordResult("mines", minesState.bet, 0);
    $("#minesCashout").style.display = "none";
    $("#minesStart").style.display = "block";
    haptic("lose");
    toast("Бомба! Раунд проигран", "lose");
  } else {
    cell.classList.add("opened");
    cell.textContent = "💎";
    minesState.opened++;
    minesState.mult = minesPayout(minesState.opened, minesState.bombs);
    $("#minesMult").textContent = minesState.mult.toFixed(2) + "x";
    $("#minesWin").textContent = fmt(Math.floor(minesState.bet * minesState.mult));
    $("#minesOpen").textContent = minesState.opened;
    haptic("light");
  }
}
$("#minesStart").addEventListener("click", () => {
  const bet = tryWager(parseInt($("#minesBet").value, 10), state.balance);
  if (!bet) return;
  let bombs = parseInt($("#minesBombs").value, 10);
  if (!Number.isFinite(bombs)) bombs = 5;
  bombs = Math.max(3, Math.min(15, bombs));
  $("#minesBombs").value = bombs;
  adjustBalance(-bet);
  buildMinesGrid();
  const set = new Set();
  while (set.size < bombs) set.add(randInt(0, MINES_TOTAL - 1));
  Object.assign(minesState, { active: true, finished: false, bet, bombs, opened: 0, mult: 1, bombSet: set });
  $("#minesMult").textContent = "1.00x";
  $("#minesWin").textContent = "0";
  $("#minesOpen").textContent = "0";
  $("#minesStart").style.display = "none";
  $("#minesCashout").style.display = "block";
  haptic("light");
});
$("#minesCashout").addEventListener("click", () => {
  if (!minesState.active || minesState.opened === 0) { toast("Сначала открой клетку", "info"); return; }
  let win = Math.floor(minesState.bet * minesState.mult);
  if (state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
  adjustBalance(win);
  recordResult("mines", minesState.bet, win);
  toast(`Забрал +${fmt(win)} (${minesState.mult.toFixed(2)}x)`, "win");
  haptic("win");
  if (minesState.mult >= 3) confettiBurst(80);
  $$("#minesGrid .mine-cell").forEach(c => c.classList.add("disabled"));
  minesState.active = false;
  $("#minesCashout").style.display = "none";
  $("#minesStart").style.display = "block";
});
buildMinesGrid();

// ---------- WHEEL OF FORTUNE ----------
const WHEEL_SEGS = [
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 1.5,  color: "#3b82f6", label: "x1.5" },
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 2,    color: "#22c55e", label: "x2" },
  { mult: 0.5,  color: "#dc2626", label: "x0.5" },
  { mult: 3,    color: "#a855f7", label: "x3" },
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 10,   color: "#ffd966", label: "x10" },
];
function buildWheel() {
  const w = $("#luckyWheel");
  w.innerHTML = "";
  const n = WHEEL_SEGS.length;
  const seg = 360 / n;
  // создаём SVG для сегментов — проще, чем CSS conic
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  svg.style.position = "absolute";
  svg.style.inset = 0;
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.transform = "rotate(-90deg)"; // 0° по верху
  for (let i = 0; i < n; i++) {
    const a0 = (i * seg) * Math.PI / 180;
    const a1 = ((i + 1) * seg) * Math.PI / 180;
    const x0 = Math.cos(a0), y0 = Math.sin(a0);
    const x1 = Math.cos(a1), y1 = Math.sin(a1);
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", `M0,0 L${x0},${y0} A1,1 0 0,1 ${x1},${y1} Z`);
    path.setAttribute("fill", WHEEL_SEGS[i].color);
    path.setAttribute("stroke", "#fff7c8");
    path.setAttribute("stroke-width", "0.01");
    svg.appendChild(path);

    const ax = ((i + 0.5) * seg) * Math.PI / 180;
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", Math.cos(ax) * 0.65);
    text.setAttribute("y", Math.sin(ax) * 0.65);
    text.setAttribute("transform", `rotate(${(i + 0.5) * seg + 90}, ${Math.cos(ax) * 0.65}, ${Math.sin(ax) * 0.65})`);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("fill", "#fff");
    text.setAttribute("font-weight", "900");
    text.setAttribute("font-size", "0.16");
    text.setAttribute("style", "text-shadow: 0 1px 2px rgba(0,0,0,0.7); paint-order: stroke; stroke: rgba(0,0,0,0.7); stroke-width: 0.01;");
    text.textContent = WHEEL_SEGS[i].label;
    svg.appendChild(text);
  }
  w.appendChild(svg);
}
buildWheel();

let wheelRotation = 0;
$("#wheelSpin").addEventListener("click", () => {
  const bet = tryWager(parseInt($("#wheelBet").value, 10), state.balance);
  if (!bet) return;
  const btn = $("#wheelSpin");
  btn.disabled = true;
  adjustBalance(-bet);
  haptic("light");

  // вес: x0=20%, x0.5=15%, x1.5=20%, x2=15%, x3=10%, x10=5%, остальные x0
  const weights = [25, 15, 20, 12, 8, 8, 7, 5];
  let r = Math.random() * weights.reduce((a,b)=>a+b);
  let idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  const segDeg = 360 / WHEEL_SEGS.length;
  // указатель сверху, мы хотим idx-й сегмент под указателем
  const target = -(idx * segDeg + segDeg / 2);
  wheelRotation += 360 * 6 + (target - (wheelRotation % 360));
  $("#luckyWheel").style.transform = `rotate(${wheelRotation}deg)`;
  $("#wheelResult").textContent = "...";

  setTimeout(() => {
    const seg = WHEEL_SEGS[idx];
    let win = Math.floor(bet * seg.mult);
    if (win > 0 && state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
    if (win > 0) {
      adjustBalance(win);
      $("#wheelResult").innerHTML = `🎉 <b>${seg.label}</b> · +${fmt(win)}`;
      toast("+" + fmt(win), "win");
      haptic("win");
      if (seg.mult >= 3) confettiBurst(80);
    } else {
      $("#wheelResult").innerHTML = `<span style="color:var(--red)">${seg.label}</span> мимо`;
      haptic("lose");
    }
    recordResult("wheel", bet, win);
    btn.disabled = false;
  }, 5100);
});

// ---------- COINFLIP ----------
let cfChoice = "heads";
$$("[data-cf]").forEach(b => b.addEventListener("click", () => {
  $$("[data-cf]").forEach(x => x.classList.remove("selected"));
  b.classList.add("selected");
  cfChoice = b.dataset.cf;
  haptic("light");
}));
$$("[data-cf]")[0].classList.add("selected");

$("#cfFlip").addEventListener("click", () => {
  const bet = tryWager(parseInt($("#cfBet").value, 10), state.balance);
  if (!bet) return;
  const btn = $("#cfFlip");
  btn.disabled = true;
  adjustBalance(-bet);
  const coin = $("#cfCoin");
  coin.classList.remove("flipping"); void coin.offsetWidth; coin.classList.add("flipping");
  haptic("light");
  const result = Math.random() < 0.5 ? "heads" : "tails";
  setTimeout(() => {
    coin.textContent = result === "heads" ? "🦅" : "$";
    let win = 0;
    if (result === cfChoice) {
      win = bet * 2;
      if (state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
      adjustBalance(win);
      toast(`+${fmt(win)} · ${result === "heads" ? "Орёл" : "Решка"}`, "win");
      haptic("win");
    } else {
      toast(`Выпало ${result === "heads" ? "Орёл" : "Решка"}`, "lose");
      haptic("lose");
    }
    recordResult("coinflip", bet, win);
    btn.disabled = false;
  }, 1700);
});

// ---------- CASES ----------
const CASES = [
  { id: "bronze", name: "Бронза", icon: "📦", price: 100, tier: "bronze",
    items: [
      { ico: "🍂", name: "Лист", v: 50,    rarity: "common", w: 50 },
      { ico: "🪵", name: "Палка", v: 100,  rarity: "common", w: 28 },
      { ico: "🔧", name: "Гайка", v: 200,  rarity: "rare",   w: 12 },
      { ico: "⚙️", name: "Шестерня", v: 400, rarity: "rare", w: 6 },
      { ico: "🪙", name: "Монета", v: 800, rarity: "epic",  w: 3 },
      { ico: "💍", name: "Кольцо", v: 2000, rarity: "legend", w: 0.9 },
      { ico: "👑", name: "Корона", v: 10000, rarity: "myth", w: 0.1 },
    ]},
  { id: "silver", name: "Серебро", icon: "🎁", price: 500, tier: "silver",
    items: [
      { ico: "🥉", name: "Бронза", v: 200,   rarity: "common", w: 35 },
      { ico: "🥈", name: "Серебро", v: 600,  rarity: "rare",   w: 30 },
      { ico: "🪄", name: "Палочка", v: 1200, rarity: "rare",   w: 15 },
      { ico: "💎", name: "Алмазик", v: 2500, rarity: "epic",   w: 12 },
      { ico: "🗡️", name: "Меч", v: 5000,    rarity: "legend", w: 6 },
      { ico: "🛡️", name: "Щит", v: 12000,   rarity: "legend", w: 1.5 },
      { ico: "🌟", name: "Звезда", v: 30000, rarity: "myth",   w: 0.5 },
    ]},
  { id: "gold", name: "Золото", icon: "🏆", price: 2000, tier: "gold",
    items: [
      { ico: "🥇", name: "Медаль", v: 800,    rarity: "common", w: 25 },
      { ico: "💰", name: "Мешок", v: 2000,    rarity: "rare",   w: 30 },
      { ico: "💎", name: "Алмаз", v: 5000,    rarity: "epic",   w: 22 },
      { ico: "👑", name: "Корона", v: 12000,  rarity: "epic",   w: 12 },
      { ico: "🐉", name: "Дракон", v: 30000,  rarity: "legend", w: 7 },
      { ico: "🦄", name: "Единорог", v: 75000, rarity: "myth",  w: 3 },
      { ico: "🌌", name: "Галактика", v: 200000, rarity: "myth", w: 1 },
    ]},
  { id: "diamond", name: "Алмазный", icon: "💎", price: 10000, tier: "diamond",
    items: [
      { ico: "💎", name: "Алмазный осколок", v: 5000,  rarity: "common", w: 25 },
      { ico: "🔮", name: "Сфера", v: 15000,             rarity: "rare",   w: 30 },
      { ico: "👑", name: "Корона эпик", v: 35000,       rarity: "epic",   w: 22 },
      { ico: "🐲", name: "Тёмный дракон", v: 80000,    rarity: "legend", w: 12 },
      { ico: "🦄", name: "Звёздный единорог", v: 200000, rarity: "myth", w: 7 },
      { ico: "🌟", name: "Сверхновая", v: 500000,       rarity: "myth",   w: 3 },
      { ico: "👽", name: "Космос", v: 1500000,          rarity: "myth",   w: 1 },
    ]},
];

function renderCases() {
  const list = $("#caseList");
  list.innerHTML = "";
  for (const c of CASES) {
    const card = document.createElement("div");
    card.className = "case-card " + c.tier;
    card.innerHTML = `
      <div class="case-icon">${c.icon}</div>
      <div class="case-name">${c.name}</div>
      <div class="case-price">${fmt(c.price)} 🪙</div>`;
    card.addEventListener("click", () => openCase(c));
    list.appendChild(card);
  }
  renderInventory();
}

function renderInventory() {
  const inv = $("#invGrid");
  inv.innerHTML = "";
  if (state.inventory.length === 0) {
    inv.innerHTML = `<div class="inv-empty" style="grid-column: span 4;">Пусто. Открой кейс!</div>`;
    return;
  }
  // последние 24
  const items = state.inventory.slice(-24).reverse();
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "inv-item";
    el.innerHTML = `<div>${it.ico}</div><div class="v">${fmt(it.v)}</div>`;
    el.title = it.name;
    inv.appendChild(el);
  }
}

let currentCase = null;
function openCase(c) {
  currentCase = c;
  $("#caseTitle").textContent = c.icon + " " + c.name;

  // paytable
  const pay = $("#casePaytable");
  pay.innerHTML = "<div style='font-weight:700; margin-bottom:6px;'>Призы:</div>" +
    c.items.map(it => `
      <div class="row">
        <div class="ico">${it.ico}</div>
        <div class="name r-${it.rarity}">${it.name}</div>
        <div class="pay">${fmt(it.v)} 🪙</div>
      </div>`).join("");

  // strip
  const strip = $("#caseRollStrip");
  strip.style.transition = "none";
  strip.style.transform = "translateX(0)";
  strip.innerHTML = "";

  // empty result
  $("#caseResultBox").innerHTML = "";

  // configure button
  const btn = $("#caseOpenBtn");
  btn.textContent = `📦 Открыть · ${fmt(c.price)} 🪙`;
  btn.disabled = false;
  btn.onclick = () => doOpenCase(c);

  openScreen("case");
}

function doOpenCase(c) {
  const btn = $("#caseOpenBtn");
  if (state.balance < c.price) { toast("Не хватает", "lose"); return; }
  adjustBalance(-c.price);
  btn.disabled = true;
  haptic("light");

  // выбираем приз заранее
  const won = pickWeighted(c.items);

  // строим ленту
  const strip = $("#caseRollStrip");
  const itemW = 90;
  const total = 60;
  const winIndex = 50; // куда приземлится курсор
  const items = [];
  for (let i = 0; i < total; i++) {
    if (i === winIndex) items.push(won);
    else items.push(pickWeighted(c.items));
  }
  strip.innerHTML = items.map(it => `
    <div class="case-roll-item r-${it.rarity}">
      <div>${it.ico}</div>
      <div class="v">${fmt(it.v)}</div>
    </div>`).join("");

  // позиция: маркер в центре экрана; смещаем strip так,
  // чтобы winIndex-й item оказался под маркером
  const screenW = $("#screen-case .screen-body").clientWidth - 32; // padding
  const containerW = $(".case-roll").clientWidth;
  const offset = winIndex * itemW + itemW / 2 - containerW / 2 + (Math.random() - 0.5) * 30;

  strip.style.transition = "none";
  strip.style.transform = "translateX(0)";
  void strip.offsetWidth;
  strip.style.transition = "transform 5s cubic-bezier(0.1, 0.7, 0.2, 1)";
  strip.style.transform = `translateX(${-offset}px)`;

  setTimeout(() => {
    // показываем результат
    let prize = won.v;
    if (state.upgrades.vault > 0) prize = Math.floor(prize * (1 + 0.05 * state.upgrades.vault));
    adjustBalance(prize);
    state.inventory.push({ ico: won.ico, name: won.name, v: prize });
    state.stats.casesOpened++;
    recordResult("case_" + c.id, c.price, prize);
    save();

    $("#caseResultBox").innerHTML = `
      <div class="case-result r-${won.rarity}">
        <div class="ico">${won.ico}</div>
        <div class="v" style="color: var(--gold);">+${fmt(prize)} · ${won.name}</div>
      </div>`;

    if (prize >= c.price * 5) confettiBurst(120);
    if (prize >= c.price) { toast("Победа +" + fmt(prize), "win"); haptic("win"); }
    else { toast(`Выпал ${won.name} (${fmt(prize)})`, "info"); haptic("warn"); }

    btn.textContent = `🔄 Ещё раз · ${fmt(c.price)} 🪙`;
    btn.disabled = false;
  }, 5100);
}

// ---------- PROFILE ----------
function levelFromBalance(stats) {
  const xp = stats.totalWagered;
  const lvl = Math.floor(Math.sqrt(xp / 500)) + 1;
  const titles = ["Новичок", "Любитель", "Игрок", "Профи", "Высокий ролл", "Магнат", "Легенда", "Миф", "Космос"];
  const t = titles[Math.min(titles.length - 1, Math.floor(lvl / 3))];
  return { lvl, title: t };
}
function renderProfile() {
  const { lvl, title } = levelFromBalance(state.stats);
  const user = tg?.initDataUnsafe?.user;
  const name = user?.first_name || user?.username || "Игрок";
  const avatar = (user?.first_name?.[0] || "🎮").toUpperCase();
  $("#profileAvatar").textContent = avatar;
  $("#profileName").textContent = name;
  $("#profileLevel").textContent = `${title} · Lv.${lvl}`;

  const s = state.stats;
  const winrate = s.spins ? Math.round(s.wins / s.spins * 100) : 0;
  const grid = $("#statGrid");
  grid.innerHTML = `
    <div class="stat-tile"><div class="label">Игр сыграно</div><div class="value">${fmt(s.spins)}</div></div>
    <div class="stat-tile"><div class="label">Винрейт</div><div class="value">${winrate}%</div></div>
    <div class="stat-tile"><div class="label">Самый большой выигрыш</div><div class="value" style="color:var(--gold);">${fmt(s.biggestWin)}</div></div>
    <div class="stat-tile"><div class="label">Кейсов открыто</div><div class="value">${fmt(s.casesOpened)}</div></div>
    <div class="stat-tile"><div class="label">Всего поставлено</div><div class="value">${fmt(s.totalWagered)}</div></div>
    <div class="stat-tile"><div class="label">Всего выиграно</div><div class="value" style="color:var(--green);">${fmt(s.totalWon)}</div></div>
    <div class="stat-tile"><div class="label">Тапов</div><div class="value">${fmt(state.taps)}</div></div>
    <div class="stat-tile"><div class="label">Баланс</div><div class="value" style="color:var(--gold);">${fmt(state.balance)}</div></div>
  `;
}

$("#resetBtn").addEventListener("click", () => {
  if (!confirm("Точно сбросить весь прогресс?")) return;
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  save();
  applyAllUpgrades();
  refreshBalance();
  renderUpgrades();
  refreshDaily();
  renderProfile();
  renderCases();
  tapPerClickEl.textContent = "+" + state.perTap + " за тап";
  tapCountEl.textContent = "0";
  tapEarnedEl.textContent = "0";
  toast("Прогресс сброшен", "info");
});

// ---------- INIT ----------
applyAllUpgrades();
refreshBalance();
renderUpgrades();
renderCases();
refreshDaily();
tapPerClickEl.textContent = "+" + state.perTap + " за тап";
tapCountEl.textContent = fmt(state.taps);
tapEarnedEl.textContent = fmt(state.earnedFromTaps);
renderCrashHistory();

})();
