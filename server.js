'use strict';
/* ソフトテニス トレーニングマッチ管理アプリ
   - 公開: 閲覧ページ / 申込フォーム / 実績ページ
   - 管理: 設定・申込管理・昇降級・コート自動配置・トーナメント移行・印刷(名簿/領収書/要項)
   Node.js 標準機能のみ。データは JSON ファイルに保存。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ---------------- storage ---------------- */
let DB = null;
const ttsCache = new Map();
function loadDB() {
  try {
    DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!DB || !Array.isArray(DB.events)) throw new Error('bad');
  } catch (e) {
    DB = { adminHash: null, events: [] };
  }
  if (!DB.sessions) DB.sessions = [];
  if (!DB.viewSessions) DB.viewSessions = [];
}
function saveDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DATA_FILE);
}
loadDB();

/* ---------------- auth ---------------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex'));
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function sessionToken(req) {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim());
  for (const p of c) if (p.startsWith('tt_admin=')) return p.slice(9);
  return null;
}
function isAdmin(req) {
  const t = sessionToken(req);
  return !!t && DB.sessions.includes(t);
}
function cookieVal(req, name) {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim());
  for (const p of c) if (p.startsWith(name + '=')) return p.slice(name.length + 1);
  return null;
}
function hasViewAccess(req, ev) {
  if (!ev.viewPassHash) return true;
  if (isAdmin(req)) return true;
  const t = cookieVal(req, 'tt_view');
  return !!t && DB.viewSessions.some(s => s.t === t && s.evId === ev.id);
}

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return crypto.randomBytes(6).toString('hex'); }
function todayStr() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function levelName(i) { // 0->A, 1->B, ... 26->AA
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function seedPositions(size) {
  let pos = [1, 2];
  while (pos.length < size) {
    const sum = pos.length * 2 + 1;
    const next = [];
    for (const p of pos) { next.push(p); next.push(sum - p); }
    pos = next;
  }
  return pos;
}

/* ---------------- data model ---------------- */
const CATEGORIES = ['男子', '女子', '混合'];
const YEARS = ['小4以下', '小5', '小6', '中1', '中2', '中3', '高1', '高2', '高3', '一般'];
const LEVEL_ATTRS = ['県大会出場', '地区大会出場', '地区大会未出場', '初心者'];

function blankEvent() {
  return {
    id: uid(),
    name: '新しい大会',
    date: '',
    venue: '',
    organizer: '',
    notes: '',           // 要項の備考
    levelCount: 4,       // レベル数 (A,B,C,D...)
    courtCount: 4,
    waitSlots: 1,  // 1コートあたりの待機試合数 (1-3)
    gameMode: 'single',  // single|double|triple = 1コート同時試合数
    feeType: 'pair',     // person|pair|team
    feeAmount: 2000,
    bentoCheck: false,   // 申込フォームで弁当要否を確認するか
    bentoPrice: 800,
    advanceCount: 8,     // トーナメント進出ペア数
    allowSameTeam: true, // 同チーム同士の対戦を許可するか
    allowRematch: true,  // 一度対戦したペア同士の再戦を許可するか
    regOpen: true,
    regDeadline: '',     // 受付締切日 (YYYY-MM-DD)。空欄なら開催日まで受付
    viewPassHash: null,  // 閲覧用パスワード (大会ごと)。nullなら誰でも閲覧可
    phase: 'entry',      // entry | training | tournament
    registrations: [],   // {id, teamName, contact, pairs:[{pid,p1,p2,category,year1,year2,levelAttr,startLevel}], bentoCount, totalFee, createdAt}
    levels: [],          // training: [[pid,...], ...]
    stats: {},           // pid -> {w, l}
    matches: [],         // {id, level, court, a, b, status: waiting|playing|done, winner, createdAt, calledAt, finishedAt}
    matchSeq: 0,
    tournament: null,    // {size, rounds: [[{a,b,winner}...]...], seeds:[pid...]}
    createdAt: Date.now(),
  };
}
function getEvent(id) {
  if (id) { const e = DB.events.find(e => e.id === id); if (e) return e; }
  return DB.events[0] || null;
}
function allPairs(ev) {
  const out = [];
  for (const r of ev.registrations) {
    for (const p of r.pairs) out.push({ ...p, teamId: r.id, teamName: r.teamName });
  }
  return out;
}
function pairMap(ev) {
  const m = {};
  for (const p of allPairs(ev)) m[p.pid] = p;
  return m;
}
function pairLabel(p) { return p ? (p.p1 + '・' + p.p2) : '未定'; }
function pairYears(p) {
  const y1 = p.year1 || p.year || '一般';
  const y2 = p.year2 || p.year || '一般';
  return [y1, y2];
}
function pairYearLabel(p) {
  const ys = pairYears(p);
  return ys[0] === ys[1] ? ys[0] : ys[0] + '・' + ys[1];
}
function autoLevel(ev, levelAttr) {
  const score = levelAttr === '県大会出場' ? 0 : levelAttr === '地区大会出場' ? 1 : levelAttr === '地区大会未出場' ? 2 : 3;
  const n = Math.max(1, (ev.levels && ev.levels.length) || ev.levelCount || 4);
  return Math.min(n - 1, Math.floor(score * n / 4));
}
function regDeadlineOf(ev) { return ev.regDeadline || ev.date || ''; }
function isRegOpen(ev) {
  if (!ev.regOpen) return false;
  if (ev.phase === 'tournament') return false;
  const dl = regDeadlineOf(ev);
  if (dl && todayStr() > dl) return false;
  return true;
}
function placePairInTraining(ev, pair) {
  if (!Array.isArray(ev.levels) || ev.levels.length === 0) {
    ev.levels = Array.from({ length: Math.max(1, ev.levelCount || 4) }, () => []);
  }
  for (let i = 0; i < ev.levels.length; i++) if (!Array.isArray(ev.levels[i])) ev.levels[i] = [];
  let lv = pair.startLevel;
  if (lv == null || lv < 0 || lv >= ev.levels.length) lv = autoLevel(ev, pair.levelAttr);
  if (lv == null || lv < 0 || lv >= ev.levels.length) lv = ev.levels.length - 1;
  if (!ev.levels[lv].includes(pair.pid)) ev.levels[lv].push(pair.pid);
  if (!ev.stats[pair.pid]) ev.stats[pair.pid] = { w: 0, l: 0 };
}

/* 参加費計算: feeType person=人数単位 pair=ペア単位 team=チーム単位 / 弁当は個数×単価 */
function calcFee(ev, pairCount, bentoCount) {
  let base = 0;
  if (ev.feeType === 'person') base = ev.feeAmount * pairCount * 2;
  else if (ev.feeType === 'pair') base = ev.feeAmount * pairCount;
  else base = ev.feeAmount;
  const bento = ev.bentoCheck ? ev.bentoPrice * (bentoCount || 0) : 0;
  return { base, bento, total: base + bento };
}

/* ---------------- training logic ---------------- */
function pairLevel(ev, pid) {
  for (let i = 0; i < ev.levels.length; i++) if (Array.isArray(ev.levels[i]) && ev.levels[i].includes(pid)) return i;
  return -1;
}
function activeMatchOf(ev, pid) {
  return ev.matches.find(m => m.status !== 'done' && (m.a === pid || m.b === pid)) || null;
}
function gamesPlayed(ev, pid) {
  const s = ev.stats[pid];
  return s ? s.w + s.l : 0;
}
function lastPlayedAt(ev, pid) {
  let t = 0;
  for (const m of ev.matches) {
    if (m.status === 'done' && (m.a === pid || m.b === pid)) t = Math.max(t, m.finishedAt || 0);
  }
  return t;
}
/* コートの空き枠に待機/試合中マッチを自動配置する。
   1コートあたり: 試合中 = gameMode試合まで + 待機 = 1試合。
   対戦は同一レベル内で、試合数が少なく長く待っているペアを優先。 */
function matchesPerCourt(ev) { return ev.gameMode === 'triple' ? 3 : ev.gameMode === 'double' ? 2 : 1; }
function waitSlotsOf(ev) { const n = parseInt(ev.waitSlots, 10); return (n >= 1 && n <= 3) ? n : 1; }
function ensureAssignments(ev) {
  if (ev.phase !== 'training') return;
  const per = matchesPerCourt(ev);
  let changed = false;
  const playingCount = c => ev.matches.filter(m => m.court === c && m.status === 'playing').length;
  // まず空いているコートへ、他のコートで待機しているマッチを移動して開始する。
  // 待機マッチをコートに固定したままだと、空きコートがあっても特定レベルが滞留するため。
  for (let court = 1; court <= ev.courtCount; court++) {
    while (playingCount(court) < per) {
      let w = ev.matches.find(m => m.court === court && m.status === 'waiting');
      if (!w) {
        const others = ev.matches.filter(m => m.status === 'waiting' && m.court !== court)
          .sort((x, y) => (x.calledAt || x.createdAt || 0) - (y.calledAt || y.createdAt || 0));
        w = others[0];
        if (w) w.court = court;
      }
      if (!w) break;
      w.status = 'playing';
      changed = true;
    }
  }
  for (let court = 1; court <= ev.courtCount; court++) {
    // 空き枠 (試合中+待機) があれば新規マッチを作成
    for (;;) {
      const playing = ev.matches.filter(m => m.court === court && m.status === 'playing').length;
      const waiting = ev.matches.filter(m => m.court === court && m.status === 'waiting').length;
      const ws = waitSlotsOf(ev);
      if (playing >= per && waiting >= ws) break;
      if (playing + waiting >= per + ws) break;
      const m = pickMatch(ev);
      if (!m) break;
      m.court = court;
      m.status = playing < per ? 'playing' : 'waiting';
      if (m.status === 'waiting') m.calledAt = Date.now();
      ev.matches.push(m);
      changed = true;
    }
  }
  if (changed) saveDB();
}
function pickMatch(ev) {
  // レベルごとに空きペアの組み合わせを探す（同チーム対決・再戦の設定を反映）。
  // 優先順: そのレベルで進行中（試合中＋待機）のマッチが少ない → 試合数の少ないペア → 長く待っているペア。
  // 進行中マッチ数を先に見ることで、特定レベルだけが滞るのを防ぐ。
  const pm = pairMap(ev);
  const played = new Set();
  const activeByLevel = {};
  for (const m of ev.matches) {
    if (m.status === 'done') played.add([m.a, m.b].sort().join('|'));
    else activeByLevel[m.level] = (activeByLevel[m.level] || 0) + 1;
  }
  let best = null;
  const scan = (ignoreRules) => {
    for (let lv = 0; lv < ev.levels.length; lv++) {
      const free = (Array.isArray(ev.levels[lv]) ? ev.levels[lv] : []).filter(pid => !activeMatchOf(ev, pid));
      if (free.length < 2) continue;
      const la = activeByLevel[lv] || 0;
      for (let i = 0; i < free.length; i++) {
        for (let j = i + 1; j < free.length; j++) {
          const a = free[i], b = free[j];
          if (!ignoreRules && ev.allowSameTeam === false && pm[a] && pm[b] && pm[a].teamId === pm[b].teamId) continue;
          if (!ignoreRules && ev.allowRematch === false && played.has([a, b].sort().join('|'))) continue;
          const score = gamesPlayed(ev, a) + gamesPlayed(ev, b);
          const wait = Math.min(lastPlayedAt(ev, a), lastPlayedAt(ev, b));
          if (!best || la < best.la || (la === best.la && (score < best.score || (score === best.score && wait < best.wait)))) best = { a, b, level: lv, la, score, wait };
        }
      }
    }
  };
  scan(false);
  // コートを空けないため、制限内では組めない場合に限り同チーム・再戦でも組む
  if (!best) scan(true);
  if (!best) return null;
  ev.matchSeq += 1;
  return { id: 'm' + ev.matchSeq, level: best.level, court: 0, a: best.a, b: best.b, status: 'playing', winner: null, createdAt: Date.now(), calledAt: null, finishedAt: null };
}
/* 結果入力: 勝者を1つ上、敗者を1つ下のレベルへ (端は残留)。統計も更新。 */
function applyResult(ev, match, ga, gb) {
  const winnerPid = ga > gb ? match.a : match.b;
  const loserPid = match.a === winnerPid ? match.b : match.a;
  match.status = 'done';
  match.winner = winnerPid;
  match.ga = ga; match.gb = gb;
  match.finishedAt = Date.now();
  for (const pid of [winnerPid, loserPid]) if (!ev.stats[pid]) ev.stats[pid] = { w: 0, l: 0 };
  ev.stats[winnerPid].w += 1;
  ev.stats[loserPid].l += 1;
  movePair(ev, winnerPid, -1);
  movePair(ev, loserPid, +1);
}
function movePair(ev, pid, dir) {
  const lv = pairLevel(ev, pid);
  if (lv < 0) return;
  const nl = lv + dir;
  if (nl < 0 || nl >= ev.levels.length) return; // 端は残留
  ev.levels[lv] = ev.levels[lv].filter(x => x !== pid);
  ev.levels[nl].push(pid);
}
function movePairToLevel(ev, pid, target) {
  if (target < 0 || target >= ev.levels.length) return;
  const lv = pairLevel(ev, pid);
  if (lv < 0 || lv === target) return;
  ev.levels[lv] = ev.levels[lv].filter(x => x !== pid);
  if (!Array.isArray(ev.levels[target])) ev.levels[target] = [];
  ev.levels[target].push(pid);
}
/* 終わった試合の結果修正: 統計は巻き戻して付け直す。
   レベルの移動は、その試合より後に終わった試合が両ペアとも無い場合のみ正確に戻せる。
   後の試合がある場合は勝敗・勝率のみ修正し、レベル位置は変更しない。 */
