// 畫面渲染與互動。所有遊戲動作都透過 app.dispatch(action) 送出，由房主的規則引擎裁決。
import {
  RES, RES_NAME, RES_ICON, DEV_NAME, DEV_DESC, COST, WIN_VP,
  canAfford, emptyHand, handTotal, victoryPoints, tradeRatios, playableDev, robberNearOwn,
  validRoadEdges, validSettlementVertices, validCityVertices, geo,
} from './engine.js';

const S = 100; // 1 單位 = 100 SVG 像素
const TILE_COLOR = {
  wood: '#2f7d32', brick: '#c0582f', sheep: '#9ccc65', wheat: '#f2c94c', ore: '#8d939c', desert: '#dcc79a',
};
const DICE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const $ = (sel) => document.querySelector(sel);
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let app;

// ================================================================= 互動目標

function targets() {
  const s = app.view;
  const me = app.me;
  if (!s || s.phase === 'ended') return {};
  if (s.pending?.type === 'specialBuild') return s.pending.queue[0] === me ? modeTargets(s, me) : {};
  if (s.current !== me) return {};
  if (s.phase === 'setup') {
    return s.setup.stage === 'settlement'
      ? { vertices: validSettlementVertices(s, me), kind: 'settlement' }
      : { edges: validRoadEdges(s, me), kind: 'road' };
  }
  const p = s.pending;
  if (p?.type === 'robber') return { hexes: geo(s).hexes.map((h) => h.id).filter((h) => h !== s.board.robber) };
  if (p?.type === 'roadBuilding') return { edges: validRoadEdges(s, me), kind: 'road' };
  if (p || !s.rolled) return {};
  return modeTargets(s, me);
}

function modeTargets(s, me) {
  if (app.mode === 'road') return { edges: validRoadEdges(s, me), kind: 'road' };
  if (app.mode === 'settlement') return { vertices: validSettlementVertices(s, me), kind: 'settlement' };
  if (app.mode === 'city') return { vertices: validCityVertices(s, me), kind: 'city' };
  return {};
}

// ================================================================= 棋盤

const pt = (x, y) => `${(x * S).toFixed(1)},${(y * S).toFixed(1)}`;

function hexPoints(h, scale = 1) {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return pt(h.x + Math.cos(a) * scale, h.y + Math.sin(a) * scale);
  }).join(' ');
}

function pips(n) {
  return 6 - Math.abs(7 - n);
}

