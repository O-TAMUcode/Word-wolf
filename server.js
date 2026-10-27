const express = require('express'), http = require('http'), path = require('path');
const { WebSocketServer } = require('ws');
const app = express();
const fs = require('fs');
const SRC = fs.readFileSync(__filename, 'utf8'), MA = '/*' + 'HTML', MB = 'HTML' + '*/';
const PAGE = SRC.slice(SRC.indexOf(MA) + MA.length, SRC.lastIndexOf(MB));
app.get('/', (req, res) => res.type('html').send(PAGE));
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
    log: r.log, result: r.result, chat: r.chat,
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
      const nr = { pw, host: uid, players: new Map(), mode: 'word', phase: 'lobby', sub: '', round: 1, dead: new Set(), roles: {}, acts: {}, votes: {}, seerLog: {}, log: [], result: '', chat: [] };
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
  else if (m.t === 'chat') {
    const text = String(m.text || '').trim().slice(0, 200), p = r.players.get(uid);
    const muted = r.phase === 'play' && (r.dead.has(uid) || (r.mode === 'wolf' && r.sub === 'night'));
    if (text && p && !muted) { r.chat.push({ name: p.name, text }); if (r.chat.length > 100) r.chat.shift(); }
  }
  else if (m.t === 'start' && host && r.phase === 'lobby') {
    const ids = shuffle([...r.players.keys()]);
    if (ids.length < (r.mode === 'wolf' ? 4 : 3)) return;
    r.roles = {}; r.dead = new Set(); r.acts = {}; r.votes = {}; r.seerLog = {}; r.round = 1; r.result = ''; r.chat = []; r.log = ['ゲーム開始'];
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
</style></head><body><div id="app"></div>
<script>
const RN={wolf:'人狼',seer:'占い師',villager:'村人',citizen:'市民'};
let ws,uid,name='',err='',view='name',S=null,draft='';
try{uid=localStorage.getItem('uid');name=localStorage.getItem('name')||''}catch(e){}
if(!uid){uid='u'+Math.random().toString(36).slice(2,10);try{localStorage.setItem('uid',uid)}catch(e){}}
const $=s=>document.getElementById(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
  ws.onopen=()=>{err='';ws.send(JSON.stringify({t:'hello',uid}));render()};
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.t==='state'){S=m;view='room';err=''}
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
function targets(){
  return S.players.filter(p=>!p.dead&&p.uid!==S.me).map(p=>
    `<button class="t ${S.target===p.uid?'on':''}" onclick="aim('${p.uid}')">${esc(p.name)}${S.target===p.uid?'　✔':''}</button>`).join('');
}
function sendChat(){const t=draft.trim();if(!t)return;send({t:'chat',text:t});draft='';const ci=$('ci');if(ci){ci.value='';ci.focus()}}
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
  const me=S.players.find(p=>p.uid===S.me)||{},alive=!me.dead;
  const list=S.players.map(p=>`<li class="${p.dead&&S.phase==='play'?'dead':''}">${esc(p.name)}${p.isHost?' 👑':''}${p.uid===S.me?'（あなた）':''}</li>`).join('');
  let h=`<h1>部屋</h1><div class="card"><b>参加者 ${S.players.length}人</b><ul>${list}</ul></div>`;
  if(S.phase==='lobby'){
    const min=S.mode==='wolf'?4:3,ok=S.players.length>=min;
    h+=S.host?`<div class="card"><b>ゲームを選ぶ</b><select onchange="send({t:'mode',mode:this.value})">
      <option value="word" ${S.mode==='word'?'selected':''}>ワードウルフ（3人〜）</option>
      <option value="wolf" ${S.mode==='wolf'?'selected':''}>人狼（4人〜）</option></select>
      <button onclick="send({t:'start'})" ${ok?'':'disabled style="opacity:.4"'}>ゲーム開始</button>
      ${ok?'':`<div class="mu">あと${min-S.players.length}人必要です</div>`}</div>`
      :`<div class="card">ホストがゲームを選んで開始するのを待っています。<br><span class="mu">選択中：${S.mode==='wolf'?'人狼':'ワードウルフ'}</span></div>`;
  }else{
    h+=`<div class="card"><span class="mu">あなたの役割</span>`;
    if(S.mode==='word')h+=`<div class="big">お題：${esc(S.word)}</div><div class="mu">みんなで話してウルフを探そう</div>`;
    else{h+=`<div class="big">${RN[S.role]||''}</div>`;
      if(S.role==='wolf')h+=`<div class="mu">仲間：${S.mates.map(esc).join('、')||'なし'}</div>`;
      if(S.role==='seer'&&S.seer.length)h+=`<div class="mu">占い結果：</div><ul>${S.seer.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;}
    h+=`</div><div class="card"><b>経過</b><ul>${S.log.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></div>`;
    if(S.sub==='night'){
      h+=`<h2>🌙 第${S.round}夜</h2>`;
      if(alive&&S.role==='wolf')h+=`<div class="mu">襲う相手を選んでください</div>${targets()}`;
      else if(alive&&S.role==='seer')h+=`<div class="mu">占う相手を選んでください</div>${targets()}`;
      else h+=`<div class="mu">夜が明けるのを待っています…</div>`;
    }else if(S.sub==='day'||S.sub==='talk'){
      h+=`<h2>☀️ 話し合い</h2><div class="mu">みんなで話し合いましょう。</div>`;
      if(S.host)h+=`<button onclick="send({t:'tovote'})">投票を始める</button>`;
    }else if(S.sub==='vote'){
      h+=`<h2>🗳 投票</h2>`+(alive?`<div class="mu">怪しい人を選んでください（変更できます）</div>${targets()}`:'<div class="mu">脱落者は投票できません</div>');
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
