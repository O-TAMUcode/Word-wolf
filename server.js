const express = require('express'), http = require('http'), path = require('path');
const { WebSocketServer } = require('ws');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map(), where = new Map();
const PAIRS = [['りんご','なし'],['犬','猫'],['コーヒー','紅茶'],['カレー','シチュー'],['海','プール'],['電車','バス'],['ラーメン','うどん'],['サッカー','野球'],['スマホ','パソコン'],['ペン','鉛筆']];
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const nm = (r, u) => (r.players.get(u) || {}).name || '？';
const alive = r => [...r.players.keys()].filter(u => !r.dead.has(u));

function view(r, uid) {
  const ro = r.roles[uid];
  const wolves = Object.keys(r.roles).filter(u => r.roles[u].role === 'wolf' && u !== uid && r.players.has(u)).map(u => nm(r, u));
  return {
    t: 'state', me: uid, host: r.host === uid, mode: r.mode, phase: r.phase, sub: r.sub, round: r.round,
    log: r.log, result: r.result,
    players: [...r.players].map(([u, p]) => ({ uid: u, name: p.name, dead: r.dead.has(u), isHost: u === r.host })),
    role: ro && ro.role, word: ro && ro.word, mates: ro && ro.role === 'wolf' ? wolves : [],
    seer: r.seerLog[uid] || [],
    target: (r.sub === 'night' ? r.acts : r.votes)[uid] || null,
    reveal: r.sub === 'end' ? r.roles : null
  };
}
const push = r => { for (const [u, p] of r.players) send(p.ws, view(r, u)); };

function top(m) {
  const cnt = {};
  Object.values(m).forEach(t => cnt[t] = (cnt[t] || 0) + 1);
  const mx = Math.max(...Object.values(cnt)), t = Object.keys(cnt).filter(k => cnt[k] === mx);
  return t.length === 1 ? t[0] : null;
}
function win(r, ids) {
  const w = ids.filter(u => r.roles[u] && r.roles[u].role === 'wolf').length;
  if (!w) return '村人チームの勝ち';
  return w >= ids.length - w ? '人狼チームの勝ち' : '';
}
function step(r) {
  if (r.phase !== 'play') return;
  const al = alive(r);
  if (r.sub === 'night') {
    const need = al.filter(u => ['wolf', 'seer'].includes(r.roles[u].role));
    if (need.length && need.every(u => r.acts[u])) {
      const wa = {};
      al.filter(u => r.roles[u].role === 'wolf').forEach(u => wa[u] = r.acts[u]);
      const v = top(wa) || Object.values(wa)[0];
      al.filter(u => r.roles[u].role === 'seer').forEach(u => {
        const t = r.acts[u];
        (r.seerLog[u] = r.seerLog[u] || []).push('第' + r.round + '夜：' + nm(r, t) + 'さんは' + (r.roles[t] && r.roles[t].role === 'wolf' ? '人狼' : '人狼ではない'));
      });
      r.dead.add(v);
      r.log.push('第' + r.round + '夜：' + nm(r, v) + 'さんが襲撃されました');
      r.acts = {};
      const w = win(r, alive(r));
      r.sub = w ? 'end' : 'day'; r.result = w;
    }
  } else if (r.sub === 'vote') {
    if (al.length && al.every(u => r.votes[u])) {
      const t = top(r.votes);
      if (r.mode === 'word') {
        r.log.push(t ? nm(r, t) + 'さんが最多票でした' : '同票でした');
        r.result = t && r.roles[t].role === 'wolf' ? '市民チームの勝ち（ウルフを当てました）' : 'ウルフの勝ち';
        r.sub = 'end';
      } else {
        if (t) r.dead.add(t);
        r.log.push('第' + r.round + '日：' + (t ? nm(r, t) + 'さんが追放されました' : '同票で誰も追放されませんでした'));
        const w = win(r, alive(r));
        r.votes = {};
        if (w) { r.sub = 'end'; r.result = w; } else { r.sub = 'night'; r.round++; }
      }
    }
  }
}
function removeP(r, uid) {
  r.players.delete(uid); where.delete(uid);
  if (!r.players.size) { rooms.delete(r.pw); return; }
  if (r.host === uid) r.host = r.players.keys().next().value;
  step(r); push(r);
}
function addP(r, ws, name) {
  r.players.set(ws.uid, { name, ws, t: Date.now() });
  where.set(ws.uid, r.pw);
}
const clean = s => String(s || '').trim().slice(0, 30);