function boardSVG(s, t) {
  const out = [];
  out.push('<rect x="-5000" y="-5000" width="10000" height="10000" class="sea"/>'); // 海洋填滿整個棋盤區

  // 人脈
  for (const port of s.board.ports) {
    const e = geo(s).edges[port.edge];
    const [a, b] = e.v.map((v) => geo(s).vertices[v]);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const h = geo(s).hexes[e.hexes[0]];
    const dx = mx - h.x;
    const dy = my - h.y;
    const len = Math.hypot(dx, dy);
    const px = mx + (dx / len) * 0.6;
    const py = my + (dy / len) * 0.6;
    out.push(`<line x1="${a.x * S}" y1="${a.y * S}" x2="${px * S}" y2="${py * S}" class="pier"/>`);
    out.push(`<line x1="${b.x * S}" y1="${b.y * S}" x2="${px * S}" y2="${py * S}" class="pier"/>`);
    const label = port.type === 'any' ? '3:1' : '2:1';
    const icon = port.type === 'any' ? '❓' : RES_ICON[port.type];
    const title = port.type === 'any' ? '3:1 人脈：任意資源 3 換 1' : `2:1 人脈：${RES_NAME[port.type]} 2 換 1`;
    out.push(`<g class="port"><title>${title}</title><circle cx="${px * S}" cy="${py * S}" r="34"/>
      <text x="${px * S}" y="${py * S - 7}" class="port-icon">${icon}</text>
      <text x="${px * S}" y="${py * S + 21}" class="port-ratio">${label}</text></g>`);
  }

  // 選區
  const sum = s.dice ? s.dice[0] + s.dice[1] : 0;
  s.board.hexes.forEach((tile, i) => {
    const h = geo(s).hexes[i];
    const hot = sum && sum !== 7 && tile.number === sum;
    out.push(`<polygon points="${hexPoints(h)}" fill="${TILE_COLOR[tile.resource]}" class="tile${hot ? ' hot' : ''}"><title>${tile.resource === 'desert' ? '艱困選區' : RES_NAME[tile.resource]}</title></polygon>`);
    out.push(`<polygon points="${hexPoints(h, 0.82)}" class="tile-inner"/>`);
    const cx = h.x * S;
    const cy = h.y * S;
    if (tile.number) {
      out.push(`<text x="${cx}" y="${cy - 34}" class="tile-icon">${RES_ICON[tile.resource]}</text>`);
      const red = tile.number === 6 || tile.number === 8;
      const ty = cy + 32; // 數字牌放在圖示下方
      out.push(`<circle cx="${cx}" cy="${ty}" r="28" class="token"/>`);
      out.push(`<text x="${cx}" y="${ty - 3}" class="token-num${red ? ' red' : ''}">${tile.number}</text>`);
      const n = pips(tile.number);
      for (let k = 0; k < n; k++) {
        out.push(`<circle cx="${cx + (k - (n - 1) / 2) * 7}" cy="${ty + 15}" r="2.6" class="pip${red ? ' red' : ''}"/>`);
      }
    } else {
      out.push(`<text x="${cx}" y="${cy}" class="tile-icon big">${RES_ICON.desert}</text>`);
    }
  });

  // 黑函
  {
    const h = geo(s).hexes[s.board.robber];
    const x = h.x * S - (s.board.hexes[s.board.robber].number ? 50 : 0);
    const y = h.y * S + 8;
    out.push(`<g class="robber"><title>黑函</title><ellipse cx="${x}" cy="${y + 10}" rx="15" ry="20"/><circle cx="${x}" cy="${y - 16}" r="11"/></g>`);
  }

  // 掃街路線
  for (const [eid, owner] of Object.entries(s.roads)) {
    const [a, b] = geo(s).edges[eid].v.map((v) => geo(s).vertices[v]);
    const k = 0.14;
    const x1 = a.x + (b.x - a.x) * k; const y1 = a.y + (b.y - a.y) * k;
    const x2 = b.x + (a.x - b.x) * k; const y2 = b.y + (a.y - b.y) * k;
    out.push(`<line x1="${x1 * S}" y1="${y1 * S}" x2="${x2 * S}" y2="${y2 * S}" class="road-outline"/>`);
    out.push(`<line x1="${x1 * S}" y1="${y1 * S}" x2="${x2 * S}" y2="${y2 * S}" class="road" stroke="${s.players[owner].color}"/>`);
  }

  // 建築
  for (const [vid, b] of Object.entries(s.buildings)) {
    const v = geo(s).vertices[vid];
    const color = s.players[b.owner].color;
    const shape = b.type === 'city'
      ? '-31,20 31,20 31,-6 6,-6 6,-20 -13,-38 -31,-20'
      : '-21,15 21,15 21,-8 0,-27 -21,-8';
    out.push(`<polygon points="${shape}" transform="translate(${v.x * S},${v.y * S})" class="building" fill="${color}"/>`);
  }

  // 可點選目標
  for (const hid of t.hexes || []) {
    out.push(`<polygon points="${hexPoints(geo(s).hexes[hid], 0.9)}" class="spot-hex" data-hex="${hid}"/>`);
  }
  for (const eid of t.edges || []) {
    const [a, b] = geo(s).edges[eid].v.map((v) => geo(s).vertices[v]);
    // 與服務處放置點相同風格：白色掃街路線加紅色外框
    const k = 0.18;
    const seg = `x1="${(a.x + (b.x - a.x) * k) * S}" y1="${(a.y + (b.y - a.y) * k) * S}" x2="${(b.x + (a.x - b.x) * k) * S}" y2="${(b.y + (a.y - b.y) * k) * S}"`;
    out.push(`<g class="spot-edge" data-edge="${eid}"><line x1="${a.x * S}" y1="${a.y * S}" x2="${b.x * S}" y2="${b.y * S}" class="hit"/><line ${seg} class="vis-outline"/><line ${seg} class="vis"/></g>`);
  }
  for (const vid of t.vertices || []) {
    const v = geo(s).vertices[vid];
    out.push(`<circle cx="${v.x * S}" cy="${v.y * S}" r="16" class="spot" data-vertex="${vid}"/>`);
  }
  return out.join('');
}

