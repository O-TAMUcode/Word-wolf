const express = require('express'), http = require('http'), fs = require('fs');
const { WebSocketServer } = require('ws');
const app = express();
const SRC = fs.readFileSync(__filename, 'utf8'), MA = '/*' + 'HTML', MB = 'HTML' + '*/';
const PAGE = SRC.slice(SRC.indexOf(MA) + MA.length, SRC.lastIndexOf(MB));
app.get('/', (req, res) => res.type('html').send(PAGE));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map(), where = new Map();
const DISC = 120000, ANIM = 6500, LIM = { word: [3, 10], wolf: [4, 20] };
const PAIRS = [['りんご','なし'],['犬','猫'],['コーヒー','紅茶'],['カレー','シチュー'],['海','プール'],['電車','バス'],['ラーメン','うどん'],['サッカー','野球'],['スマホ','パソコン'],['ペン','鉛筆'],
['ハンバーガー','サンドイッチ'],['ピザ','お好み焼き'],['寿司','おにぎり'],['チョコ','キャラメル'],['アイス','かき氷'],['コーラ','サイダー'],['牛乳','豆乳'],['バナナ','みかん'],['トマト','きゅうり'],['卵焼き','オムレツ'],
['学校','塾'],['先生','校長'],['図書館','本屋'],['映画館','劇場'],['遊園地','動物園'],['温泉','銭湯'],['ホテル','旅館'],['空港','駅'],['飛行機','新幹線'],['自転車','バイク'],
['サングラス','メガネ'],['マフラー','手袋'],['スニーカー','ブーツ'],['リュック','トートバッグ'],['腕時計','指輪'],['傘','レインコート'],['布団','ベッド'],['冷蔵庫','冷凍庫'],['掃除機','ほうき'],['テレビ','ラジオ'],
['ギター','ベース'],['ピアノ','オルガン'],['歌手','俳優'],['漫画','アニメ'],['ゲーム','トランプ'],['将棋','囲碁'],['キャンプ','登山'],['釣り','潜水'],['花火','たき火'],['桜','梅'],
['夏','冬'],['雨','雪'],['朝','昼'],['月','太陽'],['富士山','東京タワー'],['忍者','侍'],['魔法使い','占い師'],['警察','探偵'],['医者','看護師'],['パン屋','ケーキ屋']];
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const nm = (r, u) => (r.players.get(u) || {}).name || '？';
const alive = r => [...r.players.keys()].filter(u => !r.dead.has(u));
const roleOf = (r, u) => (r.roles[u] || {}).role;

function view(r, uid) {
  const ro = r.roles[uid], al = alive(r);
  const mates = ro && ['wolf', 'mason'].includes(ro.role) && r.mode === 'wolf'
    ? Object.keys(r.roles).filter(u => r.roles[u].role === ro.role && u !== uid && r.players.has(u)).map(u => nm(r, u)) : [];
  return {
    t: 'state', me: uid, host: r.host === uid, mode: r.mode, phase: r.phase, sub: r.sub, round: r.round,
    log: r.log, result: r.result, chat: r.chat,
    players: [...r.players].map(([u, p]) => ({ uid: u, name: p.name, dead: r.dead.has(u), isHost: u === r.host })),
    role: ro && ro.role, word: ro && ro.word, mates, priv: r.priv[uid] || [],
    target: (r.sub === 'night' ? r.acts : r.votes)[uid] || null,
    left: r.deadline ? Math.max(0, r.deadline - Date.now()) : 0,
    vote: { done: al.filter(u => r.votes[u]).length, total: al.length },
    anim: r.sub === 'anim' ? r.anim : null,
    reveal: r.sub === 'end' ? r.roles : null
  };
}
const push = r => { for (const [u, p] of r.players) send(p.ws, view(r, u)); };

