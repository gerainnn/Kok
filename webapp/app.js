/* ============================================================
   GameBuddy Casino — игровой движок (v2: проигрышное казино,
   кейсы x1/x5/x10, инвентарь со стеком, контракт, in-app big win)
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
    contractsRun: 0,
  },
  inventory: [],          // [{ico, name, v, rarity}]   стекаем по ключу name+v
  lastDaily: 0,
  bigWinThreshold: 5000,  // повышен порог уведомления, чтобы не спамить
};
const STORAGE_KEY = "gamebuddy_casino_v2";
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_STATE, parsed, {
        upgrades: Object.assign({}, DEFAULT_STATE.upgrades, parsed.upgrades || {}),
        stats: Object.assign({}, DEFAULT_STATE.stats, parsed.stats || {}),
      });
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

// ---------- инвентарь как стек ----------
function invKey(it) { return `${it.rarity}|${it.name}|${it.v}|${it.ico}`; }

function invAdd(item) {
  const key = invKey(item);
  const found = state.inventory.find(x => invKey(x) === key);
  if (found) found.qty = (found.qty || 1) + 1;
  else state.inventory.push({ ...item, qty: 1 });
}
function invRemove(item, count = 1) {
  const idx = state.inventory.findIndex(x => invKey(x) === invKey(item));
  if (idx < 0) return 0;
  const cur = state.inventory[idx];
  cur.qty = (cur.qty || 1) - count;
  if (cur.qty <= 0) state.inventory.splice(idx, 1);
  return count;
}
function invTotalQty(it) {
  const f = state.inventory.find(x => invKey(x) === invKey(it));
  return f ? (f.qty || 1) : 0;
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

// ---------- BIG WIN MODAL внутри приложения ----------
const bigWinModal = $("#bigWinModal");
$("#bwClose").addEventListener("click", () => bigWinModal.classList.remove("open"));
function showBigWin(amount, gameTitle, opts = {}) {
  $("#bwIco").textContent = opts.ico || (amount >= 50000 ? "🤑" : amount >= 20000 ? "🎰" : "🔥");
  $("#bwTitle").textContent = opts.title || (amount >= 50000 ? "ДЖЕКПОТ!" : "Большой выигрыш!");
  $("#bwSub").textContent = gameTitle || "Удача";
  $("#bwAmount").textContent = "+" + fmt(amount) + " 🪙";
  bigWinModal.classList.add("open");
  haptic("win");
  confettiBurst(80);
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
  if (win >= state.bigWinThreshold) {
    const titles = { slots: "🎰 Слоты", roulette: "🎯 Рулетка", crash: "🚀 Crash",
      mines: "💣 Mines", wheel: "🎡 Колесо", coinflip: "🪙 Coinflip" };
    showBigWin(win, titles[game] || "");
  }
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
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeScreen();
});

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

// ---------- TAP / CLICKER (без изменений) ----------
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

  if (state.taps % 10 === 0) save();
}
tapCoin.addEventListener("pointerdown", tapHandler);

// ---------- DAILY BONUS ----------
const dailyBtn = $("#dailyBtn");
function refreshDaily() {
  const ms = 22 * 60 * 60 * 1000;
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

// ============================================================
// ⚖️  Балансировка: казино теперь проигрышное (RTP ~85-92%)
// ============================================================

// ---------- SLOTS (порезанные выплаты) ----------
const SLOT_SYMBOLS = [
  { s: "🍋", w: 38 },
  { s: "🍒", w: 28 },
  { s: "🍀", w: 18 },
  { s: "⭐", w: 9 },
  { s: "💎", w: 5 },
  { s: "7️⃣", w: 2 },
];
// было: lemon x3, cherry x5, clover x7, star x10, diamond x20, seven x50
// стало:
const SLOT_PAYOUT = { "🍋": 2, "🍒": 3, "🍀": 4, "⭐": 6, "💎": 12, "7️⃣": 30 };
const SLOT_PAIR_PAYOUT = 0;  // пары больше не платят

function renderReelStrip(reelEl, finalSym) {
  const seq = [];
  for (let i = 0; i < 25; i++) seq.push(pickWeighted(SLOT_SYMBOLS).s);
  seq.push(finalSym);
  reelEl.style.transition = "none";
  reelEl.style.transform = "translateY(0)";
  reelEl.innerHTML = seq.map(s => `<div>${s}</div>`).join("");
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
    label = `${result.join(" ")} — x${m}!`;
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
  } else {
    $("#slotsResult").innerHTML = `<div class="result-banner lose">${label}</div>`;
    haptic("lose");
  }
  btn.disabled = false;
});

// ---------- ROULETTE (выплаты американские, нерфим) ----------
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
  // выплаты: x1.9 для красное/чёрное/чёт/нечёт/low/high (вместо x2);
  // x2.8 для дюжин (вместо x3); x30 для зеро (вместо x36)
  if (num === 0) return betKey === "zero" ? 30 : 0;
  switch (betKey) {
    case "red": return rouletteColor(num) === "red" ? 1.9 : 0;
    case "black": return rouletteColor(num) === "black" ? 1.9 : 0;
    case "zero": return 0;
    case "even": return num % 2 === 0 ? 1.9 : 0;
    case "odd": return num % 2 === 1 ? 1.9 : 0;
    case "low": return num <= 18 ? 1.9 : 0;
    case "high": return num >= 19 ? 1.9 : 0;
    case "d1": return num <= 12 ? 2.8 : 0;
    case "d2": return num >= 13 && num <= 24 ? 2.8 : 0;
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
  const order = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const idx = order.indexOf(num);
  const segDeg = 360 / 37;
  const targetAngle = -(idx * segDeg + segDeg / 2);
  roulCurrentRotation += 360 * 6 + (targetAngle - (roulCurrentRotation % 360));
  $("#roulWheel").style.transform = `rotate(${roulCurrentRotation}deg)`;
  $("#roulResult").textContent = "...";

  setTimeout(() => {
    const mult = checkRouletteWin(num, roulSelectedBet);
    let win = Math.floor(bet * mult);
    if (win > 0 && state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
    const color = rouletteColor(num);
    const colorEmoji = color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";
    $("#roulResult").innerHTML = `${colorEmoji} <b>${num}</b> · ${win > 0 ? `+${fmt(win)}` : "мимо"}`;
    recordResult("roulette", bet, win);
    if (win > 0) {
      adjustBalance(win);
      toast("+" + fmt(win), "win");
      haptic("win");
    } else {
      haptic("lose");
    }
    btn.disabled = false;
  }, 5100);
});

// ---------- CRASH (понижаем хаусэдж) ----------
const crashHistory = [];
function pickCrashPoint() {
  // RTP ~88% (было 95%)
  const r = Math.random();
  if (r < 0.10) return 1.00;  // больше моментальных крашей
  const e = Math.random();
  let v = 0.88 / (1 - e);
  if (v > 50) v = 50;
  return Math.max(1.01, parseFloat(v.toFixed(2)));
}
let crashAnim = null;
let crashHandler = null;

function resetCrashUI() {
  const btn = $("#crashStart");
  btn.textContent = "🚀 Старт";
  btn.classList.remove("btn-danger");
  btn.classList.add("btn-primary");
  if (crashHandler) { btn.removeEventListener("click", crashHandler); crashHandler = null; }
  btn.addEventListener("click", startCrash, { once: true });
  btn.disabled = false;
  $("#crashMult").textContent = "1.00x";
  $("#crashMult").classList.remove("crashed");
  $("#crashRocket").textContent = "🚀";
  $("#crashRocket").style.transform = "";
}

function startCrash() {
  if (crashAnim) return;
  const bet = tryWager(parseInt($("#crashBet").value, 10), state.balance);
  if (!bet) { resetCrashUI(); return; }
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
  btn.classList.remove("btn-primary");
  btn.disabled = false;

  const onCash = () => {
    if (cashed) return;
    cashed = true;
    let win = Math.floor(bet * mult);
    if (state.upgrades.vault > 0) win = Math.floor(win * (1 + 0.05 * state.upgrades.vault));
    adjustBalance(win);
    recordResult("crash", bet, win);
    toast(`Забрал на x${mult.toFixed(2)} · +${fmt(win)}`, "win");
    haptic("win");
  };
  crashHandler = onCash;
  btn.addEventListener("click", onCash);

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
      btn.removeEventListener("click", onCash);
      crashHandler = null;
      setTimeout(resetCrashUI, 1200);
      return;
    }
    multEl.textContent = mult.toFixed(2) + "x";
    const dx = Math.min(280, t * 60);
    const dy = -Math.min(180, t * 40);
    rocketEl.style.transform = `translate(${dx}px, ${dy}px) rotate(-30deg)`;
    crashAnim = requestAnimationFrame(frame);
  }
  crashAnim = requestAnimationFrame(frame);
}

resetCrashUI();
function renderCrashHistory() {
  const c = $("#crashHistory");
  c.innerHTML = crashHistory.map(v =>
    `<span class="crash-h-item ${v >= 2 ? "high" : "low"}">x${v.toFixed(2)}</span>`
  ).join("");
}
$("#screen-crash [data-close]").addEventListener("click", () => {
  if (crashAnim) cancelAnimationFrame(crashAnim);
  crashAnim = null;
  resetCrashUI();
});

// ---------- MINES (RTP 88% вместо 96%) ----------
const minesState = { active: false, bet: 0, bombs: 5, opened: 0, mult: 1, bombSet: null, finished: false };
const MINES_TOTAL = 25;

function minesPayout(open, bombs) {
  // RTP ~88%
  const safe = MINES_TOTAL - bombs;
  let p = 1;
  for (let i = 0; i < open; i++) p *= (safe - i) / (MINES_TOTAL - i);
  return p > 0 ? 0.88 / p : 0;
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
  $$("#minesGrid .mine-cell").forEach(c => c.classList.add("disabled"));
  minesState.active = false;
  $("#minesCashout").style.display = "none";
  $("#minesStart").style.display = "block";
});
buildMinesGrid();

// ---------- WHEEL OF FORTUNE (нерф: больше zero-секторов) ----------
const WHEEL_SEGS = [
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 1.2,  color: "#3b82f6", label: "x1.2" },
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 1.5,  color: "#22c55e", label: "x1.5" },
  { mult: 0,    color: "#dc2626", label: "x0" },
  { mult: 2,    color: "#a855f7", label: "x2" },
  { mult: 0,    color: "#444",    label: "x0" },
  { mult: 5,    color: "#ffd966", label: "x5" },
];
function buildWheel() {
  const w = $("#luckyWheel");
  w.innerHTML = "";
  const n = WHEEL_SEGS.length;
  const seg = 360 / n;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  svg.style.position = "absolute";
  svg.style.inset = 0;
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.transform = "rotate(-90deg)";
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
    text.setAttribute("style", "paint-order: stroke; stroke: rgba(0,0,0,0.7); stroke-width: 0.01;");
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

  // нерф: x5 теперь 3%, x0 чаще
  const weights = [32, 14, 22, 10, 12, 5, 2, 3];
  let r = Math.random() * weights.reduce((a,b)=>a+b);
  let idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  const segDeg = 360 / WHEEL_SEGS.length;
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
    } else {
      $("#wheelResult").innerHTML = `<span style="color:var(--red)">${seg.label}</span> мимо`;
      haptic("lose");
    }
    recordResult("wheel", bet, win);
    btn.disabled = false;
  }, 5100);
});

// ---------- COINFLIP (нерф: x1.9 вместо x2) ----------
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
      win = Math.floor(bet * 1.9);  // 5% house edge
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

// ============================================================
// 📦 КЕЙСЫ — больше тиров, multi-open, инвентарь стекается
// ============================================================
// EV каждого кейса ~85% от цены: суммарно вы в минус идёте
const RARITY_TIER = { common: 1, rare: 2, epic: 3, legend: 4, myth: 5 };

const CASES = [
  { id: "bronze", name: "Бронзовый", icon: "📦", price: 100, tier: "bronze",
    items: [
      { ico: "🍂", name: "Лист", v: 30,    rarity: "common", w: 55 },
      { ico: "🪵", name: "Палка", v: 60,   rarity: "common", w: 28 },
      { ico: "🔧", name: "Гайка", v: 130,  rarity: "rare",   w: 12 },
      { ico: "⚙️", name: "Шестерня", v: 280, rarity: "rare", w: 4 },
      { ico: "🪙", name: "Монета", v: 600, rarity: "epic",   w: 0.9 },
      { ico: "💍", name: "Кольцо", v: 1500, rarity: "legend", w: 0.1 },
    ]},
  { id: "silver", name: "Серебряный", icon: "🎁", price: 500, tier: "silver",
    items: [
      { ico: "🥉", name: "Бронза", v: 150,   rarity: "common", w: 38 },
      { ico: "🥈", name: "Серебро", v: 380,  rarity: "rare",   w: 32 },
      { ico: "🪄", name: "Палочка", v: 750,  rarity: "rare",   w: 18 },
      { ico: "💎", name: "Алмазик", v: 1500, rarity: "epic",   w: 9 },
      { ico: "🗡️", name: "Меч", v: 3000,    rarity: "legend", w: 2.5 },
      { ico: "🌟", name: "Звезда", v: 9000,  rarity: "myth",   w: 0.5 },
    ]},
  { id: "emerald", name: "Изумрудный", icon: "🍀", price: 1500, tier: "silver",
    items: [
      { ico: "🌿", name: "Веточка", v: 500,    rarity: "common", w: 35 },
      { ico: "🍃", name: "Листва", v: 1100,    rarity: "rare",   w: 30 },
      { ico: "🥦", name: "Кустик", v: 2000,    rarity: "rare",   w: 18 },
      { ico: "🌳", name: "Дерево", v: 4500,    rarity: "epic",   w: 12 },
      { ico: "🦗", name: "Кузнечик", v: 9000,  rarity: "legend", w: 4 },
      { ico: "🐍", name: "Изумрудный змей", v: 25000, rarity: "myth", w: 1 },
    ]},
  { id: "gold", name: "Золотой", icon: "🏆", price: 5000, tier: "gold",
    items: [
      { ico: "🥇", name: "Медаль", v: 1800,    rarity: "common", w: 30 },
      { ico: "💰", name: "Мешок", v: 4200,     rarity: "rare",   w: 32 },
      { ico: "💎", name: "Алмаз", v: 9000,     rarity: "epic",   w: 22 },
      { ico: "👑", name: "Корона", v: 22000,   rarity: "epic",   w: 11 },
      { ico: "🐉", name: "Дракон", v: 55000,   rarity: "legend", w: 4 },
      { ico: "🦄", name: "Единорог", v: 150000, rarity: "myth",  w: 1 },
    ]},
  { id: "ruby", name: "Рубиновый", icon: "❤️‍🔥", price: 10000, tier: "gold",
    items: [
      { ico: "🔥", name: "Огонёк", v: 4000,    rarity: "common", w: 30 },
      { ico: "🌶️", name: "Перчик", v: 9500,    rarity: "rare",   w: 32 },
      { ico: "🍷", name: "Бокал", v: 18000,    rarity: "epic",   w: 22 },
      { ico: "💋", name: "Поцелуй", v: 42000,  rarity: "epic",   w: 11 },
      { ico: "🐲", name: "Огнедышащий", v: 110000, rarity: "legend", w: 4 },
      { ico: "🌋", name: "Вулкан", v: 320000,  rarity: "myth",   w: 1 },
    ]},
  { id: "sapphire", name: "Сапфировый", icon: "💙", price: 25000, tier: "diamond",
    items: [
      { ico: "💧", name: "Капля", v: 10000,    rarity: "common", w: 30 },
      { ico: "🐬", name: "Дельфин", v: 24000,  rarity: "rare",   w: 32 },
      { ico: "🐳", name: "Кит", v: 50000,      rarity: "epic",   w: 22 },
      { ico: "🌊", name: "Цунами", v: 120000,  rarity: "epic",   w: 11 },
      { ico: "🧜", name: "Русалка", v: 320000, rarity: "legend", w: 4 },
      { ico: "👁️", name: "Око глубин", v: 900000, rarity: "myth", w: 1 },
    ]},
  { id: "diamond", name: "Алмазный", icon: "💎", price: 50000, tier: "diamond",
    items: [
      { ico: "💎", name: "Осколок", v: 20000,         rarity: "common", w: 30 },
      { ico: "🔮", name: "Сфера", v: 50000,            rarity: "rare",   w: 32 },
      { ico: "👑", name: "Корона эпик", v: 110000,     rarity: "epic",   w: 22 },
      { ico: "🐲", name: "Тёмный дракон", v: 280000,   rarity: "epic",   w: 11 },
      { ico: "🦄", name: "Звёздный единорог", v: 700000, rarity: "legend", w: 4 },
      { ico: "🌟", name: "Сверхновая", v: 1800000,     rarity: "myth",   w: 1 },
    ]},
  { id: "mythic", name: "Мифический", icon: "🌌", price: 200000, tier: "diamond",
    items: [
      { ico: "🪐", name: "Планета", v: 80000,       rarity: "common", w: 30 },
      { ico: "☄️", name: "Комета", v: 200000,       rarity: "rare",   w: 32 },
      { ico: "🌠", name: "Падающая звезда", v: 460000, rarity: "epic", w: 22 },
      { ico: "🌌", name: "Туманность", v: 1100000,  rarity: "epic",   w: 11 },
      { ico: "👽", name: "Космический", v: 2800000, rarity: "legend", w: 4 },
      { ico: "🛸", name: "НЛО джекпот", v: 7500000, rarity: "myth",   w: 1 },
    ]},
];

let invFilter = "all";
$$(".inv-tab").forEach(b => b.addEventListener("click", () => {
  $$(".inv-tab").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  invFilter = b.dataset.invTab;
  renderInventory();
  haptic("light");
}));

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

function inventoryFiltered() {
  if (invFilter === "all") return state.inventory;
  if (invFilter === "common") return state.inventory.filter(x => x.rarity === "common");
  if (invFilter === "rare") return state.inventory.filter(x => RARITY_TIER[x.rarity] >= 2);
  if (invFilter === "legend") return state.inventory.filter(x => RARITY_TIER[x.rarity] >= 4);
  return state.inventory;
}

function renderInventory() {
  const inv = $("#invGrid");
  inv.innerHTML = "";
  const items = inventoryFiltered().slice().sort((a, b) =>
    (RARITY_TIER[b.rarity] || 0) - (RARITY_TIER[a.rarity] || 0) || b.v - a.v
  );
  if (items.length === 0) {
    inv.innerHTML = `<div class="inv-empty" style="grid-column: span 4;">Пусто. Открой кейс!</div>`;
    return;
  }
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "inv-item";
    el.innerHTML = `
      ${(it.qty || 1) > 1 ? `<span class="stack">x${it.qty}</span>` : ""}
      <div>${it.ico}</div>
      <div class="v">${fmt(it.v)}</div>`;
    el.title = it.name;
    el.addEventListener("click", () => openItemView(it));
    inv.appendChild(el);
  }
}

// ---------- открытие кейса с multi ----------
let currentCase = null;
let currentMulti = 1;
$$(".case-multi .multi-btn").forEach(b => {
  b.addEventListener("click", () => {
    $$(".case-multi .multi-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    currentMulti = parseInt(b.dataset.multi, 10);
    if (currentCase) {
      $("#caseOpenBtn").textContent = `📦 Открыть x${currentMulti} · ${fmt(currentCase.price * currentMulti)} 🪙`;
    }
    haptic("light");
  });
});

function openCase(c) {
  currentCase = c;
  $("#caseTitle").textContent = c.icon + " " + c.name;

  const pay = $("#casePaytable");
  pay.innerHTML = "<div style='font-weight:700; margin-bottom:6px;'>Призы:</div>" +
    c.items.map(it => `
      <div class="row">
        <div class="ico">${it.ico}</div>
        <div class="name r-${it.rarity}">${it.name}</div>
        <div class="pay">${fmt(it.v)} 🪙</div>
      </div>`).join("");

  const strip = $("#caseRollStrip");
  strip.style.transition = "none";
  strip.style.transform = "translateX(0)";
  strip.innerHTML = "";

  $("#caseResultBox").innerHTML = "";
  $("#caseRoll").style.display = "block";

  const btn = $("#caseOpenBtn");
  btn.textContent = `📦 Открыть x${currentMulti} · ${fmt(c.price * currentMulti)} 🪙`;
  btn.disabled = false;
  btn.onclick = () => doOpenCase(c, currentMulti);

  openScreen("case");
}

async function doOpenCase(c, multi) {
  const totalCost = c.price * multi;
  if (state.balance < totalCost) { toast("Не хватает", "lose"); return; }

  const btn = $("#caseOpenBtn");
  btn.disabled = true;
  adjustBalance(-totalCost);
  haptic("light");

  if (multi === 1) {
    // классическая анимация ленты
    $("#caseRoll").style.display = "block";
    $("#caseResultBox").innerHTML = "";

    const won = pickWeighted(c.items);
    const itemW = 90;
    const total = 60;
    const winIndex = 50;
    const items = [];
    for (let i = 0; i < total; i++) {
      items.push(i === winIndex ? won : pickWeighted(c.items));
    }
    const strip = $("#caseRollStrip");
    strip.innerHTML = items.map(it => `
      <div class="case-roll-item r-${it.rarity}">
        <div>${it.ico}</div>
        <div class="v">${fmt(it.v)}</div>
      </div>`).join("");
    const containerW = $(".case-roll").clientWidth;
    const offset = winIndex * itemW + itemW / 2 - containerW / 2 + (Math.random() - 0.5) * 30;
    strip.style.transition = "none";
    strip.style.transform = "translateX(0)";
    void strip.offsetWidth;
    strip.style.transition = "transform 5s cubic-bezier(0.1, 0.7, 0.2, 1)";
    strip.style.transform = `translateX(${-offset}px)`;

    setTimeout(() => {
      let prize = won.v;
      if (state.upgrades.vault > 0) prize = Math.floor(prize * (1 + 0.05 * state.upgrades.vault));
      // в инвентарь добавляется ИМЕННО предмет, не деньги
      invAdd({ ico: won.ico, name: won.name, v: prize, rarity: won.rarity });
      state.stats.casesOpened++;
      // EV-логика: запишем как «потратил price, получил prize стоимости»
      state.stats.totalWagered += c.price;
      state.stats.totalWon += prize;
      state.stats.spins++;
      if (prize >= c.price) state.stats.wins++; else state.stats.losses++;
      if (prize > state.stats.biggestWin) state.stats.biggestWin = prize;
      save();

      $("#caseResultBox").innerHTML = `
        <div class="case-result r-${won.rarity}">
          <div class="ico">${won.ico}</div>
          <div class="v">${won.name} · ${fmt(prize)} 🪙</div>
          <div style="font-size:11px; color: var(--text-dim); margin-top:4px;">Добавлено в инвентарь</div>
        </div>`;

      if (prize >= c.price * 5 && prize >= 5000) showBigWin(prize, `${c.icon} ${c.name}`, { ico: won.ico, title: "Редкий дроп!" });
      if (prize >= c.price * 5) confettiBurst(120);
      if (prize >= c.price) { toast("Победа +" + fmt(prize), "win"); haptic("win"); }
      else { toast(`Выпал ${won.name} (${fmt(prize)})`, "info"); haptic("warn"); }

      btn.textContent = `🔄 Ещё раз x${currentMulti} · ${fmt(c.price * currentMulti)} 🪙`;
      btn.disabled = false;
    }, 5100);
    return;
  }

  // multi: x5 / x10 — анимация лент по очереди очень долгая. Делаем мульти-грид с pop'ом.
  $("#caseRoll").style.display = "none";
  $("#caseResultBox").innerHTML = "";

  const wonList = [];
  for (let i = 0; i < multi; i++) wonList.push(pickWeighted(c.items));

  const grid = document.createElement("div");
  grid.className = "multi-result-grid";
  $("#caseResultBox").appendChild(grid);

  let totalPrize = 0;
  let bestRarity = "common";
  for (let i = 0; i < wonList.length; i++) {
    const it = wonList[i];
    let prize = it.v;
    if (state.upgrades.vault > 0) prize = Math.floor(prize * (1 + 0.05 * state.upgrades.vault));
    totalPrize += prize;
    if (RARITY_TIER[it.rarity] > RARITY_TIER[bestRarity]) bestRarity = it.rarity;

    invAdd({ ico: it.ico, name: it.name, v: prize, rarity: it.rarity });
    state.stats.casesOpened++;

    // в течение анимации показываем по одному
    await new Promise(res => {
      setTimeout(() => {
        const el = document.createElement("div");
        el.className = "multi-item r-" + it.rarity;
        el.innerHTML = `<div>${it.ico}</div><div class="v">${fmt(prize)}</div>`;
        el.style.animationDelay = "0s";
        grid.appendChild(el);
        haptic("light");
        res();
      }, 250);
    });
  }

  // запишем суммарные статы
  state.stats.totalWagered += c.price * multi;
  state.stats.totalWon += totalPrize;
  state.stats.spins += multi;
  if (totalPrize > state.stats.biggestWin) state.stats.biggestWin = totalPrize;
  save();

  // итог
  const summary = document.createElement("div");
  summary.className = "result-banner " + (totalPrize >= totalCost ? "win" : "lose");
  summary.innerHTML = `Открыто: x${multi} · Потрачено: ${fmt(totalCost)} · Получено: ${fmt(totalPrize)}`;
  $("#caseResultBox").appendChild(summary);

  if (totalPrize >= totalCost * 2 && totalPrize >= 10000) {
    showBigWin(totalPrize, `${c.icon} ${c.name} x${multi}`, { ico: "🎁", title: "Удачное вскрытие!" });
  } else if (totalPrize >= totalCost) {
    toast("В плюсе +" + fmt(totalPrize - totalCost), "win");
    haptic("win");
  } else {
    toast(`В минусе −${fmt(totalCost - totalPrize)}`, "lose");
    haptic("lose");
  }

  btn.textContent = `🔄 Ещё раз x${currentMulti} · ${fmt(c.price * currentMulti)} 🪙`;
  btn.disabled = false;
}

// ============================================================
// 🎒 Просмотр предмета — продать/оставить
// ============================================================
let currentItem = null;
function openItemView(it) {
  currentItem = it;
  $("#itemTitle").textContent = it.name;
  $("#itemBox").innerHTML = `
    <div style="font-size: 80px;">${it.ico}</div>
    <div style="font-weight:800; font-size:20px; margin-top: 8px;" class="r-${it.rarity}">${it.name}</div>
    <div style="color: var(--gold); font-weight:800; font-size: 22px; margin-top: 4px;">${fmt(it.v)} 🪙</div>
    <div style="color: var(--text-dim); font-size: 13px; margin-top: 4px;">У тебя: <b>${it.qty || 1}</b> шт.</div>
    <div style="color: var(--text-dim); font-size: 11px; text-transform: uppercase; margin-top: 6px;">${it.rarity}</div>
  `;
  const oneBtn = $("#itemSellOne");
  const allBtn = $("#itemSellAll");
  oneBtn.textContent = `Продать 1 за ${fmt(it.v)}`;
  allBtn.textContent = `Продать все (${it.qty || 1}) за ${fmt(it.v * (it.qty || 1))}`;
  allBtn.style.display = (it.qty || 1) > 1 ? "block" : "none";
  openScreen("item");
}
$("#itemSellOne").addEventListener("click", () => {
  if (!currentItem) return;
  invRemove(currentItem, 1);
  adjustBalance(currentItem.v);
  toast(`Продано: ${currentItem.name} +${fmt(currentItem.v)}`, "win");
  haptic("medium");
  if (invTotalQty(currentItem) === 0) closeScreen();
  else openItemView({ ...currentItem, qty: invTotalQty(currentItem) });
  renderInventory();
});
$("#itemSellAll").addEventListener("click", () => {
  if (!currentItem) return;
  const qty = invTotalQty(currentItem);
  const total = currentItem.v * qty;
  invRemove(currentItem, qty);
  adjustBalance(total);
  toast(`Продано: ${qty}x ${currentItem.name} +${fmt(total)}`, "win");
  haptic("medium");
  closeScreen();
  renderInventory();
});

// ============================================================
// 🔧 КОНТРАКТ — 5 предметов одной редкости -> 1 предмет на тир выше
// ============================================================
const RARITY_ORDER = ["common", "rare", "epic", "legend", "myth"];
let contractSelection = []; // массив {key, item}

$("#openContractBtn").addEventListener("click", () => {
  contractSelection = [];
  renderContractSlots();
  renderContractPick();
  renderContractStats();
  $("#contractRunBtn").disabled = true;
  $("#contractRunBtn").textContent = "Выбери 5 предметов";
  openScreen("contract");
});

function renderContractSlots() {
  const slots = $("#contractSlots");
  slots.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const it = contractSelection[i]?.item;
    const div = document.createElement("div");
    div.className = "contract-slot " + (it ? "filled r-" + it.rarity : "");
    div.style.position = "relative";
    if (it) {
      div.innerHTML = `${it.ico}<div class="v" style="position:absolute; bottom:2px; font-size:9px; color: var(--gold); font-weight:700;">${fmt(it.v)}</div>`;
      div.addEventListener("click", () => {
        contractSelection.splice(i, 1);
        renderContractSlots();
        renderContractPick();
        renderContractStats();
        haptic("light");
      });
    } else {
      div.textContent = "+";
    }
    slots.appendChild(div);
  }
}

function renderContractPick() {
  const pick = $("#contractPick");
  pick.innerHTML = "";
  // фильтруем: можно брать только если не максимальная редкость, и только одной редкости в одном контракте
  const lockedRarity = contractSelection[0]?.item?.rarity;
  // считаем сколько уже выделено по каждому ключу
  const usedCount = new Map();
  for (const sel of contractSelection) {
    usedCount.set(sel.key, (usedCount.get(sel.key) || 0) + 1);
  }

  const items = state.inventory
    .filter(it => it.rarity !== "myth")
    .filter(it => !lockedRarity || it.rarity === lockedRarity)
    .slice()
    .sort((a,b) => RARITY_TIER[b.rarity] - RARITY_TIER[a.rarity] || b.v - a.v);

  if (items.length === 0) {
    pick.innerHTML = `<div class="inv-empty" style="grid-column: span 4;">Нет подходящих предметов.<br>Нужны не-мифические одной редкости.</div>`;
    return;
  }

  for (const it of items) {
    const used = usedCount.get(invKey(it)) || 0;
    const available = (it.qty || 1) - used;
    if (available <= 0) continue;
    const el = document.createElement("div");
    el.className = "inv-item";
    el.innerHTML = `
      ${available > 1 ? `<span class="stack">x${available}</span>` : ""}
      <div>${it.ico}</div>
      <div class="v">${fmt(it.v)}</div>`;
    el.addEventListener("click", () => {
      if (contractSelection.length >= 5) { toast("Уже выбрано 5", "info"); return; }
      contractSelection.push({ key: invKey(it), item: it });
      renderContractSlots();
      renderContractPick();
      renderContractStats();
      haptic("light");
    });
    pick.appendChild(el);
  }
}

function renderContractStats() {
  const stats = $("#contractStats");
  if (contractSelection.length === 0) { stats.style.display = "none"; return; }
  const items = contractSelection.map(s => s.item);
  const total = items.reduce((a, b) => a + b.v, 0);
  const avg = total / items.length;
  const lockedRarity = items[0].rarity;
  const nextRarity = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, RARITY_ORDER.indexOf(lockedRarity) + 1)];

  stats.style.display = "block";
  stats.innerHTML = `
    <div class="row"><span>Сумма входа:</span><span class="v">${fmt(total)} 🪙</span></div>
    <div class="row"><span>Средняя стоимость:</span><span class="v">${fmt(avg)} 🪙</span></div>
    <div class="row"><span>Целевая редкость:</span><span class="v r-${nextRarity}">${nextRarity.toUpperCase()}</span></div>
    <div class="row" style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">
      <span>Результат: случайный предмет той редкости из всех кейсов с шансом получить редкий вариант с весом, пропорциональным средней цене входа.</span>
    </div>
  `;

  const btn = $("#contractRunBtn");
  if (contractSelection.length === 5) {
    btn.disabled = false;
    btn.textContent = `🔧 Запустить контракт (${nextRarity.toUpperCase()})`;
  } else {
    btn.disabled = true;
    btn.textContent = `Выбери ещё ${5 - contractSelection.length}`;
  }
}

// все возможные предметы из всех кейсов
function allItemsByRarity(rarity) {
  const out = [];
  for (const c of CASES) {
    for (const it of c.items) {
      if (it.rarity === rarity) out.push(it);
    }
  }
  return out;
}

$("#contractRunBtn").addEventListener("click", () => {
  if (contractSelection.length !== 5) return;
  const items = contractSelection.map(s => s.item);
  const lockedRarity = items[0].rarity;
  const nextRarity = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, RARITY_ORDER.indexOf(lockedRarity) + 1)];
  const avg = items.reduce((a, b) => a + b.v, 0) / items.length;

  // удалим из инвентаря
  for (const sel of contractSelection) {
    invRemove(sel.item, 1);
  }
  state.stats.contractsRun = (state.stats.contractsRun || 0) + 1;

  // выбираем результат: предметы целевой редкости, вес = 1/abs(v - avg*X) ... простая логика:
  // EV ~ 80% средней суммы входа, с дисперсией
  let pool = allItemsByRarity(nextRarity);
  if (pool.length === 0) pool = allItemsByRarity(lockedRarity); // fallback
  // взвешиваем обратной квадратной разницей с целевой стоимостью
  const target = avg * 4;  // 5 in -> 1 out стоит ~80% от 5x = 4x avg
  const weighted = pool.map(it => ({ ...it, w: 1 / (1 + Math.pow((it.v - target) / Math.max(target, 1), 2)) }));
  const result = pickWeighted(weighted);

  invAdd({ ico: result.ico, name: result.name, v: result.v, rarity: result.rarity });
  save();

  // покажем результат
  contractSelection = [];
  renderContractSlots();
  renderContractPick();
  $("#contractStats").style.display = "none";
  $("#contractRunBtn").disabled = true;
  $("#contractRunBtn").textContent = "Выбери 5 предметов";

  toast(`+ ${result.ico} ${result.name} (${fmt(result.v)})`, result.v >= avg * 5 ? "win" : "info");
  showBigWin(result.v, `🔧 Контракт ${lockedRarity.toUpperCase()} → ${nextRarity.toUpperCase()}`, {
    ico: result.ico,
    title: result.v >= avg * 5 ? "Удача!" : "Готово",
  });
  haptic(result.v >= avg * 5 ? "win" : "medium");
  renderInventory();
});

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
    <div class="stat-tile"><div class="label">Контрактов</div><div class="value">${fmt(s.contractsRun || 0)}</div></div>
    <div class="stat-tile"><div class="label">Тапов</div><div class="value">${fmt(state.taps)}</div></div>
    <div class="stat-tile"><div class="label">Всего поставлено</div><div class="value">${fmt(s.totalWagered)}</div></div>
    <div class="stat-tile"><div class="label">Всего выиграно</div><div class="value" style="color:var(--green);">${fmt(s.totalWon)}</div></div>
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

// ============================================================
// v3: миграция state, bulk-sell, апгрейд, аркада
// ============================================================

// миграция: добавляем поля для аркады если их нет
if (!state.arcade) {
  state.arcade = {
    soulShards: 0,                 // мета-валюта рогалика
    metaUpgrades: { hp: 0, atk: 0, spd: 0, regen: 0, magnet: 0, luck: 0 },
    rogueBest: { depth: 0, kills: 0, time: 0 },
    best2048: 0,
    bestSnake: 0,
  };
  save();
}
if (typeof state.arcade.bestSnake !== "number") { state.arcade.bestSnake = 0; save(); }

// ---------- bulk-sell ----------
function bulkSell(mode) {
  // mode: "common" | "rare-and-below" | "all"
  const RTIER = { common: 1, rare: 2, epic: 3, legend: 4, myth: 5 };
  const keep = (it) => {
    const t = RTIER[it.rarity] || 0;
    if (mode === "common") return t > 1;
    if (mode === "rare-and-below") return t > 2;
    if (mode === "all") return false;
    return true;
  };
  let total = 0, count = 0;
  const survivors = [];
  for (const it of state.inventory) {
    if (keep(it)) { survivors.push(it); continue; }
    total += (it.qty || 1) * it.v;
    count += (it.qty || 1);
  }
  if (count === 0) { toast("Нечего продавать", "info"); return; }
  if (!confirm(`Продать ${count} предмет(ов) за ${fmt(total)} 🪙?`)) return;
  state.inventory = survivors;
  adjustBalance(total);
  save();
  renderInventory();
  toast(`+${fmt(total)} за ${count} шт.`, "win");
  haptic("medium");
}
$$(".bulk-btn").forEach(b => b.addEventListener("click", () => bulkSell(b.dataset.bulk)));

// ============================================================
// АПГРЕЙД ПРЕДМЕТА: исходник + цель → шанс → анимация
// ============================================================
const upgState = { src: null, dst: null, mult: null, running: false };
const UPG_MULTIPLIERS = [
  { mult: 1.5,  base: 0.62 }, // х1.5  ~62%
  { mult: 2.0,  base: 0.46 }, // х2.0  ~46%
  { mult: 3.0,  base: 0.30 }, // х3.0  ~30%
  { mult: 5.0,  base: 0.16 }, // х5.0  ~16%
];

function openItemUpgrade(srcItem) {
  upgState.src = srcItem || null;
  upgState.dst = null;
  upgState.mult = null;
  upgState.running = false;
  $("#upgAnim").style.display = "none";
  $("#upgChanceInfo").style.display = "none";
  renderUpgScreen();
  openScreen("upgrade");
}

function renderUpgScreen() {
  // src slot
  const srcEl = $("#upgSrc"); const srcCnt = $("#upgSrcContent");
  if (upgState.src) {
    srcEl.classList.add("filled");
    srcCnt.innerHTML = `<div>${upgState.src.ico}</div>
      <div class="name">${upgState.src.name}</div>
      <div class="v">${fmt(upgState.src.v)} 🪙</div>`;
  } else {
    srcEl.classList.remove("filled");
    srcCnt.innerHTML = "+";
  }

  // dst slot
  const dstEl = $("#upgDst"); const dstCnt = $("#upgDstContent");
  if (upgState.dst) {
    dstEl.classList.add("filled");
    dstCnt.innerHTML = `<div>${upgState.dst.ico}</div>
      <div class="name">${upgState.dst.name}</div>
      <div class="v">${fmt(upgState.dst.v)} 🪙</div>`;
  } else if (upgState.mult) {
    dstEl.classList.add("filled");
    dstCnt.innerHTML = `<div style="font-size:30px;">✨</div>
      <div class="name">x${upgState.mult.mult.toFixed(1)}</div>
      <div class="v">${upgState.src ? fmt(Math.floor(upgState.src.v * upgState.mult.mult)) : "?"} 🪙</div>`;
  } else {
    dstEl.classList.remove("filled");
    dstCnt.innerHTML = "?";
  }

  // multipliers
  const mults = $("#upgMults");
  mults.innerHTML = "";
  UPG_MULTIPLIERS.forEach((m, i) => {
    const b = document.createElement("button");
    b.className = "upg-mult-btn";
    if (upgState.mult === m && !upgState.dst) b.classList.add("selected");
    b.innerHTML = `x${m.mult.toFixed(1)}<span class="v">~${Math.round(m.base * 100)}%</span>`;
    b.addEventListener("click", () => {
      upgState.mult = m;
      upgState.dst = null;
      renderUpgScreen();
      haptic("light");
    });
    mults.appendChild(b);
  });

  // pick инвентарь (для исходника или цели в зависимости от состояния)
  const pick = $("#upgPick");
  pick.innerHTML = "";
  const items = state.inventory.slice().sort((a, b) =>
    (RARITY_TIER[b.rarity] || 0) - (RARITY_TIER[a.rarity] || 0) || b.v - a.v
  );
  if (items.length === 0) {
    pick.innerHTML = `<div class="inv-empty" style="grid-column: span 4;">Инвентарь пуст</div>`;
  }
  for (const it of items) {
    // если выбран src, не даём выбрать тот же стэк для dst, и dst должен быть дороже
    const isSrcOption = !upgState.src;
    const sameAsSrc = upgState.src && invKey(it) === invKey(upgState.src);
    const tooCheap = upgState.src && it.v <= upgState.src.v;
    const el = document.createElement("div");
    el.className = "inv-item";
    if (isSrcOption || (!sameAsSrc && !tooCheap)) {
      el.style.cursor = "pointer";
    } else {
      el.style.opacity = "0.35";
    }
    el.innerHTML = `${(it.qty || 1) > 1 ? `<span class="stack">x${it.qty}</span>` : ""}
      <div>${it.ico}</div><div class="v">${fmt(it.v)}</div>`;
    el.addEventListener("click", () => {
      if (upgState.running) return;
      if (isSrcOption) {
        upgState.src = { ...it };
        upgState.dst = null;
        upgState.mult = null;
        renderUpgScreen();
        haptic("light");
      } else if (!sameAsSrc && !tooCheap) {
        upgState.dst = { ...it };
        upgState.mult = null;
        renderUpgScreen();
        haptic("light");
      } else {
        toast(sameAsSrc ? "Это же сам исходник" : "Цель должна быть дороже", "lose");
      }
    });
    pick.appendChild(el);
  }

  // chance/info + button
  const btn = $("#upgRunBtn");
  const info = $("#upgChanceInfo");
  if (!upgState.src) {
    btn.disabled = true; btn.textContent = "Выбери исходник из инвентаря";
    info.style.display = "none";
  } else if (!upgState.dst && !upgState.mult) {
    btn.disabled = true; btn.textContent = "Выбери цель или множитель";
    info.style.display = "none";
  } else {
    const chance = computeUpgChance();
    btn.disabled = false;
    btn.textContent = `🎲 Прокачать (шанс ${Math.round(chance * 100)}%)`;
    info.style.display = "block";
    const newVal = upgState.dst ? upgState.dst.v : Math.floor(upgState.src.v * upgState.mult.mult);
    info.innerHTML = `Если получится — заберёшь предмет на <b>${fmt(newVal)}</b> 🪙. ` +
                     `Если нет — потеряешь свой <b>${upgState.src.name}</b> (${fmt(upgState.src.v)}).`;
  }
}

function computeUpgChance() {
  if (!upgState.src) return 0;
  // ratio target/src
  const targetVal = upgState.dst ? upgState.dst.v : Math.floor(upgState.src.v * upgState.mult.mult);
  const ratio = targetVal / upgState.src.v;
  // базовый шанс по ratio: формула 0.92 / ratio (кэп 92%, минимум 5%)
  let chance = 0.92 / ratio;
  // luck бонус из meta
  const luckBonus = (state.arcade?.metaUpgrades?.luck || 0) * 0.01;
  chance += luckBonus;
  // vault upgrade тоже немного даёт
  chance += (state.upgrades?.vault || 0) * 0.005;
  return Math.max(0.05, Math.min(0.92, chance));
}

$("#upgRunBtn").addEventListener("click", async () => {
  if (upgState.running) return;
  if (!upgState.src || (!upgState.dst && !upgState.mult)) return;
  upgState.running = true;
  const chance = computeUpgChance();

  // снимаем исходник (1 шт)
  invRemove(upgState.src, 1);
  save();

  // показываем анимацию
  const anim = $("#upgAnim");
  anim.style.display = "block";
  anim.classList.remove("success", "fail");
  $("#upgAnimText").textContent = "Куём... ⚒️";
  haptic("medium");

  // crude reanimation: replace node to restart CSS animation
  const progress = $("#upgProgress");
  const fresh = progress.cloneNode(false);
  progress.replaceWith(fresh);

  const success = Math.random() < chance;

  await new Promise(r => setTimeout(r, 2050));

  if (success) {
    let prize;
    if (upgState.dst) {
      prize = { ...upgState.dst, qty: 1 };
    } else {
      const newVal = Math.floor(upgState.src.v * upgState.mult.mult);
      prize = {
        ico: "✨",
        name: upgState.src.name + "+",
        v: newVal,
        rarity: upgState.src.rarity,
        qty: 1,
      };
    }
    invAdd(prize);
    save();
    anim.classList.add("success");
    $("#upgAnimText").textContent = `🎉 Успех! +${prize.ico} ${prize.name} (${fmt(prize.v)})`;
    haptic("win");
    if (prize.v >= upgState.src.v * 3) confettiBurst(60);
  } else {
    anim.classList.add("fail");
    $("#upgAnimText").textContent = `💥 Не вышло. Потерян ${upgState.src.ico} ${upgState.src.name}`;
    haptic("lose");
  }

  // сбрасываем выбор
  upgState.src = null;
  upgState.dst = null;
  upgState.mult = null;
  upgState.running = false;
  setTimeout(() => {
    anim.style.display = "none";
    renderUpgScreen();
    renderInventory();
  }, 2200);
});

// открытие апгрейда из карточки предмета
$("#itemUpgradeBtn").addEventListener("click", () => {
  if (!currentItem) return;
  closeScreen();
  setTimeout(() => openItemUpgrade(currentItem), 200);
});

// ============================================================
// РОГАЛИК — Подземелье
// ============================================================
const rogueRefs = {
  canvas: null, ctx: null, dpr: 1, W: 0, H: 0,
  arena: null, body: null,
  raf: null, last: 0, running: false,
};

const ROGUE = {
  player: null,
  enemies: [],
  bullets: [],
  drops: [],
  particles: [],
  popups: [],
  depth: 1,
  killCount: 0,
  spawnTimer: 0,
  spawnInterval: 1.5,
  bossActive: false,
  bossSpawnedAtDepth: false,
  goldGained: 0,
  shardsGained: 0,
  startTime: 0,
  paused: false,
  joy: { active: false, dx: 0, dy: 0, len: 0 },
  bg: [], // фон точек
};

const ROGUE_PERKS = [
  { id: "atk",     name: "🗡️ Сила удара",   desc: "+25% урона",                    rarity: "common", apply: p => p.atk *= 1.25 },
  { id: "spd",     name: "👟 Скорость",      desc: "+15% к скорости",               rarity: "common", apply: p => p.spd *= 1.15 },
  { id: "rate",    name: "⚡ Скорость атаки", desc: "+20% к скорости атаки",         rarity: "common", apply: p => p.atkRate *= 1.20 },
  { id: "range",   name: "🎯 Дальность",     desc: "+25% к радиусу атаки",          rarity: "common", apply: p => p.atkRange *= 1.25 },
  { id: "hp",      name: "❤️ Витальность",   desc: "+20 макс. HP и +20 HP сейчас",  rarity: "common", apply: p => { p.hpMax += 20; p.hp = Math.min(p.hpMax, p.hp + 20); } },
  { id: "regen",   name: "💚 Регенерация",   desc: "+1 HP/сек",                     rarity: "rare",   apply: p => p.regen += 1 },
  { id: "multi",   name: "🌀 Двойной выстрел", desc: "Стреляешь по 2 врагам сразу", rarity: "rare",   apply: p => p.shotsPerTick += 1 },
  { id: "pierce",  name: "🏹 Пронзание",     desc: "+1 цель пробивания снаряда",    rarity: "rare",   apply: p => p.pierce += 1 },
  { id: "crit",    name: "✨ Крит",           desc: "+15% шанс крита (x2 урон)",     rarity: "rare",   apply: p => p.critChance += 0.15 },
  { id: "magnet",  name: "🧲 Магнит",        desc: "+50% к радиусу подбора лута",   rarity: "rare",   apply: p => p.magnet *= 1.5 },
  { id: "vamp",    name: "🩸 Вампиризм",     desc: "Лечишься на 5% от урона",       rarity: "epic",   apply: p => p.lifesteal += 0.05 },
  { id: "shield",  name: "🛡️ Щит",          desc: "Раз в 8 сек блокируешь удар",   rarity: "epic",   apply: p => p.shieldCd = Math.max(2, p.shieldCd ? p.shieldCd - 2 : 8) },
  { id: "boom",    name: "💥 Взрыв",        desc: "Снаряд взрывается по AoE",      rarity: "legend", apply: p => p.explode = (p.explode || 0) + 18 },
];

const META_UPGRADES = [
  { id: "hp",     name: "❤️ Стартовое HP",   desc: "+10 HP с самого начала",     baseCost: 5,  max: 10 },
  { id: "atk",    name: "🗡️ Стартовый урон", desc: "+10% урона стартом",        baseCost: 6,  max: 10 },
  { id: "spd",    name: "👟 Стартовая скорость", desc: "+5% к скорости",         baseCost: 5,  max: 10 },
  { id: "regen",  name: "💚 Стартовая регенерация", desc: "+0.3 HP/сек стартом", baseCost: 8,  max: 8 },
  { id: "magnet", name: "🧲 Магнит",         desc: "+15% к радиусу подбора",     baseCost: 4,  max: 10 },
  { id: "luck",   name: "🍀 Удача",          desc: "+1% к шансу апгрейда предметов", baseCost: 10, max: 10 },
];

function metaCost(u) {
  const lvl = state.arcade.metaUpgrades[u.id] || 0;
  return Math.floor(u.baseCost * Math.pow(1.5, lvl));
}

function renderRogueMeta(el) {
  const shardsLine = `<div class="rogue-shards-bar">💎 Осколков душ: ${fmt(state.arcade.soulShards)}</div>`;
  let html = shardsLine;
  for (const u of META_UPGRADES) {
    const lvl = state.arcade.metaUpgrades[u.id] || 0;
    const cost = metaCost(u);
    const max = lvl >= u.max;
    html += `<div class="rogue-meta-item">
      <div class="info">
        <div class="name">${u.name} <span class="lvl">Lv.${lvl}/${u.max}</span></div>
        <div class="desc">${u.desc}</div>
      </div>
      <button data-meta="${u.id}" ${max || state.arcade.soulShards < cost ? "disabled" : ""}>
        ${max ? "MAX" : `💎 ${cost}`}
      </button>
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll("button[data-meta]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.meta;
    const u = META_UPGRADES.find(x => x.id === id);
    const lvl = state.arcade.metaUpgrades[id] || 0;
    if (lvl >= u.max) return;
    const cost = metaCost(u);
    if (state.arcade.soulShards < cost) return;
    state.arcade.soulShards -= cost;
    state.arcade.metaUpgrades[id] = lvl + 1;
    save();
    haptic("medium");
    toast(`Улучшено: ${u.name}`, "win");
    renderRogueMeta(el);
  }));
}

function rogueShowOverlay(which) {
  const ov = $("#rogueOverlay");
  ov.classList.remove("hidden");
  $("#rogueMenuStart").classList.toggle("hidden", which !== "start");
  $("#rogueMenuLevelUp").classList.toggle("hidden", which !== "levelup");
  $("#rogueMenuDead").classList.toggle("hidden", which !== "dead");
  $("#rogueMenuMeta").classList.toggle("hidden", which !== "meta");
  if (which === "start") {
    renderRogueMeta($("#rogueMetaPanel"));
  } else if (which === "meta") {
    renderRogueMeta($("#rogueMetaList"));
  }
}
function rogueHideOverlay() { $("#rogueOverlay").classList.add("hidden"); }

function rogueResize() {
  const c = rogueRefs.canvas;
  const arena = $(".rogue-arena");
  if (!c || !arena) return;
  const rect = arena.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  rogueRefs.dpr = dpr;
  rogueRefs.W = rect.width;
  rogueRefs.H = rect.height;
  c.width = Math.floor(rect.width * dpr);
  c.height = Math.floor(rect.height * dpr);
  c.style.width = rect.width + "px";
  c.style.height = rect.height + "px";
  rogueRefs.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function rogueInitPlayer() {
  const meta = state.arcade.metaUpgrades;
  ROGUE.player = {
    x: rogueRefs.W / 2,
    y: rogueRefs.H / 2,
    r: 9,
    color: "#66e0ff",
    hpMax: 100 + meta.hp * 10,
    hp: 100 + meta.hp * 10,
    spd: 70 * (1 + 0.05 * meta.spd),
    atk: 12 * (1 + 0.10 * meta.atk),
    atkRate: 1.5,                   // выстрелов в сек
    atkRange: 110,
    atkCd: 0,
    shotsPerTick: 1,
    pierce: 0,
    explode: 0,
    critChance: 0.05,
    regen: 0.3 * meta.regen,
    regenAcc: 0,
    lifesteal: 0,
    shieldCd: 0,                    // 0 = нет щита, иначе кулдаун; charge ниже
    shieldCharge: 0,
    shieldTimer: 0,
    magnet: 22 * (1 + 0.15 * meta.magnet),
    xp: 0,
    xpNext: 6,
    level: 1,
    facing: 0,
  };
  if (ROGUE.player.shieldCd === 0) ROGUE.player.shieldCharge = 0;
}

function rogueStart() {
  rogueResize();
  rogueInitPlayer();
  ROGUE.enemies.length = 0;
  ROGUE.bullets.length = 0;
  ROGUE.drops.length = 0;
  ROGUE.particles.length = 0;
  ROGUE.popups.length = 0;
  ROGUE.depth = 1;
  ROGUE.killCount = 0;
  ROGUE.goldGained = 0;
  ROGUE.shardsGained = 0;
  ROGUE.spawnInterval = 1.5;
  ROGUE.spawnTimer = 0;
  ROGUE.bossActive = false;
  ROGUE.bossSpawnedAtDepth = false;
  ROGUE.startTime = performance.now();
  ROGUE.paused = false;
  // фон точек (звёздочки)
  ROGUE.bg = Array.from({ length: 40 }, () => ({
    x: Math.random() * rogueRefs.W,
    y: Math.random() * rogueRefs.H,
    s: Math.random() * 1.4 + 0.4,
    a: 0.2 + Math.random() * 0.6,
  }));
  rogueHideOverlay();
  ROGUE.running = true;
  rogueRefs.last = performance.now();
  rogueLoop(rogueRefs.last);
  $("#rogueDepth").textContent = "Этаж " + ROGUE.depth;
}

function rogueAddPopup(text, x, y, kind) {
  ROGUE.popups.push({ text, x, y, kind, life: 0.7 });
}

function rogueSpawnEnemy(force) {
  const w = rogueRefs.W, h = rogueRefs.H;
  // на краю
  const side = Math.floor(Math.random() * 4);
  let x, y;
  if (side === 0) { x = -10; y = Math.random() * h; }
  else if (side === 1) { x = w + 10; y = Math.random() * h; }
  else if (side === 2) { y = -10; x = Math.random() * w; }
  else { y = h + 10; x = Math.random() * w; }

  const depthMul = 1 + (ROGUE.depth - 1) * 0.18;
  // тип:
  const r = Math.random();
  let type, hp, dmg, spd, color, radius, isFast = false, isShoot = false;
  if (r < 0.55 || ROGUE.depth < 3) {
    type = "slime"; hp = 20 * depthMul; dmg = 8 * depthMul; spd = 38; color = "#a78bfa"; radius = 8;
  } else if (r < 0.80) {
    type = "bat"; hp = 14 * depthMul; dmg = 6 * depthMul; spd = 65; color = "#f87171"; radius = 7; isFast = true;
  } else if (r < 0.95) {
    type = "tank"; hp = 60 * depthMul; dmg = 14 * depthMul; spd = 26; color = "#4ade80"; radius = 12;
  } else {
    type = "shooter"; hp = 22 * depthMul; dmg = 7 * depthMul; spd = 30; color = "#fb923c"; radius = 8; isShoot = true;
  }

  ROGUE.enemies.push({
    x, y, r: radius, hp, hpMax: hp, dmg, spd, color, type,
    hitFlash: 0, isFast, isShoot, shootCd: 1.5 + Math.random(),
  });
}

function rogueSpawnBoss(stage) {
  const w = rogueRefs.W, h = rogueRefs.H;
  const depthMul = 1 + (stage / 5) * 0.7;
  const bossTypes = [
    { type: "slime-king", color: "#c084fc", hp: 350, dmg: 16, spd: 22, r: 22, ico: "👹" },
    { type: "demon",      color: "#ef4444", hp: 600, dmg: 22, spd: 30, r: 24, ico: "😈" },
    { type: "lich",       color: "#22d3ee", hp: 850, dmg: 18, spd: 36, r: 26, ico: "💀" },
    { type: "titan",      color: "#facc15", hp: 1200, dmg: 28, spd: 24, r: 30, ico: "👑" },
  ];
  const b = bossTypes[Math.min(bossTypes.length - 1, Math.floor((stage - 1) / 5))];
  ROGUE.enemies.push({
    x: w / 2, y: -30,
    r: b.r, hp: b.hp * depthMul, hpMax: b.hp * depthMul,
    dmg: b.dmg * depthMul, spd: b.spd, color: b.color, type: b.type, ico: b.ico,
    isBoss: true, hitFlash: 0, shootCd: 2,
  });
  ROGUE.bossActive = true;
}

function rogueShoot() {
  const p = ROGUE.player;
  // ищем N ближайших врагов в радиусе
  const inRange = ROGUE.enemies
    .map(e => ({ e, d: Math.hypot(e.x - p.x, e.y - p.y) }))
    .filter(o => o.d <= p.atkRange)
    .sort((a, b) => a.d - b.d)
    .slice(0, p.shotsPerTick);
  if (inRange.length === 0) return;
  for (const o of inRange) {
    const dx = o.e.x - p.x, dy = o.e.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const isCrit = Math.random() < p.critChance;
    const dmg = p.atk * (isCrit ? 2 : 1);
    ROGUE.bullets.push({
      x: p.x, y: p.y,
      vx: (dx / len) * 220, vy: (dy / len) * 220,
      r: 4, dmg, life: 1.0,
      pierce: p.pierce,
      explode: p.explode,
      crit: isCrit,
      hitSet: new Set(),
    });
    p.facing = Math.atan2(dy, dx);
  }
}

function rogueGiveXP(p, amount) {
  p.xp += amount;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = Math.floor(6 + p.level * 4 + Math.pow(p.level, 1.4));
    rogueOfferLevelUp();
  }
}

function rogueOfferLevelUp() {
  ROGUE.paused = true;
  // 3 случайных перка
  const pool = ROGUE_PERKS.slice();
  // взвешиваем редкость
  const weights = pool.map(p => ({ ...p, w: p.rarity === "common" ? 60 : p.rarity === "rare" ? 28 : p.rarity === "epic" ? 10 : 4 }));
  const choices = [];
  while (choices.length < 3 && weights.length > 0) {
    let total = weights.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i].w;
      if (r <= 0) { idx = i; break; }
    }
    choices.push(weights[idx]);
    weights.splice(idx, 1);
  }
  const cont = $("#rogueChoices");
  cont.innerHTML = "";
  for (const c of choices) {
    const b = document.createElement("button");
    b.className = "rogue-choice " + (c.rarity || "common");
    b.innerHTML = `<div class="choice-row">
      <div class="choice-ico">${c.name.split(" ")[0]}</div>
      <div>
        <div class="choice-name">${c.name}</div>
        <div class="choice-desc">${c.desc}</div>
      </div>
    </div>`;
    b.addEventListener("click", () => {
      c.apply(ROGUE.player);
      haptic("medium");
      ROGUE.paused = false;
      rogueHideOverlay();
    });
    cont.appendChild(b);
  }
  rogueShowOverlay("levelup");
}

function rogueDie() {
  ROGUE.running = false;
  if (rogueRefs.raf) cancelAnimationFrame(rogueRefs.raf);
  rogueRefs.raf = null;
  // награда: shards + gold (gold идёт в основной баланс!)
  const time = (performance.now() - ROGUE.startTime) / 1000;
  const earnedShards = ROGUE.shardsGained + Math.floor(ROGUE.depth * 1) + Math.floor(ROGUE.killCount / 8);
  const earnedGold = ROGUE.goldGained;
  state.arcade.soulShards += earnedShards;
  if (ROGUE.depth > state.arcade.rogueBest.depth) state.arcade.rogueBest.depth = ROGUE.depth;
  if (ROGUE.killCount > state.arcade.rogueBest.kills) state.arcade.rogueBest.kills = ROGUE.killCount;
  if (time > state.arcade.rogueBest.time) state.arcade.rogueBest.time = time;
  if (earnedGold > 0) {
    state.balance += earnedGold;
    refreshBalance();
  }
  save();
  $("#rogueDeadStats").innerHTML = `
    <div style="display:flex; flex-direction: column; gap:4px; font-size:13px; margin: 8px 0;">
      <div>Этаж: <b>${ROGUE.depth}</b></div>
      <div>Убито: <b>${ROGUE.killCount}</b></div>
      <div>Время: <b>${formatTime(time)}</b></div>
      <div style="margin-top:6px;">💎 Осколков получено: <b style="color: var(--purple);">+${earnedShards}</b></div>
      <div>🪙 Золото в баланс: <b style="color: var(--gold);">+${fmt(earnedGold)}</b></div>
    </div>`;
  $("#rogueDeadTitle").textContent = ROGUE.depth >= 15 ? "🏆 Финальный босс пал!" : "💀 Гибель";
  rogueShowOverlay("dead");
  haptic("lose");
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function rogueDamageEnemy(e, dmg, isCrit, x, y) {
  e.hp -= dmg;
  e.hitFlash = 0.15;
  rogueAddPopup(Math.floor(dmg).toString(), e.x, e.y - e.r, isCrit ? "crit" : "");
  // particles
  for (let i = 0; i < 4; i++) {
    ROGUE.particles.push({
      x: e.x, y: e.y, vx: (Math.random() - 0.5) * 80, vy: (Math.random() - 0.5) * 80,
      life: 0.4, color: e.color,
    });
  }
  if (e.hp <= 0) {
    // drop
    const isBoss = !!e.isBoss;
    const drops = isBoss ? 6 + Math.floor(Math.random() * 4) : 1;
    for (let i = 0; i < drops; i++) {
      ROGUE.drops.push({
        x: e.x + (Math.random() - 0.5) * 20, y: e.y + (Math.random() - 0.5) * 20,
        type: Math.random() < 0.85 ? "xp" : "heart",
        life: 30,
      });
    }
    if (isBoss) {
      ROGUE.bossActive = false;
      ROGUE.shardsGained += 3 + Math.floor(ROGUE.depth / 5);
      // shard drop visible
      ROGUE.drops.push({ x: e.x, y: e.y, type: "shard", life: 30 });
      ROGUE.depth++;
      $("#rogueDepth").textContent = "Этаж " + ROGUE.depth;
      if (ROGUE.depth > 20) { rogueDie(); return; }
      ROGUE.bossSpawnedAtDepth = false;
    } else {
      ROGUE.killCount++;
      ROGUE.goldGained += 1 + Math.floor(Math.random() * 2);
    }
  }
}

function rogueUpdate(dt) {
  if (ROGUE.paused) return;
  const p = ROGUE.player;
  // регенерация
  p.regenAcc += p.regen * dt;
  if (p.regenAcc >= 1) {
    const heal = Math.floor(p.regenAcc);
    p.regenAcc -= heal;
    if (p.hp < p.hpMax) {
      p.hp = Math.min(p.hpMax, p.hp + heal);
      rogueAddPopup("+" + heal, p.x, p.y - p.r, "heal");
    }
  }
  // щит
  if (p.shieldCd > 0) {
    p.shieldTimer = (p.shieldTimer || 0) - dt;
    if (p.shieldTimer <= 0 && p.shieldCharge < 1) {
      p.shieldCharge = 1;
    }
  }

  // движение игрока (джойстик)
  const j = ROGUE.joy;
  if (j.active && j.len > 0.05) {
    p.x += j.dx * p.spd * dt;
    p.y += j.dy * p.spd * dt;
  }
  p.x = Math.max(p.r, Math.min(rogueRefs.W - p.r, p.x));
  p.y = Math.max(p.r, Math.min(rogueRefs.H - p.r, p.y));

  // авто-атака
  p.atkCd -= dt;
  if (p.atkCd <= 0) {
    rogueShoot();
    p.atkCd = 1 / p.atkRate;
  }

  // спавн врагов
  if (!ROGUE.bossActive) {
    ROGUE.spawnTimer += dt;
    const interval = Math.max(0.35, ROGUE.spawnInterval - ROGUE.depth * 0.06);
    if (ROGUE.spawnTimer >= interval) {
      ROGUE.spawnTimer = 0;
      const cnt = 1 + Math.floor(Math.random() * (ROGUE.depth > 4 ? 2 : 1));
      for (let i = 0; i < cnt; i++) rogueSpawnEnemy();
    }
    // босс на 5/10/15/20 этажах после Х килов
    if (!ROGUE.bossSpawnedAtDepth && ROGUE.depth % 5 === 0 && ROGUE.killCount >= 8 + ROGUE.depth) {
      rogueSpawnBoss(ROGUE.depth);
      ROGUE.bossSpawnedAtDepth = true;
    }
    // прогресс по этажам по килам (для не-боссовых уровней)
    const killsForFloor = 12 + ROGUE.depth * 4;
    if (!ROGUE.bossActive && ROGUE.depth % 5 !== 0 && ROGUE.killCount >= killsForFloor * Math.ceil(ROGUE.depth / 1)) {
      // уже учитывается ниже через depthChecker; оставим простую логику в иной ветке
    }
  }

  // движение врагов и контакт
  for (let i = ROGUE.enemies.length - 1; i >= 0; i--) {
    const e = ROGUE.enemies[i];
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt);
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    e.x += (dx / dist) * e.spd * dt;
    e.y += (dy / dist) * e.spd * dt;
    // shooter атакует
    if (e.isShoot) {
      e.shootCd -= dt;
      if (e.shootCd <= 0 && dist < 200) {
        ROGUE.bullets.push({
          x: e.x, y: e.y,
          vx: (dx / dist) * 130, vy: (dy / dist) * 130,
          r: 4, dmg: e.dmg * 0.6, life: 2,
          enemy: true, color: "#fb923c",
        });
        e.shootCd = 1.8 + Math.random() * 1.2;
      }
    }
    if (e.isBoss && (e.shootCd = (e.shootCd || 2) - dt) <= 0) {
      // босс делает круговой выстрел
      const N = 8;
      for (let k = 0; k < N; k++) {
        const ang = (k / N) * Math.PI * 2;
        ROGUE.bullets.push({
          x: e.x, y: e.y,
          vx: Math.cos(ang) * 110, vy: Math.sin(ang) * 110,
          r: 5, dmg: e.dmg * 0.5, life: 3,
          enemy: true, color: "#ef4444",
        });
      }
      e.shootCd = 3.5;
    }
    // контакт
    if (dist < e.r + p.r) {
      let dmg = e.dmg * dt * 1.6;
      // щит
      if (p.shieldCd > 0 && p.shieldCharge >= 1 && dmg > 0) {
        // блокирует один тик контакта (упростим: блок + кулдаун)
        dmg = 0;
        p.shieldCharge = 0;
        p.shieldTimer = p.shieldCd;
        rogueAddPopup("BLOCK", p.x, p.y - p.r - 10, "heal");
      }
      if (dmg > 0) {
        p.hp -= dmg;
        if (p.hp <= 0) { rogueDie(); return; }
      }
    }
    if (e.hp <= 0) ROGUE.enemies.splice(i, 1);
  }

  // переход на следующий этаж по килам (не-боссовые)
  if (!ROGUE.bossActive && ROGUE.depth % 5 !== 0) {
    const need = 10 + ROGUE.depth * 3;
    if (ROGUE.killCount >= need) {
      ROGUE.depth++;
      $("#rogueDepth").textContent = "Этаж " + ROGUE.depth;
      ROGUE.killCount = 0;
      ROGUE.bossSpawnedAtDepth = false;
      rogueAddPopup("ЭТАЖ " + ROGUE.depth, p.x, p.y - 30, "crit");
    }
  }

  // bullets
  for (let i = ROGUE.bullets.length - 1; i >= 0; i--) {
    const b = ROGUE.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.x > rogueRefs.W + 20 || b.y < -20 || b.y > rogueRefs.H + 20) {
      ROGUE.bullets.splice(i, 1);
      continue;
    }
    if (b.enemy) {
      // вражеский снаряд бьёт игрока
      if (Math.hypot(b.x - p.x, b.y - p.y) < b.r + p.r) {
        let dmg = b.dmg;
        if (p.shieldCd > 0 && p.shieldCharge >= 1) {
          dmg = 0;
          p.shieldCharge = 0;
          p.shieldTimer = p.shieldCd;
          rogueAddPopup("BLOCK", p.x, p.y - p.r - 10, "heal");
        }
        if (dmg > 0) {
          p.hp -= dmg;
          if (p.hp <= 0) { rogueDie(); return; }
        }
        ROGUE.bullets.splice(i, 1);
      }
      continue;
    }
    // наш снаряд
    for (const e of ROGUE.enemies) {
      if (b.hitSet && b.hitSet.has(e)) continue;
      if (Math.hypot(b.x - e.x, b.y - e.y) < b.r + e.r) {
        rogueDamageEnemy(e, b.dmg, b.crit, b.x, b.y);
        // ваmpiрizm
        if (p.lifesteal > 0) {
          const heal = b.dmg * p.lifesteal;
          if (p.hp < p.hpMax) {
            p.hp = Math.min(p.hpMax, p.hp + heal);
          }
        }
        if (b.explode) {
          // AoE
          for (const e2 of ROGUE.enemies) {
            if (e2 === e) continue;
            if (Math.hypot(b.x - e2.x, b.y - e2.y) < b.explode) {
              rogueDamageEnemy(e2, b.dmg * 0.6, false, b.x, b.y);
            }
          }
          // частицы взрыва
          for (let pp = 0; pp < 12; pp++) {
            ROGUE.particles.push({
              x: b.x, y: b.y, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200,
              life: 0.4, color: "#fb923c",
            });
          }
        }
        if (b.pierce > 0) {
          if (!b.hitSet) b.hitSet = new Set();
          b.hitSet.add(e);
          b.pierce--;
        } else {
          ROGUE.bullets.splice(i, 1);
        }
        break;
      }
    }
  }

  // подбор лута + magnet
  for (let i = ROGUE.drops.length - 1; i >= 0; i--) {
    const d = ROGUE.drops[i];
    d.life -= dt;
    if (d.life <= 0) { ROGUE.drops.splice(i, 1); continue; }
    const dist = Math.hypot(p.x - d.x, p.y - d.y);
    if (dist < p.magnet) {
      const k = (1 - dist / p.magnet) * 200 * dt;
      d.x += ((p.x - d.x) / (dist || 1)) * k;
      d.y += ((p.y - d.y) / (dist || 1)) * k;
    }
    if (dist < p.r + 6) {
      if (d.type === "xp") rogueGiveXP(p, 1);
      else if (d.type === "heart") {
        const heal = 12;
        p.hp = Math.min(p.hpMax, p.hp + heal);
        rogueAddPopup("+" + heal, p.x, p.y - p.r, "heal");
      }
      else if (d.type === "shard") {
        ROGUE.shardsGained += 3;
        rogueAddPopup("+3 💎", p.x, p.y - p.r, "crit");
      }
      ROGUE.drops.splice(i, 1);
    }
  }

  // particles
  for (let i = ROGUE.particles.length - 1; i >= 0; i--) {
    const pr = ROGUE.particles[i];
    pr.life -= dt;
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    pr.vx *= 0.9; pr.vy *= 0.9;
    if (pr.life <= 0) ROGUE.particles.splice(i, 1);
  }
  // popups
  for (let i = ROGUE.popups.length - 1; i >= 0; i--) {
    const o = ROGUE.popups[i];
    o.life -= dt;
    o.y -= 24 * dt;
    if (o.life <= 0) ROGUE.popups.splice(i, 1);
  }
}

function rogueRender() {
  const ctx = rogueRefs.ctx;
  if (!ctx) return;
  const W = rogueRefs.W, H = rogueRefs.H;
  // фон
  ctx.fillStyle = "#0a0a1a";
  ctx.fillRect(0, 0, W, H);
  // лёгкая сетка для пиксельности
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  const grid = 24;
  for (let x = 0; x < W; x += grid) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += grid) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // звёзды
  for (const s of ROGUE.bg) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(s.x, s.y, s.s, s.s);
  }
  ctx.globalAlpha = 1;

  // drops
  for (const d of ROGUE.drops) {
    if (d.type === "xp") {
      ctx.fillStyle = "#66e0ff";
      ctx.fillRect(d.x - 3, d.y - 3, 6, 6);
    } else if (d.type === "heart") {
      ctx.fillStyle = "#f87171";
      ctx.fillRect(d.x - 4, d.y - 4, 8, 8);
    } else if (d.type === "shard") {
      ctx.fillStyle = "#a78bfa";
      ctx.beginPath();
      ctx.moveTo(d.x, d.y - 6); ctx.lineTo(d.x + 5, d.y); ctx.lineTo(d.x, d.y + 6); ctx.lineTo(d.x - 5, d.y);
      ctx.closePath(); ctx.fill();
    }
  }

  // particles
  for (const pr of ROGUE.particles) {
    ctx.globalAlpha = Math.max(0, pr.life * 2.5);
    ctx.fillStyle = pr.color;
    ctx.fillRect(pr.x - 1.5, pr.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // enemies
  for (const e of ROGUE.enemies) {
    // тело — пиксельный квадратик
    ctx.fillStyle = e.hitFlash > 0 ? "#ffffff" : e.color;
    ctx.fillRect(e.x - e.r, e.y - e.r, e.r * 2, e.r * 2);
    // глаза/контур
    ctx.fillStyle = "#000";
    ctx.fillRect(e.x - e.r * 0.5, e.y - e.r * 0.3, 2, 2);
    ctx.fillRect(e.x + e.r * 0.5 - 2, e.y - e.r * 0.3, 2, 2);
    // hp bar для боссов / толстых
    if (e.hpMax > 30) {
      const w = Math.max(20, e.r * 2.5);
      const ratio = Math.max(0, e.hp / e.hpMax);
      ctx.fillStyle = "#000";
      ctx.fillRect(e.x - w / 2 - 1, e.y - e.r - 8, w + 2, 4);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(e.x - w / 2, e.y - e.r - 7, w * ratio, 2);
    }
    if (e.isBoss && e.ico) {
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "white";
      ctx.fillText(e.ico, e.x, e.y + 5);
    }
  }

  // bullets
  for (const b of ROGUE.bullets) {
    ctx.fillStyle = b.enemy ? (b.color || "#fb923c") : (b.crit ? "#fb923c" : "#ffd966");
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    if (b.explode) {
      ctx.strokeStyle = "rgba(251,146,60,0.4)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 3, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // player
  const p = ROGUE.player;
  if (p) {
    // body
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    // glasses
    ctx.fillStyle = "#fff";
    ctx.fillRect(p.x - p.r * 0.5, p.y - p.r * 0.3, 2, 2);
    ctx.fillRect(p.x + p.r * 0.5 - 2, p.y - p.r * 0.3, 2, 2);
    // direction "меч"
    const fx = Math.cos(p.facing), fy = Math.sin(p.facing);
    ctx.strokeStyle = "#ffd966";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p.x + fx * p.r, p.y + fy * p.r);
    ctx.lineTo(p.x + fx * (p.r + 8), p.y + fy * (p.r + 8));
    ctx.stroke();
    // shield глифа
    if (p.shieldCd > 0 && p.shieldCharge >= 1) {
      ctx.strokeStyle = "rgba(102,224,255,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2); ctx.stroke();
    }
    // attack range hint
    ctx.strokeStyle = "rgba(102,224,255,0.08)";
    ctx.beginPath(); ctx.arc(p.x, p.y, p.atkRange, 0, Math.PI * 2); ctx.stroke();
  }

  // popups
  for (const o of ROGUE.popups) {
    ctx.globalAlpha = Math.max(0, o.life * 1.5);
    ctx.font = o.kind === "crit" ? "bold 14px monospace" : "bold 12px monospace";
    ctx.fillStyle = o.kind === "crit" ? "#fb923c" : o.kind === "heal" ? "#4ade80" : "#ffd966";
    ctx.textAlign = "center";
    ctx.fillText(o.text, o.x, o.y);
  }
  ctx.globalAlpha = 1;
}

function rogueUpdateHUD() {
  const p = ROGUE.player;
  if (!p) return;
  $("#rogueHpText").textContent = `${Math.max(0, Math.ceil(p.hp))}/${Math.ceil(p.hpMax)}`;
  $("#rogueHpFill").style.width = Math.max(0, p.hp / p.hpMax * 100) + "%";
  $("#rogueLvl").textContent = p.level;
  $("#rogueXpText").textContent = `${p.xp}/${p.xpNext}`;
  $("#rogueXpFill").style.width = (p.xp / p.xpNext * 100) + "%";
  const t = (performance.now() - ROGUE.startTime) / 1000;
  $("#rogueTime").textContent = formatTime(t);
  $("#rogueKills").textContent = ROGUE.killCount;
  $("#rogueGold").textContent = ROGUE.goldGained;
}

function rogueLoop(now) {
  if (!ROGUE.running) return;
  let dt = (now - rogueRefs.last) / 1000;
  rogueRefs.last = now;
  if (dt > 0.1) dt = 0.1;
  rogueUpdate(dt);
  rogueRender();
  rogueUpdateHUD();
  rogueRefs.raf = requestAnimationFrame(rogueLoop);
}

// инициализация рогалика при первом открытии
function initRogueOnce() {
  if (rogueRefs.canvas) return;
  rogueRefs.canvas = $("#rogueCanvas");
  rogueRefs.ctx = rogueRefs.canvas.getContext("2d");
  // jоистик
  const stick = $("#rogueStick");
  const knob = $("#rogueStickKnob");
  const center = { x: 55, y: 55 }; // центр стика (110/2)
  const moveKnob = (dx, dy) => {
    const max = 35;
    let len = Math.hypot(dx, dy);
    if (len > max) { dx *= max / len; dy *= max / len; len = max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    ROGUE.joy.dx = len > 0 ? dx / max : 0;
    ROGUE.joy.dy = len > 0 ? dy / max : 0;
    ROGUE.joy.len = len / max;
  };
  const start = (e) => {
    e.preventDefault();
    ROGUE.joy.active = true;
  };
  const move = (e) => {
    if (!ROGUE.joy.active) return;
    const t = e.touches?.[0] || e;
    const rect = stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    moveKnob(t.clientX - cx, t.clientY - cy);
  };
  const end = (e) => {
    ROGUE.joy.active = false;
    moveKnob(0, 0);
  };
  stick.addEventListener("touchstart", start, { passive: false });
  stick.addEventListener("touchmove", move, { passive: false });
  stick.addEventListener("touchend", end);
  stick.addEventListener("touchcancel", end);
  stick.addEventListener("mousedown", (e) => { start(e); document.addEventListener("mousemove", move); document.addEventListener("mouseup", upOnce); });
  function upOnce(e) { end(e); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", upOnce); }

  $("#rogueStartBtn").addEventListener("click", rogueStart);
  $("#rogueRestartBtn").addEventListener("click", () => { rogueStart(); });
  $("#rogueMetaBtn").addEventListener("click", () => rogueShowOverlay("meta"));
  $("#rogueMetaClose").addEventListener("click", () => rogueShowOverlay(ROGUE.running ? "_none" : "start"));
  $("#rogueBack").addEventListener("click", () => {
    if (ROGUE.running) ROGUE.running = false;
    if (rogueRefs.raf) cancelAnimationFrame(rogueRefs.raf);
    rogueRefs.raf = null;
    closeScreen();
  });

  window.addEventListener("resize", () => {
    if (rogueRefs.canvas) rogueResize();
  });
}

// открытие экрана рогалика
function openRogueScreen() {
  initRogueOnce();
  openScreen("rogue");
  // подождать раскрытия и измерить
  setTimeout(rogueResize, 50);
  rogueShowOverlay("start");
}

// ============================================================
// 2048
// ============================================================
const G2048 = {
  size: 4,
  grid: null,           // 2D массив значений (0 = пусто)
  tiles: [],            // {value, x, y, id, merged}
  score: 0,
  moves: 0,
  uid: 0,
  busy: false,
  over: false,
};

function g2048New() {
  G2048.size = 4;
  G2048.grid = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  G2048.tiles = [];
  G2048.score = 0;
  G2048.moves = 0;
  G2048.uid = 0;
  G2048.busy = false;
  G2048.over = false;
  $("#g2048Result").textContent = "";
  g2048Spawn(); g2048Spawn();
  g2048Render();
}

function g2048Spawn() {
  const empty = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
    if (G2048.grid[r][c] === 0) empty.push([r, c]);
  if (empty.length === 0) return;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const v = Math.random() < 0.9 ? 2 : 4;
  G2048.grid[r][c] = v;
  G2048.tiles.push({ id: G2048.uid++, r, c, value: v, spawn: true });
}

function g2048Render() {
  const board = $("#g2048Board");
  const W = board.clientWidth - 16; // padding
  const cell = W / 4;
  // bg
  let bg = board.querySelector(".g2048-bg");
  if (!bg) {
    bg = document.createElement("div");
    bg.className = "g2048-bg";
    bg.innerHTML = '<div class="cell"></div>'.repeat(16);
    board.appendChild(bg);
  }
  // tiles
  // удалим лишние и обновим
  Array.from(board.querySelectorAll(".g2048-tile")).forEach(el => el.remove());
  for (const t of G2048.tiles) {
    const el = document.createElement("div");
    el.className = `g2048-tile t-${Math.min(8192, t.value)}`;
    if (t.spawn) el.classList.add("spawn");
    if (t.merged) el.classList.add("merged");
    const size = cell - 6;
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.left = (8 + t.c * cell + 3) + "px";
    el.style.top = (8 + t.r * cell + 3) + "px";
    el.textContent = t.value;
    board.appendChild(el);
    t.spawn = false; t.merged = false;
  }
  $("#score2048").textContent = fmt(G2048.score);
  $("#moves2048").textContent = G2048.moves;
  $("#best2048").textContent = fmt(state.arcade.best2048 || 0);
  $("#best2048b").textContent = fmt(state.arcade.best2048 || 0);
}

function g2048Move(dir) {
  if (G2048.busy || G2048.over) return;
  // dir: "left" | "right" | "up" | "down"
  const grid = G2048.grid.map(row => row.slice());
  const tilesByRC = new Map();
  for (const t of G2048.tiles) tilesByRC.set(t.r * 4 + t.c, t);

  let moved = false;
  let scored = 0;
  const newTiles = [];

  function processLine(cells) {
    // cells: [[r,c]...] в порядке движения
    const oldVals = cells.map(([r, c]) => grid[r][c]);
    const oldTiles = cells.map(([r, c]) => tilesByRC.get(r * 4 + c));
    const filtered = [];
    const tilesFiltered = [];
    for (let i = 0; i < oldVals.length; i++) {
      if (oldVals[i]) { filtered.push(oldVals[i]); tilesFiltered.push(oldTiles[i]); }
    }
    const merged = [];
    const mergedTiles = [];
    for (let i = 0; i < filtered.length; i++) {
      if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
        const v = filtered[i] * 2;
        merged.push(v);
        scored += v;
        mergedTiles.push({ value: v, sourceTiles: [tilesFiltered[i], tilesFiltered[i + 1]], wasMerged: true });
        i++;
      } else {
        merged.push(filtered[i]);
        mergedTiles.push({ value: filtered[i], sourceTiles: [tilesFiltered[i]], wasMerged: false });
      }
    }
    while (merged.length < cells.length) { merged.push(0); mergedTiles.push(null); }
    // запишем
    for (let i = 0; i < cells.length; i++) {
      const [r, c] = cells[i];
      const before = grid[r][c];
      grid[r][c] = merged[i];
      if (before !== merged[i]) moved = true;
      const m = mergedTiles[i];
      if (m) {
        // если есть исходник на этой клетке и не мердж — двинем существующий
        if (!m.wasMerged && m.sourceTiles[0]) {
          const t = m.sourceTiles[0];
          newTiles.push({ id: t.id, r, c, value: m.value, spawn: false, merged: false });
        } else if (m.wasMerged) {
          // оба исходника визуально едут к [r,c], а потом появляется новая объединённая
          newTiles.push({ id: G2048.uid++, r, c, value: m.value, spawn: false, merged: true });
        }
      }
    }
  }

  if (dir === "left") {
    for (let r = 0; r < 4; r++) processLine([[r,0],[r,1],[r,2],[r,3]]);
  } else if (dir === "right") {
    for (let r = 0; r < 4; r++) processLine([[r,3],[r,2],[r,1],[r,0]]);
  } else if (dir === "up") {
    for (let c = 0; c < 4; c++) processLine([[0,c],[1,c],[2,c],[3,c]]);
  } else if (dir === "down") {
    for (let c = 0; c < 4; c++) processLine([[3,c],[2,c],[1,c],[0,c]]);
  }

  if (!moved) return;
  G2048.grid = grid;
  G2048.tiles = newTiles;
  G2048.score += scored;
  G2048.moves++;
  if (G2048.score > (state.arcade.best2048 || 0)) {
    state.arcade.best2048 = G2048.score;
    save();
  }
  g2048Spawn();
  g2048Render();
  haptic("light");
  // game over check
  if (g2048IsOver()) {
    G2048.over = true;
    $("#g2048Result").innerHTML = `<b style="color: var(--red);">Конец игры. Счёт ${fmt(G2048.score)}</b>`;
    haptic("lose");
  } else {
    // win popup
    if (G2048.tiles.some(t => t.value >= 2048) && !G2048.warned) {
      G2048.warned = true;
      $("#g2048Result").innerHTML = `<b style="color: var(--gold);">🏆 2048! Можно играть дальше</b>`;
      confettiBurst(60);
    }
  }
}

function g2048IsOver() {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (G2048.grid[r][c] === 0) return false;
    const v = G2048.grid[r][c];
    if (c < 3 && G2048.grid[r][c+1] === v) return false;
    if (r < 3 && G2048.grid[r+1][c] === v) return false;
  }
  return true;
}

// инициализация 2048 управления
let g2048Inited = false;
function init2048() {
  if (g2048Inited) return;
  g2048Inited = true;
  $("#g2048Restart").addEventListener("click", g2048New);

  const board = $("#g2048Board");
  let touchStart = null;
  board.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  board.addEventListener("touchmove", (e) => { e.preventDefault(); }, { passive: false });
  board.addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
    if (Math.abs(dx) > Math.abs(dy)) g2048Move(dx > 0 ? "right" : "left");
    else g2048Move(dy > 0 ? "down" : "up");
  });
  document.addEventListener("keydown", (e) => {
    if (!$("#screen-game2048").classList.contains("open")) return;
    if (e.key === "ArrowLeft") g2048Move("left");
    else if (e.key === "ArrowRight") g2048Move("right");
    else if (e.key === "ArrowUp") g2048Move("up");
    else if (e.key === "ArrowDown") g2048Move("down");
  });
}

function open2048() {
  init2048();
  openScreen("game2048");
  setTimeout(() => { g2048New(); }, 50);
}

// ============================================================
// SNAKE
// ============================================================
const SNAKE = {
  cols: 20, rows: 20,
  body: [], dir: "right", nextDir: "right",
  food: null,
  alive: false,
  score: 0,
  speed: 8, // тиков в секунду
  acc: 0,
  raf: null, last: 0,
  ctx: null, canvas: null,
  W: 0, H: 0,
};

function snakeNew() {
  SNAKE.body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  SNAKE.dir = "right";
  SNAKE.nextDir = "right";
  SNAKE.food = snakeRandomFood();
  SNAKE.alive = true;
  SNAKE.score = 0;
  SNAKE.speed = 8;
  SNAKE.acc = 0;
  $("#snakeOverlay").classList.add("hidden");
  snakeRender();
  if (!SNAKE.raf) {
    SNAKE.last = performance.now();
    SNAKE.raf = requestAnimationFrame(snakeLoop);
  }
  $("#scoreSnake").textContent = SNAKE.score;
  $("#lenSnake").textContent = SNAKE.body.length;
  $("#spdSnake").textContent = (SNAKE.speed / 8).toFixed(1) + "x";
  $("#bestSnake").textContent = state.arcade.bestSnake || 0;
}

function snakeRandomFood() {
  while (true) {
    const x = Math.floor(Math.random() * SNAKE.cols);
    const y = Math.floor(Math.random() * SNAKE.rows);
    if (!SNAKE.body.some(s => s.x === x && s.y === y)) return { x, y };
  }
}

function snakeStep() {
  if (!SNAKE.alive) return;
  // не разворот
  const opp = { up: "down", down: "up", left: "right", right: "left" };
  if (SNAKE.nextDir !== opp[SNAKE.dir]) SNAKE.dir = SNAKE.nextDir;
  const head = { ...SNAKE.body[0] };
  if (SNAKE.dir === "up") head.y--;
  else if (SNAKE.dir === "down") head.y++;
  else if (SNAKE.dir === "left") head.x--;
  else if (SNAKE.dir === "right") head.x++;
  // стены
  if (head.x < 0 || head.y < 0 || head.x >= SNAKE.cols || head.y >= SNAKE.rows) {
    return snakeOver();
  }
  // самопересечение
  if (SNAKE.body.some(s => s.x === head.x && s.y === head.y)) {
    return snakeOver();
  }
  SNAKE.body.unshift(head);
  if (head.x === SNAKE.food.x && head.y === SNAKE.food.y) {
    SNAKE.score += 10;
    SNAKE.food = snakeRandomFood();
    SNAKE.speed = Math.min(20, 8 + Math.floor(SNAKE.body.length / 5));
    haptic("light");
  } else {
    SNAKE.body.pop();
  }
  $("#scoreSnake").textContent = SNAKE.score;
  $("#lenSnake").textContent = SNAKE.body.length;
  $("#spdSnake").textContent = (SNAKE.speed / 8).toFixed(1) + "x";
}

function snakeOver() {
  SNAKE.alive = false;
  if (SNAKE.score > (state.arcade.bestSnake || 0)) {
    state.arcade.bestSnake = SNAKE.score;
    save();
  }
  const ov = $("#snakeOverlay");
  ov.classList.remove("hidden");
  $("#snakeOverTitle").textContent = "💀 Конец";
  $("#snakeOverText").innerHTML = `Счёт: <b>${SNAKE.score}</b><br>Лучший: <b>${state.arcade.bestSnake}</b>`;
  $("#snakeStart").textContent = "🔁 Заново";
  haptic("lose");
}

function snakeRender() {
  const c = SNAKE.canvas;
  const ctx = SNAKE.ctx;
  if (!c || !ctx) return;
  ctx.fillStyle = "#0a0a1a";
  ctx.fillRect(0, 0, SNAKE.W, SNAKE.H);
  const cw = SNAKE.W / SNAKE.cols;
  const ch = SNAKE.H / SNAKE.rows;
  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < SNAKE.cols; i++) {
    ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, SNAKE.H); ctx.stroke();
  }
  for (let i = 0; i < SNAKE.rows; i++) {
    ctx.beginPath(); ctx.moveTo(0, i * ch); ctx.lineTo(SNAKE.W, i * ch); ctx.stroke();
  }
  // food
  ctx.fillStyle = "#f87171";
  ctx.fillRect(SNAKE.food.x * cw + 2, SNAKE.food.y * ch + 2, cw - 4, ch - 4);
  // snake
  for (let i = 0; i < SNAKE.body.length; i++) {
    const s = SNAKE.body[i];
    ctx.fillStyle = i === 0 ? "#a3e635" : "#65a30d";
    ctx.fillRect(s.x * cw + 1, s.y * ch + 1, cw - 2, ch - 2);
  }
}

function snakeLoop(now) {
  if (!$("#screen-snake").classList.contains("open")) {
    if (SNAKE.raf) cancelAnimationFrame(SNAKE.raf);
    SNAKE.raf = null;
    return;
  }
  const dt = (now - SNAKE.last) / 1000;
  SNAKE.last = now;
  if (SNAKE.alive) {
    SNAKE.acc += dt * SNAKE.speed;
    while (SNAKE.acc >= 1) {
      SNAKE.acc -= 1;
      snakeStep();
      if (!SNAKE.alive) break;
    }
  }
  snakeRender();
  SNAKE.raf = requestAnimationFrame(snakeLoop);
}

let snakeInited = false;
function initSnake() {
  if (snakeInited) return;
  snakeInited = true;
  SNAKE.canvas = $("#snakeCanvas");
  SNAKE.ctx = SNAKE.canvas.getContext("2d");
  const resize = () => {
    const arena = SNAKE.canvas.parentElement;
    const rect = arena.getBoundingClientRect();
    SNAKE.W = rect.width;
    SNAKE.H = rect.height;
    SNAKE.canvas.width = SNAKE.W;
    SNAKE.canvas.height = SNAKE.H;
    snakeRender();
  };
  window.addEventListener("resize", resize);
  setTimeout(resize, 50);

  $("#snakeStart").addEventListener("click", snakeNew);
  $$(".snake-key").forEach(b => b.addEventListener("click", () => {
    SNAKE.nextDir = b.dataset.snakeDir;
    haptic("light");
  }));
  document.addEventListener("keydown", (e) => {
    if (!$("#screen-snake").classList.contains("open")) return;
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (map[e.key]) SNAKE.nextDir = map[e.key];
  });
  // свайпы
  SNAKE.canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    SNAKE._ts = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  SNAKE.canvas.addEventListener("touchend", (e) => {
    if (!SNAKE._ts) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - SNAKE._ts.x, dy = t.clientY - SNAKE._ts.y;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return;
    if (Math.abs(dx) > Math.abs(dy)) SNAKE.nextDir = dx > 0 ? "right" : "left";
    else SNAKE.nextDir = dy > 0 ? "down" : "up";
  });
}

function openSnake() {
  initSnake();
  openScreen("snake");
  // не стартуем сразу — оверлей
  setTimeout(() => {
    SNAKE.W = SNAKE.canvas.parentElement.clientWidth;
    SNAKE.H = SNAKE.canvas.parentElement.clientHeight;
    SNAKE.canvas.width = SNAKE.W;
    SNAKE.canvas.height = SNAKE.H;
    if (!SNAKE.raf) {
      SNAKE.last = performance.now();
      SNAKE.raf = requestAnimationFrame(snakeLoop);
    }
    snakeRender();
    $("#bestSnake").textContent = state.arcade.bestSnake || 0;
  }, 50);
}

// ============================================================
// маршрутизация data-open для аркады + рекорды на профиле/таб
// ============================================================
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open]");
  if (!t) return;
  const id = t.dataset.open;
  if (id === "rogue") { e.preventDefault(); e.stopPropagation(); openRogueScreen(); }
  else if (id === "game2048") { e.preventDefault(); e.stopPropagation(); open2048(); }
  else if (id === "snake") { e.preventDefault(); e.stopPropagation(); openSnake(); }
}, true);

// рендер блока рекордов в табе аркада
function renderArcadeRecords() {
  const a = state.arcade || {};
  const r = a.rogueBest || { depth: 0, kills: 0, time: 0 };
  $("#arcadeRecords").innerHTML = `
    <div class="stat-tile"><div class="label">🗡️ Подземелье · этаж</div><div class="value">${r.depth}</div></div>
    <div class="stat-tile"><div class="label">🗡️ Подземелье · убийств</div><div class="value">${r.kills}</div></div>
    <div class="stat-tile"><div class="label">🔢 2048 · счёт</div><div class="value" style="color:var(--gold);">${fmt(a.best2048 || 0)}</div></div>
    <div class="stat-tile"><div class="label">🐍 Змейка · счёт</div><div class="value">${a.bestSnake || 0}</div></div>
    <div class="stat-tile"><div class="label">💎 Осколков</div><div class="value" style="color:var(--purple);">${fmt(a.soulShards || 0)}</div></div>
    <div class="stat-tile"><div class="label">⏱ Лучшее время в подземелье</div><div class="value">${formatTime(r.time || 0)}</div></div>
  `;
}

// расширяем nav handler, чтобы рендерить рекорды
const _origNavHandler = null;
$$(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.nav === "arcade") renderArcadeRecords();
  });
});
// первый рендер
renderArcadeRecords();

})();