function onBoardClick(ev) {
  const s = app.view;
  if (!s) return;
  const t = targets();
  const vEl = ev.target.closest('[data-vertex]');
  const eEl = ev.target.closest('[data-edge]');
  const hEl = ev.target.closest('[data-hex]');
  if (vEl) {
    app.mode = null;
    app.dispatch({ type: 'build', kind: t.kind, at: Number(vEl.dataset.vertex) });
  } else if (eEl) {
    if (app.mode === 'road') app.mode = null;
    app.dispatch({ type: 'build', kind: 'road', at: Number(eEl.dataset.edge) });
  } else if (hEl) {
    app.dispatch({ type: 'moveRobber', hex: Number(hEl.dataset.hex) });
  }
}

// ================================================================= 側邊欄

function nameOf(i) {
  const p = app.view.players[i];
  return `<span class="pname" style="--c:${p.color}">${esc(p.name)}</span>`;
}

function hintText(s, t) {
  const me = app.me;
  const cur = s.current;
  const mine = cur === me;
  if (s.phase === 'ended') return `🏆 ${nameOf(s.winner)} 獲勝！`;
  if (s.phase === 'setup') {
    const round = s.setup.idx < s.players.length ? 1 : 2;
    if (!mine) return `等待 ${nameOf(cur)} 放置起始${s.setup.stage === 'settlement' ? '服務處' : '掃街路線'}…（第 ${round} 輪）`;
    const total = s.options?.setupRoads ?? 1;
    const placed = s.setup.roads?.length || 0;
    return s.setup.stage === 'settlement'
      ? `第 ${round} 輪：點選亮起的路口放置服務處${round === 2 ? '（會立即獲得周圍選區的資源）' : ''}`
      : total > 1
        ? `點選與剛放置的服務處或掃街路線相連的邊放置掃街路線（第 ${placed + 1}/${total} 條）`
        : '點選與剛放置服務處相連的邊放置掃街路線';
  }
  const p = s.pending;
  if (p?.type === 'specialBuild') {
    const b = p.queue[0];
    return b === me
      ? '🔨 特別建設階段：你可以建造或購買錦囊卡（不能交易），完成後按「結束建設」'
      : `🔨 特別建設階段：等待 ${nameOf(b)} 建設…`;
  }
  if (p?.type === 'discard') {
    if (p.need[me]) return `擲出 7！你的手牌超過 7 張，請棄掉 ${p.need[me]} 張`;
    return `等待玩家棄牌：${Object.keys(p.need).map((i) => nameOf(+i)).join('、')}`;
  }
  if (p?.type === 'robber') return mine ? '🕵️ 點選一個選區放置黑函' : `等待 ${nameOf(cur)} 移動黑函…`;
  if (p?.type === 'steal') return mine ? '選擇要挖角的玩家與資源' : `等待 ${nameOf(cur)} 選擇挖角對象…`;
  if (p?.type === 'roadBuilding') return mine ? `📢 掃街拜票：點選位置建造掃街路線（剩 ${p.remaining} 條）` : `${nameOf(cur)} 正在使用掃街拜票…`;
  if (!mine) return `等待 ${nameOf(cur)} 的回合…`;
  if (!s.rolled) return '🎲 你的回合！擲骰子開始（也可以先使用樁腳卡）';
  if (app.mode) {
    const n = { road: '掃街路線', settlement: '服務處', city: '競選總部' }[app.mode];
    if (!(t.edges?.length || t.vertices?.length)) return `目前沒有可以建造${n}的位置`;
    return `點選亮起的位置建造${n}（再按一次按鈕取消）`;
  }
  return s.built
    ? '🔨 建設階段：可以繼續建造或使用錦囊卡（本回合已不能交易），完成後按「結束回合」'
    : '🤝 交易階段：先完成交易，再建造（一旦建造或購買錦囊卡就不能再交易）';
}

function renderTopbar(s) {
  const turnInfo = s.phase === 'setup' ? '準備階段' : s.phase === 'ended' ? '遊戲結束' : `第 ${Math.ceil(s.turn / s.players.length)} 輪`;
  const dice = s.dice ? `<span class="dice" title="${s.dice[0] + s.dice[1]}">${DICE[s.dice[0]]}${DICE[s.dice[1]]}</span><b class="dice-sum">${s.dice[0] + s.dice[1]}</b>` : '';
  $('#topbar').innerHTML = `
    <div class="brand">🗳️ 大選戰</div>
    <div class="room">房間 <b>${esc(app.code)}</b> <button class="link" data-act="copyInvite">複製邀請連結</button></div>
    <div class="turninfo">${turnInfo} · 先拿到 ${WIN_VP} 票當選</div>
    <div class="dicebox">${dice}</div>
    <div class="bankinfo" title="公庫剩餘資源 / 錦囊卡">${RES.map((r) => `<span>${RES_ICON[r]}${s.bank[r]}</span>`).join('')}<span>📜${s.deckCount}</span></div>`;
}