function go(r, sub) {
  clearTimeout(r.timer);
  r.sub = sub; r.anim = null; r.deadline = 0;
  if (sub === 'day' || sub === 'talk') {
    r.deadline = Date.now() + DISC;
    r.timer = setTimeout(() => { if (r.sub === sub) { go(r, 'vote'); push(r); } }, DISC);
  }
}
function anim(r, kind, names, next) {
  clearTimeout(r.timer);
  r.sub = 'anim'; r.anim = { kind, names }; r.next = next; r.deadline = 0;
  r.timer = setTimeout(() => { if (r.sub === 'anim') { go(r, r.next); push(r); } }, ANIM);
}
function top(m) {
  const cnt = {};
  Object.values(m).forEach(t => cnt[t] = (cnt[t] || 0) + 1);
  const mx = Math.max(...Object.values(cnt)), t = Object.keys(cnt).filter(k => cnt[k] === mx);
  return t.length === 1 ? t[0] : null;
}
function win(r, ids) {
  const w = ids.filter(u => roleOf(r, u) === 'wolf').length;
  const h = ids.filter(u => !['wolf', 'fox', 'vampire'].includes(roleOf(r, u))).length;
  let res = '';
  if (!w) res = '村人チームの勝ち'; else if (w >= h) res = '人狼チームの勝ち';
  if (res && ids.some(u => ['fox', 'vampire'].includes(roleOf(r, u)))) res = '吸血鬼の勝ち';
  if (res === '村人チームの勝ち' && ids.some(u => roleOf(r, u) === 'rich')) res += '（富豪が生き残ったので勝利ポイント2倍）';
  return res;
}
function step(r) {
  if (r.phase !== 'play') return;
  const al = alive(r);
  if (r.sub === 'night') {
    const need = al.filter(u => ['wolf', 'seer', 'hunter'].includes(roleOf(r, u)));
    if (need.length && need.every(u => r.acts[u])) {
      const wa = {};
      al.filter(u => roleOf(r, u) === 'wolf').forEach(u => wa[u] = r.acts[u]);
      const v = top(wa) || Object.values(wa)[0];
      const guard = al.filter(u => roleOf(r, u) === 'hunter').map(u => r.acts[u]);
      const kills = [];
      al.filter(u => roleOf(r, u) === 'seer').forEach(u => {
        const t = r.acts[u], ro = roleOf(r, t);
        (r.priv[u] = r.priv[u] || []).push('第' + r.round + '夜 占い：' + nm(r, t) + 'さんは' + (ro === 'wolf' ? '人狼' : '人狼ではない'));
        if (ro === 'fox' && !kills.includes(t)) kills.push(t);
        if (ro === 'psychokiller' && !kills.includes(u)) kills.push(u);
      });
      al.filter(u => roleOf(r, u) === 'hunter').forEach(u => {
        if (roleOf(r, r.acts[u]) === 'psychokiller' && !kills.includes(u)) kills.push(u);
      });
      if (v && roleOf(r, v) !== 'fox' && !guard.includes(v) && !kills.includes(v)) kills.unshift(v);
      kills.forEach(k => r.dead.add(k));
      const names = kills.map(k => nm(r, k));
      r.log.push('第' + r.round + '夜：' + (names.length ? names.join('、') + 'さんが殺されました' : '誰も殺されませんでした'));
      r.acts = {};
      r.result = win(r, alive(r));
      anim(r, 'night', names, r.result ? 'end' : 'day');
    }
  } else if (r.sub === 'vote') {
    if (al.length && al.every(u => r.votes[u])) {
      const t = top(r.votes);
      if (r.mode === 'word') {
        r.log.push(t ? nm(r, t) + 'さんが最多票でした' : '同票でした');
        r.result = t && roleOf(r, t) === 'wolf' ? '市民チームの勝ち（ウルフを当てました）' : 'ウルフの勝ち';
        go(r, 'end');
      } else {
        if (t) {
          r.dead.add(t);
          alive(r).filter(u => roleOf(r, u) === 'medium').forEach(u =>
            (r.priv[u] = r.priv[u] || []).push('第' + r.round + '日 霊能：' + nm(r, t) + 'さんは' + (roleOf(r, t) === 'wolf' ? '人狼' : '人狼ではない')));
        }
        r.log.push('第' + r.round + '日：' + (t ? nm(r, t) + 'さんが追放されました' : '同票で誰も追放されませんでした'));
        r.votes = {};
        r.result = win(r, alive(r));
        if (!r.result) r.round++;
        anim(r, 'exec', t ? [nm(r, t)] : [], r.result ? 'end' : 'night');
      }
    }
  }
}
function removeP(r, uid) {
  r.players.delete(uid); where.delete(uid);
  if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.pw); return; }
  if (r.host === uid) r.host = r.players.keys().next().value;
  step(r); push(r);
}
function addP(r, ws, name) {
  r.players.set(ws.uid, { name, ws, t: Date.now() });
  where.set(ws.uid, r.pw);
}
const clean = s => String(s || '').trim().slice(0, 30);

