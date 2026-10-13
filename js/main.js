// 應用程式主控：首頁 / 大廳 / 遊戲畫面切換，以及房主（權威端）與客戶端的訊息處理。
import {
  createGame, applyAction, DEFAULT_OPTIONS, MAX_PLAYERS, geo, FACTIONS, viewFor, GameError, COLORS, RES, emptyHand,
  validSettlementVertices, validRoadEdges,
} from './engine.js';
import { HostNet, ClientNet, genCode, normalizeCode } from './net.js';
import { initUI, render, toast, esc } from './ui.js';

const HOST_SAVE = 'daxuanzhan-host';
const CLIENT_SESSION = 'daxuanzhan-client';

const $ = (sel) => document.querySelector(sel);

function myToken() {
  let t = sessionStorage.getItem('daxuanzhan-token');
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    sessionStorage.setItem('daxuanzhan-token', t);
  }
  return t;
}

const app = {
  role: null, // 'host' | 'client'
  code: null,
  name: '',
  net: null,
  options: { ...DEFAULT_OPTIONS }, // 房主：房間設定
  seats: [], // 房主：[{ name, token, conn, online }]
  game: null, // 房主：完整遊戲狀態
  view: null, // 自己看到的狀態（隱藏他人錦囊卡）
  me: null,
  lobby: null,
  online: [],
  mode: null,
  modal: null,
  modalData: {},
  chat: [],
  dispatch,
  copyInvite,
  autoplay,
  leave,
};

// ================================================================= 畫面

function showScreen(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== `screen-${id}`;
}

function setStatus(text) {
  for (const el of document.querySelectorAll('.status')) {
    el.textContent = text || '';
    el.hidden = !text;
  }
}

function inviteUrl() {
  return `${location.origin}${location.pathname}?room=${app.code}`;
}

function copyInvite() {
  const url = inviteUrl();
  const done = () => toast('已複製邀請連結', 'info');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(`請手動複製：${url}`, 'info'));
  } else {
    const inp = $('#invite-url');
    inp.select();
    document.execCommand('copy') ? done() : toast(`請手動複製：${url}`, 'info');
  }
}

function renderLobby() {
  showScreen('lobby');
  $('#lobby-code').textContent = app.code;
  $('#invite-url').value = inviteUrl();
  const players = app.lobby?.players || [];
  $('#lobby-players').innerHTML = Array.from({ length: MAX_PLAYERS }, (_, i) => {
    const p = players[i];
    if (!p) return '<li class="empty">等待玩家加入…</li>';
    return `<li style="--c:${COLORS[i]}"><span class="pdot"></span><b>${esc(p.name)}</b>
      ${i === 0 ? '<span class="tag">房主</span>' : ''}${i === app.me ? '<span class="tag you">你</span>' : ''}</li>`;
  }).join('');
  const host = app.role === 'host';
  const opts = app.lobby?.options || DEFAULT_OPTIONS;
  const sel = $('#opt-setup-roads');
  sel.value = String(opts.setupRoads);
  sel.disabled = !host;
  const ev = $('#opt-events');
  ev.checked = !!opts.events;
  ev.disabled = !host;
  const fo = $('#opt-factions');
  fo.checked = !!opts.factions;
  fo.disabled = !host;
  const n = Math.max(players.length, 2);
  $('#faction-list').hidden = !opts.factions;
  $('#faction-list').innerHTML = FACTIONS.slice(0, n).map((f, i) => `<li style="--c:${COLORS[i]}"><span class="ftag">${f.color}・${f.title}</span><span>${esc(f.skill)}</span></li>`).join('')
    + (opts.shuffleSeats ? '<li class="muted">開始時隨機分配順序，也就是隨機分配陣營</li>' : '');
  const ss = $('#opt-shuffle-seats');
  ss.checked = !!opts.shuffleSeats;
  ss.disabled = !host;
  const sb = $('#opt-special-build');
  sb.checked = !!opts.specialBuild;
  sb.disabled = !host;
  $('#lobby-map').textContent = players.length >= 5
    ? '🗺️ 5~6 人大地圖（30 個選區、2 個艱困選區、11 個人脈）'
    : '🗺️ 標準地圖（19 個選區）；5~6 人時自動改用大地圖';
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = players.length < 2;
  $('#lobby-note').textContent = host
    ? (players.length < 2 ? '至少需要 2 位玩家（建議 3~4 人）' : `${players.length} 位玩家已就緒，可以開始了！`)
    : '等待房主開始遊戲…';
}

let lastCurrent = null;
function onView() {
  const s = app.view;
  showScreen('game');
  if (s.phase !== 'ended' && s.current === app.me && lastCurrent !== app.me && lastCurrent !== null) {
    toast('輪到你了！', 'info');
  }
  lastCurrent = s.current;
  document.title = s.phase !== 'ended' && s.current === app.me ? '▶ 輪到你了 - 大選戰' : '大選戰 Online';
  if (s.phase === 'ended') localStorage.removeItem(HOST_SAVE);
  render();
}