function fixResult(ev, m, ga, gb) {
  const oldWinner = m.winner;
  const oldLoser = oldWinner === m.a ? m.b : m.a;
  const newWinner = ga > gb ? m.a : m.b;
  const newLoser = newWinner === m.a ? m.b : m.a;
  for (const pid of [oldWinner, oldLoser, newWinner, newLoser]) if (!ev.stats[pid]) ev.stats[pid] = { w: 0, l: 0 };
  ev.stats[oldWinner].w = Math.max(0, ev.stats[oldWinner].w - 1);
  ev.stats[oldLoser].l = Math.max(0, ev.stats[oldLoser].l - 1);
  ev.stats[newWinner].w += 1;
  ev.stats[newLoser].l += 1;
  let levelsAdjusted = true;
  if (oldWinner !== newWinner) {
    const later = ev.matches.some(x => x.status === 'done' && x.id !== m.id && (x.finishedAt || 0) > (m.finishedAt || 0) && (x.a === m.a || x.b === m.a || x.a === m.b || x.b === m.b));
    if (!later) {
      movePairToLevel(ev, oldWinner, m.level);
      movePairToLevel(ev, oldLoser, m.level);
      movePair(ev, newWinner, -1);
      movePair(ev, newLoser, +1);
    } else {
      levelsAdjusted = false;
    }
  }
  m.ga = ga; m.gb = gb; m.winner = newWinner;
  m.fixedAt = Date.now();
  return { levelsAdjusted };
}
/* 実績ランキング: 勝率→勝数→敗数 の順 */
function standings(ev) {
  const pm = pairMap(ev);
  const rows = allPairs(ev).map(p => {
    const s = ev.stats[p.pid] || { w: 0, l: 0 };
    const g = s.w + s.l;
    return { pid: p.pid, pair: p, teamName: p.teamName, w: s.w, l: s.l, games: g, rate: g ? s.w / g : 0, level: pairLevel(ev, p.pid) };
  });
  rows.sort((x, y) => (y.rate - x.rate) || (y.w - x.w) || (x.l - y.l) || (x.games - y.games));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
/* トーナメント生成: 勝率上位 advanceCount ペアをシード順に配置 */
function buildTournament(ev) {
  const rows = standings(ev).filter(r => r.games > 0 || true);
  const n = Math.max(2, Math.min(ev.advanceCount, rows.length));
  const seeds = rows.slice(0, n).map(r => r.pid);
  const size = nextPow2(n);
  const pos = seedPositions(size);
  const first = [];
  for (let i = 0; i < size / 2; i++) {
    const sa = pos[i * 2], sb = pos[i * 2 + 1];
    first.push({ a: sa <= n ? seeds[sa - 1] : null, b: sb <= n ? seeds[sb - 1] : null, winner: null });
  }
  const rounds = [first];
  let cnt = size / 2;
  while (cnt > 1) { cnt = cnt / 2; rounds.push(Array.from({ length: cnt }, () => ({ a: null, b: null, winner: null }))); }
  ev.tournament = { size, seeds, rounds };
  // BYE の自動勝ち上がり
  propagateByes(ev);
  ev.phase = 'tournament';
}
function propagateByes(ev) {
  const T = ev.tournament;
  if (!T) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < T.rounds.length; r++) {
      for (let i = 0; i < T.rounds[r].length; i++) {
        const m = T.rounds[r][i];
        if (m.winner) continue;
        const only = (m.a && !m.b) ? m.a : (!m.a && m.b) ? m.b : null;
        if (only && (m.a !== null || m.b !== null) && r === 0) {
          m.winner = only;
          changed = true;
        }
        if (m.winner && r + 1 < T.rounds.length) {
          const nm = T.rounds[r + 1][Math.floor(i / 2)];
          const slot = i % 2 === 0 ? 'a' : 'b';
          if (nm[slot] !== m.winner) { nm[slot] = m.winner; changed = true; }
        }
      }
    }
  }
}
function setTournamentWinner(ev, r, i, ga, gb) {
  const T = ev.tournament;
  const m = T.rounds[r][i];
  if (!m || !m.a || !m.b) return false;
  const pid = ga > gb ? m.a : m.b;
  m.winner = pid;
  m.ga = ga; m.gb = gb;
  if (r + 1 < T.rounds.length) {
    const nm = T.rounds[r + 1][Math.floor(i / 2)];
    nm[i % 2 === 0 ? 'a' : 'b'] = pid;
  }
  return true;
}

/* ---------------- public state ---------------- */
function publicState(ev) {
  const pm = pairMap(ev);
  const pairInfo = pid => {
    const p = pm[pid];
    if (!p) return null;
    const s = ev.stats[pid] || { w: 0, l: 0 };
    const ys = pairYears(p);
    return { pid, label: pairLabel(p), teamName: p.teamName, category: p.category, year: pairYearLabel(p), year1: ys[0], year2: ys[1], levelAttr: p.levelAttr, w: s.w, l: s.l };
  };
  ensureAssignments(ev);
  const courts = [];
  for (let c = 1; c <= ev.courtCount; c++) {
    courts.push({
      court: c,
      playing: ev.matches.filter(m => m.court === c && m.status === 'playing').map(m => ({ id: m.id, level: m.level, a: pairInfo(m.a), b: pairInfo(m.b) })),
      waiting: ev.matches.filter(m => m.court === c && m.status === 'waiting').map(m => ({ id: m.id, level: m.level, a: pairInfo(m.a), b: pairInfo(m.b), calledAt: m.calledAt })),
    });
  }
  const recent = ev.matches.filter(m => m.status === 'done').slice(-12).reverse().map(m => ({
    id: m.id, level: m.level, court: m.court,
    a: pairInfo(m.a), b: pairInfo(m.b),
    winnerPid: m.winner, finishedAt: m.finishedAt, ga: m.ga, gb: m.gb,
  }));
  return {
    event: { id: ev.id, name: ev.name, date: ev.date, venue: ev.venue, phase: ev.phase, levelCount: ev.levels.length || ev.levelCount, courtCount: ev.courtCount, gameMode: ev.gameMode, regOpen: isRegOpen(ev), regDeadline: regDeadlineOf(ev), hasViewPass: !!ev.viewPassHash },
    levels: ev.levels.map((l, i) => ({ level: i, name: levelName(i), pairs: l.map(pid => pairInfo(pid)) })),
    courts,
    recent,
    standings: standings(ev).map(r => ({ rank: r.rank, pid: r.pid, label: pairLabel(r.pair), teamName: r.teamName, category: r.pair.category, year: pairYearLabel(r.pair), levelAttr: r.pair.levelAttr, w: r.w, l: r.l, games: r.games, rate: r.rate, level: r.level })),
    tournament: ev.tournament ? {
      size: ev.tournament.size,
      rounds: ev.tournament.rounds.map(rd => rd.map(m => ({ a: m.a ? pairInfo(m.a) : null, b: m.b ? pairInfo(m.b) : null, winner: m.winner, ga: m.ga, gb: m.gb }))),
    } : null,
    levelNames: Array.from({ length: Math.max(ev.levels.length, ev.levelCount) }, (_, i) => levelName(i)),
  };
}

