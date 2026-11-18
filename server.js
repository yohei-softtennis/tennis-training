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
function loadDB() {
  try {
    DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!DB || !Array.isArray(DB.events)) throw new Error('bad');
  } catch (e) {
    DB = { adminHash: null, events: [] };
  }
  if (!DB.sessions) DB.sessions = [];
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
    gameMode: 'single',  // single|double|triple = 1コート同時試合数
    feeType: 'pair',     // person|pair|team
    feeAmount: 2000,
    bentoCheck: false,   // 申込フォームで弁当要否を確認するか
    bentoPrice: 800,
    advanceCount: 8,     // トーナメント進出ペア数
    allowSameTeam: true, // 同チーム同士の対戦を許可するか
    allowRematch: true,  // 一度対戦したペア同士の再戦を許可するか
    regOpen: true,
    phase: 'entry',      // entry | training | tournament
    registrations: [],   // {id, teamName, contact, pairs:[{pid,p1,p2,category,year,levelAttr,startLevel}], bentoCount, totalFee, createdAt}
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
  for (let i = 0; i < ev.levels.length; i++) if (ev.levels[i].includes(pid)) return i;
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
function ensureAssignments(ev) {
  if (ev.phase !== 'training') return;
  const per = matchesPerCourt(ev);
  let changed = false;
  for (let court = 1; court <= ev.courtCount; court++) {
    // 待機があれば試合中へ繰り上げ
    for (;;) {
      const playing = ev.matches.filter(m => m.court === court && m.status === 'playing').length;
      if (playing >= per) break;
      const w = ev.matches.find(m => m.court === court && m.status === 'waiting');
      if (!w) break;
      w.status = 'playing';
      changed = true;
    }
    // 空き枠 (試合中+待機) があれば新規マッチを作成
    for (;;) {
      const playing = ev.matches.filter(m => m.court === court && m.status === 'playing').length;
      const waiting = ev.matches.filter(m => m.court === court && m.status === 'waiting').length;
      if (playing >= per && waiting >= 1) break;
      if (playing + waiting >= per + 1) break;
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
  // レベルごとに空きペアの組み合わせを探す（同チーム対決・再戦の設定を反映）
  const pm = pairMap(ev);
  const played = new Set();
  for (const m of ev.matches) if (m.status === 'done') played.add([m.a, m.b].sort().join('|'));
  let best = null;
  for (let lv = 0; lv < ev.levels.length; lv++) {
    const free = ev.levels[lv].filter(pid => !activeMatchOf(ev, pid));
    if (free.length < 2) continue;
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], b = free[j];
        if (ev.allowSameTeam === false && pm[a] && pm[b] && pm[a].teamId === pm[b].teamId) continue;
        if (ev.allowRematch === false && played.has([a, b].sort().join('|'))) continue;
        const score = gamesPlayed(ev, a) + gamesPlayed(ev, b);
        const wait = Math.min(lastPlayedAt(ev, a), lastPlayedAt(ev, b));
        if (!best || score < best.score || (score === best.score && wait < best.wait)) best = { a, b, level: lv, score, wait };
      }
    }
  }
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
    return { pid, label: pairLabel(p), teamName: p.teamName, category: p.category, year: p.year, levelAttr: p.levelAttr, w: s.w, l: s.l };
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
    level: m.level, court: m.court,
    a: pairInfo(m.a), b: pairInfo(m.b),
    winnerPid: m.winner, finishedAt: m.finishedAt, ga: m.ga, gb: m.gb,
  }));
  return {
    event: { id: ev.id, name: ev.name, date: ev.date, venue: ev.venue, phase: ev.phase, levelCount: ev.levels.length || ev.levelCount, courtCount: ev.courtCount, gameMode: ev.gameMode, regOpen: ev.regOpen },
    levels: ev.levels.map((l, i) => ({ level: i, name: levelName(i), pairs: l.map(pid => pairInfo(pid)) })),
    courts,
    recent,
    standings: standings(ev).map(r => ({ rank: r.rank, pid: r.pid, label: pairLabel(r.pair), teamName: r.teamName, w: r.w, l: r.l, games: r.games, rate: r.rate, level: r.level })),
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
      return sendJson(res, 200, { events: DB.events.map(e => ({ id: e.id, name: e.name, date: e.date, phase: e.phase, regOpen: e.regOpen })) });
    }
    if (p === '/api/state') {
      const ev = getEvent(url.searchParams.get('event'));
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      return sendJson(res, 200, publicState(ev));
    }
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const ev = getEvent(b.eventId);
      if (!ev) return sendJson(res, 404, { error: 'no event' });
      if (!ev.regOpen || ev.phase !== 'entry') return sendJson(res, 400, { error: '受付は終了しています' });
      const teamName = String(b.teamName || '').trim();
      if (!teamName) return sendJson(res, 400, { error: 'チーム名を入力してください' });
      const pairsIn = Array.isArray(b.pairs) ? b.pairs : [];
      const pairs = [];
      for (const q of pairsIn) {
        const p1 = String(q.p1 || '').trim(), p2 = String(q.p2 || '').trim();
        if (!p1 && !p2) continue;
        if (!p1 || !p2) return sendJson(res, 400, { error: 'ペアは2人とも入力してください' });
        pairs.push({
          pid: uid(), p1, p2,
          category: CATEGORIES.includes(q.category) ? q.category : '混合',
          year: YEARS.includes(q.year) ? q.year : '一般',
          levelAttr: LEVEL_ATTRS.includes(q.levelAttr) ? q.levelAttr : '地区大会未出場',
          startLevel: null,
        });
      }
      if (!pairs.length) return sendJson(res, 400, { error: 'ペアを1組以上入力してください' });
      const bentoCount = ev.bentoCheck ? Math.max(0, Math.min(999, parseInt(b.bentoCount, 10) || 0)) : 0;
      const fee = calcFee(ev, pairs.length, bentoCount);
      const reg = { id: uid(), teamName, contact: String(b.contact || '').trim(), pairs, bentoCount, totalFee: fee.total, createdAt: Date.now() };
      ev.registrations.push(reg);
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
        if (s.levelCount != null) ev.levelCount = Math.max(1, Math.min(12, parseInt(s.levelCount, 10) || 4));
        if (s.courtCount != null) ev.courtCount = Math.max(1, Math.min(30, parseInt(s.courtCount, 10) || 4));
        if (['single', 'double', 'triple'].includes(s.gameMode)) ev.gameMode = s.gameMode;
        if (['person', 'pair', 'team'].includes(s.feeType)) ev.feeType = s.feeType;
        if (s.feeAmount != null) ev.feeAmount = Math.max(0, parseInt(s.feeAmount, 10) || 0);
        if (s.bentoCheck != null) ev.bentoCheck = !!s.bentoCheck;
        if (s.bentoPrice != null) ev.bentoPrice = Math.max(0, parseInt(s.bentoPrice, 10) || 0);
        if (s.advanceCount != null) ev.advanceCount = Math.max(2, parseInt(s.advanceCount, 10) || 8);
        if (s.allowSameTeam != null) ev.allowSameTeam = !!s.allowSameTeam;
        if (s.allowRematch != null) ev.allowRematch = !!s.allowRematch;
        if (s.regOpen != null) ev.regOpen = !!s.regOpen;
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
    bodyHtml + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
}
function topBar(title) {
  return '<header class="top"><h1>' + esc(title) + '</h1><nav>' +
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
`;

function viewerPage() {
  const body = topBar('トレーニングマッチ対戦表') +
    '<main>' +
    '<div id="evhead"></div>' +
    '<div id="callout"></div>' +
    '<div class="card"><h2>コート状況</h2><div id="courts" class="grid c2"></div></div>' +
    '<div class="card"><h2>レベル別ペア</h2><div id="levels"></div></div>' +
    '<div id="tournament"></div>' +
    '<div class="card"><h2>最近の結果</h2><div id="recent"></div></div>' +
    '<p class="mut">このページは15秒ごとに自動更新されます。</p>' +
    '</main>';
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
function load(){api('/api/state'+(EVENT_ID?'?event='+EVENT_ID:'')).then(render).catch(function(){})}
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
  d.innerHTML='<div style="display:flex;gap:6px;flex-wrap:wrap">'+
  '<input class="p1" placeholder="選手1の名前" style="flex:1;min-width:120px">'+
  '<input class="p2" placeholder="選手2の名前" style="flex:1;min-width:120px"></div>'+
  '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">'+
  '<select class="cat">'+opts(CATS)+'</select>'+
  '<select class="yr">'+opts(YEARS)+'</select>'+
  '<select class="lv">'+opts(LVS)+'</select>'+
  '<button type="button" class="sub del">削除</button></div>';
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
  document.getElementById('evinfo').textContent=(ev.date||'')+' '+(ev.phase==='entry'&&ev.regOpen?'受付中':'受付終了');
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
  var open=j.events.filter(function(e){return e.phase==='entry'&&e.regOpen});
  var list=open.length?open:j.events;
  if(!list.length){sel.innerHTML='<option>大会がありません</option>';return}
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
    pairs.push({p1:p1,p2:p2,category:d.querySelector('.cat').value,year:d.querySelector('.yr').value,levelAttr:d.querySelector('.lv').value});
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
    '<main><div class="card"><h2>ペア別実績</h2>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input id="q" placeholder="チーム名・選手名で検索" style="flex:1;min-width:160px">' +
    '<select id="teamsel"><option value="">すべてのチーム</option></select></div>' +
    '<div id="standings"></div></div>' +
    '<div class="card"><h2>チーム別集計</h2><div id="byteam"></div></div>' +
    '<p class="mut">このページは誰でも閲覧できます。15秒ごとに自動更新されます。</p></main>';
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
    '<div class="card"><h2>コート状況と結果入力</h2><div style="margin-bottom:8px"><button id="soundbtn" class="sub">🔊 音声アナウンス：ON</button> <span class="mut">待機ペアが出たら音声とバナーでお知らせします</span></div><div id="courts" class="grid c2"></div></div>' +
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
function speak(text){
  if(!soundOn)return;
  try{
    if(!window.speechSynthesis)return;
    var u=new SpeechSynthesisUtterance(text);
    u.lang='ja-JP';u.rate=0.95;
    var vs=speechSynthesis.getVoices().filter(function(v){return v.lang&&v.lang.indexOf('ja')===0});
    if(vs.length)u.voice=vs[0];
    utters.push(u);if(utters.length>10)utters.shift();
    speechSynthesis.resume();
    speechSynthesis.speak(u);
  }catch(e){}
}
if(window.speechSynthesis){try{speechSynthesis.getVoices();speechSynthesis.onvoiceschanged=function(){speechSynthesis.getVoices()}}catch(e){}}
/* 音声ロック解除: ページを開いた後の最初のタップで無音の発話をして許可を取り、以後は定期的に resume して停止を防ぐ */
document.addEventListener('pointerdown',function prime(){
  try{if(window.speechSynthesis){speechSynthesis.resume();var u=new SpeechSynthesisUtterance(' ');u.volume=0;u.lang='ja-JP';speechSynthesis.speak(u)}}catch(e){}
  document.removeEventListener('pointerdown',prime);
});
setInterval(function(){try{if(soundOn&&window.speechSynthesis)speechSynthesis.resume()}catch(e){}},10000);
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
  renderCourts();renderSettings();renderRegs();renderPhase();renderTournament();
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
  if(!firstLoad&&newOnes.length){
    newOnes.forEach(function(x,i){
      setTimeout(function(){
        speak(x.m.a.teamName+'の'+x.m.a.label+'ペアと、'+x.m.b.teamName+'の'+x.m.b.label+'ペアは、'+x.court+'番コートで待機してください');
      },i*6000);
    });
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
  '<label class="f"><span>トーナメント進出ペア数</span><input id="s_advanceCount" type="number" min="2" value="'+s.advanceCount+'" style="width:100%"></label></div></div>'+
  '<div class="grid c2"><div><label class="f"><span>参加費の単位</span><select id="s_feeType" style="width:100%">'+ft('person','人数単位（1人あたり）')+ft('pair','ペア単位（1ペアあたり）')+ft('team','チーム単位（1チームあたり）')+'</select></label>'+
  fld('参加費（円）','s_feeAmount',s.feeAmount,'number')+'</div>'+
  '<div><label class="f"><span>申込フォームで弁当の要否・個数を確認する</span><select id="s_bentoCheck" style="width:100%"><option value="0"'+(!s.bentoCheck?' selected':'')+'>確認しない</option><option value="1"'+(s.bentoCheck?' selected':'')+'>確認する</option></select></label>'+
  fld('弁当1個の金額（円）','s_bentoPrice',s.bentoPrice,'number')+'</div></div>'+
  '<div class="grid c2"><div><label class="f"><span>同チーム同士の対戦</span><select id="s_sameTeam" style="width:100%"><option value="1"'+(s.allowSameTeam!==false?' selected':'')+'>あり（対戦する）</option><option value="0"'+(s.allowSameTeam===false?' selected':'')+'>なし（避ける）</option></select></label></div>'+
  '<div><label class="f"><span>一度対戦したペア同士の再戦</span><select id="s_rematch" style="width:100%"><option value="1"'+(s.allowRematch!==false?' selected':'')+'>あり（再戦する）</option><option value="0"'+(s.allowRematch===false?' selected':'')+'>なし（避ける）</option></select></label></div></div>'+
  '<label class="f"><span>要項の備考</span><textarea id="s_notes" rows="3" style="width:100%">'+esc(s.notes||'')+'</textarea></label>'+
  '<label style="display:block;margin:6px 0"><input type="checkbox" id="s_regOpen" '+(s.regOpen?'checked':'')+'> 申込受付を開放する</label>';
}
function renderRegs(){
  var totalPairs=0,totalFee=0,totalBento=0;
  EV.registrations.forEach(function(r){totalPairs+=r.pairs.length;totalFee+=r.totalFee;totalBento+=r.bentoCount});
  document.getElementById('regsummary').innerHTML='<p><b>'+EV.registrations.length+'チーム / '+totalPairs+'ペア / 合計 '+totalFee.toLocaleString()+'円'+(EV.bentoCheck?' / 弁当 '+totalBento+'個':'')+'</b></p>';
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
    h+='<table style="margin-top:6px"><tr><th>ペア</th><th>部門</th><th>年次</th><th>レベル</th>'+(EV.phase==='entry'?'<th>開始レベル</th>':'')+'</tr>';
    r.pairs.forEach(function(p){
      h+='<tr><td>'+esc(p.p1)+'・'+esc(p.p2)+'</td><td>'+esc(p.category)+'</td><td>'+esc(p.year)+'</td><td>'+esc(p.levelAttr)+'</td>';
      if(EV.phase==='entry')h+='<td><select onchange="setStartLevel(\\''+p.pid+'\\',this.value)">'+lvOpts(p.startLevel)+'</select></td>';
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
  if(soundOn)speak('音声アナウンスをオンにしました');
};
document.getElementById('savesettings').onclick=function(){
  var g=function(id){return document.getElementById(id)};
  post('/api/admin/settings',{eventId:EV.id,settings:{
    name:g('s_name').value,date:g('s_date').value,venue:g('s_venue').value,organizer:g('s_organizer').value,notes:g('s_notes').value,
    levelCount:parseInt(g('s_levelCount').value,10),courtCount:parseInt(g('s_courtCount').value,10),gameMode:g('s_gameMode').value,
    advanceCount:parseInt(g('s_advanceCount').value,10),feeType:g('s_feeType').value,feeAmount:parseInt(g('s_feeAmount').value,10),
    bentoCheck:g('s_bentoCheck').value==='1',bentoPrice:parseInt(g('s_bentoPrice').value,10),regOpen:g('s_regOpen').checked,
    allowSameTeam:g('s_sameTeam').value==='1',allowRematch:g('s_rematch').value==='1'
  }}).then(function(j){document.getElementById('setmsg').textContent=j.ok?'保存しました':'保存に失敗しました';load()});
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
    '</style></head><body><div class="noprint"><button onclick="window.print()">🖨 印刷する</button> <a href="/admin">管理者ページに戻る</a></div>' + inner + '</body></html>';
}
function rosterPrintPage(ev) {
  let totalPairs = 0, totalFee = 0, totalBento = 0;
  let rows = '';
  ev.registrations.forEach((r, ri) => {
    totalPairs += r.pairs.length; totalFee += r.totalFee; totalBento += r.bentoCount;
    r.pairs.forEach((p, pi) => {
      rows += '<tr>' +
        (pi === 0 ? '<td rowspan="' + r.pairs.length + '">' + (ri + 1) + '</td><td rowspan="' + r.pairs.length + '">' + esc(r.teamName) + '</td>' : '') +
        '<td>' + esc(p.p1) + '</td><td>' + esc(p.p2) + '</td><td>' + esc(p.category) + '</td><td>' + esc(p.year) + '</td><td>' + esc(p.levelAttr) + '</td>' +
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