// ================================================================= 房主

function hostStart(resume) {
  const name = readName();
  if (!name) return;
  app.role = 'host';
  if (resume) {
    app.code = resume.code;
    app.game = resume.game;
    app.seats = resume.seats.map((s, i) => ({ ...s, conn: null, online: i === 0 }));
    app.seats[0].token = myToken();
    app.chat = [];
  } else {
    app.code = genCode();
    app.game = null;
    app.seats = [{ name, token: myToken(), conn: null, online: true }];
  }
  showScreen('lobby');
  $('#lobby-code').textContent = app.code;
  openHostNet(!!resume, 0);
}

function openHostNet(resume, attempt) {
  setStatus(attempt ? `房間代碼仍被佔用，重試中（${attempt}）…` : '正在建立房間…');
  app.net?.destroy();
  app.net = new HostNet(app.code, {
    onReady: () => {
      setStatus('');
      hostBroadcast();
    },
    onData: hostOnData,
    onClose: hostOnClose,
    onError: (e) => {
      if (e.type === 'unavailable-id') {
        // 恢復舊房間時，舊連線可能還沒被配對伺服器釋放，稍等再試
        if (resume && attempt < 10) setTimeout(() => openHostNet(true, attempt + 1), 3000);
        else {
          if (resume) toast('原房間代碼無法使用，已改用新代碼，請重新分享邀請連結', 'info');
          app.code = genCode();
          openHostNet(false, 0);
        }
        return;
      }
      if (e.type === 'peer-unavailable') return;
      toast(e.text);
      if (e.type === 'lib' || e.type === 'browser-incompatible') setStatus(e.text);
    },
  });
  app.net.start();
}

// 大廳座位（房主固定是 0）與遊戲中玩家順序的對應
function pidOfSeat(si) {
  if (!app.game) return si;
  return app.game.players.findIndex((p, pi) => (p.seat ?? pi) === si);
}

function seatOfPid(pi) {
  return app.game.players[pi].seat ?? pi;
}

function seatOf(conn) {
  return app.seats.findIndex((s) => s.conn === conn);
}

function reject(conn, text) {
  app.net.send(conn, { t: 'kick', text });
  setTimeout(() => conn.close(), 800);
}

function hostOnData(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') {
    const name = cleanName(msg.name) || '玩家';
    const token = String(msg.token || '');
    let idx = app.seats.findIndex((s) => s.token === token);
    if (idx === 0) return reject(conn, '不能從同一個分頁加入自己的房間，請開新視窗');
    if (idx < 0) {
      if (app.game) return reject(conn, '遊戲已經開始，無法加入新玩家');
      if (app.seats.length >= MAX_PLAYERS) return reject(conn, `房間已滿（最多 ${MAX_PLAYERS} 人）`);
      app.seats.push({ name, token, conn, online: true });
      idx = app.seats.length - 1;
    } else {
      const seat = app.seats[idx];
      if (seat.conn && seat.conn !== conn) seat.conn.close();
      seat.conn = conn;
      seat.online = true;
      if (!app.game) seat.name = name;
      else hostChat(null, `${app.seats[idx].name} 重新連線`);
    }
    hostBroadcast();
    return;
  }
  const idx = seatOf(conn);
  if (idx < 0) return;
  if (msg.t === 'action') {
    if (!app.game) return;
    try {
      applyAction(app.game, pidOfSeat(idx), msg.action);
    } catch (err) {
      app.net.send(conn, { t: 'error', text: err instanceof GameError ? err.message : '發生錯誤' });
      if (!(err instanceof GameError)) console.error(err);
      return;
    }
    hostBroadcast();
  } else if (msg.t === 'chat') {
    hostChat(idx, msg.text);
  }
}

function hostOnClose(conn) {
  const idx = seatOf(conn);
  if (idx < 0) return;
  if (!app.game) {
    app.seats.splice(idx, 1);
  } else {
    app.seats[idx].conn = null;
    app.seats[idx].online = false;
    hostChat(null, `${app.seats[idx].name} 已離線`);
  }
  hostBroadcast();
}

function hostChat(idx, text) {
  text = String(text || '').trim().slice(0, 200);
  if (!text) return;
  const msg = {
    t: 'chat',
    n: app.game ? app.game.seq - 0.5 : -1,
    from: idx == null ? '系統' : app.seats[idx].name,
    color: idx == null ? '#888' : app.game ? app.game.players[pidOfSeat(idx)].color : COLORS[idx],
    text,
  };
  app.seats.forEach((seat, i) => i > 0 && app.net.send(seat.conn, msg));
  addChat(msg);
}