/* ---------------- http plumbing ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendHtml(res, code, html, extraHeaders) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, extraHeaders || {}));
  res.end(html);
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    /* ----- public API ----- */
    if (p === '/api/events') {
      return sendJson(res, 200, { events: DB.events.map(e => ({ id: e.id, name: e.name, date: e.date, phase: e.phase, regOpen: isRegOpen(e), regDeadline: regDeadlineOf(e), hasViewPass: !!e.viewPassHash })) });
    }
    if (p === '/api/state') {
      const ev = getEvent(url.searchParams.get('event'));
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      if (!hasViewAccess(req, ev)) return sendJson(res, 401, { needViewPass: true, eventName: ev.name });
      return sendJson(res, 200, publicState(ev));
    }
    if (p === '/api/view/login' && req.method === 'POST') {
      const b = await readBody(req);
      const ev = getEvent(b.eventId);
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      if (!ev.viewPassHash) return sendJson(res, 200, { ok: true });
      if (!checkPw(String(b.password || ''), ev.viewPassHash)) return sendJson(res, 401, { error: 'パスワードが違います' });
      const t = newToken(); DB.viewSessions.push({ t, evId: ev.id }); saveDB();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'tt_view=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/tts') {
      const q = String(url.searchParams.get('q') || '').slice(0, 140);
      if (!q) return sendJson(res, 400, { error: 'no text' });
      const key = crypto.createHash('sha1').update(q).digest('hex');
      if (ttsCache.has(key)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
        return res.end(ttsCache.get(key));
      }
      try {
        const u = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=' + encodeURIComponent(q);
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'Referer': 'https://translate.google.com/' } });
        if (!r.ok) throw new Error('tts status ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (ttsCache.size > 200) ttsCache.clear();
        ttsCache.set(key, buf);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
        return res.end(buf);
      } catch (e) {
        return sendJson(res, 502, { error: 'tts unavailable' });
      }
    }
    if (p === '/logo.png') {
      try {
        const buf = fs.readFileSync(path.join(__dirname, 'logo.png'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return res.end(buf);
      } catch (e) { return sendHtml(res, 404, 'no logo'); }
    }
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const ev = getEvent(b.eventId);
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      if (!isRegOpen(ev)) return sendJson(res, 400, { error: '受付は終了しています' });
      const teamName = String(b.teamName || '').trim();
      if (!teamName) return sendJson(res, 400, { error: 'チーム名を入力してください' });
      const pairsIn = Array.isArray(b.pairs) ? b.pairs : [];
      const pairs = [];
      for (const q of pairsIn) {
        const p1 = String(q.p1 || '').trim(), p2 = String(q.p2 || '').trim();
        if (!p1 && !p2) continue;
        if (!p1 || !p2) return sendJson(res, 400, { error: 'ペアは2人とも入力してください' });
        const y1 = YEARS.includes(q.year1) ? q.year1 : (YEARS.includes(q.year) ? q.year : '一般');
        const y2 = YEARS.includes(q.year2) ? q.year2 : (YEARS.includes(q.year) ? q.year : '一般');
        pairs.push({
          pid: uid(), p1, p2,
          category: CATEGORIES.includes(q.category) ? q.category : '混合',
          year1: y1, year2: y2, year: y1 === y2 ? y1 : y1 + '・' + y2,
          levelAttr: LEVEL_ATTRS.includes(q.levelAttr) ? q.levelAttr : '地区大会未出場',
          startLevel: null,
        });
      }
      if (!pairs.length) return sendJson(res, 400, { error: 'ペアを1組以上入力してください' });
      const bentoCount = ev.bentoCheck ? Math.max(0, Math.min(999, parseInt(b.bentoCount, 10) || 0)) : 0;
      const fee = calcFee(ev, pairs.length, bentoCount);
      const reg = { id: uid(), teamName, contact: String(b.contact || '').trim(), pairs, bentoCount, totalFee: fee.total, createdAt: Date.now() };
      ev.registrations.push(reg);
      if (ev.phase === 'training') {
        try {
          for (const pr of pairs) placePairInTraining(ev, pr);
          ensureAssignments(ev);
        } catch (e) {
          ev.registrations = ev.registrations.filter(r => r.id !== reg.id);
          for (const pr of pairs) ev.levels = ev.levels.map(l => (Array.isArray(l) ? l.filter(x => x !== pr.pid) : l));
          throw e;
        }
      }
      saveDB();
      return sendJson(res, 200, { ok: true, registrationId: reg.id, totalFee: fee.total, feeBreakdown: fee });
    }
    if (p === '/api/fee' && req.method === 'POST') {
      const b = await readBody(req);
      const ev = getEvent(b.eventId);
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      return sendJson(res, 200, {
        feeType: ev.feeType, feeAmount: ev.feeAmount, bentoCheck: ev.bentoCheck, bentoPrice: ev.bentoPrice,
        fee: calcFee(ev, Math.max(0, parseInt(b.pairCount, 10) || 0), Math.max(0, parseInt(b.bentoCount, 10) || 0)),
      });
    }
    /* ----- auth ----- */
    if (p === '/api/auth/status') return sendJson(res, 200, { hasPassword: !!DB.adminHash, loggedIn: isAdmin(req) });
    if (p === '/api/auth/setup' && req.method === 'POST') {
      const b = await readBody(req);
      if (DB.adminHash) return sendJson(res, 400, { error: 'already set' });
      if (!b.password || String(b.password).length < 4) return sendJson(res, 400, { error: 'パスワードは4文字以上にしてください' });
      DB.adminHash = hashPw(String(b.password));
      const t = newToken(); DB.sessions.push(t); saveDB();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'tt_admin=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!checkPw(String(b.password || ''), DB.adminHash)) return sendJson(res, 401, { error: 'パスワードが違います' });
      const t = newToken(); DB.sessions.push(t); saveDB();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'tt_admin=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' });
      return res.end(JSON.stringify({ ok: true }));
    }

    /* ----- admin API ----- */
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'login required' });
      if (p === '/api/admin/state') {
        const ev = getEvent(url.searchParams.get('event'));
        if (!ev) return sendJson(res, 404, { error: 'no event' });
        ensureAssignments(ev);
        return sendJson(res, 200, { event: ev, state: publicState(ev) });
      }
      const b = await readBody(req);
      const ev = getEvent(b.eventId || url.searchParams.get('event'));
      if (p === '/api/admin/event/create') {
        const ne = blankEvent();
        if (b.name) ne.name = String(b.name);
        DB.events.push(ne); saveDB();
        return sendJson(res, 200, { ok: true, id: ne.id });
      }
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      if (p === '/api/admin/event/delete') {
        DB.events = DB.events.filter(e => e.id !== ev.id); saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/settings') {
        const s = b.settings || {};
        if (s.name != null) ev.name = String(s.name);
        if (s.date != null) ev.date = String(s.date);
        if (s.venue != null) ev.venue = String(s.venue);
        if (s.organizer != null) ev.organizer = String(s.organizer);
        if (s.notes != null) ev.notes = String(s.notes);
        if (s.levelCount != null) {
          ev.levelCount = Math.max(1, Math.min(12, parseInt(s.levelCount, 10) || 4));
          if (ev.phase === 'training' && Array.isArray(ev.levels) && ev.levels.length) {
            while (ev.levels.length < ev.levelCount) ev.levels.push([]);
            while (ev.levels.length > ev.levelCount && ev.levels[ev.levels.length - 1].length === 0) ev.levels.pop();
          }
        }
        if (s.courtCount != null) ev.courtCount = Math.max(1, Math.min(30, parseInt(s.courtCount, 10) || 4));
        if (s.waitSlots != null) ev.waitSlots = Math.max(1, Math.min(3, parseInt(s.waitSlots, 10) || 1));
        if (['single', 'double', 'triple'].includes(s.gameMode)) ev.gameMode = s.gameMode;
        if (['person', 'pair', 'team'].includes(s.feeType)) ev.feeType = s.feeType;
        if (s.feeAmount != null) ev.feeAmount = Math.max(0, parseInt(s.feeAmount, 10) || 0);
        if (s.bentoCheck != null) ev.bentoCheck = !!s.bentoCheck;
        if (s.bentoPrice != null) ev.bentoPrice = Math.max(0, parseInt(s.bentoPrice, 10) || 0);
        if (s.advanceCount != null) ev.advanceCount = Math.max(2, parseInt(s.advanceCount, 10) || 8);
        if (s.allowSameTeam != null) ev.allowSameTeam = !!s.allowSameTeam;
        if (s.allowRematch != null) ev.allowRematch = !!s.allowRematch;
        if (s.regOpen != null) ev.regOpen = !!s.regOpen;
        if (s.regDeadline != null) ev.regDeadline = String(s.regDeadline || '');
        if (s.viewPassClear) ev.viewPassHash = null;
        else if (s.viewPassword) {
          if (String(s.viewPassword).length < 4) return sendJson(res, 400, { error: '閲覧パスワードは4文字以上にしてください' });
          ev.viewPassHash = hashPw(String(s.viewPassword));
        }
        // 申込済みペアの金額を再計算
        for (const r of ev.registrations) r.totalFee = calcFee(ev, r.pairs.length, r.bentoCount).total;
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/registration/delete') {
        ev.registrations = ev.registrations.filter(r => r.id !== b.registrationId);
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/registration/bento') {
        const r = ev.registrations.find(r => r.id === b.registrationId);
        if (!r) return sendJson(res, 404, { error: 'not found' });
        r.bentoCount = Math.max(0, parseInt(b.bentoCount, 10) || 0);
        r.totalFee = calcFee(ev, r.pairs.length, r.bentoCount).total;
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/pair/add') {
        if (ev.phase === 'tournament') return sendJson(res, 400, { error: 'トーナメント中はペアを追加できません' });
        const teamName = String(b.teamName || '').trim();
        const p1 = String(b.p1 || '').trim(), p2 = String(b.p2 || '').trim();
        if (!teamName) return sendJson(res, 400, { error: 'チーム名を入力してください' });
        if (!p1 || !p2) return sendJson(res, 400, { error: '選手は2人とも入力してください' });
        const y1 = YEARS.includes(b.year1) ? b.year1 : '一般';
        const y2 = YEARS.includes(b.year2) ? b.year2 : '一般';
        const pair = {
          pid: uid(), p1, p2,
          category: CATEGORIES.includes(b.category) ? b.category : '混合',
          year1: y1, year2: y2, year: y1 === y2 ? y1 : y1 + '・' + y2,
          levelAttr: LEVEL_ATTRS.includes(b.levelAttr) ? b.levelAttr : '地区大会未出場',
          startLevel: (b.startLevel == null || b.startLevel === '') ? null : Math.max(0, parseInt(b.startLevel, 10) || 0),
        };
        let reg = ev.registrations.find(r => r.teamName === teamName);
        if (!reg) { reg = { id: uid(), teamName, contact: String(b.contact || '').trim(), pairs: [], bentoCount: 0, totalFee: 0, createdAt: Date.now() }; ev.registrations.push(reg); }
        reg.pairs.push(pair);
        reg.totalFee = calcFee(ev, reg.pairs.length, reg.bentoCount).total;
        if (ev.phase === 'training') {
          try { placePairInTraining(ev, pair); ensureAssignments(ev); }
          catch (e) {
            reg.pairs = reg.pairs.filter(x => x.pid !== pair.pid);
            reg.totalFee = calcFee(ev, reg.pairs.length, reg.bentoCount).total;
            throw e;
          }
        }
        saveDB();
        return sendJson(res, 200, { ok: true, pid: pair.pid });
      }
      if (p === '/api/admin/pair/update') {
        let owner = null, pair = null;
        for (const r of ev.registrations) { const f = r.pairs.find(x => x.pid === b.pid); if (f) { owner = r; pair = f; break; } }
        if (!pair) return sendJson(res, 404, { error: 'pair not found' });
        const p1 = String(b.p1 || '').trim(), p2 = String(b.p2 || '').trim();
        if (!p1 || !p2) return sendJson(res, 400, { error: '選手は2人とも入力してください' });
        pair.p1 = p1; pair.p2 = p2;
        if (CATEGORIES.includes(b.category)) pair.category = b.category;
        if (YEARS.includes(b.year1)) pair.year1 = b.year1;
        if (YEARS.includes(b.year2)) pair.year2 = b.year2;
        const ys = pairYears(pair); pair.year = ys[0] === ys[1] ? ys[0] : ys[0] + '・' + ys[1];
        if (LEVEL_ATTRS.includes(b.levelAttr)) pair.levelAttr = b.levelAttr;
        const newTeam = String(b.teamName || '').trim();
        if (newTeam && newTeam !== owner.teamName) {
          owner.pairs = owner.pairs.filter(x => x.pid !== pair.pid);
          let target = ev.registrations.find(r => r.teamName === newTeam);
          if (!target) { target = { id: uid(), teamName: newTeam, contact: '', pairs: [], bentoCount: 0, totalFee: 0, createdAt: Date.now() }; ev.registrations.push(target); }
          target.pairs.push(pair);
          target.totalFee = calcFee(ev, target.pairs.length, target.bentoCount).total;
          if (owner.pairs.length === 0) ev.registrations = ev.registrations.filter(r => r.id !== owner.id);
          else owner.totalFee = calcFee(ev, owner.pairs.length, owner.bentoCount).total;
        }
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/pair/delete') {
        if (ev.phase === 'tournament' && ev.tournament) {
          const inT = JSON.stringify(ev.tournament.rounds).includes(b.pid);
          if (inT) return sendJson(res, 400, { error: 'トーナメントに出場中のペアは削除できません' });
        }
        let removed = false;
        for (const r of ev.registrations) {
          const before = r.pairs.length;
          r.pairs = r.pairs.filter(x => x.pid !== b.pid);
          if (r.pairs.length !== before) { removed = true; r.totalFee = calcFee(ev, r.pairs.length, r.bentoCount).total; }
        }
        if (!removed) return sendJson(res, 404, { error: 'pair not found' });
        ev.registrations = ev.registrations.filter(r => r.pairs.length > 0);
        if (ev.phase === 'training' || ev.phase === 'tournament') {
          ev.levels = ev.levels.map(l => l.filter(x => x !== b.pid));
          delete ev.stats[b.pid];
          ev.matches = ev.matches.filter(m => m.status === 'done' || (m.a !== b.pid && m.b !== b.pid));
          if (ev.phase === 'training') ensureAssignments(ev);
        }
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/pair/startlevel') {
        for (const r of ev.registrations) for (const pr of r.pairs) {
          if (pr.pid === b.pid) { pr.startLevel = (b.level == null ? null : Math.max(0, parseInt(b.level, 10) || 0)); saveDB(); return sendJson(res, 200, { ok: true }); }
        }
        return sendJson(res, 404, { error: 'pair not found' });
      }
      if (p === '/api/admin/start') {
        if (ev.phase !== 'entry') return sendJson(res, 400, { error: 'すでに開始しています' });
        const pairs = allPairs(ev);
        if (pairs.length < 2) return sendJson(res, 400, { error: 'ペアが2組以上必要です' });
        ev.levels = Array.from({ length: ev.levelCount }, () => []);
        const attrScore = a => a === '県大会出場' ? 0 : a === '地区大会出場' ? 1 : a === '地区大会未出場' ? 2 : 3;
        for (const pr of pairs) {
          let lv = pr.startLevel;
          if (lv == null || lv < 0 || lv >= ev.levelCount) {
            // 属性から自動配置: 4段階を levelCount に按分
            lv = Math.min(ev.levelCount - 1, Math.floor(attrScore(pr.levelAttr) * ev.levelCount / 4));
          }
          ev.levels[lv].push(pr.pid);
        }
        ev.stats = {}; ev.matches = []; ev.matchSeq = 0; ev.tournament = null;
        ev.phase = 'training';
        ensureAssignments(ev);
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/reset-training') {
        ev.phase = 'entry'; ev.levels = []; ev.stats = {}; ev.matches = []; ev.matchSeq = 0; ev.tournament = null;
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/result') {
        const m = ev.matches.find(m => m.id === b.matchId);
        if (!m || m.status === 'done') return sendJson(res, 404, { error: 'match not found' });
        const ga = parseInt(b.ga, 10), gb = parseInt(b.gb, 10);
        if (isNaN(ga) || isNaN(gb) || ga < 0 || gb < 0) return sendJson(res, 400, { error: 'ゲームカウントを入力してください' });
        if (ga === gb) return sendJson(res, 400, { error: '同点では確定できません' });
        applyResult(ev, m, ga, gb);
        ensureAssignments(ev);
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/result/fix') {
        const m = ev.matches.find(m => m.id === b.matchId);
        if (!m || m.status !== 'done') return sendJson(res, 404, { error: 'match not found' });
        const ga = parseInt(b.ga, 10), gb = parseInt(b.gb, 10);
        if (isNaN(ga) || isNaN(gb) || ga < 0 || gb < 0) return sendJson(res, 400, { error: 'ゲームカウントを入力してください' });
        if (ga === gb) return sendJson(res, 400, { error: '同点では確定できません' });
        const r = fixResult(ev, m, ga, gb);
        ensureAssignments(ev);
        saveDB();
        return sendJson(res, 200, { ok: true, levelsAdjusted: r.levelsAdjusted });
      }
      if (p === '/api/admin/tournament/start') {
        if (ev.phase !== 'training') return sendJson(res, 400, { error: 'トレーニング中のみ移行できます' });
        if (b.advanceCount) ev.advanceCount = Math.max(2, parseInt(b.advanceCount, 10) || 8);
        buildTournament(ev);
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/tournament/result') {
        if (!ev.tournament) return sendJson(res, 400, { error: 'no tournament' });
        const tga = parseInt(b.ga, 10), tgb = parseInt(b.gb, 10);
        if (isNaN(tga) || isNaN(tgb) || tga < 0 || tgb < 0) return sendJson(res, 400, { error: 'ゲームカウントを入力してください' });
        if (tga === tgb) return sendJson(res, 400, { error: '同点では確定できません' });
        const ok = setTournamentWinner(ev, parseInt(b.round, 10) || 0, parseInt(b.index, 10) || 0, tga, tgb);
        if (!ok) return sendJson(res, 400, { error: 'invalid' });
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/admin/back-to-training') {
        ev.tournament = null; ev.phase = 'training';
        ensureAssignments(ev);
        saveDB();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'unknown admin api' });
    }
    /* ----- pages ----- */
    if (p === '/' ) return sendHtml(res, 200, viewerPage());
    if (p === '/register') return sendHtml(res, 200, registerPage());
    if (p === '/results') return sendHtml(res, 200, resultsPage());
    if (p === '/admin') return sendHtml(res, 200, adminPage());
    if (p === '/print/roster' || p === '/print/receipt' || p === '/print/outline') {
      if (!isAdmin(req)) return sendHtml(res, 401, loginWallPage());
      const ev = getEvent(url.searchParams.get('event'));
      if (!ev) return sendHtml(res, 404, '大会がありません');
      if (p === '/print/roster') return sendHtml(res, 200, rosterPrintPage(ev));
      if (p === '/print/outline') return sendHtml(res, 200, outlinePrintPage(ev));
      const reg = ev.registrations.find(r => r.id === url.searchParams.get('reg'));
      if (!reg) return sendHtml(res, 404, '申込がありません');
      return sendHtml(res, 200, receiptPrintPage(ev, reg));
    }
    return sendHtml(res, 404, 'not found');
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

