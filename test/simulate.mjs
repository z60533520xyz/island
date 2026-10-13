// 以隨機機器人跑大量完整對局，檢查規則引擎不會卡死、資源守恆、最終能分出勝負。
// 執行：node test/simulate.mjs [對局數]
import assert from 'node:assert/strict';
import { GEO, geoFor } from '../js/geometry.js';
import {
  RES, COST, applyAction, createGame, canAfford, handTotal, tradeRatios, viewFor, victoryPoints,
  validRoadEdges, validSettlementVertices, validCityVertices, playableDev, longestRoadFor,
  geo, bankSize, robberNearOwn,
} from '../js/engine.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function checkInvariants(s) {
  for (const r of RES) {
    const total = s.bank[r] + s.players.reduce((a, p) => a + p.resources[r], 0);
    assert.equal(total, bankSize(s), `${r} 總數應為 ${bankSize(s)}`);
    assert.ok(s.bank[r] >= 0);
    s.players.forEach((p) => assert.ok(p.resources[r] >= 0));
  }
  const devTotal = s.deck.length + s.players.reduce((a, p) => a + p.dev.length, 0);
  assert.ok(devTotal <= (s.players.length >= 5 ? 34 : 25));
  s.players.forEach((p, i) => {
    const roads = Object.values(s.roads).filter((o) => o === i).length;
    assert.equal(p.pieces.road + roads, 15);
  });
}

