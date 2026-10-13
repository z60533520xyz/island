// 以極簡 DOM 替身執行所有渲染路徑，確認各種遊戲狀態下畫面程式不會出錯。執行：node test/render.mjs
import { createGame, applyAction, applyEvent, viewFor, validSettlementVertices, validRoadEdges, RES } from '../js/engine.js';

const els = {};
const el = () => ({ innerHTML: '', hidden: false, dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  classList: { toggle() {}, add() {} }, addEventListener() {}, appendChild() {}, setAttribute() {} });
globalThis.document = { querySelector: (s) => (els[s] ||= el()), addEventListener() {} };
const ui = await import('../js/ui.js');

const app = { me: 0, online: [], chat: [], code: 'TEST', role: 'host', dispatch() {}, modal: null };
ui.initUI(app);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let renders = 0;

// 3 人基本地圖、6 人擴充地圖
for (const n of [3, 6]) {
  app.online = [];
  const s = createGame([{ name: '<b>A</b>' }, ...Array.from({ length: n - 1 }, (_, i) => ({ name: `P${i}` }))]);
  function renderAll() {
    for (let me = 0; me < n; me++) {
      app.me = me;
      app.view = viewFor(s, me);
      for (const mode of [null, 'road', 'settlement', 'city']) {
        app.mode = mode;
        for (const modal of [null, 'trade', 'yop', 'monopoly']) {
          app.modal = modal;
          app.modalData = modal === 'trade' ? { tab: renders % 2 ? 'bank' : 'player', bgive: 'wood', bget: 'ore' } : {};
          ui.render();
          renders++;
        }
      }
    }
  }
  while (s.phase === 'setup') {
    renderAll();
    const me = s.current;
    if (s.setup.stage === 'settlement') applyAction(s, me, { type: 'build', kind: 'settlement', at: pick(validSettlementVertices(s, me)) });
    else applyAction(s, me, { type: 'build', kind: 'road', at: pick(validRoadEdges(s, me)) });
  }
  // 製造各種待處理狀態
  s.players.forEach((p) => RES.forEach((r) => { p.resources[r] += 3; s.bank[r] -= 3; }));
  s.players[0].dev.push({ type: 'knight', turn: 0 }, { type: 'vp', turn: 0 }, { type: 'monopoly', turn: 1 });
  renderAll();
  applyAction(s, 0, { type: 'roll' });
  renderAll();
  const saved = s.pending; s.pending = null; // 棄牌等強制對話框會蓋過新聞卡
  for (const id of ['debate', 'tactical', 'clarify']) { applyEvent(s, id); app.eventSeen = -1; renderAll(); }
  if (!els['#modal'].innerHTML.includes('時事新聞')) throw new Error('新聞卡沒有顯示');
  s.pending = saved;
  s.pending = { type: 'discard', need: { 1: 7 } }; renderAll();
  s.pending = { type: 'robber' }; renderAll();
  s.pending = { type: 'steal', candidates: [1, 2] }; renderAll();
  s.pending = { type: 'roadBuilding', remaining: 2 }; renderAll();
  s.pending = null;
  s.rolled = true;
  applyAction(s, 0, { type: 'tradeOffer', give: { wood: 1 }, want: { ore: 1 } });
  applyAction(s, 1, { type: 'tradeRespond', accept: true });
  renderAll();
  app.online = [true, false, true];
  renderAll();
  applyAction(s, 0, { type: 'tradeCancel' });
  if (n >= 5) {
    applyAction(s, 0, { type: 'endTurn' });
    if (s.pending?.type !== 'specialBuild') throw new Error('應進入特別建設階段');
    app.mode = 'road';
    renderAll();
    applyAction(s, 1, { type: 'passBuild' });
    renderAll();
  }
  s.phase = 'ended'; s.winner = 0; renderAll();
  const board = els['#board'].innerHTML;
  if (board.includes('undefined') || board.includes('NaN')) throw new Error('棋盤 SVG 含 undefined/NaN');
  for (const [k, e] of Object.entries(els)) if (/undefined|NaN/.test(e.innerHTML)) throw new Error(`${k} 含 undefined/NaN`);
  if (els['#players'].innerHTML.includes('<b>A</b>')) throw new Error('玩家名稱未跳脫');
}
console.log(`渲染 ${renders} 次無錯誤 ✔`);