/* ---------------- pages ---------------- */
const BASE_CSS = `
:root{color-scheme:light only;--bg:#f7f5f0;--card:#ffffff;--ink:#1c2422;--mut:#5c6a66;--line:#ddd8cc;--acc:#0e7a5f;--acc2:#e8f4ef;--warn:#b3541e;--wait:#fdf3e0;--play:#e8f4ef}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;font-size:15px}
header.top{background:var(--acc);color:#fff;padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
header.top h1{font-size:17px;margin:0}
.brand{display:flex;align-items:center;gap:10px}
.brand img.logo{width:44px;height:44px;border-radius:50%;background:#fff;object-fit:cover;flex:none}
.brandsub{font-size:11px;opacity:.92;letter-spacing:.02em}
footer.foot{text-align:center;color:var(--mut);font-size:12px;padding:14px 10px 22px}
footer.foot img{width:22px;height:22px;border-radius:50%;vertical-align:-6px;margin-right:5px}
header.top nav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
header.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.18);padding:5px 10px;border-radius:999px;font-size:13px}
main{max-width:980px;margin:0 auto;padding:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 12px}
.card h2{font-size:15px;margin:0 0 8px}
.grid{display:grid;gap:10px}
@media(min-width:700px){.grid.c2{grid-template-columns:1fr 1fr}.grid.c3{grid-template-columns:1fr 1fr 1fr}}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}
th{background:var(--acc2)}
.badge{display:inline-block;background:var(--acc);color:#fff;border-radius:6px;padding:0 7px;font-size:12px;font-weight:700}
.badge.lv{background:#34558b}
.badge.wait{background:var(--warn)}
.mut{color:var(--mut);font-size:13px}
.match{border:1px solid var(--line);border-radius:10px;padding:8px;margin:6px 0;background:#fff}
.match.playing{background:var(--play)}
.match.waiting{background:var(--wait)}
.vs{font-weight:700}
button,.btn{display:inline-block;background:var(--acc);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;text-decoration:none}
button.sub,.btn.sub{background:#e6e2d6;color:var(--ink)}
button.danger{background:#b03a2e}
button:disabled{opacity:.45}
input,select,textarea{font-size:15px;padding:7px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);max-width:100%}
label.f{display:block;margin:8px 0}
label.f span{display:block;font-size:13px;color:var(--mut);margin-bottom:3px}
.callout{background:#fff3cd;border:2px solid var(--warn);border-radius:12px;padding:10px 12px;margin:0 0 12px;font-weight:700}
.hidden{display:none}
@media print{header.top,nav,.noprint{display:none!important}body{background:#fff}main{max-width:none}}
`;
function pageShell(title, bodyHtml, script) {
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="only light"><title>' + esc(title) + '</title><style>' + BASE_CSS + '</style></head><body>' +
    bodyHtml + '<footer class="foot"><img src="/logo.png" alt="">このアプリは岩瀬ジュニア ソフトテニスクラブ（岩瀬STC）が開発・運営しています</footer>' + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
}
function topBar(title) {
  return '<header class="top"><div class="brand"><img class="logo" src="/logo.png" alt="岩瀬ジュニア ソフトテニスクラブ"><div><h1>' + esc(title) + '</h1><div class="brandsub">岩瀬ジュニア・岩瀬STC 開発アプリ</div></div></div><nav>' +
    '<a href="/">対戦表</a><a href="/results">実績</a><a href="/register">参加申込</a><a href="/admin">管理者</a></nav></header>';
}
const CLIENT_COMMON = `
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function q(name){return new URLSearchParams(location.search).get(name)}
var EVENT_ID=q('event')||'';
function api(path){return fetch(path).then(function(r){return r.json()})}
function pairHtml(p,extra){
  if(!p)return '<span class="mut">未定</span>';
  return '<div><span class="vs">'+esc(p.label)+'</span> <span class="mut">('+esc(p.teamName)+')</span>'+(extra||'')+
  '<div class="mut">'+esc(p.category)+' / '+esc(p.year)+' / '+esc(p.levelAttr)+' ・ '+p.w+'勝'+p.l+'敗</div></div>';
}
function showViewLock(){
  var el=document.getElementById('viewlock');if(el)el.classList.remove('hidden');
  var main=document.getElementById('viewmain');if(main)main.classList.add('hidden');
}
function bindViewLock(){
  var b=document.getElementById('viewbtn');if(!b)return;
  b.onclick=function(){
    var pw=document.getElementById('viewpw').value;
    fetch('/api/view/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:EVENT_ID,password:pw})})
    .then(function(r){return r.json()}).then(function(j){
      if(j.ok){document.getElementById('viewlock').classList.add('hidden');var m=document.getElementById('viewmain');if(m)m.classList.remove('hidden');if(window.load)window.load();}
      else document.getElementById('viewmsg').textContent=j.error||'パスワードが違います';
    });
  };
}
var VIEWLOCK_HTML='<div id="viewlock" class="card hidden"><h2>🔒 閲覧パスワード</h2><p class="mut">この大会は個人情報保護のため、閲覧にパスワードが必要です。主催者から案内されたパスワードを入力してください。</p><label class="f"><span>パスワード</span><input id="viewpw" type="password" style="width:100%"></label><button id="viewbtn">閲覧する</button><div id="viewmsg" class="mut" style="margin-top:6px"></div></div>';
`;

function viewerPage() {
  const body = topBar('トレーニングマッチ対戦表') +
    '<main>' +
    '<div id="viewlockbox"></div>' +
    '<div id="viewmain">' +
    '<div id="evhead"></div>' +
    '<div id="callout"></div>' +
    '<div class="card"><h2>コート状況</h2><div id="courts" class="grid c2"></div></div>' +
    '<div class="card"><h2>レベル別ペア</h2><div id="levels"></div></div>' +
    '<div id="tournament"></div>' +
    '<div class="card"><h2>最近の結果</h2><div id="recent"></div></div>' +
    '<p class="mut">このページは15秒ごとに自動更新されます。</p>' +
    '</div></main>';
  const script = CLIENT_COMMON + `
var lastCallKey='';
function render(S){
  var ev=S.event;
  document.title=ev.name+'｜対戦表';
  document.querySelector('header.top h1').textContent=ev.name+(ev.phase==='entry'?'（受付中）':ev.phase==='tournament'?'（トーナメント）':'');
  var head='<div class="card"><b>'+esc(ev.date||'')+'</b> '+esc(ev.venue||'')+
    ' <span class="badge">'+(ev.phase==='entry'?'参加受付中':ev.phase==='tournament'?'トーナメント実施中':'トレーニングマッチ実施中')+'</span>'+
    ' <span class="mut">レベル数 '+ev.levelCount+' / コート '+ev.courtCount+'面 / '+(ev.gameMode==='single'?'シングルゲーム':ev.gameMode==='double'?'ダブルゲーム':'トリプルゲーム')+'</span></div>';
  document.getElementById('evhead').innerHTML=head;
  // 呼び出しバナー
  var calls=[];
  S.courts.forEach(function(c){c.waiting.forEach(function(m){calls.push({court:c.court,m:m})})});
  var key=calls.map(function(x){return x.m.id}).join(',');
  var co=document.getElementById('callout');
  if(calls.length){
    co.innerHTML=calls.map(function(x){
      return '<div class="callout">📣 '+x.court+'番コート待機：'+esc(x.m.a.label)+'（'+esc(x.m.a.teamName)+'） vs '+esc(x.m.b.label)+'（'+esc(x.m.b.teamName)+'）</div>';
    }).join('');
  } else co.innerHTML='';
  lastCallKey=key;
  // コート
  document.getElementById('courts').innerHTML=S.courts.map(function(c){
    var h='<div class="card" style="margin:0"><h2>'+c.court+'番コート</h2>';
    if(!c.playing.length&&!c.waiting.length)h+='<p class="mut">空き</p>';
    c.playing.forEach(function(m){h+='<div class="match playing"><span class="badge">試合中</span> <span class="badge lv">'+esc(S.levelNames[m.level])+'リーグ</span>'+pairHtml(m.a)+'<div class="mut" style="text-align:center">vs</div>'+pairHtml(m.b)+'</div>'});
    c.waiting.forEach(function(m){h+='<div class="match waiting"><span class="badge wait">待機</span> <span class="badge lv">'+esc(S.levelNames[m.level])+'リーグ</span>'+pairHtml(m.a)+'<div class="mut" style="text-align:center">vs</div>'+pairHtml(m.b)+'</div>'});
    return h+'</div>';
  }).join('');
  // レベル別
  document.getElementById('levels').innerHTML=S.levels.map(function(L){
    var h='<h3 style="margin:10px 0 4px">'+esc(L.name)+'リーグ</h3>';
    if(!L.pairs.length)return h+'<p class="mut">ペアなし</p>';
    h+='<table><tr><th>ペア</th><th>チーム</th><th>勝敗</th></tr>';
    L.pairs.forEach(function(p){h+='<tr><td>'+esc(p.label)+'</td><td>'+esc(p.teamName)+'</td><td>'+p.w+'勝'+p.l+'敗</td></tr>'});
    return h+'</table>';
  }).join('')||'<p class="mut">まだ開始していません</p>';
  // トーナメント
  var t=document.getElementById('tournament');
  if(S.tournament){
    var h='<div class="card"><h2>トーナメント表</h2><div style="display:flex;gap:14px;overflow-x:auto">';
    var names=['1回戦','2回戦','準々決勝','準決勝','決勝'];
    S.tournament.rounds.forEach(function(rd,ri){
      h+='<div style="min-width:210px"><h3>'+esc(roundName(S.tournament.rounds.length,ri))+'</h3>';
      rd.forEach(function(m,i){
        h+='<div class="match"><span class="badge">'+(i+1)+'</span>'+pairHtml(m.a)+'<div class="mut" style="text-align:center">vs</div>'+pairHtml(m.b);
        if(m.winner){var w=m.winner===(m.a&&m.a.pid)?m.a:m.b;h+='<div>🏆 <b>'+esc(w?labelOf(S,m.winner):'')+'</b>'+(m.ga!=null?'（'+m.ga+'-'+m.gb+'）':'')+'</div>'}
        h+='</div>';
      });
      h+='</div>';
    });
    t.innerHTML=h+'</div></div>';
  } else t.innerHTML='';
  // 最近の結果
  document.getElementById('recent').innerHTML=S.recent.length?S.recent.map(function(m){
    var w=m.winnerPid===(m.a&&m.a.pid)?m.a:m.b;
    return '<div class="match"><span class="badge lv">'+esc(S.levelNames[m.level])+'リーグ</span> '+esc(m.a?m.a.label:'')+' vs '+esc(m.b?m.b.label:'')+(m.ga!=null?' <b>'+m.ga+'-'+m.gb+'</b>':'')+' → 勝者：<b>'+esc(w?w.label:'')+'</b> <span class="mut">('+esc(w?w.teamName:'')+')</span></div>';
  }).join(''):'<p class="mut">まだ結果がありません</p>';
}
function labelOf(S,pid){
  var found='';
  S.standings.forEach(function(r){if(r.pid===pid)found=r.label});
  return found;
}
function roundName(total,ri){
  var fromEnd=total-1-ri;
  if(fromEnd===0)return '決勝';
  if(fromEnd===1)return '準決勝';
  if(fromEnd===2)return '準々決勝';
  return (ri+1)+'回戦';
}
function load(){api('/api/state'+(EVENT_ID?'?event='+EVENT_ID:'')).then(function(j){if(j.needViewPass){showViewLock();return}render(j)}).catch(function(){})}
window.load=load;
document.getElementById('viewlockbox').innerHTML=VIEWLOCK_HTML;bindViewLock();
load();setInterval(load,15000);
`;
  return pageShell('トレーニングマッチ対戦表', body, script);
}