function renderPlayers(s) {
  const html = s.players.map((p, i) => {
    const vp = victoryPoints(s, i, i === app.me || s.phase === 'ended');
    const online = app.online[i] !== false;
    const badges = [
      s.longestRoad === i ? '<span class="badge" title="最長掃街路線 +2 票">🚶 最長掃街路線</span>' : '',
      s.largestArmy === i ? '<span class="badge" title="最強樁腳網 +2 票">👥 最強樁腳網</span>' : '',
    ].join('');
    const builder = s.pending?.type === 'specialBuild' && s.pending.queue[0] === i;
    return `<div class="player${s.current === i && s.phase !== 'ended' ? ' current' : ''}${builder ? ' builder' : ''}" style="--c:${p.color}">
      <div class="prow">
        <span class="pdot"></span>
        <b class="pn">${esc(p.name)}${i === app.me ? '（你）' : ''}${builder ? ' 🔨' : ''}</b>
        ${online ? '' : '<span class="offline" title="離線中">離線</span>'}
        <span class="vp" title="得票${i === app.me ? '（含隱藏的民調領先卡）' : ''}">🗳️ ${vp}</span>
      </div>
      <div class="pres">${RES.map((r) => `<span class="${p.resources[r] ? '' : 'zero'}" title="${RES_NAME[r]}">${RES_ICON[r]}${p.resources[r]}</span>`).join('')}</div>
      <div class="pstats">
        <span title="資源卡">🃏 ${p.handCount}</span>
        <span title="錦囊卡">📜 ${p.devCount}</span>
        <span title="已使用樁腳">👥 ${p.knights}</span>
        <span title="最長掃街路線長度">🚶 ${p.roadLen}</span>
        <span title="剩餘棋子：掃街路線/服務處/競選總部" class="pieces">🧩 ${p.pieces.road}/${p.pieces.settlement}/${p.pieces.city}</span>
      </div>
      ${badges ? `<div class="badges">${badges}</div>` : ''}
    </div>`;
  }).join('');
  $('#players').innerHTML = html;
}

function renderHand(s) {
  const P = s.players[app.me];
  if (!P?.resources) { $('#hand').innerHTML = ''; return; }
  const cards = RES.map((r) => `<div class="rcard ${r}${P.resources[r] ? '' : ' zero'}" title="${RES_NAME[r]}">
      <span class="ricon">${RES_ICON[r]}</span><span class="rcount">${P.resources[r]}</span><span class="rname">${RES_NAME[r]}</span></div>`).join('');

  const mine = s.current === app.me && s.phase === 'play';
  const playable = playableDev(s, app.me);
  const groups = {};
  for (const c of P.dev) groups[c.type] = (groups[c.type] || 0) + 1;
  const devHtml = Object.keys(groups).length
    ? Object.entries(groups).map(([type, n]) => {
      const fresh = type !== 'vp' && !playable.includes(type);
      const blocked = type === 'knight' && !fresh && !robberNearOwn(s, app.me);
      const can = mine && type !== 'vp' && !s.devPlayed && !s.pending && playable.includes(type) && !blocked;
      return `<div class="dcard" title="${DEV_DESC[type]}">
        <div><b>${DEV_NAME[type]}</b> ×${n}</div>
        <div class="ddesc">${DEV_DESC[type]}</div>
        ${type === 'vp' ? '' : `<button data-act="playDev" data-card="${type}" ${can ? '' : 'disabled'}>${fresh ? '下回合可用' : blocked ? '黑函不在旁邊' : '使用'}</button>`}
      </div>`;
    }).join('')
    : '<div class="muted">尚無錦囊卡</div>';

  $('#hand').innerHTML = `<h3>你的手牌 <small>${handTotal(P.resources)} 張</small></h3><div class="rcards">${cards}</div>
    <h3>錦囊卡${s.devPlayed && mine ? ' <small>（本回合已使用）</small>' : ''}</h3><div class="dcards">${devHtml}</div>`;
}

function costHtml(cost) {
  return RES.filter((r) => cost[r]).map((r) => `${RES_ICON[r]}${cost[r] > 1 ? `×${cost[r]}` : ''}`).join('');
}

