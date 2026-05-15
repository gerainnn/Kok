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

})();