function registerPage() {
  const catOpts = CATEGORIES.map(c => '<option>' + c + '</option>').join('');
  const yearOpts = YEARS.map(c => '<option>' + c + '</option>').join('');
  const lvOpts = LEVEL_ATTRS.map(c => '<option>' + c + '</option>').join('');
  const body = topBar('参加申込フォーム') +
    '<main><div class="card"><h2>大会を選んでください</h2><select id="evsel" style="width:100%"></select><div id="evinfo" class="mut" style="margin-top:6px"></div></div>' +
    '<div class="card"><h2>申込内容</h2>' +
    '<label class="f"><span>チーム名（必須）</span><input id="team" style="width:100%"></label>' +
    '<label class="f"><span>連絡先（任意：担当者名・電話など）</span><input id="contact" style="width:100%"></label>' +
    '<h3 style="margin:12px 0 4px">参加ペア</h3><div id="pairs"></div>' +
    '<button class="sub" id="addpair" type="button">＋ ペアを追加</button>' +
    '<div id="bentobox"></div>' +
    '<div class="card" style="background:var(--acc2);margin-top:12px"><b>合計金額：<span id="total">-</span></b><div id="breakdown" class="mut"></div></div>' +
    '<button id="submit" style="width:100%;padding:12px;font-size:16px">申し込む</button>' +
    '<div id="done"></div>' +
    '</div></main>';
  const script = CLIENT_COMMON + `
var CATS=${JSON.stringify(CATEGORIES)}, YEARS=${JSON.stringify(YEARS)}, LVS=${JSON.stringify(LEVEL_ATTRS)};
var EV=null;
function opts(list){return list.map(function(x){return '<option>'+esc(x)+'</option>'}).join('')}
function pairRow(){
  var d=document.createElement('div');
  d.className='match pairrow';
  d.innerHTML='<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'+
  '<span class="mut" style="min-width:44px">選手1</span><input class="p1" placeholder="名前" style="flex:1;min-width:110px">'+
  '<select class="yr1" aria-label="選手1の年次">'+opts(YEARS)+'</select></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">'+
  '<span class="mut" style="min-width:44px">選手2</span><input class="p2" placeholder="名前" style="flex:1;min-width:110px">'+
  '<select class="yr2" aria-label="選手2の年次">'+opts(YEARS)+'</select></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">'+
  '<span class="mut">部門</span><select class="cat">'+opts(CATS)+'</select>'+
  '<span class="mut">レベル</span><select class="lv">'+opts(LVS)+'</select>'+
  '<button type="button" class="sub del">削除</button></div>'+
  '<div class="mut" style="margin-top:4px">年次は選手ごとに選べます（学年違いのペアもそのまま入力してください）</div>';
  d.querySelector('.del').onclick=function(){d.remove();recalc()};
  d.querySelectorAll('input,select').forEach(function(el){el.addEventListener('input',recalc);el.addEventListener('change',recalc)});
  return d;
}
function pairCount(){return document.querySelectorAll('.pairrow').length}
function recalc(){
  if(!EV)return;
  var bc=document.getElementById('bentoNum');
  fetch('/api/fee',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:EV.id,pairCount:pairCount(),bentoCount:bc?parseInt(bc.value,10)||0:0})})
  .then(function(r){return r.json()}).then(function(j){
    if(!j.fee)return;
    document.getElementById('total').textContent=j.fee.total.toLocaleString()+'円';
    var unit=j.feeType==='person'?'1人':j.feeType==='pair'?'1ペア':'1チーム';
    var s='参加費 '+j.feeAmount.toLocaleString()+'円（'+unit+'）→ '+j.fee.base.toLocaleString()+'円';
    if(j.bentoCheck)s+=' ／ 弁当 '+j.bentoPrice.toLocaleString()+'円 × '+(bc?bc.value:0)+'個 → '+j.fee.bento.toLocaleString()+'円';
    document.getElementById('breakdown').textContent=s;
  });
}
function setEvent(ev){
  EV=ev;
  var dl=ev.regDeadline||ev.date||'';
  document.getElementById('evinfo').textContent='開催日 '+(ev.date||'未定')+(dl?' ／ 受付締切 '+dl:'')+' ／ '+(ev.regOpen?'受付中':'受付終了');
  document.getElementById('submit').disabled=!ev.regOpen;
  document.getElementById('submit').textContent=ev.regOpen?'申し込む':'受付は終了しています';
  fetch('/api/fee',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:ev.id,pairCount:0,bentoCount:0})})
  .then(function(r){return r.json()}).then(function(j){
    var bb=document.getElementById('bentobox');
    if(j.bentoCheck){
      bb.innerHTML='<label class="f"><span>弁当の注文個数（1個 '+j.bentoPrice.toLocaleString()+'円）</span><input id="bentoNum" type="number" min="0" value="0" style="width:120px"></label>';
      document.getElementById('bentoNum').addEventListener('input',recalc);
    } else bb.innerHTML='';
    recalc();
  });
}
api('/api/events').then(function(j){
  var sel=document.getElementById('evsel');
  var list=j.events.filter(function(e){return e.regOpen});
  if(!list.length){sel.innerHTML='<option>現在受付中の大会はありません</option>';document.getElementById('evinfo').textContent='現在受付中の大会はありません';document.getElementById('submit').disabled=true;return}
  sel.innerHTML=list.map(function(e){return '<option value="'+e.id+'">'+esc(e.name)+'（'+esc(e.date||'')+'）</option>'}).join('');
  if(EVENT_ID)sel.value=EVENT_ID;
  setEvent(list.find(function(e){return e.id===sel.value})||list[0]);
  sel.onchange=function(){setEvent(list.find(function(e){return e.id===sel.value}))};
});
document.getElementById('pairs').appendChild(pairRow());
document.getElementById('addpair').onclick=function(){document.getElementById('pairs').appendChild(pairRow());recalc()};
document.getElementById('submit').onclick=function(){
  var pairs=[];
  var bad=false;
  document.querySelectorAll('.pairrow').forEach(function(d){
    var p1=d.querySelector('.p1').value.trim(),p2=d.querySelector('.p2').value.trim();
    if(!p1&&!p2)return;
    if(!p1||!p2){bad=true;return}
    pairs.push({p1:p1,p2:p2,category:d.querySelector('.cat').value,year1:d.querySelector('.yr1').value,year2:d.querySelector('.yr2').value,levelAttr:d.querySelector('.lv').value});
  });
  if(bad){alert('ペアは2人とも名前を入力してください');return}
  if(!pairs.length){alert('ペアを1組以上入力してください');return}
  var bc=document.getElementById('bentoNum');
  fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    eventId:EV.id,teamName:document.getElementById('team').value,contact:document.getElementById('contact').value,
    pairs:pairs,bentoCount:bc?parseInt(bc.value,10)||0:0})})
  .then(function(r){return r.json()}).then(function(j){
    if(!j.ok){alert(j.error||'申込に失敗しました');return}
    document.getElementById('done').innerHTML='<div class="callout">✅ 申込を受け付けました。合計金額は <b>'+j.totalFee.toLocaleString()+'円</b> です。当日受付でお支払いください。</div>';
    window.scrollTo(0,document.body.scrollHeight);
  });
};
`;
  return pageShell('参加申込フォーム', body, script);
}

function resultsPage() {
  const body = topBar('実績確認') +
    '<main><div id="viewlockbox"></div><div id="viewmain"><div class="card"><h2>ペア別実績</h2>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input id="q" placeholder="チーム名・選手名で検索" style="flex:1;min-width:160px">' +
    '<select id="teamsel"><option value="">すべてのチーム</option></select></div>' +
    '<div id="standings"></div></div>' +
    '<div class="card"><h2>チーム別集計</h2><div id="byteam"></div></div>' +
    '<p class="mut">15秒ごとに自動更新されます。大会によっては閲覧パスワードが必要です。</p></div></main>';
  const script = CLIENT_COMMON + `
var S=null;
function render(){
  if(!S)return;
  var q=(document.getElementById('q').value||'').trim();
  var tf=document.getElementById('teamsel').value;
  var rows=S.standings.filter(function(r){
    if(tf&&r.teamName!==tf)return false;
    if(q&&(r.label.indexOf(q)<0&&r.teamName.indexOf(q)<0))return false;
    return true;
  });
  var h='<table><tr><th>順位</th><th>ペア</th><th>チーム</th><th>現レベル</th><th>勝</th><th>敗</th><th>勝率</th></tr>';
  rows.forEach(function(r){
    h+='<tr><td>'+r.rank+'</td><td>'+esc(r.label)+'</td><td>'+esc(r.teamName)+'</td><td>'+(r.level>=0?esc(S.levelNames[r.level])+'リーグ':'-')+'</td><td>'+r.w+'</td><td>'+r.l+'</td><td>'+(r.games?Math.round(r.rate*1000)/10+'%':'-')+'</td></tr>';
  });
  document.getElementById('standings').innerHTML=rows.length?h+'</table>':'<p class="mut">該当するペアがありません</p>';
  var teams={};
  S.standings.forEach(function(r){
    if(!teams[r.teamName])teams[r.teamName]={pairs:0,w:0,l:0};
    teams[r.teamName].pairs++;teams[r.teamName].w+=r.w;teams[r.teamName].l+=r.l;
  });
  var th='<table><tr><th>チーム</th><th>ペア数</th><th>勝</th><th>敗</th><th>勝率</th></tr>';
  Object.keys(teams).sort().forEach(function(t){
    var x=teams[t],g=x.w+x.l;
    th+='<tr><td>'+esc(t)+'</td><td>'+x.pairs+'</td><td>'+x.w+'</td><td>'+x.l+'</td><td>'+(g?Math.round(x.w/g*1000)/10+'%':'-')+'</td></tr>';
  });
  document.getElementById('byteam').innerHTML=th+'</table>';
}
function load(){
  api('/api/state'+(EVENT_ID?'?event='+EVENT_ID:'')).then(function(j){
    if(j.needViewPass){showViewLock();return}
    S=j;
    var sel=document.getElementById('teamsel');
    var cur=sel.value;
    var teams={};S.standings.forEach(function(r){teams[r.teamName]=1});
    sel.innerHTML='<option value="">すべてのチーム</option>'+Object.keys(teams).sort().map(function(t){return '<option>'+esc(t)+'</option>'}).join('');
    sel.value=cur;
    render();
  }).catch(function(){});
}
document.getElementById('q').addEventListener('input',render);
document.getElementById('teamsel').addEventListener('change',render);
window.load=load;
document.getElementById('viewlockbox').innerHTML=VIEWLOCK_HTML;bindViewLock();
load();setInterval(load,15000);
`;
  return pageShell('実績確認', body, script);
}

function loginWallPage() {
  return pageShell('管理者ログイン', '<main><div class="card"><h2>管理者ページ</h2><p>このページは管理者ログインが必要です。<a href="/admin">管理者ページへ</a></p></div></main>', '');
}