function buildButtons(s, me, busy) {
  const P = s.players[me];
  const btn = (kind, label, cost, spots) => {
    const ok = !busy && canAfford(P.resources, cost) && spots > 0;
    return `<button data-act="mode" data-kind="${kind}" class="${app.mode === kind ? 'active' : ''}" ${ok ? '' : 'disabled'}>${label}<span class="cost">${costHtml(cost)}</span></button>`;
  };
  const canDev = !busy && canAfford(P.resources, COST.dev) && s.deckCount > 0;
  return `<div class="btngrid">
    ${btn('road', '🚶 掃街路線', COST.road, validRoadEdges(s, me).length)}
    ${btn('settlement', '🏢 服務處', COST.settlement, validSettlementVertices(s, me).length)}
    ${btn('city', '🏛️ 競選總部', COST.city, validCityVertices(s, me).length)}
    <button data-act="buyDev" ${canDev ? '' : 'disabled'}>📜 錦囊卡<span class="cost">${costHtml(COST.dev)}</span></button>
  </div>`;
}

function renderActions(s) {
  const me = app.me;
  const el = $('#actions');
  const mine = s.current === me;
  if (s.pending?.type === 'specialBuild' && s.pending.queue[0] === me) {
    el.innerHTML = `<h3>🔨 特別建設階段</h3>${buildButtons(s, me, false)}
      <div class="btnrow"><button class="primary" data-act="passBuild">結束建設 ➜</button></div>${hostAssist(s)}`;
    return;
  }
  if (s.phase !== 'play' || !mine) {
    el.innerHTML = app.role === 'host' ? hostAssist(s) : '';
    return;
  }
  const out = [];
  if (s.pending?.type === 'roadBuilding') {
    out.push('<button data-act="skipRoadBuilding">放棄剩餘掃街路線</button>');
  } else if (!s.rolled) {
    out.push(`<button class="primary big" data-act="roll" ${s.pending ? 'disabled' : ''}>🎲 擲骰子</button>`);
  } else {
    const busy = !!s.pending;
    out.push(buildButtons(s, me, busy));
    out.push(`<div class="phase">${s.built ? '🔨 建設階段 <small>（本回合已不能交易）</small>' : '🤝 交易階段 <small>→ 建造後進入建設階段</small>'}</div>`);
    out.push(`<div class="btnrow"><button data-act="openTrade" ${busy || s.built ? 'disabled' : ''} title="${s.built ? '已建造，本回合不能再交易' : ''}">🤝 交易</button>
      <button class="primary" data-act="endTurn" ${busy ? 'disabled' : ''}>結束回合 ➜</button></div>`);
  }
  el.innerHTML = out.join('') + hostAssist(s);
}

// 房主可以替離線玩家完成卡住遊戲的步驟
function hostAssist(s) {
  if (app.role !== 'host' || s.phase === 'ended') return '';
  const blocking = new Set();
  if (s.pending?.type === 'discard') Object.keys(s.pending.need).forEach((i) => blocking.add(+i));
  else if (s.pending?.type === 'specialBuild') blocking.add(s.pending.queue[0]);
  else blocking.add(s.current);
  const offline = [...blocking].filter((i) => i !== app.me && app.online[i] === false);
  if (!offline.length) return '';
  return `<div class="assist">${offline.map((i) => nameOf(i)).join('、')} 已離線。
    <button data-act="autoplay">代為行動（自動完成目前步驟）</button></div>`;
}

