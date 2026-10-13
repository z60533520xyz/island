// 卡坦島規則引擎：純資料、無 DOM 依賴。只由房主執行，客戶端只拿來做查詢（合法位置、分數等）。
import { geoFor, generateBoard, shuffle } from './geometry.js';

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_NAME = { wood: '木材', brick: '磚塊', sheep: '羊毛', wheat: '小麥', ore: '礦石' };
export const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️', desert: '🏜️' };
export const DEV_NAME = { knight: '騎士', vp: '勝利分數', roadBuilding: '道路建設', yearOfPlenty: '豐收之年', monopoly: '壟斷' };
export const DEV_DESC = {
  knight: '移動強盜並搶奪一張資源卡',
  vp: '+1 勝利分數（自動計入，不需打出）',
  roadBuilding: '免費建造 2 條道路',
  yearOfPlenty: '從銀行拿取任意 2 張資源',
  monopoly: '宣告一種資源，其他玩家須交出所有該資源',
};
export const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
export const COLORS = ['#d63031', '#0984e3', '#e67e22', '#27ae60', '#8e44ad', '#6d4c41'];
export const MAX_PLAYERS = 6;

export const WIN_VP = 10;

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

export const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
export const handTotal = (h) => RES.reduce((s, r) => s + (h[r] || 0), 0);
export const canAfford = (hand, cost) => RES.every((r) => (hand[r] || 0) >= (cost[r] || 0));

function pay(s, pid, cost) {
  const h = s.players[pid].resources;
  if (!canAfford(h, cost)) fail('資源不足');
  for (const r of RES) {
    const n = cost[r] || 0;
    h[r] -= n;
    s.bank[r] += n;
  }
}

function give(s, pid, r, n) {
  s.players[pid].resources[r] += n;
  s.bank[r] -= n;
}

function log(s, text) {
  s.log.push({ n: s.seq, text });
  if (s.log.length > 150) s.log.splice(0, s.log.length - 150);
}

const nm = (s, pid) => s.players[pid].name;

function rand(n) {
  return Math.floor(Math.random() * n);
}

// ---------------------------------------------------------------- 建立遊戲

export const DEFAULT_OPTIONS = { setupRoads: 1, specialBuild: true };

// 2~4 人用基本版，5~6 人用擴充版（較大地圖、較多資源與發展卡）
const SETS = {
  standard: { bank: 19, deck: { knight: 14, vp: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 } },
  large: { bank: 24, deck: { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 } },
};

export const layoutFor = (n) => (n >= 5 ? 'large' : 'standard');

export function geo(s) {
  return geoFor(s.board.layout || 'standard');
}

export function bankSize(s) {
  return SETS[s.board.layout || 'standard'].bank;
}

// 5~6 人時，每個回合結束後其他玩家依序進行「特別建設階段」
export function specialBuildEnabled(s) {
  return s.players.length >= 5 && (s.options?.specialBuild ?? true);
}

export function createGame(seats, opts = {}) {
  const n = seats.length;
  if (n < 2 || n > MAX_PLAYERS) fail(`需要 2~${MAX_PLAYERS} 位玩家`);
  const options = { ...DEFAULT_OPTIONS, ...opts };
  if (![1, 2].includes(options.setupRoads)) fail('起始道路數只能是 1 或 2');
  options.specialBuild = !!options.specialBuild;
  const layout = layoutFor(n);
  const set = SETS[layout];
  const deck = shuffle(Object.entries(set.deck).flatMap(([t, k]) => Array(k).fill(t)));
  const order = [...Array(n).keys(), ...[...Array(n).keys()].reverse()];
  const s = {
    phase: 'setup',
    board: generateBoard(layout),
    buildings: {},
    roads: {},
    players: seats.map((seat, i) => ({
      name: seat.name,
      color: COLORS[i],
      resources: emptyHand(),
      dev: [],
      knights: 0,
      roadLen: 0,
      pieces: { road: 15, settlement: 5, city: 4 },
    })),
    bank: Object.fromEntries(RES.map((r) => [r, set.bank])),
    deck,
    current: 0,
    turn: 0,
    options,
    setup: { order, idx: 0, stage: 'settlement', vertex: null, roads: [] },
    rolled: false,
    dice: null,
    devPlayed: false,
    pending: null,
    trade: null,
    longestRoad: null,
    largestArmy: null,
    winner: null,
    log: [],
    seq: 0,
  };
  log(s, `遊戲開始！${layout === 'large' ? '5~6 人擴充地圖。' : ''}每輪依序放置 1 座村莊 + ${options.setupRoads} 條道路，共兩輪（第二輪順序相反）。`);
  return s;
}