function adminPage() {
  const body = topBar('管理者ページ') +
    '<main>' +
    '<div id="loginbox" class="card hidden"><h2 id="loginTitle">管理者ログイン</h2>' +
    '<label class="f"><span>パスワード</span><input id="pw" type="password" style="width:100%"></label>' +
    '<button id="loginbtn">ログイン</button><div id="loginmsg" class="mut"></div></div>' +
    '<div id="app" class="hidden">' +
    '<div class="card"><h2>大会</h2><div style="display:flex;gap:6px;flex-wrap:wrap"><select id="evsel" style="flex:1;min-width:200px"></select>' +
    '<button class="sub" id="newev">＋ 新しい大会</button><button class="danger" id="delev">この大会を削除</button></div></div>' +
    '<div id="callout"></div>' +
    '<div class="card"><h2>コート状況と結果入力</h2><div style="margin-bottom:8px"><button id="soundbtn" class="sub">🔊 音声アナウンス：ON</button> <button id="soundtest" class="sub">▶ テスト再生</button> <span class="mut">待機ペアが出たらチャイム＋音声とバナーでお知らせします</span><div id="soundstat" class="mut" style="margin-top:4px"></div></div><div id="courts" class="grid c2"></div></div>' +
    '<div class="card"><h2>✏️ 終わった試合の結果修正</h2><p class="mut">直近12試合のスコアを直せます。勝敗が変わると勝敗数・勝率も直ります。その試合より後の試合が無いペア同士なら、レベルの移動も合わせて戻します。</p><div id="fixlist"></div></div>' +
    '<div class="card"><h2>大会設定</h2><div id="settings"></div><button id="savesettings">設定を保存</button> <span id="setmsg" class="mut"></span></div>' +
    '<div class="card"><h2>申込一覧・当日資料</h2><div id="regsummary"></div><div id="regs"></div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><a class="btn sub" id="printroster" target="_blank">🖨 名簿を印刷</a><a class="btn sub" id="printoutline" target="_blank">🖨 要項を印刷</a></div></div>' +
    '<div class="card"><h2>進行コントロール</h2><div id="phasebox"></div></div>' +
    '<div class="card"><h2>トーナメント</h2><div id="tournament"></div></div>' +
    '</div></main>';
  const script = CLIENT_COMMON + `
var EV=null, ST=null, seenWait={}, firstLoad=true;
var soundOn=(function(){try{var v=localStorage.getItem('tt_sound');return v===null?true:v==='1'}catch(e){return true}})();
function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json()})}
var utters=[];
var armed=false, audioCtx=null, speakQueue=[], speakPlaying=false, pendingCalls=[], curAudio=null;
function soundStat(msg){var el=document.getElementById('soundstat');if(el)el.textContent=msg}
function speakNative(text,done){
  try{
    if(!window.speechSynthesis){done&&done();return}
    var u=new SpeechSynthesisUtterance(text);
    u.lang='ja-JP';u.rate=0.95;
    var vs=speechSynthesis.getVoices().filter(function(v){return v.lang&&v.lang.indexOf('ja')===0});
    if(vs.length)u.voice=vs[0];
    u.onend=function(){done&&done()};
    u.onerror=function(){done&&done()};
    utters.push(u);if(utters.length>10)utters.shift();
    speechSynthesis.resume();
    speechSynthesis.speak(u);
    setTimeout(function(){try{speechSynthesis.cancel()}catch(e){}done&&done()},Math.max(4000,text.length*350));
  }catch(e){done&&done()}
}
function ensureCtx(){
  try{
    if(!audioCtx){var AC=window.AudioContext||window.webkitAudioContext;if(AC)audioCtx=new AC()}
    if(audioCtx&&audioCtx.state==='suspended')audioCtx.resume();
  }catch(e){}
  return audioCtx;
}
function playTTSWebAudio(text){
  return new Promise(function(resolve){
    var ctx=ensureCtx();
    if(!ctx){resolve(false);return}
    var settled=false,started=false;
    var ok=function(v){if(settled)return;settled=true;resolve(v)};
    // 読み込みが10秒以内に始まらなければ失敗扱い。再生が始まった後は絶対に失敗扱いにしない
    // （途中で別方式に切り替えると、同じ文が二重に流れて重なるため）
    setTimeout(function(){if(!started)ok(false)},10000);
    fetch('/api/tts?q='+encodeURIComponent(text)).then(function(r){
      if(!r.ok)throw new Error('tts '+r.status);
      return r.arrayBuffer();
    }).then(function(ab){
      return ctx.decodeAudioData(ab);
    }).then(function(buf){
      var src=ctx.createBufferSource();
      src.buffer=buf;src.connect(ctx.destination);
      src.onended=function(){ok(true)};
      started=true;
      src.start();
      soundStat('音声：読み上げ中（チャイムと同じ仕組みで再生）');
      setTimeout(function(){ok(true)},buf.duration*1000+4000);
    }).catch(function(){if(!started)ok(false)});
  });
}
function playTTSAudioEl(text){
  return new Promise(function(resolve){
    var settled=false;var ok=function(v){if(settled)return;settled=true;resolve(v)};
    try{
      var a=new Audio('/api/tts?q='+encodeURIComponent(text));
      curAudio=a;
      a.onended=function(){ok(true)};
      a.onerror=function(){ok(false)};
      var pr=a.play();
      if(pr&&pr.catch)pr.catch(function(){ok(false)});
      setTimeout(function(){try{a.pause()}catch(e){}ok(true)},45000);
    }catch(e){ok(false)}
  });
}
function playNextSpeak(){
  if(!speakQueue.length){speakPlaying=false;return}
  speakPlaying=true;
  var text=speakQueue.shift();
  playTTSWebAudio(text).then(function(done1){
    if(done1){setTimeout(playNextSpeak,300);return}
    soundStat('音声：別の方式で再生します');
    return playTTSAudioEl(text).then(function(done2){
      if(done2){setTimeout(playNextSpeak,300);return}
      soundStat('音声：端末の音声で再生します');
      speakNative(text,function(){setTimeout(playNextSpeak,300)});
    });
  });
}
function speak(text){
  if(!soundOn)return;
  speakQueue.push(text);
  if(!speakPlaying)playNextSpeak();
}
function chime(){
  if(!soundOn)return;
  try{
    ensureCtx();
    if(!audioCtx)return;
    var t0=audioCtx.currentTime+0.03;
    // 目立つアラート音: ピンポーン（高→低）を3回、倍音つきで大きく鳴らす
    var seq=[[1318,0],[1046,0.24],[1318,0.58],[1046,0.82],[1318,1.16],[1046,1.40]];
    seq.forEach(function(pair){
      var f=pair[0],off=pair[1];
      [[1,'sine',0.34],[2,'triangle',0.10]].forEach(function(h){
        var o=audioCtx.createOscillator(),g=audioCtx.createGain();
        o.type=h[1];o.frequency.value=f*h[0];
        g.gain.setValueAtTime(0.0001,t0+off);
        g.gain.exponentialRampToValueAtTime(h[2],t0+off+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001,t0+off+0.36);
        o.connect(g);g.connect(audioCtx.destination);
        o.start(t0+off);o.stop(t0+off+0.38);
      });
    });
  }catch(e){}
}
var CHIME_MS=1950, ANN_GAP_MS=1200;
function chimeAsync(){
  return new Promise(function(resolve){
    chime();
    setTimeout(resolve,CHIME_MS);
  });
}
function playOneSpeak(text){
  return playTTSWebAudio(text).then(function(d1){
    if(d1)return true;
    soundStat('音声：別の方式で再生します');
    return playTTSAudioEl(text).then(function(d2){
      if(d2)return true;
      soundStat('音声：端末の音声で再生します');
      return new Promise(function(res){speakNative(text,function(){res(true)})});
    });
  });
}
var annQueue=[], annPlaying=false;
function runAnnQueue(){
  if(annPlaying)return;
  var item=annQueue.shift();
  if(!item)return;
  annPlaying=true;
  var steps=Promise.resolve();
  if(item.chime)steps=steps.then(chimeAsync);
  steps.then(function(){return playOneSpeak(item.text)}).then(function(){
    setTimeout(function(){annPlaying=false;runAnnQueue()},ANN_GAP_MS);
  },function(){
    setTimeout(function(){annPlaying=false;runAnnQueue()},ANN_GAP_MS);
  });
}
function announceCalls(list){
  if(!list.length)return;
  list.forEach(function(x,i){
    annQueue.push({chime:i===0,text:x.m.a.teamName+'の'+x.m.a.label+'ペアと、'+x.m.b.teamName+'の'+x.m.b.label+'ペアは、'+x.court+'番コートで待機してください'});
  });
  runAnnQueue();
}
if(window.speechSynthesis){try{speechSynthesis.getVoices();speechSynthesis.onvoiceschanged=function(){speechSynthesis.getVoices()}}catch(e){}}
/* 音声ロック解除: 最初のタップで音声再生の許可を取り、その時点で待機中のペアがいればまとめて読み上げる */
document.addEventListener('pointerdown',function prime(){
  armed=true;
  try{
    ensureCtx();
    var silent=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
    var pr=silent.play();if(pr&&pr.catch)pr.catch(function(){});
    if(window.speechSynthesis)speechSynthesis.resume();
  }catch(e){}
  document.removeEventListener('pointerdown',prime);
  if(pendingCalls.length){var pc=pendingCalls;pendingCalls=[];announceCalls(pc)}
});
setInterval(function(){try{if(soundOn&&window.speechSynthesis)speechSynthesis.resume();if(audioCtx&&audioCtx.state==='suspended'&&armed)audioCtx.resume()}catch(e){}},10000);
document.addEventListener('visibilitychange',function(){try{if(!document.hidden&&window.speechSynthesis)speechSynthesis.resume()}catch(e){}});
function loadEvents(){
  return api('/api/events').then(function(j){
    var sel=document.getElementById('evsel');
    sel.innerHTML=j.events.map(function(e){return '<option value="'+e.id+'">'+esc(e.name)+'（'+esc(e.date||'')+'）</option>'}).join('')||'<option value="">大会なし</option>';
    if(EVENT_ID&&j.events.some(function(e){return e.id===EVENT_ID}))sel.value=EVENT_ID;
    sel.onchange=function(){EVENT_ID=sel.value;firstLoad=true;seenWait={};load()};
  });
}
function load(){
  if(!EVENT_ID){var sel=document.getElementById('evsel');EVENT_ID=sel.value}
  if(!EVENT_ID)return;
  api('/api/admin/state?event='+EVENT_ID).then(function(j){
    if(j.error)return;
    EV=j.event;ST=j.state;
    render();
  }).catch(function(){});
}
function render(){
  if(!EV||!ST)return;
  document.getElementById('printroster').href='/print/roster?event='+EV.id;
  document.getElementById('printoutline').href='/print/outline?event='+EV.id;
  renderCourts();renderSettings();renderRegs();renderPhase();renderTournament();renderFixList();
}
function announceCheck(){
  var calls=[];
  ST.courts.forEach(function(c){c.waiting.forEach(function(m){calls.push({court:c.court,m:m})})});
  var newOnes=calls.filter(function(x){return !seenWait[x.m.id]});
  calls.forEach(function(x){seenWait[x.m.id]=1});
  var co=document.getElementById('callout');
  if(calls.length){
    co.innerHTML=calls.map(function(x){
      return '<div class="callout">📣 '+x.court+'番コート待機：'+esc(x.m.a.label)+'（'+esc(x.m.a.teamName)+'） vs '+esc(x.m.b.label)+'（'+esc(x.m.b.teamName)+'）</div>';
    }).join('');
  } else co.innerHTML='';
  if(newOnes.length){
    if(armed){announceCalls(newOnes)}
    else{
      newOnes.forEach(function(x){if(!pendingCalls.some(function(y){return y.m.id===x.m.id}))pendingCalls.push(x)});
      soundStat('音声：画面を一度タップすると読み上げが始まります');
    }
  }
  firstLoad=false;
}
function matchAdminHtml(m,court,status){
  var h='<div class="match '+(status==='playing'?'playing':'waiting')+'"><span class="badge">'+(status==='playing'?'試合中':'待機')+'</span> <span class="badge lv">'+esc(ST.levelNames[m.level])+'リーグ</span>';
  h+=pairHtml(m.a)+'<div class="mut" style="text-align:center">vs</div>'+pairHtml(m.b);
  if(status==='playing'){
    h+='<div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap"><span class="mut">ゲーム数</span>'+
    '<input type="number" min="0" id="sc-'+m.id+'-a" style="width:64px" placeholder="'+esc(m.a?m.a.label:'')+'">'+
    '<span>―</span><input type="number" min="0" id="sc-'+m.id+'-b" style="width:64px" placeholder="'+esc(m.b?m.b.label:'')+'">'+
    '<button onclick="confirmScore(\\''+m.id+'\\')">確定</button></div>';
  }
  return h+'</div>';
}
function renderCourts(){
  announceCheck();
  document.getElementById('courts').innerHTML=ST.courts.map(function(c){
    var h='<div class="card" style="margin:0"><h2>'+c.court+'番コート</h2>';
    if(!c.playing.length&&!c.waiting.length)h+='<p class="mut">空き</p>';
    c.playing.forEach(function(m){h+=matchAdminHtml(m,c.court,'playing')});
    c.waiting.forEach(function(m){h+=matchAdminHtml(m,c.court,'waiting')});
    return h+'</div>';
  }).join('');
}
function renderFixList(){
  var ae=document.activeElement;
  if(ae&&ae.id&&ae.id.indexOf('fx-')===0)return;
  var el=document.getElementById('fixlist');
  if(!el)return;
  if(!ST.recent||!ST.recent.length){el.innerHTML='<p class="mut">終了した試合はまだありません</p>';return}
  el.innerHTML=ST.recent.map(function(m){
    var winA=m.winnerPid===(m.a&&m.a.pid);
    return '<div class="match"><span class="badge lv">'+esc(ST.levelNames[m.level])+'リーグ</span> <span class="mut">'+m.court+'番コート</span>'+
    '<div style="margin-top:4px">'+(winA?'🏆 ':'')+pairHtml(m.a)+'</div>'+
    '<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="number" min="0" id="fx-'+m.id+'-a" style="width:64px" value="'+(m.ga==null?'':m.ga)+'"><span>―</span><input type="number" min="0" id="fx-'+m.id+'-b" style="width:64px" value="'+(m.gb==null?'':m.gb)+'"><button class="sub" onclick="fixScore(\\''+m.id+'\\')">修正する</button></div>'+
    '<div>'+(winA?'':'🏆 ')+pairHtml(m.b)+'</div></div>';
  }).join('');
}
window.fixScore=function(mid){
  var ea=document.getElementById('fx-'+mid+'-a'),eb=document.getElementById('fx-'+mid+'-b');
  var ga=parseInt(ea?ea.value:'',10),gb=parseInt(eb?eb.value:'',10);
  if(isNaN(ga)||isNaN(gb)){alert('ゲームカウントを両方入力してください');return}
  if(ga===gb){alert('同点では確定できません');return}
  if(!confirm('この試合の結果を '+ga+'-'+gb+' に修正しますか？'))return;
  post('/api/admin/result/fix',{eventId:EV.id,matchId:mid,ga:ga,gb:gb}).then(function(j){
    if(!j.ok){alert(j.error||'失敗');return}
    if(j.levelsAdjusted===false)alert('勝敗と勝率は修正しました。ただし、この後に終わった試合があるため、レベルの位置は変更していません。');
    load();
  });
};
window.confirmScore=function(mid){
  var ea=document.getElementById('sc-'+mid+'-a'),eb=document.getElementById('sc-'+mid+'-b');
  var ga=parseInt(ea?ea.value:'',10),gb=parseInt(eb?eb.value:'',10);
  if(isNaN(ga)||isNaN(gb)){alert('ゲームカウントを両方入力してください');return}
  if(ga===gb){alert('同点では確定できません');return}
  post('/api/admin/result',{eventId:EV.id,matchId:mid,ga:ga,gb:gb}).then(function(j){if(!j.ok)alert(j.error||'失敗');load()});
};
function fld(label,id,val,type,extra){
  return '<label class="f"><span>'+label+'</span><input id="'+id+'" type="'+(type||'text')+'" value="'+esc(val==null?'':val)+'" '+(extra||'')+' style="width:100%"></label>';
}
function renderSettings(){
  if(document.activeElement&&document.activeElement.id&&document.activeElement.id.indexOf('s_')===0)return;
  var s=EV;
  var gm=function(v,t){return '<option value="'+v+'"'+(s.gameMode===v?' selected':'')+'>'+t+'</option>'};
  var ft=function(v,t){return '<option value="'+v+'"'+(s.feeType===v?' selected':'')+'>'+t+'</option>'};
  document.getElementById('settings').innerHTML=
  '<div class="grid c2"><div>'+fld('大会名','s_name',s.name)+fld('開催日','s_date',s.date,'date')+fld('会場','s_venue',s.venue)+fld('主催者名（領収書用）','s_organizer',s.organizer)+'</div>'+
  '<div><label class="f"><span>レベル数（A〜）</span><input id="s_levelCount" type="number" min="1" max="12" value="'+s.levelCount+'" style="width:100%"></label>'+
  '<label class="f"><span>コート数</span><input id="s_courtCount" type="number" min="1" max="30" value="'+s.courtCount+'" style="width:100%"></label>'+
  '<label class="f"><span>ゲーム形式</span><select id="s_gameMode" style="width:100%">'+gm('single','シングルゲーム（1コート1試合）')+gm('double','ダブルゲーム（1コート2試合同時）')+gm('triple','トリプルゲーム（1コート3試合同時）')+'</select></label>'+
  '<label class="f"><span>待機数（1コートあたり）</span><select id="s_waitSlots" style="width:100%"><option value="1"'+((s.waitSlots||1)===1?' selected':'')+'>1試合</option><option value="2"'+(s.waitSlots===2?' selected':'')+'>2試合</option><option value="3"'+(s.waitSlots===3?' selected':'')+'>3試合</option></select></label>'+
  '<label class="f"><span>トーナメント進出ペア数</span><input id="s_advanceCount" type="number" min="2" value="'+s.advanceCount+'" style="width:100%"></label></div></div>'+
  '<div class="grid c2"><div><label class="f"><span>参加費の単位</span><select id="s_feeType" style="width:100%">'+ft('person','人数単位（1人あたり）')+ft('pair','ペア単位（1ペアあたり）')+ft('team','チーム単位（1チームあたり）')+'</select></label>'+
  fld('参加費（円）','s_feeAmount',s.feeAmount,'number')+'</div>'+
  '<div><label class="f"><span>申込フォームで弁当の要否・個数を確認する</span><select id="s_bentoCheck" style="width:100%"><option value="0"'+(!s.bentoCheck?' selected':'')+'>確認しない</option><option value="1"'+(s.bentoCheck?' selected':'')+'>確認する</option></select></label>'+
  fld('弁当1個の金額（円）','s_bentoPrice',s.bentoPrice,'number')+'</div></div>'+
  '<div class="grid c2"><div><label class="f"><span>同チーム同士の対戦</span><select id="s_sameTeam" style="width:100%"><option value="1"'+(s.allowSameTeam!==false?' selected':'')+'>あり（対戦する）</option><option value="0"'+(s.allowSameTeam===false?' selected':'')+'>なし（避ける）</option></select></label></div>'+
  '<div><label class="f"><span>一度対戦したペア同士の再戦</span><select id="s_rematch" style="width:100%"><option value="1"'+(s.allowRematch!==false?' selected':'')+'>あり（再戦する）</option><option value="0"'+(s.allowRematch===false?' selected':'')+'>なし（避ける）</option></select></label></div></div>'+
  '<label class="f"><span>要項の備考</span><textarea id="s_notes" rows="3" style="width:100%">'+esc(s.notes||'')+'</textarea></label>'+
  '<label style="display:block;margin:6px 0"><input type="checkbox" id="s_regOpen" '+(s.regOpen?'checked':'')+'> 申込受付を開放する</label>'+
  '<div class="grid c2"><div>'+fld('受付締切日（空欄なら開催日まで）','s_regDeadline',s.regDeadline||'','date')+'<p class="mut">締切日までは、トレーニング開始後でも申込フォームから追加申込でき、当日追加としてそのまま参加できます。</p></div>'+
  '<div><label class="f"><span>閲覧用パスワード（大会ごと） '+(s.viewPassHash?'［現在：設定済み］':'［現在：未設定］')+'</span><input id="s_viewpw" type="password" placeholder="変更する場合のみ入力" style="width:100%"></label>'+
  '<label style="display:block;margin:6px 0"><input type="checkbox" id="s_viewpwClear"> 閲覧パスワードを解除する（誰でも閲覧可に戻す）</label>'+
  '<p class="mut">設定すると対戦表・実績ページの閲覧にパスワードが必要になります。参加者へパスワードを案内してください。</p></div></div>';
}
var EDIT_PID=null;
function pairFormHtml(){
  var catOpts=['男子','女子','混合'].map(function(c){return '<option>'+c+'</option>'}).join('');
  var yrOpts=['小4以下','小5','小6','中1','中2','中3','高1','高2','高3','一般'].map(function(c){return '<option>'+c+'</option>'}).join('');
  var lvOpts=['県大会出場','地区大会出場','地区大会未出場','初心者'].map(function(c){return '<option>'+c+'</option>'}).join('');
  var teamList=EV.registrations.map(function(r){return '<option value="'+esc(r.teamName)+'">'}).join('');
  var startOpts='<option value="">自動（属性）</option>';
  for(var i=0;i<EV.levelCount;i++)startOpts+='<option value="'+i+'">'+esc(ST.levelNames[i])+'リーグ</option>';
  return '<div class="match" style="background:var(--acc2)"><b id="ap_title">当日ペア追加・変更</b>'+
  '<div class="mut">当日来たペアの追加や、名前・年次・チームの変更ができます。トレーニング中でも追加でき、追加したペアはすぐ対戦に入ります。</div>'+
  '<label class="f"><span>チーム名（既存チームは選べます）</span><input id="ap_team" list="ap_teams" style="width:100%"><datalist id="ap_teams">'+teamList+'</datalist></label>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="mut" style="min-width:44px">選手1</span><input id="ap_p1" placeholder="名前" style="flex:1;min-width:110px"><select id="ap_y1">'+yrOpts+'</select></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center"><span class="mut" style="min-width:44px">選手2</span><input id="ap_p2" placeholder="名前" style="flex:1;min-width:110px"><select id="ap_y2">'+yrOpts+'</select></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center"><span class="mut">部門</span><select id="ap_cat">'+catOpts+'</select><span class="mut">レベル</span><select id="ap_lv">'+lvOpts+'</select>'+
  (EV.phase!=='tournament'?'<span class="mut">開始レベル</span><select id="ap_start">'+startOpts+'</select>':'')+
  '</div><div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button id="ap_btn" onclick="savePairForm()">＋ ペアを追加</button><button class="sub" onclick="clearPairForm()">入力をクリア</button></div></div>';
}
window.clearPairForm=function(){
  EDIT_PID=null;
  ['ap_team','ap_p1','ap_p2'].forEach(function(id){document.getElementById(id).value=''});
  document.getElementById('ap_title').textContent='当日ペア追加・変更';
  document.getElementById('ap_btn').textContent='＋ ペアを追加';
};
window.editPair=function(pid){
  var found=null,team='';
  EV.registrations.forEach(function(r){r.pairs.forEach(function(p){if(p.pid===pid){found=p;team=r.teamName}})});
  if(!found)return;
  EDIT_PID=pid;
  document.getElementById('ap_team').value=team;
  document.getElementById('ap_p1').value=found.p1;document.getElementById('ap_p2').value=found.p2;
  document.getElementById('ap_y1').value=found.year1||found.year||'一般';
  document.getElementById('ap_y2').value=found.year2||found.year||'一般';
  document.getElementById('ap_cat').value=found.category;document.getElementById('ap_lv').value=found.levelAttr;
  document.getElementById('ap_title').textContent='ペアを変更中：'+found.p1+'・'+found.p2;
  document.getElementById('ap_btn').textContent='変更を保存';
  document.getElementById('ap_team').scrollIntoView({behavior:'smooth',block:'center'});
};
window.savePairForm=function(){
  var body={eventId:EV.id,teamName:document.getElementById('ap_team').value,p1:document.getElementById('ap_p1').value,p2:document.getElementById('ap_p2').value,
    year1:document.getElementById('ap_y1').value,year2:document.getElementById('ap_y2').value,
    category:document.getElementById('ap_cat').value,levelAttr:document.getElementById('ap_lv').value};
  var st=document.getElementById('ap_start');if(st)body.startLevel=st.value===''?null:parseInt(st.value,10);
  if(EDIT_PID){body.pid=EDIT_PID;post('/api/admin/pair/update',body).then(function(j){if(!j.ok){alert(j.error||'失敗');return}clearPairForm();load()});}
  else post('/api/admin/pair/add',body).then(function(j){if(!j.ok){alert(j.error||'失敗');return}clearPairForm();load()});
};
window.delPair=function(pid,label){
  if(!confirm(label+' を削除しますか？\\nトレーニング中の場合、対戦相手の待機・試合中マッチも取り消されます。'))return;
  post('/api/admin/pair/delete',{eventId:EV.id,pid:pid}).then(function(j){if(!j.ok)alert(j.error||'失敗');load()});
};
function renderRegs(){
  var ae=document.activeElement;
  if(EDIT_PID)return;
  if(ae&&ae.id&&ae.id.indexOf('ap_')===0)return;
  var p1El=document.getElementById('ap_p1');
  if(p1El&&(p1El.value||document.getElementById('ap_p2').value||document.getElementById('ap_team').value))return;
  var totalPairs=0,totalFee=0,totalBento=0;
  EV.registrations.forEach(function(r){totalPairs+=r.pairs.length;totalFee+=r.totalFee;totalBento+=r.bentoCount});
  document.getElementById('regsummary').innerHTML='<p><b>'+EV.registrations.length+'チーム / '+totalPairs+'ペア / 合計 '+totalFee.toLocaleString()+'円'+(EV.bentoCheck?' / 弁当 '+totalBento+'個':'')+'</b></p>'+pairFormHtml();
  var lvOpts=function(cur){
    var h='<option value="">自動（属性）</option>';
    for(var i=0;i<EV.levelCount;i++)h+='<option value="'+i+'"'+(cur===i?' selected':'')+'>'+esc(ST.levelNames[i])+'リーグ</option>';
    return h;
  };
  document.getElementById('regs').innerHTML=EV.registrations.map(function(r){
    var h='<div class="match"><b>'+esc(r.teamName)+'</b> <span class="mut">'+esc(r.contact||'')+'</span> ／ 合計 <b>'+r.totalFee.toLocaleString()+'円</b> '+
    '<a class="btn sub" target="_blank" href="/print/receipt?event='+EV.id+'&reg='+r.id+'">🖨 領収書</a> '+
    '<button class="sub" onclick="delReg(\\''+r.id+'\\')">申込を削除</button>';
    if(EV.bentoCheck)h+='<div style="margin-top:4px">弁当：<input type="number" min="0" value="'+r.bentoCount+'" style="width:80px" onchange="setBento(\\''+r.id+'\\',this.value)"> 個</div>';
    h+='<table style="margin-top:6px"><tr><th>ペア</th><th>部門</th><th>年次</th><th>レベル</th>'+(EV.phase==='entry'?'<th>開始レベル</th>':'')+'<th>操作</th></tr>';
    r.pairs.forEach(function(p){
      var yl=(p.year1&&p.year2&&p.year1!==p.year2)?p.year1+'・'+p.year2:(p.year||p.year1||'');
      h+='<tr><td>'+esc(p.p1)+' <span class="mut">('+( esc(p.year1||p.year||''))+')</span>・'+esc(p.p2)+' <span class="mut">('+( esc(p.year2||p.year||''))+')</span></td><td>'+esc(p.category)+'</td><td>'+esc(yl)+'</td><td>'+esc(p.levelAttr)+'</td>';
      if(EV.phase==='entry')h+='<td><select onchange="setStartLevel(\\''+p.pid+'\\',this.value)">'+lvOpts(p.startLevel)+'</select></td>';
      h+='<td style="white-space:nowrap"><button class="sub" onclick="editPair(\\''+p.pid+'\\')">変更</button> <button class="sub" onclick="delPair(\\''+p.pid+'\\',\\''+esc(p.p1)+'・'+esc(p.p2)+'\\')">削除</button></td>';
      h+='</tr>';
    });
    return h+'</table></div>';
  }).join('')||'<p class="mut">まだ申込がありません</p>';
}
window.delReg=function(id){if(!confirm('この申込を削除しますか？'))return;post('/api/admin/registration/delete',{eventId:EV.id,registrationId:id}).then(load)};
window.setBento=function(id,v){post('/api/admin/registration/bento',{eventId:EV.id,registrationId:id,bentoCount:parseInt(v,10)||0}).then(load)};
window.setStartLevel=function(pid,v){post('/api/admin/pair/startlevel',{eventId:EV.id,pid:pid,level:v===''?null:parseInt(v,10)}).then(load)};
function renderPhase(){
  var h='';
  if(EV.phase==='entry'){
    h='<p>現在は<b>参加受付中</b>です。申込がそろったらトレーニングマッチを開始してください。開始レベルは申込一覧でペアごとに指定できます（未指定は属性から自動）。</p>'+
    '<button onclick="startTraining()">▶ トレーニングマッチを開始</button>';
  }else if(EV.phase==='training'){
    h='<p>現在は<b>トレーニングマッチ実施中</b>です。</p>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span>勝率上位</span><input id="advN" type="number" min="2" value="'+EV.advanceCount+'" style="width:80px"><span>ペアで</span>'+
    '<button onclick="startTournament()">🏆 トーナメントへ移行</button>'+
    '<button class="danger" onclick="resetTraining()">受付状態に戻す（結果リセット）</button></div>';
  }else{
    h='<p>現在は<b>トーナメント実施中</b>です。</p><button class="sub" onclick="backTraining()">トレーニングマッチに戻る</button>';
  }
  document.getElementById('phasebox').innerHTML=h;
}
window.startTraining=function(){if(!confirm('トレーニングマッチを開始しますか？'))return;post('/api/admin/start',{eventId:EV.id}).then(function(j){if(!j.ok)alert(j.error||'失敗');firstLoad=true;seenWait={};load()})};
window.resetTraining=function(){if(!confirm('結果をすべてリセットして受付状態に戻しますか？'))return;post('/api/admin/reset-training',{eventId:EV.id}).then(load)};
window.startTournament=function(){var n=parseInt(document.getElementById('advN').value,10)||EV.advanceCount;if(!confirm('勝率上位'+n+'ペアでトーナメントを開始しますか？'))return;post('/api/admin/tournament/start',{eventId:EV.id,advanceCount:n}).then(function(j){if(!j.ok)alert(j.error||'失敗');load()})};
window.backTraining=function(){post('/api/admin/back-to-training',{eventId:EV.id}).then(load)};
function renderTournament(){
  var t=document.getElementById('tournament');
  if(!ST.tournament){t.innerHTML='<p class="mut">まだトーナメントは始まっていません。実績は<a href="/results">実績ページ</a>で確認できます。</p>';return}
  var h='<div style="display:flex;gap:14px;overflow-x:auto">';
  ST.tournament.rounds.forEach(function(rd,ri){
    h+='<div style="min-width:220px"><h3>'+roundName(ST.tournament.rounds.length,ri)+'</h3>';
    rd.forEach(function(m,i){
      h+='<div class="match"><span class="badge">'+(i+1)+'</span>'+pairHtml(m.a)+'<div class="mut" style="text-align:center">vs</div>'+pairHtml(m.b);
      if(m.a&&m.b&&!m.winner){
        h+='<div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap"><span class="mut">ゲーム数</span><input type="number" min="0" id="ts-'+ri+'-'+i+'-a" style="width:60px"><span>―</span><input type="number" min="0" id="ts-'+ri+'-'+i+'-b" style="width:60px"><button onclick="confirmT('+ri+','+i+')">確定</button></div>';
      }
      if(m.winner){var w=m.winner===(m.a&&m.a.pid)?m.a:m.b;h+='<div>🏆 <b>'+esc(w?w.label:'')+'</b>'+(m.ga!=null?'（'+m.ga+'-'+m.gb+'）':'')+'</div>'}
      h+='</div>';
    });
    h+='</div>';
  });
  t.innerHTML=h+'</div>';
}
window.confirmT=function(r,i){
  var ea=document.getElementById('ts-'+r+'-'+i+'-a'),eb=document.getElementById('ts-'+r+'-'+i+'-b');
  var ga=parseInt(ea?ea.value:'',10),gb=parseInt(eb?eb.value:'',10);
  if(isNaN(ga)||isNaN(gb)){alert('ゲームカウントを両方入力してください');return}
  if(ga===gb){alert('同点では確定できません');return}
  post('/api/admin/tournament/result',{eventId:EV.id,round:r,index:i,ga:ga,gb:gb}).then(function(j){if(!j.ok)alert(j.error||'失敗');load()});
};
function roundName(total,ri){
  var fromEnd=total-1-ri;
  if(fromEnd===0)return '決勝';
  if(fromEnd===1)return '準決勝';
  if(fromEnd===2)return '準々決勝';
  return (ri+1)+'回戦';
}
document.getElementById('soundbtn').onclick=function(){
  soundOn=!soundOn;
  try{localStorage.setItem('tt_sound',soundOn?'1':'0')}catch(e){}
  this.textContent=soundOn?'🔊 音声アナウンス：ON':'🔊 音声アナウンス：OFF';
  if(soundOn){armed=true;speak('音声アナウンスをオンにしました')}
};
document.getElementById('soundtest').onclick=function(){
  if(!soundOn){soundOn=true;try{localStorage.setItem('tt_sound','1')}catch(e){}document.getElementById('soundbtn').textContent='🔊 音声アナウンス：ON'}
  armed=true;
  soundStat('音声：テスト再生中…');
  annQueue.push({chime:true,text:'テストです。音声アナウンスが流れています。聞こえたら準備OKです'});
  runAnnQueue();
};
document.getElementById('savesettings').onclick=function(){
  var g=function(id){return document.getElementById(id)};
  post('/api/admin/settings',{eventId:EV.id,settings:{
    name:g('s_name').value,date:g('s_date').value,venue:g('s_venue').value,organizer:g('s_organizer').value,notes:g('s_notes').value,
    levelCount:parseInt(g('s_levelCount').value,10),courtCount:parseInt(g('s_courtCount').value,10),gameMode:g('s_gameMode').value,waitSlots:parseInt(g('s_waitSlots').value,10),
    advanceCount:parseInt(g('s_advanceCount').value,10),feeType:g('s_feeType').value,feeAmount:parseInt(g('s_feeAmount').value,10),
    bentoCheck:g('s_bentoCheck').value==='1',bentoPrice:parseInt(g('s_bentoPrice').value,10),regOpen:g('s_regOpen').checked,
    regDeadline:g('s_regDeadline').value,viewPassword:g('s_viewpw').value,viewPassClear:g('s_viewpwClear').checked,
    allowSameTeam:g('s_sameTeam').value==='1',allowRematch:g('s_rematch').value==='1'
  }}).then(function(j){document.getElementById('setmsg').textContent=j.ok?'保存しました':(j.error||'保存に失敗しました');load()});
};
document.getElementById('newev').onclick=function(){
  var name=prompt('新しい大会名');
  if(!name)return;
  post('/api/admin/event/create',{name:name}).then(function(j){EVENT_ID=j.id;loadEvents().then(load)});
};
document.getElementById('delev').onclick=function(){
  if(!confirm('この大会とすべてのデータを削除しますか？'))return;
  post('/api/admin/event/delete',{eventId:EV.id}).then(function(){EVENT_ID='';loadEvents().then(load)});
};
function init(){
  var sb=document.getElementById('soundbtn');
  if(sb)sb.textContent=soundOn?'🔊 音声アナウンス：ON':'🔊 音声アナウンス：OFF';
  api('/api/auth/status').then(function(j){
    if(!j.hasPassword){
      document.getElementById('loginTitle').textContent='管理者パスワードを決めてください（初回設定）';
      document.getElementById('loginbtn').textContent='設定してログイン';
    }
    if(j.loggedIn){
      document.getElementById('app').classList.remove('hidden');
      loadEvents().then(load);
      setInterval(load,10000);
    }else{
      document.getElementById('loginbox').classList.remove('hidden');
    }
  });
}
document.getElementById('loginbtn').onclick=function(){
  var pw=document.getElementById('pw').value;
  api('/api/auth/status').then(function(j){
    var path=j.hasPassword?'/api/auth/login':'/api/auth/setup';
    fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
    .then(function(r){return r.json()}).then(function(x){
      if(!x.ok){document.getElementById('loginmsg').textContent=x.error||'ログインできませんでした';return}
      location.reload();
    });
  });
};
init();
`;
  return pageShell('管理者ページ', body, script);
}