function botStep(s) {
  // 先處理所有人的棄牌
  if (s.pending?.type === 'discard') {
    const [pid, need] = Object.entries(s.pending.need)[0];
    const h = { ...s.players[pid].resources };
    const d = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    for (let i = 0; i < need; i++) {
      const r = pick(RES.filter((x) => h[x] > 0));
      h[r]--; d[r]++;
    }
    return applyAction(s, +pid, { type: 'discard', resources: d });
  }
  // 特別建設階段：有錢就蓋，否則跳過
  if (s.pending?.type === 'specialBuild') {
    const b = s.pending.queue[0];
    const H = s.players[b].resources;
    const sett = validSettlementVertices(s, b);
    if (sett.length && canAfford(H, COST.settlement)) return applyAction(s, b, { type: 'build', kind: 'settlement', at: pick(sett) });
    const city = validCityVertices(s, b);
    if (city.length && canAfford(H, COST.city)) return applyAction(s, b, { type: 'build', kind: 'city', at: pick(city) });
    const rd = validRoadEdges(s, b);
    if (rd.length && canAfford(H, COST.road) && Math.random() < 0.5) return applyAction(s, b, { type: 'build', kind: 'road', at: pick(rd) });
    return applyAction(s, b, { type: 'passBuild' });
  }
  const me = s.current;
  const P = s.players[me];
  if (s.phase === 'setup') {
    if (s.setup.stage === 'settlement') return applyAction(s, me, { type: 'build', kind: 'settlement', at: pick(validSettlementVertices(s, me)) });
    return applyAction(s, me, { type: 'build', kind: 'road', at: pick(validRoadEdges(s, me)) });
  }
  if (s.pending?.type === 'robber') {
    const hexes = geo(s).hexes.map((h) => h.id).filter((h) => h !== s.board.robber);
    return applyAction(s, me, { type: 'moveRobber', hex: pick(hexes) });
  }
  if (s.pending?.type === 'steal') {
    const target = pick(s.pending.candidates);
    const resource = pick(RES.filter((r) => s.players[target].resources[r] > 0));
    return applyAction(s, me, { type: 'steal', target, resource });
  }
  if (s.pending?.type === 'roadBuilding') {
    return applyAction(s, me, { type: 'build', kind: 'road', at: pick(validRoadEdges(s, me)) });
  }

  const devs = s.devPlayed ? [] : playableDev(s, me);
  if (!s.rolled) {
    if (devs.includes('knight') && robberNearOwn(s, me) && Math.random() < 0.5) return applyAction(s, me, { type: 'playDev', card: 'knight' });
    return applyAction(s, me, { type: 'roll' });
  }
  if (devs.length && Math.random() < 0.5) {
    const card = pick(devs);
    const extra = card === 'yearOfPlenty' ? { resources: [pick(RES), pick(RES)] } : card === 'monopoly' ? { resource: pick(RES) } : {};
    try { return applyAction(s, me, { type: 'playDev', card, ...extra }); } catch { /* 銀行不足等，忽略 */ }
  }
  const city = validCityVertices(s, me);
  if (city.length && canAfford(P.resources, COST.city)) return applyAction(s, me, { type: 'build', kind: 'city', at: pick(city) });
  const sett = validSettlementVertices(s, me);
  if (sett.length && canAfford(P.resources, COST.settlement)) return applyAction(s, me, { type: 'build', kind: 'settlement', at: pick(sett) });
  const roads = validRoadEdges(s, me);
  if (roads.length && canAfford(P.resources, COST.road) && Math.random() < 0.7) return applyAction(s, me, { type: 'build', kind: 'road', at: pick(roads) });
  if (s.deck.length && canAfford(P.resources, COST.dev) && Math.random() < 0.5) return applyAction(s, me, { type: 'buyDev' });

  // 玩家交易：提案 → 隨機一人接受 → 成交
  if (!s.built && !s.trade && handTotal(P.resources) >= 2 && Math.random() < 0.1) {
    const have = RES.filter((r) => P.resources[r] > 0);
    const g = pick(have);
    const w = pick(RES.filter((r) => r !== g));
    applyAction(s, me, { type: 'tradeOffer', give: { [g]: 1 }, want: { [w]: 1 } });
    s.players.forEach((p, i) => {
      if (i !== me) {
        const can = p.resources[w] >= 1;
        applyAction(s, i, { type: 'tradeRespond', accept: can && Math.random() < 0.5 });
      }
    });
    const ok = Object.entries(s.trade.responses).find(([, v]) => v);
    if (ok) return applyAction(s, me, { type: 'tradeAccept', with: +ok[0] });
    return applyAction(s, me, { type: 'tradeCancel' });
  }

  const ratios = tradeRatios(s, me);
  const surplus = RES.find((r) => P.resources[r] >= ratios[r] + 1);
  if (surplus && !s.built && Math.random() < 0.6) {
    const need = pick(RES.filter((r) => r !== surplus && s.bank[r] > 0));
    if (need) return applyAction(s, me, { type: 'bankTrade', give: surplus, get: need });
  }
  return applyAction(s, me, { type: 'endTurn' });
}

function expectThrow(fn) {
  assert.throws(fn, (e) => e.name === 'Error' || e.constructor.name === 'GameError');
}

// ---- 幾何
assert.equal(GEO.hexes.length, 19);
assert.equal(GEO.vertices.length, 54);
assert.equal(GEO.edges.length, 72);
assert.equal(GEO.coastal.length, 30);

// ---- 基本非法動作
{
  const s = createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  expectThrow(() => applyAction(s, 1, { type: 'build', kind: 'settlement', at: 0 }));
  expectThrow(() => applyAction(s, 0, { type: 'roll' }));
  applyAction(s, 0, { type: 'build', kind: 'settlement', at: 0 });
  expectThrow(() => applyAction(s, 0, { type: 'build', kind: 'settlement', at: 1 }));
  const far = GEO.edges.find((e) => !e.v.includes(0)).id;
  expectThrow(() => applyAction(s, 0, { type: 'build', kind: 'road', at: far }));
  // 距離規則
  applyAction(s, 0, { type: 'build', kind: 'road', at: GEO.vertices[0].edges[0] });
  expectThrow(() => applyAction(s, 1, { type: 'build', kind: 'settlement', at: GEO.vertices[0].adj[0] }));
  // 資源公開、發展卡與牌庫隱藏
  s.players[0].dev.push({ type: 'vp', turn: 0 });
  const v = viewFor(s, 1);
  assert.ok(v.players[0].resources, '資源卡應公開');
  assert.equal(v.players[0].dev, null, '他人的發展卡應隱藏');
  assert.equal(v.players[0].devCount, 1);
  assert.equal(v.deck, null);
  assert.ok(Array.isArray(viewFor(s, 0).players[0].dev));
}

