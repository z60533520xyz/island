// 大選戰規則引擎：純資料、無 DOM 依賴。只由房主執行，客戶端只拿來做查詢（合法位置、分數等）。
import { geoFor, generateBoard, shuffle } from './geometry.js';

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_NAME = { wood: '文宣', brick: '看板', sheep: '志工', wheat: '便當', ore: '資金' };
export const RES_ICON = { wood: '📄', brick: '🪧', sheep: '🙋', wheat: '🍱', ore: '💰', desert: '🥀' };
export const DEV_NAME = { knight: '樁腳', vp: '民調領先', roadBuilding: '掃街拜票', yearOfPlenty: '募款餐會', monopoly: '媒體壟斷' };
export const DEV_DESC = {
  knight: '動員樁腳：移動黑函並挖角一張資源（黑函須在你的服務處或競選總部旁才能使用）',
  vp: '+1 得票（自動計入，不需打出）',
  roadBuilding: '免費開闢 2 條掃街路線',
  yearOfPlenty: '從公庫募得任意 2 張資源',
  monopoly: '指定一種資源，其他玩家須交出所有該資源',
};
export const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
// 玩家顏色：各政黨主要顏色（藍、綠、青綠、黃、橘），紅色為虛構的「統戰」陣營
export const COLORS = ['#1f4fb4', '#1b9431', '#1fb5b5', '#f5b800', '#ff6a13', '#d32f2f'];
export const MAX_PLAYERS = 6;

// 陣營技能：依玩家顏色（順序）對應
export const FACTIONS = [
  { id: 'blue', color: '藍', title: '黑金', skill: '💰資金與公庫交易 2:1；黑函事件棄牌時資金不計入手牌（藏錢）' },
  { id: 'green', color: '綠', title: '青鳥', skill: '出征：移動黑函時可以挖角 2 張' },
  { id: 'teal', color: '青', title: '小草', skill: '小額捐款：自己擲骰後若沒拿到任何資源，從公庫獲得 1 張🙋志工' },
  { id: 'yellow', color: '黃', title: '社運', skill: '掃街路線只需 📄文宣×1' },
  { id: 'orange', color: '橘', title: '合縱連橫', skill: '所有資源與公庫交易 3:1' },
  { id: 'red', color: '紅', title: '統戰', skill: '境外金援：每次自己擲骰時從公庫獲得 1 張💰資金；但不能與其他玩家交易' },
];

export function factionOf(s, pid) {
  return s.players[pid]?.faction || null;
}

// 依陣營調整後的建造成本
export function costFor(s, pid, kind) {
  if (kind === 'road' && factionOf(s, pid) === 'yellow') return { wood: 1 };
  return COST[kind];
}

// 黑函事件時計入棄牌的手牌數（黑金的資金不計入）
export function discardableCount(s, pid) {
  const h = s.players[pid].resources;
  return handTotal(h) - (factionOf(s, pid) === 'blue' ? h.ore : 0);
}

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

export const DEFAULT_OPTIONS = { setupRoads: 1, specialBuild: true, shuffleSeats: true, factions: true };