function hostBroadcast() {
  if (app.game) {
    app.online = app.game.players.map((_, pi) => app.seats[seatOfPid(pi)].online);
    app.me = pidOfSeat(0);
    app.seats.forEach((seat, i) => {
      const pid = pidOfSeat(i);
      if (i > 0) app.net.send(seat.conn, { t: 'state', view: viewFor(app.game, pid), you: pid, online: app.online, code: app.code });
    });
    try {
      localStorage.setItem(HOST_SAVE, JSON.stringify({
        code: app.code,
        seats: app.seats.map((s) => ({ name: s.name, token: s.token })),
        game: app.game,
        savedAt: Date.now(),
      }));
    } catch { /* 儲存失敗不影響遊戲 */ }
    app.view = viewFor(app.game, app.me);
    onView();
  } else {
    app.online = app.seats.map((s) => s.online);
    app.me = 0;
    app.lobby = { players: app.seats.map((s) => ({ name: s.name })), options: app.options };
    app.seats.forEach((seat, i) => {
      if (i > 0) app.net.send(seat.conn, { t: 'lobby', lobby: app.lobby, you: i, code: app.code });
    });
    renderLobby();
  }
}

function hostStartGame() {
  if (app.seats.length < 2) return;
  app.game = createGame(app.seats.map((s) => ({ name: s.name })), app.options);
  app.chat = [];
  hostBroadcast();
}

// 替離線玩家自動完成卡住的步驟
function autoplay() {
  const s = app.game;
  if (!s) return;
  const off = (pi) => seatOfPid(pi) !== 0 && !app.seats[seatOfPid(pi)].online;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  try {
    for (let step = 0; step < 40 && s.phase !== 'ended'; step++) {
      const p = s.pending;
      if (p?.type === 'discard') {
        const offs = Object.keys(p.need).map(Number).filter(off);
        if (!offs.length) break;
        for (const pid of offs) {
          const h = { ...s.players[pid].resources };
          const d = emptyHand();
          for (let k = 0; k < p.need[pid]; k++) {
            const r = pick(RES.filter((x) => h[x] > 0 && !(x === 'ore' && s.players[pid].faction === 'blue')));
            h[r]--;
            d[r]++;
          }
          applyAction(s, pid, { type: 'discard', resources: d });
        }
        continue;
      }
      if (p?.type === 'specialBuild') {
        if (!off(p.queue[0])) break;
        applyAction(s, p.queue[0], { type: 'passBuild' });
        continue;
      }
      const cur = s.current;
      if (!off(cur)) break;
      if (s.phase === 'setup') {
        if (s.setup.stage === 'settlement') applyAction(s, cur, { type: 'build', kind: 'settlement', at: pick(validSettlementVertices(s, cur)) });
        else applyAction(s, cur, { type: 'build', kind: 'road', at: pick(validRoadEdges(s, cur)) });
      } else if (p?.type === 'robber') {
        applyAction(s, cur, { type: 'moveRobber', hex: pick(geo(s).hexes.map((h) => h.id).filter((h) => h !== s.board.robber)) });
      } else if (p?.type === 'steal') {
        const target = pick(p.candidates);
        const resource = pick(RES.filter((r) => s.players[target].resources[r] > 0));
        applyAction(s, cur, { type: 'steal', target, resource });
      } else if (p?.type === 'roadBuilding') {
        applyAction(s, cur, { type: 'skipRoadBuilding' });
      } else if (!s.rolled) {
        applyAction(s, cur, { type: 'roll' });
      } else {
        applyAction(s, cur, { type: 'endTurn' });
        break;
      }
    }
  } catch (err) {
    toast(err.message);
  }
  hostBroadcast();
}

// ================================================================= 客戶端

function clientJoin(code) {
  const name = readName();
  if (!name) return;
  code = normalizeCode(code);
  if (code.length < 4) {
    toast('請輸入正確的房間代碼');
    return;
  }
  app.role = 'client';
  app.code = code;
  sessionStorage.setItem(CLIENT_SESSION, JSON.stringify({ code, name }));
  history.replaceState(null, '', `?room=${code}`);
  app.lobby = null;
  renderLobby();
  $('#conn-banner').hidden = true;
  setStatus('正在連線到房間…');
  app.net?.destroy();
  app.net = new ClientNet(code, {
    onOpen: () => {
      setStatus('');
      app.net.send({ t: 'hello', name, token: myToken() });
    },
    onData: clientOnData,
    onClose: () => {
      if (app.kicked) return;
      toast('與房主的連線中斷');
      $('#conn-banner').hidden = false;
    },
    onError: (e) => {
      toast(e.text);
      if (!app.view && !app.lobby) {
        setStatus('');
        showScreen('home');
      } else {
        $('#conn-banner').hidden = false;
      }
    },
  });
  app.net.start();
}