// ---- 準備階段每輪 2 條道路（家規選項）
{
  const s = createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { setupRoads: 2 });
  const v0 = 0;
  applyAction(s, 0, { type: 'build', kind: 'settlement', at: v0 });
  const r1 = GEO.vertices[v0].edges[0];
  applyAction(s, 0, { type: 'build', kind: 'road', at: r1 });
  assert.equal(s.current, 0, '放完第 1 條道路後仍輪到同一位玩家');
  assert.equal(s.setup.stage, 'road');
  expectThrow(() => applyAction(s, 0, { type: 'build', kind: 'settlement', at: 30 }));
  // 第 2 條必須接在村莊或第 1 條道路上
  const ends = new Set(GEO.edges[r1].v);
  const far = GEO.edges.find((e) => !e.v.some((x) => ends.has(x))).id;
  expectThrow(() => applyAction(s, 0, { type: 'build', kind: 'road', at: far }));
  const w = GEO.edges[r1].v.find((x) => x !== v0);
  const r2 = GEO.vertices[w].edges.find((e) => e !== r1);
  applyAction(s, 0, { type: 'build', kind: 'road', at: r2 });
  assert.equal(s.current, 1);
  assert.equal(s.setup.stage, 'settlement');
  while (s.phase === 'setup') {
    const me = s.current;
    if (s.setup.stage === 'settlement') applyAction(s, me, { type: 'build', kind: 'settlement', at: validSettlementVertices(s, me)[0] });
    else applyAction(s, me, { type: 'build', kind: 'road', at: validRoadEdges(s, me)[0] });
  }
  s.players.forEach((p) => assert.equal(p.pieces.road, 11, '每人放了 4 條道路'));
  expectThrow(() => createGame([{ name: 'A' }, { name: 'B' }], { setupRoads: 3 }));
  // 預設仍是官方規則
  const d = createGame([{ name: 'A' }, { name: 'B' }]);
  applyAction(d, 0, { type: 'build', kind: 'settlement', at: 0 });
  applyAction(d, 0, { type: 'build', kind: 'road', at: GEO.vertices[0].edges[0] });
  assert.equal(d.current, 1);
}

// ---- 5~6 人擴充：大地圖、銀行 24、發展卡 34、特別建設階段
{
  const L = geoFor('large');
  assert.equal(L.hexes.length, 30);
  const s = createGame(Array.from({ length: 6 }, (_, i) => ({ name: `P${i}` })));
  assert.equal(s.board.layout, 'large');
  assert.equal(s.board.hexes.filter((h) => h.resource === 'desert').length, 2);
  assert.ok(s.board.hexes.every((h) => (h.resource === 'desert') === (h.number == null)), '沙漠沒有數字，其他都有');
  assert.equal(s.board.ports.length, 11);
  assert.equal(s.deck.length, 34);
  assert.equal(s.bank.wood, 24);
  expectThrow(() => createGame(Array.from({ length: 7 }, (_, i) => ({ name: `P${i}` }))));
  while (s.phase === 'setup') {
    const me = s.current;
    if (s.setup.stage === 'settlement') applyAction(s, me, { type: 'build', kind: 'settlement', at: validSettlementVertices(s, me)[0] });
    else applyAction(s, me, { type: 'build', kind: 'road', at: validRoadEdges(s, me)[0] });
  }
  s.dice = null;
  // 讓第 0 位玩家結束回合（避免擲出 7 的干擾，直接設定為已擲骰）
  s.rolled = true;
  applyAction(s, 0, { type: 'endTurn' });
  assert.equal(s.pending.type, 'specialBuild');
  assert.deepEqual(s.pending.queue, [1, 2, 3, 4, 5]);
  assert.equal(s.current, 0);
  expectThrow(() => applyAction(s, 2, { type: 'passBuild' }));
  expectThrow(() => applyAction(s, 1, { type: 'bankTrade', give: 'wood', get: 'ore' }));
  // 特別建設中可以建造
  s.players[1].resources.wood++; s.players[1].resources.brick++; s.bank.wood--; s.bank.brick--;
  applyAction(s, 1, { type: 'build', kind: 'road', at: validRoadEdges(s, 1)[0] });
  for (let i = 1; i <= 5; i++) applyAction(s, i, { type: 'passBuild' });
  assert.equal(s.pending, null);
  assert.equal(s.current, 1);
  // 關閉選項時直接換人
  const t2 = createGame(Array.from({ length: 5 }, (_, i) => ({ name: `P${i}` })), { specialBuild: false });
  while (t2.phase === 'setup') {
    const me = t2.current;
    if (t2.setup.stage === 'settlement') applyAction(t2, me, { type: 'build', kind: 'settlement', at: validSettlementVertices(t2, me)[0] });
    else applyAction(t2, me, { type: 'build', kind: 'road', at: validRoadEdges(t2, me)[0] });
  }
  t2.rolled = true;
  applyAction(t2, 0, { type: 'endTurn' });
  assert.equal(t2.current, 1);
}