function assign(r, ids) {
  r.roles = {};
  if (r.mode === 'wolf') {
    const n = ids.length, nw = n < 7 ? 1 : n < 11 ? 2 : n < 16 ? 3 : 4;
    const sp = ['seer'];
    if (n >= 5) sp.push('hunter');
    if (n >= 6) sp.push('medium');
    if (n >= 7) sp.push('oracle');
    if (n >= 8) sp.push('madman');
    if (n >= 9) sp.push('mason', 'mason');
    if (n >= 10) sp.push('fox');
    if (n >= 13) sp.push('rich');
    if (n >= 14) sp.push('psychokiller');
    if (n >= 15) sp.push('vampire');
    ids.forEach((u, i) => r.roles[u] = { role: i < nw ? 'wolf' : sp[i - nw] || 'villager' });
    ids.filter(u => r.roles[u].role === 'oracle').forEach(u => {
      const t = shuffle(ids.filter(x => x !== u))[0];
      r.priv[u] = ['第1夜 神託：' + nm(r, t) + 'さんは' + (r.roles[t].role === 'wolf' ? '人間ではありません' : '人間です')];
    });
  } else {
    r.used = r.used || new Set();
    let pool = PAIRS.map((_, i) => i).filter(i => !r.used.has(i));
    if (!pool.length) { r.used.clear(); pool = PAIRS.map((_, i) => i); }
    const pi = pool[Math.floor(Math.random() * pool.length)];
    r.used.add(pi);
    const pr = shuffle(PAIRS[pi]);
    ids.forEach((u, i) => r.roles[u] = { role: i ? 'citizen' : 'wolf', word: i ? pr[0] : pr[1] });
  }
}

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
      const nr = { pw, host: uid, players: new Map(), mode: 'word', phase: 'lobby', sub: '', round: 1, dead: new Set(), roles: {}, acts: {}, votes: {}, priv: {}, log: [], result: '', chat: [], deadline: 0, timer: null, anim: null, next: null };
      rooms.set(pw, nr); addP(nr, ws, name); return push(nr);
    }
    if (!ex) return send(ws, { t: 'err', msg: 'その部屋は見つかりません' });
    if (ex.phase === 'play') return send(ws, { t: 'err', msg: 'ゲーム中のため入れません' });
    if (ex.players.size >= 20) return send(ws, { t: 'err', msg: 'この部屋は満員です（20人まで）' });
    addP(ex, ws, name); return push(ex);
  }
  if (!r) return;
  if (m.t === 'leave') { removeP(r, uid); return send(ws, { t: 'left' }); }
  const host = r.host === uid;
  if (r.sub === 'anim' && ['act', 'vote', 'chat', 'tovote'].includes(m.t)) return;
  if (m.t === 'mode' && host && r.phase === 'lobby' && ['word', 'wolf'].includes(m.mode)) r.mode = m.mode;
  else if (m.t === 'chat') {
    const text = String(m.text || '').trim().slice(0, 200), p = r.players.get(uid);
    const muted = r.phase === 'play' && (r.dead.has(uid) || (r.mode === 'wolf' && r.sub === 'night'));
    if (text && p && !muted) { r.chat.push({ name: p.name, text }); if (r.chat.length > 100) r.chat.shift(); }
  }
  else if (m.t === 'start' && host && r.phase === 'lobby') {
    const n = r.players.size, [lo, hi] = LIM[r.mode];
    if (n < lo || n > hi) return send(ws, { t: 'err', msg: (r.mode === 'wolf' ? '人狼' : 'ワードウルフ') + 'は' + lo + '〜' + hi + '人で遊べます' });
    r.dead = new Set(); r.acts = {}; r.votes = {}; r.priv = {}; r.round = 1; r.result = ''; r.chat = []; r.log = ['ゲーム開始'];
    assign(r, shuffle([...r.players.keys()]));
    r.phase = 'play';
    go(r, r.mode === 'wolf' ? 'night' : 'talk');
  }
  else if (m.t === 'tovote' && host && r.phase === 'play' && ['day', 'talk'].includes(r.sub)) go(r, 'vote');
  else if (m.t === 'lobby' && host && r.sub === 'end') { r.phase = 'lobby'; r.roles = {}; go(r, ''); }
  else if ((m.t === 'act' || m.t === 'vote') && r.phase === 'play' && alive(r).includes(uid) && alive(r).includes(m.target) && m.target !== uid) {
    if (m.t === 'act' && r.sub === 'night' && ['wolf', 'seer', 'hunter'].includes(roleOf(r, uid))) r.acts[uid] = m.target;
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

/*HTML
<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>人狼・ワードウルフ</title>
<style>
:root{--bg:#fff;--fg:#1c1b22;--card:#f1f0f6;--ac:#5b3fd0;--mu:#6b6a78;--bd:#d8d6e4}
@media (prefers-color-scheme:dark){:root{--bg:#15141b;--fg:#ececf3;--card:#23212d;--ac:#9a85ff;--mu:#a09fb0;--bd:#3a3848;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
#app{max-width:520px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:17px;margin:18px 0 8px}
.card{background:var(--card);border-radius:14px;padding:14px;margin:12px 0}
input,select{width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);margin:6px 0}
button{font:inherit;padding:12px 16px;border-radius:10px;border:0;background:var(--ac);color:#fff;width:100%;margin:6px 0;cursor:pointer}
button.sub{background:transparent;color:var(--ac);border:1px solid var(--ac)}
button.t{background:var(--bg);color:var(--fg);border:1px solid var(--bd);text-align:left}
button.t.on{border-color:var(--ac);outline:2px solid var(--ac)}
.mu{color:var(--mu);font-size:14px}.err{color:#d33;font-size:14px;min-height:20px}
.big{font-size:26px;font-weight:700;margin:4px 0}
.dead{text-decoration:line-through;color:var(--mu)}
li{margin:2px 0}ul{padding-left:20px;margin:6px 0}
.ov{position:fixed;inset:0;z-index:9;background:#0a0a12;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px}
.a1{font-size:22px;animation:fi 1s both}
.a2{font-size:90px;animation:fi .6s 1.2s both,sk .5s 1.8s 2}
.a3{font-size:34px;font-weight:700;color:#ff6b6b;animation:fi .8s 1.8s both}
.a4{font-size:20px;animation:fi .8s 2.6s both}
@keyframes fi{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@keyframes sk{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
</style></head><body><div id="app"></div>
<script>
const RN={wolf:'人狼',seer:'占い師',villager:'市民',citizen:'市民',medium:'霊媒師',hunter:'騎士',mason:'恋人',madman:'多重人格',fox:'変身した吸血鬼',vampire:'吸血鬼',psychokiller:'サイコキラー',rich:'富豪',oracle:'神託者'};
const DESC={villager:'能力はありません。話し合いと推理で人狼を探します。',wolf:'夜に1人を襲撃します。仲間の人狼がわかります。',seer:'夜に1人を占い、人狼かどうかを知ります。変身した吸血鬼を占うと死なせます。',medium:'追放された人が人狼だったかを知ります。',hunter:'夜に1人を人狼の襲撃から守ります。自分は守れません。サイコキラーを守ると道連れで死にます。',mason:'もう1人の恋人が誰かわかります。',madman:'人狼チームの人間です。占っても人狼ではないと出ます。誰が人狼かはわかりません。',fox:'人狼に襲われても飛んで逃げて死にません。占い師に占われると死にます。最後まで生き残ると勝ちを奪います。',vampire:'市民チームでも人狼チームでもありません。ゲーム終了時に生き残っていると勝ちを奪います。',psychokiller:'人狼チームの人間です。夜に占い師や騎士の対象にされると、その人を道連れにします。',rich:'市民です。最後まで生き残って村人チームが勝つと、勝利ポイントが2倍になります。',oracle:'最初の夜に、ランダムな1人が人間かどうかを知ります。'};
const ASK={wolf:'襲う相手を選んでください',seer:'占う相手を選んでください',hunter:'守る相手を選んでください（自分は守れません）'};
let ws,uid,name='',err='',view='name',S=null,draft='';
try{uid=localStorage.getItem('uid');name=localStorage.getItem('name')||''}catch(e){}
if(!uid){uid='u'+Math.random().toString(36).slice(2,10);try{localStorage.setItem('uid',uid)}catch(e){}}
const $=s=>document.getElementById(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
  ws.onopen=()=>{err='';ws.send(JSON.stringify({t:'hello',uid}));render()};
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.t==='state'){S=m;S.at=Date.now();view='room';err=''}
    else if(m.t==='err')err=m.msg;
    else if(m.t==='left'&&view==='room'){S=null;view='menu'}
    render()};
  ws.onclose=()=>{err='接続が切れました。再接続中…';render();setTimeout(connect,2000)};
}
function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));else{err='接続中です。少し待ってください';render()}}
function enter(create){const pw=$('pw').value.trim();if(!pw){err='パスワードを入力してください';return render()}
  send({t:create?'create':'join',pw,name})}
function goMenu(){const v=$('nm').value.trim();if(!v)return;name=v;try{localStorage.setItem('name',name)}catch(e){}view='menu';err='';render()}
function aim(t){send({t:S.sub==='night'?'act':'vote',target:t})}
function sendChat(){const t=draft.trim();if(!t)return;send({t:'chat',text:t});draft='';const ci=$('ci');if(ci){ci.value='';ci.focus()}}
function targets(){
  return S.players.filter(p=>!p.dead&&p.uid!==S.me).map(p=>
    `<button class="t ${S.target===p.uid?'on':''}" onclick="aim('${p.uid}')">${esc(p.name)}${S.target===p.uid?'　✔':''}</button>`).join('');
}
setInterval(()=>{const e=$('tm');if(e&&S){const l=Math.max(0,S.left-(Date.now()-S.at));e.textContent=Math.floor(l/60000)+':'+String(Math.floor(l/1000)%60).padStart(2,'0')}},500);
function render(){
  const el=document.activeElement,f=el&&el.id==='ci',pos=f?el.selectionStart:0;
  draw();
  const ci=$('ci');if(ci&&f){ci.focus();try{ci.setSelectionRange(pos,pos)}catch(e){}}
  const cl=$('cl');if(cl)cl.scrollTop=cl.scrollHeight;
}
function draw(){
  const a=$('app');
  if(view==='name'){
    a.innerHTML=`<div style="text-align:center;padding:40px 0 20px"><div style="font-size:72px">🐺🌙</div>
    <h1 style="font-size:30px;margin:12px 0 4px">人狼・ワードウルフ</h1>
    <div class="mu">みんなで集まってオンラインで遊ぼう</div></div>
    <div class="card"><b>あなたの名前を入力してスタート</b>
    <input id="nm" value="${esc(name)}" maxlength="12" placeholder="名前を入力" onkeydown="if(event.key==='Enter')goMenu()">
    <div class="err">${esc(err)}</div><button onclick="goMenu()">スタート</button></div>`;return;
  }
  if(view==='menu'){
    a.innerHTML=`<h1>こんにちは、${esc(name)}さん</h1><div class="card">
    <b>部屋のパスワード</b><input id="pw" placeholder="パスワード" maxlength="30">
    <div class="err">${esc(err)}</div>
    <button onclick="enter(true)">部屋を作る（このパスワードで作成）</button>
    <button class="sub" onclick="enter(false)">部屋に入る（パスワードを入力）</button></div>
    <button class="sub" onclick="view='name';render()">名前を変更</button>`;return;
  }
  if(!S){a.innerHTML='<p>接続中…</p>';return}
  if(S.sub==='anim'&&S.anim){
    const an=S.anim,n=an.names,night=an.kind==='night';
    let o=`<div class="a1">${night?'🌅 夜が明けました':'⚖️ 投票の結果'}</div>`;
    o+=n.length?n.map(x=>`<div class="a2">💀</div><div class="a3">${esc(x)}</div><div class="a4">さん${night?'が殺されました':'が追放されました'}</div>`).join('')
      :`<div class="a4" style="animation-delay:1.2s">${night?'昨夜は誰も殺されませんでした':'同票で誰も追放されませんでした'}</div>`;
    a.innerHTML=`<div class="ov">${o}</div>`;return;
  }
  const me=S.players.find(p=>p.uid===S.me)||{},alive=!me.dead;
  const list=S.players.map(p=>`<li class="${p.dead&&S.phase==='play'?'dead':''}">${esc(p.name)}${p.isHost?' 👑':''}${p.uid===S.me?'（あなた）':''}</li>`).join('');
  let h=`<h1>部屋</h1><div class="card"><b>参加者 ${S.players.length}人</b><ul>${list}</ul></div>`;
  if(S.phase==='lobby'){
    const lo=S.mode==='wolf'?4:3,hi=S.mode==='wolf'?20:10,n=S.players.length,ok=n>=lo&&n<=hi;
    h+=S.host?`<div class="card"><b>ゲームを選ぶ</b><select onchange="send({t:'mode',mode:this.value})">
      <option value="word" ${S.mode==='word'?'selected':''}>ワードウルフ（3〜10人）</option>
      <option value="wolf" ${S.mode==='wolf'?'selected':''}>人狼（4〜20人）</option></select>
      <button onclick="send({t:'start'})" ${ok?'':'disabled style="opacity:.4"'}>ゲーム開始</button>
      ${ok?'':`<div class="mu">${n<lo?'あと'+(lo-n)+'人必要です':(n-hi)+'人多すぎます（'+hi+'人まで）'}</div>`}</div>`
      :`<div class="card">ホストがゲームを選んで開始するのを待っています。<br><span class="mu">選択中：${S.mode==='wolf'?'人狼（4〜20人）':'ワードウルフ（3〜10人）'}</span></div>`;
  }else{
    h+=`<div class="card"><span class="mu">あなたの役割</span>`;
    if(S.mode==='word')h+=`<div class="big">お題：${esc(S.word)}</div><div class="mu">みんなで話してウルフを探そう</div>`;
    else{
      h+=`<div class="big">${RN[S.role]||''}</div><div class="mu">${DESC[S.role]||''}</div>`;
      if(S.role==='wolf'||S.role==='mason')h+=`<div class="mu">${S.role==='wolf'?'仲間の人狼':'もう1人の恋人'}：${S.mates.map(esc).join('、')||'なし'}</div>`;
      if(S.priv.length)h+=`<ul>${S.priv.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
    }
    h+=`</div><div class="card"><b>経過</b><ul>${S.log.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></div>`;
    if(S.sub==='night'){
      h+=`<h2>🌙 第${S.round}夜</h2>`+(alive&&ASK[S.role]?`<div class="mu">${ASK[S.role]}</div>${targets()}`:'<div class="mu">夜が明けるのを待っています…</div>');
    }else if(S.sub==='day'||S.sub==='talk'){
      h+=`<h2>☀️ 話し合い</h2><div class="big" id="tm">2:00</div><div class="mu">時間になると自動で投票画面になります</div>`;
      if(S.host)h+=`<button class="sub" onclick="send({t:'tovote'})">今すぐ投票へ進む</button>`;
    }else if(S.sub==='vote'){
      h+=`<h2>🗳 投票</h2><div class="big">投票済み ${S.vote.done} / ${S.vote.total}人</div>`+(alive?`<div class="mu">怪しい人を選んでください（変更できます）</div>${targets()}`:'<div class="mu">脱落者は投票できません</div>');
    }else if(S.sub==='end'){
      h+=`<div class="card"><div class="big">${esc(S.result)}</div><ul>${S.players.map(p=>{const x=S.reveal[p.uid];return `<li>${esc(p.name)}：${x?RN[x.role]+(x.word?'（'+esc(x.word)+'）':''):'？'}</li>`}).join('')}</ul></div>`;
      if(S.host)h+=`<button onclick="send({t:'lobby'})">ロビーに戻る</button>`;
    }
  }
  const muted=S.phase==='play'&&(me.dead||(S.mode==='wolf'&&S.sub==='night'));
  h+=`<div class="card"><b>チャット</b><div id="cl" style="max-height:200px;overflow:auto;margin:6px 0">${(S.chat||[]).map(c=>`<div><span class="mu">${esc(c.name)}</span>　${esc(c.text)}</div>`).join('')||'<div class="mu">まだ発言はありません</div>'}</div>
  ${muted?'<div class="mu">今は発言できません</div>':`<input id="ci" value="${esc(draft)}" maxlength="200" placeholder="メッセージを入力" oninput="draft=this.value" onkeydown="if(event.key==='Enter')sendChat()"><button onclick="sendChat()">送信</button>`}</div>`;
  h+=`<div class="err">${esc(err)}</div><button class="sub" onclick="send({t:'leave'})">部屋から出る</button>`;
  a.innerHTML=h;
}
render();connect();
</script></body></html>

HTML*/