/* ---------------- print pages ---------------- */
function printShell(title, inner) {
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="color-scheme" content="only light"><title>' + esc(title) + '</title><style>' +
    'body{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;color:#111;margin:24px}h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #999;padding:5px 7px;text-align:left}th{background:#eee}.noprint{margin-bottom:14px}@media print{.noprint{display:none}}' +
    '</style></head><body><div class="noprint"><button onclick="window.print()">🖨 印刷する</button> <a href="/admin">管理者ページに戻る</a></div>' + inner + '<p style="color:#666;font-size:11px;margin-top:18px"><img src="/logo.png" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:-5px"> 岩瀬ジュニア ソフトテニスクラブ（岩瀬STC）開発アプリ</p></body></html>';
}
function rosterPrintPage(ev) {
  let totalPairs = 0, totalFee = 0, totalBento = 0;
  let rows = '';
  ev.registrations.forEach((r, ri) => {
    totalPairs += r.pairs.length; totalFee += r.totalFee; totalBento += r.bentoCount;
    r.pairs.forEach((p, pi) => {
      rows += '<tr>' +
        (pi === 0 ? '<td rowspan="' + r.pairs.length + '">' + (ri + 1) + '</td><td rowspan="' + r.pairs.length + '">' + esc(r.teamName) + '</td>' : '') +
        '<td>' + esc(p.p1) + '</td><td>' + esc(p.p2) + '</td><td>' + esc(p.category) + '</td><td>' + esc(pairYearLabel(p)) + '</td><td>' + esc(p.levelAttr) + '</td>' +
        (pi === 0 ? '<td rowspan="' + r.pairs.length + '">' + (ev.bentoCheck ? r.bentoCount + '個' : '-') + '</td><td rowspan="' + r.pairs.length + '">' + r.totalFee.toLocaleString() + '円</td>' : '') +
        '</tr>';
    });
  });
  const inner = '<h1>' + esc(ev.name) + ' 参加者名簿</h1>' +
    '<p>' + esc(ev.date || '') + ' ' + esc(ev.venue || '') + ' ／ ' + ev.registrations.length + 'チーム・' + totalPairs + 'ペア' +
    (ev.bentoCheck ? '・弁当 ' + totalBento + '個' : '') + '・参加費合計 ' + totalFee.toLocaleString() + '円</p>' +
    '<table><tr><th>No</th><th>チーム名</th><th>選手1</th><th>選手2</th><th>部門</th><th>年次</th><th>レベル</th><th>弁当</th><th>金額</th></tr>' + rows + '</table>';
  return printShell(ev.name + ' 名簿', inner);
}
function receiptPrintPage(ev, reg) {
  const fee = calcFee(ev, reg.pairs.length, reg.bentoCount);
  const unitLabel = ev.feeType === 'person' ? '1人あたり' : ev.feeType === 'pair' ? '1ペアあたり' : '1チームあたり';
  let lines = '<tr><td>参加費（' + unitLabel + ' ' + ev.feeAmount.toLocaleString() + '円）× ' + (ev.feeType === 'person' ? reg.pairs.length * 2 + '人' : ev.feeType === 'pair' ? reg.pairs.length + 'ペア' : '1チーム') + '</td><td style="text-align:right">' + fee.base.toLocaleString() + '円</td></tr>';
  if (ev.bentoCheck && reg.bentoCount > 0) lines += '<tr><td>弁当（1個 ' + ev.bentoPrice.toLocaleString() + '円）× ' + reg.bentoCount + '個</td><td style="text-align:right">' + fee.bento.toLocaleString() + '円</td></tr>';
  const inner = '<div style="border:2px solid #111;padding:28px;max-width:640px;margin:0 auto">' +
    '<h1 style="text-align:center;letter-spacing:1em">領収書</h1>' +
    '<p style="font-size:16px;border-bottom:1px solid #111;padding-bottom:6px">' + esc(reg.teamName) + ' 様</p>' +
    '<p style="font-size:22px;text-align:center">金 ' + reg.totalFee.toLocaleString() + ' 円</p>' +
    '<table>' + lines + '<tr><th>合計</th><th style="text-align:right">' + reg.totalFee.toLocaleString() + '円</th></tr></table>' +
    '<p>但し、' + esc(ev.name) + ' 参加費等として</p>' +
    '<p>' + esc(ev.date || todayStr()) + '</p>' +
    '<p style="text-align:right">' + esc(ev.organizer || ev.name) + '</p></div>';
  return printShell('領収書 - ' + reg.teamName, inner);
}
function outlinePrintPage(ev) {
  const unitLabel = ev.feeType === 'person' ? '1人あたり' : ev.feeType === 'pair' ? '1ペアあたり' : '1チームあたり';
  const gm = ev.gameMode === 'single' ? 'シングルゲーム（1コートで1試合ずつ実施）' : ev.gameMode === 'double' ? 'ダブルゲーム（1コートで2試合を同時実施）' : 'トリプルゲーム（1コートで3試合を同時実施）';
  const levels = Array.from({ length: ev.levelCount }, (_, i) => levelName(i)).join('・');
  const inner = '<h1>' + esc(ev.name) + ' 開催要項</h1>' +
    '<table>' +
    '<tr><th style="width:140px">開催日</th><td>' + esc(ev.date || '') + '</td></tr>' +
    '<tr><th>会場</th><td>' + esc(ev.venue || '') + '</td></tr>' +
    '<tr><th>受付締切</th><td>' + esc(regDeadlineOf(ev) || '当日まで') + '</td></tr>' +
    '<tr><th>主催</th><td>' + esc(ev.organizer || '') + '</td></tr>' +
    '<tr><th>参加費</th><td>' + unitLabel + ' ' + ev.feeAmount.toLocaleString() + '円' + (ev.bentoCheck ? '（弁当 1個 ' + ev.bentoPrice.toLocaleString() + '円、申込時に注文可）' : '') + '</td></tr>' +
    '<tr><th>試合形式</th><td>トレーニングマッチ（レベル別リーグ：' + levels + ' の' + ev.levelCount + '段階）<br>勝てば1つ上のレベルへ、負ければ1つ下のレベルへ移動します（最上位・最下位は残留）。<br>' + gm + ' ／ コート ' + ev.courtCount + '面</td></tr>' +
    '<tr><th>トーナメント</th><td>トレーニングマッチの勝率上位 ' + ev.advanceCount + 'ペアがトーナメントへ進出します。</td></tr>' +
    (ev.notes ? '<tr><th>備考</th><td>' + esc(ev.notes).replace(/\n/g, '<br>') + '</td></tr>' : '') +
    '</table>' +
    '<p>参加申込は申込フォームからお願いします。対戦表・実績は当日ウェブページで随時公開します。</p>';
  return printShell(ev.name + ' 要項', inner);
}

server.listen(PORT, () => {
  console.log('tennis-training app listening on ' + PORT + ' (data: ' + DATA_FILE + ')');
});