// ---------------------------------------------------------------- 查詢

export function victoryPoints(s, pid, includeHidden = true) {
  let vp = 0;
  for (const b of Object.values(s.buildings)) {
    if (b.owner === pid) vp += b.type === 'city' ? 2 : 1;
  }
  if (s.longestRoad === pid) vp += 2;
  if (s.largestArmy === pid) vp += 2;
  const dev = s.players[pid].dev;
  if (includeHidden && dev) vp += dev.filter((c) => c.type === 'vp').length;
  return vp;
}

function vertexFree(s, v) {
  if (s.buildings[v]) return false;
  return geo(s).vertices[v].adj.every((a) => !s.buildings[a]);
}

export function validSettlementVertices(s, pid) {
  const P = s.players[pid];
  if (P.pieces.settlement <= 0) return [];
  const setup = s.phase === 'setup';
  return geo(s).vertices
    .filter((v) => vertexFree(s, v.id) && (setup || v.edges.some((e) => s.roads[e] === pid)))
    .map((v) => v.id);
}

export function validCityVertices(s, pid) {
  if (s.players[pid].pieces.city <= 0) return [];
  return Object.entries(s.buildings)
    .filter(([, b]) => b.owner === pid && b.type === 'settlement')
    .map(([v]) => Number(v));
}

export function validRoadEdges(s, pid) {
  if (s.players[pid].pieces.road <= 0) return [];
  if (s.phase === 'setup') {
    const v = s.setup.vertex;
    if (v == null) return [];
    // 可以接在本輪剛放的村莊，或本輪已放的道路末端
    const ends = new Set([v]);
    for (const e of s.setup.roads || []) geo(s).edges[e].v.forEach((x) => ends.add(x));
    return [...new Set([...ends].flatMap((x) => geo(s).vertices[x].edges))].filter((e) => s.roads[e] == null);
  }
  return geo(s).edges
    .filter((e) => {
      if (s.roads[e.id] != null) return false;
      return e.v.some((v) => {
        const b = s.buildings[v];
        if (b && b.owner === pid) return true;
        if (b && b.owner !== pid) return false; // 被別人的建築阻斷
        return geo(s).vertices[v].edges.some((o) => o !== e.id && s.roads[o] === pid);
      });
    })
    .map((e) => e.id);
}