function handle(ws, m) {
  const uid = ws.uid;
  let r = rooms.get(where.get(uid));
  if (m.t === 'create' || m.t === 'join') {
    const pw = clean(m.pw), name = clean(m.name).slice(0, 12) || '名無し';
    if (!pw) return send(ws, { t: 'err', msg: 'パスワードを入力してください' });
    if (r) removeP(r, uid);
    const ex = rooms.get(pw);
    if (m.t === 'create') {
      if (ex) return send(ws, { t: 'err', msg: 'そのパスワードの部屋は既にあります' });
      const nr = { pw, host: uid, players: new Map(), mode: 'word', phase: 'lobby', sub: '', round: 1, dead: new Set(), roles: {}, acts: {}, votes: {}, seerLog: {}, log: [], result: '' };
      rooms.set(pw, nr); addP(nr, ws, name); return push(nr);
    }
    if (!ex) return send(ws, { t: 'err', msg: 'その部屋は見つかりません' });
    if (ex.phase === 'play') return send(ws, { t: 'err', msg: 'ゲーム中のため入れません' });
    addP(ex, ws, name); return push(ex);
  }
  if (!r) return;
  if (m.t === 'leave') { removeP(r, uid); return send(ws, { t: 'left' }); }
  const host = r.host === uid;
  if (m.t === 'mode' && host && r.phase === 'lobby' && ['word', 'wolf'].includes(m.mode)) r.mode = m.mode;
  else if (m.t === 'start' && host && r.phase === 'lobby') {
    const ids = shuffle([...r.players.keys()]);
    if (ids.length < (r.mode === 'wolf' ? 4 : 3)) return;
    r.roles = {}; r.dead = new Set(); r.acts = {}; r.votes = {}; r.seerLog = {}; r.round = 1; r.result = ''; r.log = ['ゲーム開始'];
    if (r.mode === 'wolf') {
      const nw = ids.length >= 7 ? 2 : 1;
      ids.forEach((u, i) => r.roles[u] = { role: i < nw ? 'wolf' : i === nw ? 'seer' : 'villager' });
      r.sub = 'night';
    } else {
      const pr = shuffle(PAIRS[Math.floor(Math.random() * PAIRS.length)]);
      ids.forEach((u, i) => r.roles[u] = { role: i ? 'citizen' : 'wolf', word: i ? pr[0] : pr[1] });
      r.sub = 'talk';
    }
    r.phase = 'play';
  }
  else if (m.t === 'tovote' && host && r.phase === 'play' && ['day', 'talk'].includes(r.sub)) r.sub = 'vote';
  else if (m.t === 'lobby' && host && r.sub === 'end') { r.phase = 'lobby'; r.sub = ''; r.roles = {}; }
  else if ((m.t === 'act' || m.t === 'vote') && r.phase === 'play' && alive(r).includes(uid) && alive(r).includes(m.target) && m.target !== uid) {
    if (m.t === 'act' && r.sub === 'night' && ['wolf', 'seer'].includes(r.roles[uid].role)) r.acts[uid] = m.target;
    else if (m.t === 'vote' && r.sub === 'vote') r.votes[uid] = m.target;
  }
  step(r); push(r);
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') {
      ws.uid = String(m.uid || '').slice(0, 40);
      const r = rooms.get(where.get(ws.uid));
      if (r && r.players.has(ws.uid)) { r.players.get(ws.uid).ws = ws; push(r); } else send(ws, { t: 'left' });
      return;
    }
    if (ws.uid) handle(ws, m);
  });
  ws.on('close', () => {
    const r = rooms.get(where.get(ws.uid)); if (!r) return;
    const p = r.players.get(ws.uid);
    if (p && p.ws === ws) {
      p.ws = null;
      if (r.phase === 'lobby') setTimeout(() => {
        const q = r.players.get(ws.uid);
        if (q && !q.ws && r.phase === 'lobby') removeP(r, ws.uid);
      }, 30000);
    }
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('listening'));