// ---- 隨機座位順序
{
  const names = ['A', 'B', 'C', 'D'];
  const seen = new Set();
  for (let k = 0; k < 50; k++) {
    const s = createGame(names.map((name) => ({ name })));
    const seats = s.players.map((p) => p.seat);
    assert.deepEqual([...seats].sort(), [0, 1, 2, 3], '座位必須是排列');
    s.players.forEach((p) => assert.equal(p.name, names[p.seat], '名字要跟著座位'));
    seen.add(seats.join());
  }
  assert.ok(seen.size > 1, '預設應會打亂順序');
  const fixed = createGame(names.map((name) => ({ name })), { shuffleSeats: false });
  assert.deepEqual(fixed.players.map((p) => p.seat), [0, 1, 2, 3]);
}

// ---- 強盜：自選對象與資源
{
  const s = createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { shuffleSeats: false });
  s.phase = 'play'; s.turn = 1; s.rolled = true;
  const hex = 4;
  const [v1] = geo(s).hexes[hex].vertices;
  s.buildings[v1] = { owner: 1, type: 'settlement' };
  s.players[1].resources.ore = 2; s.bank.ore -= 2;
  s.players[1].resources.wood = 1; s.bank.wood -= 1;
  s.board.robber = 0;
  s.pending = { type: 'robber' };
  applyAction(s, 0, { type: 'moveRobber', hex });
  assert.equal(s.pending.type, 'steal', '只有一位可搶也要自己選');
  assert.deepEqual(s.pending.candidates, [1]);
  expectThrow(() => applyAction(s, 0, { type: 'steal', target: 1, resource: 'wheat' }));
  expectThrow(() => applyAction(s, 0, { type: 'steal', target: 1 }));
  expectThrow(() => applyAction(s, 0, { type: 'steal', target: 2, resource: 'ore' }));
  applyAction(s, 0, { type: 'steal', target: 1, resource: 'ore' });
  assert.equal(s.players[1].resources.ore, 1);
  assert.equal(s.players[0].resources.ore, 1);
  assert.equal(s.pending, null);
}

