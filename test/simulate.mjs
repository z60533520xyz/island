// 以隨機機器人跑大量完整對局，檢查規則引擎不會卡死、資源守恆、最終能分出勝負。
// 執行：node test/simulate.mjs [對局數]
import assert from 'node:assert/strict';
import { GEO, geoFor } from '../js/geometry.js';
import {
  RES, COST, applyAction, createGame, canAfford, handTotal, tradeRatios, viewFor, victoryPoints,
  validRoadEdges, validSettlementVertices, validCityVertices, playableDev, longestRoadFor,
  geo, bankSize, robberNearOwn, EVENTS, applyEvent, costFor, tradeRatios as ratiosOf, discardableCount, FACTIONS,
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
      const r = pick(RES.filter((x) => h[x] > 0 && !(x === 'ore' && s.players[pid].faction === 'blue')));
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
  if (roads.length && canAfford(P.resources, costFor(s, me, 'road')) && Math.random() < 0.7) return applyAction(s, me, { type: 'build', kind: 'road', at: pick(roads) });
  if (s.deck.length && canAfford(P.resources, COST.dev) && Math.random() < 0.5) return applyAction(s, me, { type: 'buyDev' });

  // 玩家交易：提案 → 隨機一人接受 → 成交
  if (!s.built && !s.trade && P.faction !== 'red' && handTotal(P.resources) >= 2 && Math.random() < 0.1) {
    const have = RES.filter((r) => P.resources[r] > 0);
    const g = pick(have);
    const w = pick(RES.filter((r) => r !== g));
    applyAction(s, me, { type: 'tradeOffer', give: { [g]: 1 }, want: { [w]: 1 } });
    s.players.forEach((p, i) => {
      if (i !== me) {
        const can = p.resources[w] >= 1 && p.faction !== 'red';
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

// ---- 陣營技能
{
  const mk = (n = 6, opts = {}) => {
    const s = createGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), { shuffleSeats: false, events: false, ...opts });
    s.phase = 'play'; s.turn = 1; s.rolled = true;
    return s;
  };
  const giveRes = (s, pid, r, n) => { s.players[pid].resources[r] += n; s.bank[r] -= n; };
  const ids = FACTIONS.map((f) => f.id);
  assert.deepEqual(mk().players.map((p) => p.faction), ids);
  assert.ok(mk(3, { factions: false }).players.every((p) => p.faction === null), '關閉時沒有陣營');

  // 藍 黑金：資金 2:1、棄牌不計資金
  let s = mk();
  assert.equal(ratiosOf(s, 0).ore, 2);
  assert.equal(ratiosOf(s, 0).wood, 4);
  giveRes(s, 0, 'ore', 6); giveRes(s, 0, 'wood', 4);
  assert.equal(discardableCount(s, 0), 4, '資金不計入');
  giveRes(s, 0, 'wood', 6); // 10 張文宣 + 6 資金 → 需棄 5
  assert.equal(discardableCount(s, 0), 10);
  s.pending = { type: 'discard', need: { 0: 5 } };
  expectThrow(() => applyAction(s, 0, { type: 'discard', resources: { ore: 1, wood: 4 } }));
  applyAction(s, 0, { type: 'discard', resources: { wood: 5 } });

  // 橘 合縱連橫：全部 3:1
  s = mk();
  assert.deepEqual(Object.values(ratiosOf(s, 4)), [3, 3, 3, 3, 3]);

  // 黃 社運：掃街路線只需文宣
  s = mk();
  assert.deepEqual(costFor(s, 3, 'road'), { wood: 1 });
  assert.deepEqual(costFor(s, 0, 'road'), { wood: 1, brick: 1 });

  const realRandom = Math.random;
  // 紅 統戰：每次擲骰得 1 資金；不能與玩家交易
  s = mk();
  s.current = 5; s.rolled = false;
  Math.random = (() => { const q = [0.01, 0.01]; return () => q.shift() ?? realRandom(); })();
  applyAction(s, 5, { type: 'roll' });
  Math.random = realRandom;
  assert.equal(s.players[5].resources.ore, 1, '擲出雙數（2）獲得境外金援');
  // 擲出單數（1+2=3）不觸發
  const s2 = mk();
  s2.current = 5; s2.rolled = false;
  Math.random = (() => { const q = [0.01, 0.2]; return () => q.shift() ?? realRandom(); })();
  applyAction(s2, 5, { type: 'roll' });
  Math.random = realRandom;
  assert.equal(s2.dice[0] + s2.dice[1], 3);
  assert.equal(s2.players[5].resources.ore, 0, '單數不觸發');
  giveRes(s, 5, 'wood', 2);
  expectThrow(() => applyAction(s, 5, { type: 'tradeOffer', give: { wood: 1 }, want: { ore: 1 } }));
  s.current = 0;
  giveRes(s, 0, 'wood', 1);
  applyAction(s, 0, { type: 'tradeOffer', give: { wood: 1 }, want: { ore: 1 } });
  expectThrow(() => applyAction(s, 5, { type: 'tradeRespond', accept: true }));
  applyAction(s, 5, { type: 'tradeRespond', accept: false });
  s.trade.responses[5] = true; // 即使被竄改也無法成交
  expectThrow(() => applyAction(s, 0, { type: 'tradeAccept', with: 5 }));
  applyAction(s, 0, { type: 'tradeCancel' });

  // 青 小草：擲骰沒拿到資源 → 志工 +1
  s = mk();
  s.current = 2; s.rolled = false;
  Math.random = (() => { const q = [0.01, 0.01]; return () => q.shift() ?? realRandom(); })(); // 擲出 1+1=2
  applyAction(s, 2, { type: 'roll' });
  Math.random = realRandom;
  assert.equal(s.dice[0] + s.dice[1], 2);
  assert.equal(s.players[2].resources.sheep, 1, '小額捐款');

  // 綠 青鳥：挖角 2 張；其他陣營 1 張
  s = mk();
  s.current = 1;
  giveRes(s, 3, 'wheat', 2);
  s.pending = { type: 'steal', candidates: [3] };
  applyAction(s, 1, { type: 'steal', target: 3, resource: 'wheat' });
  assert.equal(s.pending?.type, 'steal', '青鳥可以再挖一張');
  applyAction(s, 1, { type: 'steal', target: 3, resource: 'wheat' });
  assert.equal(s.pending, null);
  assert.equal(s.players[1].resources.wheat, 2);
  s.current = 0;
  giveRes(s, 3, 'wheat', 2);
  s.pending = { type: 'steal', candidates: [3] };
  applyAction(s, 0, { type: 'steal', target: 3, resource: 'wheat' });
  assert.equal(s.pending, null, '非青鳥只挖一張');
}

// ---- 佈局：周圍的邊都被佔滿的路口不能設立服務處（否則放不了掃街路線而卡住）
{
  const s = createGame([{ name: 'A' }, { name: 'B' }], { shuffleSeats: false });
  const v = geo(s).vertices.find((x) => x.edges.length === 3);
  v.edges.forEach((e) => { s.roads[e] = 1; });
  assert.ok(!validSettlementVertices(s, 0).includes(v.id));
}

// ---- 時事新聞事件
{
  const mk = (opts = {}) => {
    const s = createGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { shuffleSeats: false, factions: false, ...opts });
    s.phase = 'play'; s.turn = 1;
    return s;
  };
  const giveRes = (s, pid, r, n) => { s.players[pid].resources[r] += n; s.bank[r] -= n; };
  const forceDice = (a, b) => { const q = [(a - 1) / 6 + 0.01, (b - 1) / 6 + 0.01]; const real = Math.random; Math.random = () => (q.length ? q.shift() : real()); return () => { Math.random = real; }; };

  // 五種資源的「全體獲得」事件各一張
  const gainCount = {};
  for (const e of EVENTS) {
    const m = e.desc.match(/每位候選人獲得 1 張(\p{Extended_Pictographic})/u);
    if (m) gainCount[m[1]] = (gainCount[m[1]] || 0) + 1;
  }
  assert.equal(Object.keys(gainCount).length, 5);
  assert.ok(Object.values(gainCount).every((n) => n === 1), '資源事件平均分布');

  // 對子觸發、非對子不觸發、關閉選項不觸發
  let s = mk();
  let restore = forceDice(3, 3);
  applyAction(s, 0, { type: 'roll' });
  restore();
  assert.ok(s.lastEvent, '擲出對子翻新聞');
  assert.equal(s.eventDeck.length, EVENTS.length - 1);
  s = mk(); restore = forceDice(2, 4); applyAction(s, 0, { type: 'roll' }); restore();
  assert.equal(s.lastEvent, null, '非對子不觸發');
  s = mk({ events: false }); restore = forceDice(4, 4); applyAction(s, 0, { type: 'roll' }); restore();
  assert.equal(s.lastEvent, null, '關閉時不觸發');
  assert.equal(viewFor(mk(), 0).eventDeck, null, '新聞牌庫順序不公開');

  // 全體獲得
  s = mk(); applyEvent(s, 'donation');
  assert.ok(s.players.every((p) => p.resources.ore === 1));
  s = mk(); s.bank.ore = 2; applyEvent(s, 'donation');
  assert.ok(s.players.every((p) => p.resources.ore === 0), '公庫不夠就都不發');
  // 政見發表會：各拿自己最少的
  s = mk(); giveRes(s, 0, 'wood', 1); giveRes(s, 0, 'brick', 1); giveRes(s, 0, 'sheep', 1); giveRes(s, 0, 'wheat', 1);
  applyEvent(s, 'policy');
  assert.equal(s.players[0].resources.ore, 1);
  // 棄保效應：最高給最低
  s = mk(); s.buildings[0] = { owner: 1, type: 'city' }; giveRes(s, 1, 'wheat', 3); giveRes(s, 2, 'wood', 1);
  applyEvent(s, 'tactical');
  assert.equal(s.players[1].resources.wheat, 2);
  assert.equal(s.players[0].resources.wheat, 1, '平手時手牌少的算最低');
  s = mk(); giveRes(s, 0, 'wood', 2); applyEvent(s, 'tactical');
  assert.equal(s.players[0].resources.wood, 2, '得票相同時無效');
  // 網路聲量爆紅：最低者拿最少的兩種
  s = mk(); s.buildings[0] = { owner: 0, type: 'settlement' }; s.buildings[10] = { owner: 1, type: 'settlement' };
  giveRes(s, 2, 'wood', 1); giveRes(s, 2, 'brick', 1); giveRes(s, 2, 'sheep', 1);
  applyEvent(s, 'viral');
  assert.equal(s.players[2].resources.wheat, 1);
  assert.equal(s.players[2].resources.ore, 1);
  // 幽靈人口查辦
  s = mk(); giveRes(s, 0, 'wood', 5); giveRes(s, 0, 'ore', 3); giveRes(s, 1, 'wood', 7);
  applyEvent(s, 'ghost');
  assert.equal(s.players[0].resources.wood, 3);
  assert.equal(s.players[1].resources.wood, 7, '7 張以下不受影響');
  // 澄清記者會
  s = mk(); s.board.robber = s.board.hexes.findIndex((h) => h.resource !== 'desert');
  applyEvent(s, 'clarify');
  assert.equal(s.board.hexes[s.board.robber].resource, 'desert');
  // 雙城匯流：每人把最多的資源傳給下一位
  s = mk(); giveRes(s, 0, 'wood', 2); giveRes(s, 1, 'ore', 1);
  applyEvent(s, 'alliance');
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[1].resources.wood, 1);
  assert.equal(s.players[1].resources.ore, 0);
  assert.equal(s.players[2].resources.ore, 1);
  assert.equal(handTotal(s.players[2].resources), 1, '沒有資源的人不用傳');
  // 牌庫用完重洗
  s = mk(); s.eventDeck = [];
  restore = forceDice(5, 5); applyAction(s, 0, { type: 'roll' }); restore();
  assert.ok(s.lastEvent);
  assert.equal(s.eventDeck.length, EVENTS.length - 1);
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