// 2~4 人用標準地圖，5~6 人用大地圖（較多資源與錦囊卡）
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
  if (![1, 2].includes(options.setupRoads)) fail('起始掃街路線數只能是 1 或 2');
  options.specialBuild = !!options.specialBuild;
  options.shuffleSeats = !!options.shuffleSeats;
  options.factions = !!options.factions;
  // 玩家順序（= 回合順序、顏色）；seat 記錄他在大廳的座位，讓房主對應連線
  const seatOrder = [...Array(n).keys()];
  if (options.shuffleSeats) shuffle(seatOrder);
  const layout = layoutFor(n);
  const set = SETS[layout];
  const deck = shuffle(Object.entries(set.deck).flatMap(([t, k]) => Array(k).fill(t)));
  const order = [...Array(n).keys(), ...[...Array(n).keys()].reverse()];
  const s = {
    phase: 'setup',
    board: generateBoard(layout),
    buildings: {},
    roads: {},
    players: seatOrder.map((seatIdx, i) => ({
      name: seats[seatIdx].name,
      seat: seatIdx,
      color: COLORS[i],
      faction: options.factions ? FACTIONS[i].id : null,
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
    built: false, // 本回合是否已進入建設階段（之後不能交易）
    pending: null,
    trade: null,
    longestRoad: null,
    largestArmy: null,
    winner: null,
    log: [],
    seq: 0,
  };
  log(s, `${options.shuffleSeats ? '🎲 隨機決定順序' : '依座位順序'}：${s.players.map((p) => p.name).join(' → ')}`);
  if (options.factions) log(s, `陣營：${s.players.map((p, i) => `${p.name}「${FACTIONS[i].title}」`).join('、')}`);
  log(s, `遊戲開始！${layout === 'large' ? '5~6 人大地圖。' : ''}每輪依序設立 1 間服務處 + ${options.setupRoads} 條掃街路線，共兩輪（第二輪順序相反）。`);
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
    // 佈局階段：旁邊必須還有空的邊可以放掃街路線，否則會卡住
    .filter((v) => vertexFree(s, v.id) && (setup ? v.edges.some((e) => s.roads[e] == null) : v.edges.some((e) => s.roads[e] === pid)))
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
    // 可以接在本輪剛放的服務處，或本輪已放的掃街路線末端
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
  const f = factionOf(s, pid);
  if (f === 'orange') for (const r of RES) ratios[r] = 3;
  if (f === 'blue') ratios.ore = 2;
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

// 黑函必須在自己的服務處或競選總部旁邊，才能動員樁腳
export function robberNearOwn(s, pid) {
  return geo(s).hexes[s.board.robber].vertices.some((v) => s.buildings[v]?.owner === pid);
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
    if (next != null) log(s, `🚶 ${nm(s, next)} 取得「最長掃街路線」（${max} 段）`);
    else log(s, '🚶 「最長掃街路線」暫時無人持有');
  }
}

function updateLargestArmy(s, pid) {
  const k = s.players[pid].knights;
  if (k < 3 || s.largestArmy === pid) return;
  const holder = s.largestArmy;
  if (holder == null || k > s.players[holder].knights) {
    s.largestArmy = pid;
    log(s, `👥 ${nm(s, pid)} 取得「最強樁腳網」（${k} 位樁腳）`);
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
      log(s, `公庫的${RES_NAME[r]}不足，只能發出剩餘的 ${s.bank[r]} 張`);
    } else {
      log(s, `公庫的${RES_NAME[r]}不足，本次無人獲得${RES_NAME[r]}`);
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
  return gains;
}

// 統戰：每次自己擲骰，獲得 1 張境外資金
function foreignFunding(s, pid) {
  if (factionOf(s, pid) !== 'red' || s.bank.ore < 1) return;
  give(s, pid, 'ore', 1);
  log(s, `🧧 ${nm(s, pid)} 獲得境外金援：💰×1`);
}

// 小草：自己擲骰後沒拿到資源，獲得 1 張志工
function smallDonation(s, pid, gained) {
  if (factionOf(s, pid) !== 'teal' || gained || s.bank.sheep < 1) return;
  give(s, pid, 'sheep', 1);
  log(s, `🌱 ${nm(s, pid)} 的小額捐款：獲得 🙋×1`);
}

export function fmtHand(h) {
  return RES.filter((r) => h[r]).map((r) => `${RES_ICON[r]}×${h[r]}`).join(' ');
}

function steal(s, thief, victim, r) {
  s.players[victim].resources[r]--;
  s.players[thief].resources[r]++;
  log(s, `🕵️ ${nm(s, thief)} 從 ${nm(s, victim)} 挖走 1 張資源卡`);
}

function afterRobberMoved(s, pid) {
  const hex = s.board.robber;
  const victims = new Set();
  for (const v of geo(s).hexes[hex].vertices) {
    const b = s.buildings[v];
    if (b && b.owner !== pid && handTotal(s.players[b.owner].resources) > 0) victims.add(b.owner);
  }
  const list = [...victims];
  // 黑函一律自己選擇對象與資源（即使只有一位可挖角）
  s.pending = list.length ? { type: 'steal', candidates: list } : null;
}

function validHand(h) {
  return h && RES.every((r) => Number.isInteger(h[r] ?? 0) && (h[r] ?? 0) >= 0);
}

function normHand(h) {
  const out = emptyHand();
  for (const r of RES) out[r] = (h && h[r]) || 0;
  return out;
}

// 回合分為「交易 → 建設」兩個階段：一旦建造或購買錦囊卡，本回合就不能再交易
function enterBuildPhase(s) {
  if (s.built) return;
  s.built = true;
  if (s.trade) {
    s.trade = null;
    log(s, '已進入建設階段，交易提案自動取消');
  }
}

function nextTurn(s) {
  s.current = (s.current + 1) % s.players.length;
  s.turn++;
  s.rolled = false;
  s.devPlayed = false;
  s.built = false;
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
  // 特別建設階段：只有排在佇列最前面的玩家可以建造或購買錦囊卡
  const special = s.pending?.type === 'specialBuild';
  const isBuilder = special && s.pending.queue[0] === pid;
  const requireTrade = () => {
    requireMain();
    if (s.built) fail('已進入建設階段，本回合不能再交易');
  };
  const requireBuild = () => {
    if (!special) requireMain();
    else if (!isBuilder) fail('還沒輪到你建設');
  };

  switch (a.type) {
    case 'build': {
      if (!isBuilder) requireTurn();
      const kind = a.kind;
      if (s.phase === 'setup') {
        if (kind !== s.setup.stage) fail(s.setup.stage === 'settlement' ? '請設立服務處' : '請放置掃街路線');
        if (kind === 'settlement') {
          if (!validSettlementVertices(s, pid).includes(a.at)) fail('這裡不能設立服務處');
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
            log(s, `${nm(s, pid)} 設立第二間服務處，獲得 ${fmtHand(g) || '（無）'}`);
          } else {
            log(s, `${nm(s, pid)} 設立了服務處`);
          }
        } else if (kind === 'road') {
          if (!validRoadEdges(s, pid).includes(a.at)) fail('掃街路線必須連接剛放置的服務處或掃街路線');
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
        if (!validRoadEdges(s, pid).includes(a.at)) fail('這裡不能開闢掃街路線');
        s.roads[a.at] = pid;
        P.pieces.road--;
        s.pending.remaining--;
        log(s, `${nm(s, pid)} 透過掃街拜票開闢了一條掃街路線`);
        updateLongestRoad(s);
        if (s.pending.remaining <= 0 || validRoadEdges(s, pid).length === 0) s.pending = null;
        break;
      }
      requireBuild();
      if (kind === 'road') {
        if (!validRoadEdges(s, pid).includes(a.at)) fail('這裡不能開闢掃街路線');
        pay(s, pid, costFor(s, pid, 'road'));
        enterBuildPhase(s);
        s.roads[a.at] = pid;
        P.pieces.road--;
        log(s, `${nm(s, pid)} 開闢了一條掃街路線`);
        updateLongestRoad(s);
      } else if (kind === 'settlement') {
        if (!validSettlementVertices(s, pid).includes(a.at)) fail('這裡不能設立服務處');
        pay(s, pid, COST.settlement);
        enterBuildPhase(s);
        s.buildings[a.at] = { owner: pid, type: 'settlement' };
        P.pieces.settlement--;
        log(s, `${nm(s, pid)} 設立了一間服務處`);
        updateLongestRoad(s);
      } else if (kind === 'city') {
        if (!validCityVertices(s, pid).includes(a.at)) fail('這裡不能升級競選總部');
        pay(s, pid, COST.city);
        enterBuildPhase(s);
        s.buildings[a.at] = { owner: pid, type: 'city' };
        P.pieces.city--;
        P.pieces.settlement++;
        log(s, `${nm(s, pid)} 將服務處升級為競選總部`);
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
          const t = discardableCount(s, i);
          if (t > 7) need[i] = Math.floor(t / 2);
        });
        smallDonation(s, pid, false);
        foreignFunding(s, pid);
        if (Object.keys(need).length) {
          s.pending = { type: 'discard', need };
          log(s, `手牌超過 7 張的玩家須棄掉一半：${Object.entries(need).map(([i, n]) => `${nm(s, +i)}(${n})`).join('、')}`);
        } else {
          s.pending = { type: 'robber' };
        }
      } else {
        const gains = produce(s, sum);
        smallDonation(s, pid, handTotal(gains[pid]) > 0);
        foreignFunding(s, pid);
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
      if (factionOf(s, pid) === 'blue' && d.ore) fail('黑金的資金不計入棄牌，請棄其他資源');
      if (!canAfford(P.resources, d)) fail('資源不足');
      pay(s, pid, d);
      delete s.pending.need[pid];
      log(s, `${nm(s, pid)} 棄掉 ${need} 張牌`);
      if (!Object.keys(s.pending.need).length) s.pending = { type: 'robber' };
      break;
    }

    case 'moveRobber': {
      requireTurn();
      if (!s.pending || s.pending.type !== 'robber') fail('現在不能移動黑函');
      const hex = a.hex;
      if (!Number.isInteger(hex) || hex < 0 || hex >= geo(s).hexes.length) fail('無效的選區');
      if (hex === s.board.robber) fail('黑函必須移到其他選區');
      s.board.robber = hex;
      const h = s.board.hexes[hex];
      log(s, `🕵️ ${nm(s, pid)} 將黑函投向 ${RES_ICON[h.resource]}${h.number ? ` ${h.number}` : ''}`);
      afterRobberMoved(s, pid);
      break;
    }

    case 'steal': {
      requireTurn();
      if (!s.pending || s.pending.type !== 'steal') fail('現在不能挖角');
      if (!s.pending.candidates.includes(a.target)) fail('無效的目標');
      if (!RES.includes(a.resource)) fail('請選擇要挖角的資源');
      if (!(s.players[a.target].resources[a.resource] > 0)) fail('對方沒有這種資源');
      steal(s, pid, a.target, a.resource);
      const left = (s.pending.left ?? (factionOf(s, pid) === 'green' ? 2 : 1)) - 1;
      const still = s.pending.candidates.filter((i) => handTotal(s.players[i].resources) > 0);
      if (left > 0 && still.length) {
        s.pending = { type: 'steal', candidates: still, left };
        log(s, `🐦 ${nm(s, pid)} 的青鳥出征：可以再挖角 1 張`);
      } else {
        s.pending = null;
      }
      break;
    }

    case 'buyDev': {
      requireBuild();
      if (!s.deck.length) fail('錦囊卡已售完');
      pay(s, pid, COST.dev);
      enterBuildPhase(s);
      const type = s.deck.pop();
      P.dev.push({ type, turn: s.turn });
      log(s, `${nm(s, pid)} 購買了一張錦囊卡`);
      break;
    }

    case 'playDev': {
      requireTurn();
      if (s.phase !== 'play') fail('現在不能使用錦囊卡');
      if (s.pending) fail('請先完成目前的步驟');
      if (s.devPlayed) fail('每回合只能使用一張錦囊卡');
      if (a.card === 'knight' && !robberNearOwn(s, pid)) fail('黑函必須在你的服務處或競選總部旁邊才能使用樁腳');
      const idx = P.dev.findIndex((c) => c.type === a.card && c.type !== 'vp' && c.turn < s.turn);
      if (idx < 0) fail('你沒有可以使用的這種卡（本回合購買的卡不能使用）');
      if (a.card === 'yearOfPlenty') {
        const list = a.resources;
        if (!Array.isArray(list) || list.length !== 2 || !list.every((r) => RES.includes(r))) fail('請選擇 2 種資源');
        const want = emptyHand();
        list.forEach((r) => want[r]++);
        if (!canAfford(s.bank, want)) fail('公庫資源不足');
        for (const r of RES) if (want[r]) give(s, pid, r, want[r]);
        log(s, `🍽️ ${nm(s, pid)} 使用募款餐會，獲得 ${fmtHand(want)}`);
      } else if (a.card === 'monopoly') {
        if (!RES.includes(a.resource)) fail('請選擇資源');
        let got = 0;
        s.players.forEach((p, i) => {
          if (i === pid) return;
          got += p.resources[a.resource];
          p.resources[a.resource] = 0;
        });
        P.resources[a.resource] += got;
        log(s, `📺 ${nm(s, pid)} 使用媒體壟斷，收走所有${RES_NAME[a.resource]}（共 ${got} 張）`);
      } else if (a.card === 'knight') {
        P.knights++;
        log(s, `👥 ${nm(s, pid)} 使用樁腳`);
        updateLargestArmy(s, pid);
        s.pending = { type: 'robber' };
      } else if (a.card === 'roadBuilding') {
        const remaining = Math.min(2, P.pieces.road);
        log(s, `📢 ${nm(s, pid)} 使用掃街拜票`);
        if (remaining > 0 && validRoadEdges(s, pid).length) s.pending = { type: 'roadBuilding', remaining };
      } else fail('未知的錦囊卡');
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
      requireTrade();
      const { give: g, get } = a;
      if (!RES.includes(g) || !RES.includes(get) || g === get) fail('無效的交易');
      const ratio = tradeRatios(s, pid)[g];
      if (P.resources[g] < ratio) fail(`需要 ${ratio} 張${RES_NAME[g]}`);
      if (s.bank[get] < 1) fail('公庫沒有這種資源了');
      P.resources[g] -= ratio;
      s.bank[g] += ratio;
      give(s, pid, get, 1);
      log(s, `${nm(s, pid)} 與公庫交易 ${RES_ICON[g]}×${ratio} → ${RES_ICON[get]}×1`);
      break;
    }

    case 'tradeOffer': {
      requireTrade();
      if (factionOf(s, pid) === 'red') fail('統戰陣營不能與其他玩家交易');
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
      if (a.accept && factionOf(s, pid) === 'red') fail('統戰陣營不能與其他玩家交易');
      if (a.accept && !canAfford(P.resources, s.trade.want)) fail('你的資源不足以接受');
      s.trade.responses[pid] = !!a.accept;
      log(s, `${nm(s, pid)} ${a.accept ? '願意接受' : '拒絕了'}交易`);
      break;
    }

    case 'tradeAccept': {
      requireTrade();
      const t = s.trade;
      if (!t) fail('目前沒有交易提案');
      const other = a.with;
      if (t.responses[other] !== true) fail('對方尚未接受');
      if (factionOf(s, other) === 'red') fail('統戰陣營不能與其他玩家交易');
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
        log(s, '🔨 特別建設階段：其他玩家依序可以建造或購買錦囊卡（不能交易）');
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

// 資源卡公開；依觀看者隱藏其他玩家的錦囊卡（遊戲結束後全部公開）
export function viewFor(s, viewer) {
  const v = JSON.parse(JSON.stringify(s));
  v.deckCount = s.deck.length;
  v.deck = null;
  v.players.forEach((p, i) => {
    p.handCount = handTotal(p.resources);
    p.devCount = p.dev.length;
    if (i !== viewer && s.phase !== 'ended') p.dev = null;
  });
  return v;
}