function renderTrade(s) {
  const el = $('#trade');
  const t = s.trade;
  if (!t || s.phase !== 'play') { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const me = app.me;
  const from = s.current;
  const head = `<h3>🤝 交易提案</h3><div class="offer">${nameOf(from)} 給出 <b>${fmt(t.give)}</b><br>想換取 <b>${fmt(t.want)}</b></div>`;
  if (me === from) {
    const rows = s.players.map((p, i) => {
      if (i === me) return '';
      const r = t.responses[i];
      const st = r === true
        ? `<button class="primary small" data-act="tradeAccept" data-with="${i}">與他成交</button>`
        : r === false ? '<span class="muted">拒絕</span>' : '<span class="muted">考慮中…</span>';
      return `<div class="resp">${nameOf(i)} ${st}</div>`;
    }).join('');
    el.innerHTML = `${head}${rows}<button class="small" data-act="tradeCancel">取消提案</button>`;
  } else {
    const r = t.responses[me];
    const P = s.players[me];
    const can = P.resources && canAfford(P.resources, t.want);
    const btns = `<button class="primary small" data-act="tradeRespond" data-accept="1" ${can ? '' : 'disabled title="資源不足"'}>接受</button>
      <button class="small" data-act="tradeRespond" data-accept="0">拒絕</button>`;
    const status = r === true ? '<div class="muted">你已表示接受，等待對方確認…</div>' : r === false ? '<div class="muted">你已拒絕</div>' : '';
    el.innerHTML = `${head}<div class="offer-note">對你來說：付出 ${fmt(t.want)}，得到 ${fmt(t.give)}</div>${status}<div class="btnrow">${btns}</div>`;
  }
}

function fmt(h) {
  return RES.filter((r) => h[r]).map((r) => `${RES_ICON[r]}×${h[r]}`).join(' ') || '（無）';
}

// 紀錄與聊天：只有內容變動時才重畫，並自動捲到最新一則
let lastLogHtml = '';
function renderLog(s) {
  const el = $('#log');
  const entries = s.log.map((l) => ({ k: l.n, html: `<div class="logline">${esc(l.text)}</div>` }));
  const chats = app.chat.map((c) => ({ k: c.n, html: `<div class="chatline"><span class="pname" style="--c:${c.color}">${esc(c.from)}</span>：${esc(c.text)}</div>` }));
  const html = [...entries, ...chats].sort((x, y) => x.k - y.k).map((x) => x.html).join('');
  if (html === lastLogHtml) return;
  lastLogHtml = html;
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

// ================================================================= 對話框

function stepper(field, r, val, max) {
  return `<div class="stepper"><span class="ricon">${RES_ICON[r]}</span>
    <button data-act="step" data-field="${field}" data-res="${r}" data-d="-1" ${val <= 0 ? 'disabled' : ''}>−</button>
    <b>${val}</b>
    <button data-act="step" data-field="${field}" data-res="${r}" data-d="1" ${val >= max ? 'disabled' : ''}>＋</button></div>`;
}

function modalContent(s) {
  const me = app.me;
  const P = s.players[me];
  // 強制對話框（由遊戲狀態決定）
  if (s.phase === 'ended') {
    const rows = s.players.map((p, i) => ({ i, vp: victoryPoints(s, i) })).sort((a, b) => b.vp - a.vp)
      .map(({ i, vp }) => `<div class="final">${nameOf(i)} <b>🗳️ ${vp}</b></div>`).join('');
    return { key: 'end', html: `<h2>🏆 ${nameOf(s.winner)} 獲勝！</h2>${rows}<div class="btnrow"><button data-act="closeModal">查看棋盤</button><button class="primary" data-act="leave">回到首頁</button></div>`, closable: true };
  }
  if (s.pending?.type === 'discard' && s.pending.need[me]) {
    const need = s.pending.need[me];
    const sel = app.modalData.discard ||= emptyHand();
    const total = handTotal(sel);
    const rows = RES.map((r) => stepper('discard', r, sel[r], Math.min(P.resources[r], sel[r] + need - total))).join('');
    return { key: 'discard', html: `<h2>棄牌</h2><p>擲出 7，你的手牌超過 7 張，必須棄掉 <b>${need}</b> 張（已選 ${total}）。</p>
      <div class="steppers">${rows}</div><div class="btnrow"><button class="primary" data-act="confirmDiscard" ${total === need ? '' : 'disabled'}>確定棄牌</button></div>` };
  }
  if (s.pending?.type === 'steal' && s.current === me) {
    const rows = s.pending.candidates.map((i) => {
      const h = s.players[i].resources;
      const picks = RES.map((r) => `<button class="pick" data-act="steal" data-target="${i}" data-res="${r}" ${h[r] > 0 ? '' : 'disabled'} title="${RES_NAME[r]}">${RES_ICON[r]}<small>${h[r]}</small></button>`).join('');
      return `<div class="steal-row"><div>${nameOf(i)} <span class="muted">（${s.players[i].handCount} 張）</span></div><div class="picks">${picks}</div></div>`;
    }).join('');
    return { key: 'steal', html: `<h2>🕵️ 挖角</h2><p>選擇對象，點一種資源挖走 1 張：</p>${rows}` };
  }

  const m = app.modal;
  if (!m) return null;
  if (m === 'yop') {
    const sel = app.modalData.yop ||= emptyHand();
    const total = handTotal(sel);
    const rows = RES.map((r) => stepper('yop', r, sel[r], Math.min(s.bank[r], sel[r] + 2 - total))).join('');
    return { key: 'yop', closable: true, html: `<h2>🍽️ 募款餐會</h2><p>從公庫選擇 2 張資源（已選 ${total}）</p><div class="steppers">${rows}</div>
      <div class="btnrow"><button data-act="closeModal">取消</button><button class="primary" data-act="confirmYop" ${total === 2 ? '' : 'disabled'}>確定</button></div>` };
  }
  if (m === 'monopoly') {
    const btns = RES.map((r) => `<button data-act="confirmMonopoly" data-res="${r}">${RES_ICON[r]} ${RES_NAME[r]}</button>`).join('');
    return { key: 'monopoly', closable: true, html: `<h2>📺 媒體壟斷</h2><p>選擇一種資源，其他玩家必須交出所有該資源：</p><div class="btngrid">${btns}</div>
      <div class="btnrow"><button data-act="closeModal">取消</button></div>` };
  }
  if (m === 'trade') {
    const d = app.modalData;
    d.tab ||= 'bank';
    d.pgive ||= emptyHand();
    d.pwant ||= emptyHand();
    const tabs = `<div class="tabs"><button data-act="tradeTab" data-tab="bank" class="${d.tab === 'bank' ? 'active' : ''}">公庫／人脈</button><button data-act="tradeTab" data-tab="player" class="${d.tab === 'player' ? 'active' : ''}">玩家交易</button></div>`;
    let body;
    if (d.tab === 'bank') {
      const ratios = tradeRatios(s, me);
      const give = RES.map((r) => {
        const ok = P.resources[r] >= ratios[r];
        return `<button class="pick${d.bgive === r ? ' active' : ''}" data-act="pickBank" data-field="bgive" data-res="${r}" ${ok ? '' : 'disabled'}>${RES_ICON[r]}<small>${ratios[r]}:1</small></button>`;
      }).join('');
      const get = RES.map((r) => `<button class="pick${d.bget === r ? ' active' : ''}" data-act="pickBank" data-field="bget" data-res="${r}" ${s.bank[r] > 0 && r !== d.bgive ? '' : 'disabled'}>${RES_ICON[r]}<small>${s.bank[r]}</small></button>`).join('');
      const ok = d.bgive && d.bget && d.bgive !== d.bget && P.resources[d.bgive] >= ratios[d.bgive];
      body = `<p>付出（顯示兌換比例）</p><div class="picks">${give}</div><p>換取 1 張（顯示公庫庫存）</p><div class="picks">${get}</div>
        <div class="btnrow"><button class="primary" data-act="confirmBank" ${ok ? '' : 'disabled'}>交易${ok ? `：${RES_ICON[d.bgive]}×${ratios[d.bgive]} → ${RES_ICON[d.bget]}×1` : ''}</button></div>`;
    } else {
      const give = RES.map((r) => stepper('pgive', r, d.pgive[r], P.resources[r])).join('');
      const want = RES.map((r) => stepper('pwant', r, d.pwant[r], 19)).join('');
      const ok = handTotal(d.pgive) > 0 && handTotal(d.pwant) > 0 && !RES.some((r) => d.pgive[r] && d.pwant[r]);
      body = `<div class="trade-cols"><div><p>你給出</p><div class="steppers">${give}</div></div><div><p>你想要</p><div class="steppers">${want}</div></div></div>
        ${s.trade ? '<p class="muted">送出新提案會取代目前的提案。</p>' : ''}
        <div class="btnrow"><button class="primary" data-act="confirmOffer" ${ok ? '' : 'disabled'}>向所有玩家提出</button></div>`;
    }
    return { key: 'trade', closable: true, html: `<h2>🤝 交易</h2>${tabs}${body}<div class="btnrow"><button data-act="closeModal">關閉</button></div>` };
  }
  return null;
}

function renderModal(s) {
  const c = s ? modalContent(s) : null;
  const el = $('#modal');
  if (!c || (c.key === 'end' && app.endDismissed)) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div class="modal-box">${c.html}</div>`;
  el.dataset.closable = c.closable ? '1' : '';
}

export function openModal(kind) {
  app.modal = kind;
  app.modalData = {};
  render();
}

export function closeModal() {
  if (app.view?.phase === 'ended') app.endDismissed = true;
  app.modal = null;
  app.modalData = {};
  render();
}

// ================================================================= 按鈕事件

const ACTIONS = {
  roll: () => app.dispatch({ type: 'roll' }),
  mode: (el) => { app.mode = app.mode === el.dataset.kind ? null : el.dataset.kind; render(); },
  buyDev: () => app.dispatch({ type: 'buyDev' }),
  endTurn: () => { app.mode = null; app.dispatch({ type: 'endTurn' }); },
  skipRoadBuilding: () => app.dispatch({ type: 'skipRoadBuilding' }),
  passBuild: () => { app.mode = null; app.dispatch({ type: 'passBuild' }); },
  playDev: (el) => {
    const card = el.dataset.card;
    app.mode = null;
    if (card === 'yearOfPlenty') openModal('yop');
    else if (card === 'monopoly') openModal('monopoly');
    else app.dispatch({ type: 'playDev', card });
  },
  openTrade: () => { app.mode = null; openModal('trade'); },
  closeModal: () => closeModal(),
  step: (el) => {
    const f = el.dataset.field;
    const hand = app.modalData[f] ||= emptyHand();
    hand[el.dataset.res] = Math.max(0, hand[el.dataset.res] + Number(el.dataset.d));
    render();
  },
  tradeTab: (el) => { app.modalData.tab = el.dataset.tab; render(); },
  pickBank: (el) => {
    app.modalData[el.dataset.field] = el.dataset.res;
    if (app.modalData.bgive === app.modalData.bget && el.dataset.field === 'bgive') app.modalData.bget = null;
    render();
  },
  confirmBank: () => app.dispatch({ type: 'bankTrade', give: app.modalData.bgive, get: app.modalData.bget }),
  confirmOffer: () => {
    app.dispatch({ type: 'tradeOffer', give: app.modalData.pgive, want: app.modalData.pwant });
    closeModal();
  },
  confirmDiscard: () => {
    app.dispatch({ type: 'discard', resources: app.modalData.discard });
    app.modalData.discard = null;
  },
  confirmYop: () => {
    const sel = app.modalData.yop;
    app.dispatch({ type: 'playDev', card: 'yearOfPlenty', resources: RES.flatMap((r) => Array(sel[r]).fill(r)) });
    closeModal();
  },
  confirmMonopoly: (el) => {
    app.dispatch({ type: 'playDev', card: 'monopoly', resource: el.dataset.res });
    closeModal();
  },
  steal: (el) => app.dispatch({ type: 'steal', target: Number(el.dataset.target), resource: el.dataset.res }),
  tradeRespond: (el) => app.dispatch({ type: 'tradeRespond', accept: el.dataset.accept === '1' }),
  tradeAccept: (el) => app.dispatch({ type: 'tradeAccept', with: Number(el.dataset.with) }),
  tradeCancel: () => app.dispatch({ type: 'tradeCancel' }),
  copyInvite: () => app.copyInvite(),
  autoplay: () => app.autoplay(),
  leave: () => app.leave(),
};

// ================================================================= 主渲染

export function render() {
  const s = app.view;
  if (!s) return;
  const t = targets();
  const b = geo(s).bounds;
  const m = 1.3; // 留給海洋與人脈的邊界
  $('#board').setAttribute('viewBox', [b.minX - m, b.minY - m, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m].map((x) => Math.round(x * S)).join(' '));
  $('#board').innerHTML = boardSVG(s, t);
  $('#board').classList.toggle('picking', !!(t.vertices || t.edges || t.hexes));
  $('#hint').innerHTML = hintText(s, t);
  $('#hint').classList.toggle('mine', s.current === app.me && s.phase !== 'ended');
  renderTopbar(s);
  renderPlayers(s);
  renderHand(s);
  renderActions(s);
  renderTrade(s);
  renderLog(s);
  renderModal(s);
}

export function toast(text, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 2800);
  setTimeout(() => el.remove(), 3300);
}

export function initUI(a) {
  app = a;
  app.modalData = {};
  $('#board').addEventListener('click', onBoardClick);
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (el && !el.disabled && ACTIONS[el.dataset.act]) {
      ev.preventDefault();
      ACTIONS[el.dataset.act](el);
    }
  });
  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal' && $('#modal').dataset.closable) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (app.mode) { app.mode = null; render(); } else if ($('#modal').dataset.closable) closeModal();
    }
  });
}