function clientOnData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'lobby':
      app.lobby = msg.lobby;
      app.me = msg.you;
      renderLobby();
      break;
    case 'state':
      app.view = msg.view;
      app.me = msg.you;
      app.online = msg.online || [];
      $('#conn-banner').hidden = true;
      onView();
      break;
    case 'error':
      toast(msg.text);
      break;
    case 'chat':
      addChat(msg);
      break;
    case 'kick':
      app.kicked = true;
      toast(msg.text);
      sessionStorage.removeItem(CLIENT_SESSION);
      setTimeout(leave, 1500);
      break;
    default:
  }
}

// ================================================================= 共用

function dispatch(action) {
  if (app.role === 'host') {
    if (!app.game) return;
    try {
      applyAction(app.game, pidOfSeat(0), action);
    } catch (err) {
      toast(err instanceof GameError ? err.message : '發生錯誤');
      if (!(err instanceof GameError)) console.error(err);
      render();
      return;
    }
    hostBroadcast();
  } else {
    app.net?.send({ t: 'action', action });
    render();
  }
}

function addChat(msg) {
  app.chat.push(msg);
  if (app.chat.length > 100) app.chat.shift();
  if (app.view) render();
}

function sendChat(text) {
  text = text.trim();
  if (!text) return;
  if (app.role === 'host') hostChat(0, text);
  else app.net?.send({ t: 'chat', text });
}

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function readName() {
  const name = cleanName($('#name').value);
  if (!name) {
    toast('請先輸入你的名字');
    $('#name').focus();
    return null;
  }
  localStorage.setItem('daxuanzhan-name', name);
  app.name = name;
  return name;
}

function leave() {
  app.net?.destroy();
  sessionStorage.removeItem(CLIENT_SESSION);
  location.href = location.pathname;
}

// ================================================================= 初始化

function initHome() {
  $('#name').value = localStorage.getItem('daxuanzhan-name') || '';
  const params = new URLSearchParams(location.search);
  const room = normalizeCode(params.get('room'));
  if (room) {
    $('#join-code').value = room;
    $('#home-invite').hidden = false;
    $('#home-invite-code').textContent = room;
  }

  let save = null;
  try { save = JSON.parse(localStorage.getItem(HOST_SAVE)); } catch { /* 忽略 */ }
  if (save?.game && save.game.phase !== 'ended') {
    $('#resume').hidden = false;
    $('#resume-info').textContent = `房間 ${save.code}・${save.seats.map((s) => s.name).join('、')}・${new Date(save.savedAt).toLocaleString()}`;
  }

  $('#btn-create').addEventListener('click', () => hostStart(null));
  $('#btn-join').addEventListener('click', () => clientJoin($('#join-code').value));
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') clientJoin($('#join-code').value); });
  $('#name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (room ? clientJoin($('#join-code').value) : hostStart(null));
  });
  $('#btn-resume').addEventListener('click', () => hostStart(save));
  $('#btn-discard-save').addEventListener('click', () => {
    localStorage.removeItem(HOST_SAVE);
    $('#resume').hidden = true;
  });
  $('#btn-start').addEventListener('click', hostStartGame);
  $('#opt-setup-roads').addEventListener('change', (e) => {
    if (app.role !== 'host' || app.game) return;
    app.options.setupRoads = Number(e.target.value);
    hostBroadcast();
  });
  $('#opt-events').addEventListener('change', (e) => {
    if (app.role !== 'host' || app.game) return;
    app.options.events = e.target.checked;
    hostBroadcast();
  });
  $('#opt-factions').addEventListener('change', (e) => {
    if (app.role !== 'host' || app.game) return;
    app.options.factions = e.target.checked;
    hostBroadcast();
  });
  $('#opt-shuffle-seats').addEventListener('change', (e) => {
    if (app.role !== 'host' || app.game) return;
    app.options.shuffleSeats = e.target.checked;
    hostBroadcast();
  });
  $('#opt-special-build').addEventListener('change', (e) => {
    if (app.role !== 'host' || app.game) return;
    app.options.specialBuild = e.target.checked;
    hostBroadcast();
  });
  $('#btn-leave').addEventListener('click', leave);
  $('#btn-reconnect').addEventListener('click', () => clientJoin(app.code));
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('#chat-input').value);
    $('#chat-input').value = '';
  });
  window.addEventListener('beforeunload', (e) => {
    if (app.role === 'host' && app.seats.length > 1 && app.game?.phase !== 'ended') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 重新整理後自動回到原本的房間
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(CLIENT_SESSION)); } catch { /* 忽略 */ }
  if (session && session.code === room && session.name) {
    $('#name').value = session.name;
    clientJoin(room);
  } else {
    showScreen('home');
    (room ? $('#name').value ? $('#join-code') : $('#name') : $('#name')).focus();
  }
}

initUI(app);
initHome();