// ---- 交易階段 → 建設階段
{
  const s = createGame([{ name: 'A' }, { name: 'B' }], { shuffleSeats: false });
  while (s.phase === 'setup') {
    const me = s.current;
    if (s.setup.stage === 'settlement') applyAction(s, me, { type: 'build', kind: 'settlement', at: validSettlementVertices(s, me)[0] });
    else applyAction(s, me, { type: 'build', kind: 'road', at: validRoadEdges(s, me)[0] });
  }
  s.rolled = true;
  s.players.forEach((p) => RES.forEach((r) => { p.resources[r] += 5; s.bank[r] -= 5; }));
  applyAction(s, 0, { type: 'bankTrade', give: 'wood', get: 'ore' });
  applyAction(s, 0, { type: 'tradeOffer', give: { wood: 1 }, want: { ore: 1 } });
  applyAction(s, 0, { type: 'build', kind: 'road', at: validRoadEdges(s, 0)[0] });
  assert.equal(s.built, true);
  assert.equal(s.trade, null, '建造後交易提案自動取消');
  expectThrow(() => applyAction(s, 0, { type: 'bankTrade', give: 'wood', get: 'ore' }));
  expectThrow(() => applyAction(s, 0, { type: 'tradeOffer', give: { wood: 1 }, want: { ore: 1 } }));
  applyAction(s, 0, { type: 'buyDev' }); // 建設階段仍可繼續建造／買卡
  applyAction(s, 0, { type: 'endTurn' });
  assert.equal(s.built, false, '新回合重設');
  s.rolled = true;
  applyAction(s, 1, { type: 'buyDev' });
  expectThrow(() => applyAction(s, 1, { type: 'bankTrade', give: 'wood', get: 'ore' }));
}

// ---- 騎士卡：強盜須在自己的建築旁
{
  const s = createGame([{ name: 'A' }, { name: 'B' }], { shuffleSeats: false });
  s.phase = 'play'; s.turn = 2;
  s.players[0].dev.push({ type: 'knight', turn: 1 });
  const near = geo(s).hexes[4];
  s.buildings[near.vertices[0]] = { owner: 0, type: 'city' };
  s.board.robber = geo(s).hexes.find((h) => h.vertices.every((v) => !s.buildings[v])).id;
  assert.equal(robberNearOwn(s, 0), false);
  expectThrow(() => applyAction(s, 0, { type: 'playDev', card: 'knight' }));
  assert.equal(s.players[0].dev.length, 1, '失敗時不消耗卡片');
  s.board.robber = 4;
  assert.equal(robberNearOwn(s, 0), true, '城市也算');
  applyAction(s, 0, { type: 'playDev', card: 'knight' });
  assert.equal(s.pending.type, 'robber');
  assert.equal(s.players[0].knights, 1);
}

// ---- 最長道路：被他人村莊截斷
{
  const s = createGame([{ name: 'A' }, { name: 'B' }]);
  s.phase = 'play';
  // 沿著中央地塊外圍的 5 條邊
  const hex = GEO.hexes[9];
  const path = hex.edges.slice(0, 5);
  path.forEach((e) => { s.roads[e] = 0; });
  assert.equal(longestRoadFor(s, 0), 5);
  // 對手在中間蓋村莊，道路被切成 2 + 3 段
  s.buildings[hex.vertices[2]] = { owner: 1, type: 'settlement' };
  assert.equal(longestRoadFor(s, 0), 3);
}

// ---- 大量隨機對局
const N = Number(process.argv[2] || 300);
let wins = 0;
let totalTurns = 0;
for (let g = 0; g < N; g++) {
  const n = 2 + (g % 5);
  const s = createGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), { setupRoads: 1 + (g % 2) });
  let steps = 0;
  while (s.phase !== 'ended' && s.turn < 600) {
    botStep(s);
    checkInvariants(s);
    if (++steps > 200000) throw new Error('步數過多，可能卡死');
  }
  if (s.phase === 'ended') {
    wins++;
    assert.ok(victoryPoints(s, s.winner) >= 10);
  }
  totalTurns += s.turn;
  viewFor(s, 0);
  JSON.parse(JSON.stringify(s)); // 狀態必須可序列化
}
console.log(`${N} 局完成，${wins} 局分出勝負，平均 ${Math.round(totalTurns / N)} 回合`);
assert.ok(wins >= N * 0.9, '大部分對局應分出勝負');
console.log('全部測試通過 ✔');