export function tradeRatios(s, pid) {
  const ratios = { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
  for (const port of s.board.ports) {
    const owned = geo(s).edges[port.edge].v.some((v) => s.buildings[v] && s.buildings[v].owner === pid);
    if (!owned) continue;
    if (port.type === 'any') {
      for (const r of RES) ratios[r] = Math.min(ratios[r], 3);
    } else {
      ratios[port.type] = 2;
    }
  }
  return ratios;
}

export function longestRoadFor(s, pid) {
  let best = 0;
  const blocked = (v) => s.buildings[v] && s.buildings[v].owner !== pid;
  const used = new Set();
  const dfs = (v, len) => {
    if (len > best) best = len;
    if (blocked(v)) return;
    for (const e of geo(s).vertices[v].edges) {
      if (s.roads[e] !== pid || used.has(e)) continue;
      used.add(e);
      const [a, b] = geo(s).edges[e].v;
      dfs(a === v ? b : a, len + 1);
      used.delete(e);
    }
  };
  for (const [eid, owner] of Object.entries(s.roads)) {
    if (owner !== pid) continue;
    const e = geo(s).edges[eid];
    // 從這條邊出發，分別往兩個端點延伸
    for (const end of e.v) {
      used.add(e.id);
      dfs(end, 1);
      used.delete(e.id);
    }
  }
  return best;
}

export function playableDev(s, pid) {
  const dev = s.players[pid].dev || [];
  return dev.filter((c) => c.type !== 'vp' && c.turn < s.turn).map((c) => c.type);
}

// ---------------------------------------------------------------- 狀態更新輔助

function updateLongestRoad(s) {
  const lens = s.players.map((_, i) => longestRoadFor(s, i));
  lens.forEach((l, i) => { s.players[i].roadLen = l; });
  const max = Math.max(...lens);
  const holder = s.longestRoad;
  let next;
  if (max < 5) next = null;
  else if (holder != null && lens[holder] === max) next = holder;
  else {
    const top = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
    next = top.length === 1 ? top[0] : null;
  }
  if (next !== holder) {
    s.longestRoad = next;
    if (next != null) log(s, `🛣️ ${nm(s, next)} 取得「最長道路」（${max} 段）`);
    else log(s, '🛣️ 「最長道路」暫時無人持有');
  }
}

function updateLargestArmy(s, pid) {
  const k = s.players[pid].knights;
  if (k < 3 || s.largestArmy === pid) return;
  const holder = s.largestArmy;
  if (holder == null || k > s.players[holder].knights) {
    s.largestArmy = pid;
    log(s, `⚔️ ${nm(s, pid)} 取得「最大騎士團」（${k} 位騎士）`);
  }
}

function produce(s, sum) {
  const demand = {};
  for (const r of RES) demand[r] = {};
  s.board.hexes.forEach((hex, hid) => {
    if (hex.number !== sum || hid === s.board.robber) return;
    for (const v of geo(s).hexes[hid].vertices) {
      const b = s.buildings[v];
      if (!b) continue;
      const d = demand[hex.resource];
      d[b.owner] = (d[b.owner] || 0) + (b.type === 'city' ? 2 : 1);
    }
  });
  const gains = s.players.map(() => emptyHand());
  for (const r of RES) {
    const entries = Object.entries(demand[r]);
    if (!entries.length) continue;
    const total = entries.reduce((a, [, n]) => a + n, 0);
    if (total <= s.bank[r]) {
      for (const [pid, n] of entries) gains[pid][r] += n;
    } else if (entries.length === 1) {
      gains[entries[0][0]][r] += s.bank[r];
      log(s, `銀行的${RES_NAME[r]}不足，只能發出剩餘的 ${s.bank[r]} 張`);
    } else {
      log(s, `銀行的${RES_NAME[r]}不足，本次無人獲得${RES_NAME[r]}`);
    }
  }
  let any = false;
  gains.forEach((g, pid) => {
    if (!handTotal(g)) return;
    any = true;
    for (const r of RES) if (g[r]) give(s, pid, r, g[r]);
    log(s, `${nm(s, pid)} 獲得 ${fmtHand(g)}`);
  });
  if (!any) log(s, '沒有人獲得資源');
}

export function fmtHand(h) {
  return RES.filter((r) => h[r]).map((r) => `${RES_ICON[r]}×${h[r]}`).join(' ');
}

function stealRandom(s, thief, victim) {
  const h = s.players[victim].resources;
  const cards = RES.flatMap((r) => Array(h[r]).fill(r));
  if (!cards.length) return;
  const r = cards[rand(cards.length)];
  h[r]--;
  s.players[thief].resources[r]++;
  log(s, `🦹 ${nm(s, thief)} 從 ${nm(s, victim)} 搶走 1 張資源卡`);
}

function afterRobberMoved(s, pid) {
  const hex = s.board.robber;
  const victims = new Set();
  for (const v of geo(s).hexes[hex].vertices) {
    const b = s.buildings[v];
    if (b && b.owner !== pid && handTotal(s.players[b.owner].resources) > 0) victims.add(b.owner);
  }
  const list = [...victims];
  if (list.length === 0) s.pending = null;
  else if (list.length === 1) {
    stealRandom(s, pid, list[0]);
    s.pending = null;
  } else s.pending = { type: 'steal', candidates: list };
}

function validHand(h) {
  return h && RES.every((r) => Number.isInteger(h[r] ?? 0) && (h[r] ?? 0) >= 0);
}

function normHand(h) {
  const out = emptyHand();
  for (const r of RES) out[r] = (h && h[r]) || 0;
  return out;
}

function nextTurn(s) {
  s.current = (s.current + 1) % s.players.length;
  s.turn++;
  s.rolled = false;
  s.devPlayed = false;
  s.dice = null;
  log(s, `—— 輪到 ${nm(s, s.current)} ——`);
}

// ---------------------------------------------------------------- 動作

export function applyAction(s, pid, a) {
  if (!a || typeof a.type !== 'string') fail('無效的動作');
  if (s.phase === 'ended') fail('遊戲已結束');
  const P = s.players[pid];
  if (!P) fail('無效的玩家');

  const isCurrent = pid === s.current;
  const requireTurn = () => { if (!isCurrent) fail('還沒輪到你'); };
  const requireMain = () => {
    requireTurn();
    if (s.phase !== 'play') fail('現在不能這麼做');
    if (s.pending) fail('請先完成目前的步驟');
    if (!s.rolled) fail('請先擲骰子');
  };
  // 特別建設階段：只有排在佇列最前面的玩家可以建造或購買發展卡
  const special = s.pending?.type === 'specialBuild';
  const isBuilder = special && s.pending.queue[0] === pid;
  const requireBuild = () => {
    if (!special) requireMain();
    else if (!isBuilder) fail('還沒輪到你建設');
  };

  switch (a.type) {
    case 'build': {
      if (!isBuilder) requireTurn();
      const kind = a.kind;
      if (s.phase === 'setup') {
        if (kind !== s.setup.stage) fail(s.setup.stage === 'settlement' ? '請放置村莊' : '請放置道路');
        if (kind === 'settlement') {
          if (!validSettlementVertices(s, pid).includes(a.at)) fail('這裡不能蓋村莊');
          s.buildings[a.at] = { owner: pid, type: 'settlement' };
          P.pieces.settlement--;
          s.setup.vertex = a.at;
          s.setup.stage = 'road';
          if (s.setup.idx >= s.players.length) {
            const g = emptyHand();
            for (const hid of geo(s).vertices[a.at].hexes) {
              const r = s.board.hexes[hid].resource;
              if (r !== 'desert') g[r]++;
            }
            for (const r of RES) if (g[r]) give(s, pid, r, g[r]);
            log(s, `${nm(s, pid)} 放置第二座村莊，獲得 ${fmtHand(g) || '（無）'}`);
          } else {
            log(s, `${nm(s, pid)} 放置了村莊`);
          }
        } else if (kind === 'road') {
          if (!validRoadEdges(s, pid).includes(a.at)) fail('道路必須連接剛放置的村莊或道路');
          s.roads[a.at] = pid;
          P.pieces.road--;
          (s.setup.roads ||= []).push(a.at);
          if (s.setup.roads.length < (s.options?.setupRoads ?? 1) && validRoadEdges(s, pid).length) break;
          s.setup.roads = [];
          s.setup.idx++;
          s.setup.vertex = null;
          s.setup.stage = 'settlement';
          if (s.setup.idx >= s.setup.order.length) {
            s.phase = 'play';
            s.current = 0;
            s.turn = 1;
            s.rolled = false;
            updateLongestRoad(s);
            log(s, `準備完成！輪到 ${nm(s, 0)} 擲骰子。`);
          } else {
            s.current = s.setup.order[s.setup.idx];
          }
        } else fail('現在不能這麼做');
        break;
      }

      if (s.phase !== 'play') fail('現在不能這麼做');
      if (kind === 'road' && s.pending && s.pending.type === 'roadBuilding') {
        if (!validRoadEdges(s, pid).includes(a.at)) fail('這裡不能蓋道路');
        s.roads[a.at] = pid;
        P.pieces.road--;
        s.pending.remaining--;
        log(s, `${nm(s, pid)} 使用道路建設蓋了一條道路`);
        updateLongestRoad(s);
        if (s.pending.remaining <= 0 || validRoadEdges(s, pid).length === 0) s.pending = null;
        break;
      }
      requireBuild();
      if (kind === 'road') {
        if (!validRoadEdges(s, pid).includes(a.at)) fail('這裡不能蓋道路');
        pay(s, pid, COST.road);
        s.roads[a.at] = pid;
        P.pieces.road--;
        log(s, `${nm(s, pid)} 蓋了一條道路`);
        updateLongestRoad(s);
      } else if (kind === 'settlement') {
        if (!validSettlementVertices(s, pid).includes(a.at)) fail('這裡不能蓋村莊');
        pay(s, pid, COST.settlement);
        s.buildings[a.at] = { owner: pid, type: 'settlement' };
        P.pieces.settlement--;
        log(s, `${nm(s, pid)} 蓋了一座村莊`);
        updateLongestRoad(s);
      } else if (kind === 'city') {
        if (!validCityVertices(s, pid).includes(a.at)) fail('這裡不能升級城市');
        pay(s, pid, COST.city);
        s.buildings[a.at] = { owner: pid, type: 'city' };
        P.pieces.city--;
        P.pieces.settlement++;
        log(s, `${nm(s, pid)} 將村莊升級為城市`);
      } else fail('未知的建築');
      break;
    }

    case 'roll': {
      requireTurn();
      if (s.phase !== 'play') fail('現在不能擲骰');
      if (s.rolled) fail('本回合已經擲過骰子');
      if (s.pending) fail('請先完成目前的步驟');
      const d1 = 1 + rand(6);
      const d2 = 1 + rand(6);
      s.dice = [d1, d2];
      s.rolled = true;
      const sum = d1 + d2;
      log(s, `🎲 ${nm(s, pid)} 擲出 ${d1} + ${d2} = ${sum}`);
      if (sum === 7) {
        const need = {};
        s.players.forEach((p, i) => {
          const t = handTotal(p.resources);
          if (t > 7) need[i] = Math.floor(t / 2);
        });
        if (Object.keys(need).length) {
          s.pending = { type: 'discard', need };
          log(s, `手牌超過 7 張的玩家須棄掉一半：${Object.entries(need).map(([i, n]) => `${nm(s, +i)}(${n})`).join('、')}`);
        } else {
          s.pending = { type: 'robber' };
        }
      } else {
        produce(s, sum);
      }
      break;
    }

    case 'discard': {
      if (!s.pending || s.pending.type !== 'discard') fail('現在不需要棄牌');
      const need = s.pending.need[pid];
      if (!need) fail('你不需要棄牌');
      if (!validHand(a.resources)) fail('無效的棄牌');
      const d = normHand(a.resources);
      if (handTotal(d) !== need) fail(`必須剛好棄 ${need} 張`);
      if (!canAfford(P.resources, d)) fail('資源不足');
      pay(s, pid, d);
      delete s.pending.need[pid];
      log(s, `${nm(s, pid)} 棄掉 ${need} 張牌`);
      if (!Object.keys(s.pending.need).length) s.pending = { type: 'robber' };
      break;
    }

    case 'moveRobber': {
      requireTurn();
      if (!s.pending || s.pending.type !== 'robber') fail('現在不能移動強盜');
      const hex = a.hex;
      if (!Number.isInteger(hex) || hex < 0 || hex >= geo(s).hexes.length) fail('無效的地塊');
      if (hex === s.board.robber) fail('強盜必須移到其他地塊');
      s.board.robber = hex;
      const h = s.board.hexes[hex];
      log(s, `🦹 ${nm(s, pid)} 將強盜移到 ${RES_ICON[h.resource]}${h.number ? ` ${h.number}` : ''}`);
      afterRobberMoved(s, pid);
      break;
    }

    case 'steal': {
      requireTurn();
      if (!s.pending || s.pending.type !== 'steal') fail('現在不能搶奪');
      if (!s.pending.candidates.includes(a.target)) fail('無效的目標');
      stealRandom(s, pid, a.target);
      s.pending = null;
      break;
    }

    case 'buyDev': {
      requireBuild();
      if (!s.deck.length) fail('發展卡已售完');
      pay(s, pid, COST.dev);
      const type = s.deck.pop();
      P.dev.push({ type, turn: s.turn });
      log(s, `${nm(s, pid)} 購買了一張發展卡`);
      break;
    }

    case 'playDev': {
      requireTurn();
      if (s.phase !== 'play') fail('現在不能使用發展卡');
      if (s.pending) fail('請先完成目前的步驟');
      if (s.devPlayed) fail('每回合只能使用一張發展卡');
      const idx = P.dev.findIndex((c) => c.type === a.card && c.type !== 'vp' && c.turn < s.turn);
      if (idx < 0) fail('你沒有可以使用的這種卡（本回合購買的卡不能使用）');
      if (a.card === 'yearOfPlenty') {
        const list = a.resources;
        if (!Array.isArray(list) || list.length !== 2 || !list.every((r) => RES.includes(r))) fail('請選擇 2 種資源');
        const want = emptyHand();
        list.forEach((r) => want[r]++);
        if (!canAfford(s.bank, want)) fail('銀行資源不足');
        for (const r of RES) if (want[r]) give(s, pid, r, want[r]);
        log(s, `✨ ${nm(s, pid)} 使用豐收之年，獲得 ${fmtHand(want)}`);
      } else if (a.card === 'monopoly') {
        if (!RES.includes(a.resource)) fail('請選擇資源');
        let got = 0;
        s.players.forEach((p, i) => {
          if (i === pid) return;
          got += p.resources[a.resource];
          p.resources[a.resource] = 0;
        });
        P.resources[a.resource] += got;
        log(s, `💰 ${nm(s, pid)} 使用壟斷，收走所有${RES_NAME[a.resource]}（共 ${got} 張）`);
      } else if (a.card === 'knight') {
        P.knights++;
        log(s, `⚔️ ${nm(s, pid)} 使用騎士`);
        updateLargestArmy(s, pid);
        s.pending = { type: 'robber' };
      } else if (a.card === 'roadBuilding') {
        const remaining = Math.min(2, P.pieces.road);
        log(s, `🛠️ ${nm(s, pid)} 使用道路建設`);
        if (remaining > 0 && validRoadEdges(s, pid).length) s.pending = { type: 'roadBuilding', remaining };
      } else fail('未知的發展卡');
      P.dev.splice(idx, 1);
      s.devPlayed = true;
      break;
    }

    case 'skipRoadBuilding': {
      requireTurn();
      if (!s.pending || s.pending.type !== 'roadBuilding') fail('現在不需要');
      s.pending = null;
      break;
    }

    case 'bankTrade': {
      requireMain();
      const { give: g, get } = a;
      if (!RES.includes(g) || !RES.includes(get) || g === get) fail('無效的交易');
      const ratio = tradeRatios(s, pid)[g];
      if (P.resources[g] < ratio) fail(`需要 ${ratio} 張${RES_NAME[g]}`);
      if (s.bank[get] < 1) fail('銀行沒有這種資源了');
      P.resources[g] -= ratio;
      s.bank[g] += ratio;
      give(s, pid, get, 1);
      log(s, `${nm(s, pid)} 與銀行交易 ${RES_ICON[g]}×${ratio} → ${RES_ICON[get]}×1`);
      break;
    }

    case 'tradeOffer': {
      requireMain();
      if (!validHand(a.give) || !validHand(a.want)) fail('無效的交易');
      const g = normHand(a.give);
      const w = normHand(a.want);
      if (!handTotal(g) || !handTotal(w)) fail('交易雙方都必須至少有一張牌');
      if (RES.some((r) => g[r] && w[r])) fail('不能同時給出與索取同一種資源');
      if (!canAfford(P.resources, g)) fail('你的資源不足');
      s.trade = { id: s.seq, give: g, want: w, responses: {} };
      log(s, `🤝 ${nm(s, pid)} 提出交易：給 ${fmtHand(g)}，換 ${fmtHand(w)}`);
      break;
    }

    case 'tradeRespond': {
      if (!s.trade) fail('目前沒有交易提案');
      if (isCurrent) fail('不能回應自己的提案');
      if (a.accept && !canAfford(P.resources, s.trade.want)) fail('你的資源不足以接受');
      s.trade.responses[pid] = !!a.accept;
      log(s, `${nm(s, pid)} ${a.accept ? '願意接受' : '拒絕了'}交易`);
      break;
    }

    case 'tradeAccept': {
      requireMain();
      const t = s.trade;
      if (!t) fail('目前沒有交易提案');
      const other = a.with;
      if (t.responses[other] !== true) fail('對方尚未接受');
      const O = s.players[other];
      if (!canAfford(P.resources, t.give)) fail('你的資源不足');
      if (!canAfford(O.resources, t.want)) fail('對方資源不足');
      for (const r of RES) {
        P.resources[r] += t.want[r] - t.give[r];
        O.resources[r] += t.give[r] - t.want[r];
      }
      log(s, `🤝 ${nm(s, pid)} 與 ${nm(s, other)} 完成交易`);
      s.trade = null;
      break;
    }

    case 'tradeCancel': {
      requireTurn();
      if (s.trade) log(s, `${nm(s, pid)} 取消了交易提案`);
      s.trade = null;
      break;
    }

    case 'endTurn': {
      requireMain();
      s.trade = null;
      if (specialBuildEnabled(s)) {
        const n = s.players.length;
        const queue = Array.from({ length: n - 1 }, (_, k) => (s.current + 1 + k) % n);
        s.pending = { type: 'specialBuild', queue };
        log(s, '🔨 特別建設階段：其他玩家依序可以建造或購買發展卡（不能交易）');
      } else {
        nextTurn(s);
      }
      break;
    }

    case 'passBuild': {
      if (!isBuilder) fail('還沒輪到你建設');
      s.pending.queue.shift();
      if (!s.pending.queue.length) {
        s.pending = null;
        nextTurn(s);
      }
      break;
    }

    default:
      fail('未知的動作');
  }

  if (s.phase === 'play' && victoryPoints(s, s.current) >= WIN_VP) {
    s.phase = 'ended';
    s.winner = s.current;
    s.pending = null;
    s.trade = null;
    log(s, `🏆 ${nm(s, s.current)} 達到 ${victoryPoints(s, s.current)} 分，獲得勝利！`);
  }
  s.seq++;
}

// 依觀看者隱藏其他玩家的手牌與發展卡（遊戲結束後全部公開）
export function viewFor(s, viewer) {
  const v = JSON.parse(JSON.stringify(s));
  v.deckCount = s.deck.length;
  v.deck = null;
  v.players.forEach((p, i) => {
    p.handCount = handTotal(p.resources);
    p.devCount = p.dev.length;
    if (i !== viewer && s.phase !== 'ended') {
      p.resources = null;
      p.dev = null;
    }
  });
  return v;
}
