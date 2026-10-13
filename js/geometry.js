// 棋盤幾何：地塊為尖頂朝上的六角形。
// - standard：基本版 19 塊（2~4 人），54 個路口、72 條邊
// - large：5~6 人擴充版 30 塊（每列 3-4-5-6-5-4-3）
// 幾何結構是確定性的，所有玩家各自計算即可；只有資源/數字/港口配置需要由房主產生並同步。

const SQRT3 = Math.sqrt(3);

export const LAYOUTS = {
  standard: {
    rows: [3, 4, 5, 4, 3],
    tiles: { wood: 4, brick: 3, sheep: 4, wheat: 4, ore: 3, desert: 1 },
    numbers: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
    ports: ['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'],
  },
  large: {
    rows: [3, 4, 5, 6, 5, 4, 3],
    // 家規：3 塊沙漠（官方為 2 塊），因此少一塊羊毛與一個 12
    tiles: { wood: 6, brick: 5, sheep: 5, wheat: 6, ore: 5, desert: 3 },
    numbers: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12],
    ports: ['any', 'any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'sheep', 'wheat', 'ore'],
  },
};

// 依每列的地塊數產生軸座標 (q, r)；每列置中排列
function layoutCoords(rows) {
  const coords = [];
  const mid = (rows.length - 1) / 2;
  rows.forEach((len, i) => {
    const r = i - mid;
    // 列中心的 x = q + r/2 + (len-1)/2 = 0  →  q 起點
    const q0 = -r / 2 - (len - 1) / 2;
    for (let k = 0; k < len; k++) coords.push([q0 + k, r]);
  });
  return coords;
}

function buildGeometry(rows) {
  const hexes = layoutCoords(rows).map(([q, r], id) => ({
    id, q, r,
    x: SQRT3 * (q + r / 2),
    y: 1.5 * r,
    vertices: [],
    edges: [],
    neighbors: [],
  }));

  const vertices = [];
  const vmap = new Map();
  for (const h of hexes) {
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      const x = h.x + Math.cos(ang);
      const y = h.y + Math.sin(ang);
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      let v = vmap.get(key);
      if (!v) {
        v = { id: vertices.length, x, y, hexes: [], edges: [], adj: [] };
        vertices.push(v);
        vmap.set(key, v);
      }
      v.hexes.push(h.id);
      h.vertices.push(v.id);
    }
  }

  const edges = [];
  const emap = new Map();
  for (const h of hexes) {
    for (let i = 0; i < 6; i++) {
      const a = h.vertices[i];
      const b = h.vertices[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = emap.get(key);
      if (!e) {
        e = { id: edges.length, v: [a, b], hexes: [] };
        edges.push(e);
        emap.set(key, e);
        vertices[a].edges.push(e.id);
        vertices[b].edges.push(e.id);
        vertices[a].adj.push(b);
        vertices[b].adj.push(a);
      }
      e.hexes.push(h.id);
      h.edges.push(e.id);
    }
  }

  // 中心距離約為 √3 即相鄰
  for (const h of hexes) {
    for (const o of hexes) {
      if (o !== h && Math.hypot(o.x - h.x, o.y - h.y) < 1.8) h.neighbors.push(o.id);
    }
  }

  // 沿海邊依角度排序，形成繞外圈一周的順序
  const coastal = edges
    .filter((e) => e.hexes.length === 1)
    .map((e) => {
      const [a, b] = e.v;
      const mx = (vertices[a].x + vertices[b].x) / 2;
      const my = (vertices[a].y + vertices[b].y) / 2;
      return { id: e.id, ang: Math.atan2(my, mx) };
    })
    .sort((p, q) => p.ang - q.ang)
    .map((p) => p.id);

  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

  return { hexes, vertices, edges, coastal, bounds };
}

const cache = {};
export function geoFor(layout = 'standard') {
  if (!LAYOUTS[layout]) throw new Error(`未知的地圖：${layout}`);
  return (cache[layout] ||= buildGeometry(LAYOUTS[layout].rows));
}

export const GEO = geoFor('standard');

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 港口平均分布在沿海邊上；相鄰的港口至少隔一條邊，保證不共用路口
export function portSlots(coastalCount, portCount) {
  return Array.from({ length: portCount }, (_, i) => Math.round((i * coastalCount) / portCount));
}

export function generateBoard(layout = 'standard', rng = Math.random) {
  const def = LAYOUTS[layout];
  const geo = geoFor(layout);
  const tiles = shuffle(Object.entries(def.tiles).flatMap(([t, n]) => Array(n).fill(t)), rng);

  let numbers;
  for (let attempt = 0; attempt < 5000; attempt++) {
    const pool = shuffle(def.numbers.slice(), rng);
    numbers = tiles.map((t) => (t === 'desert' ? null : pool.pop()));
    const hot = (n) => n === 6 || n === 8;
    const ok = geo.hexes.every((h) => !hot(numbers[h.id]) || h.neighbors.every((o) => !hot(numbers[o])));
    if (ok) break;
  }

  const portTypes = shuffle(def.ports.slice(), rng);
  const ports = portSlots(geo.coastal.length, portTypes.length).map((slot, i) => ({ edge: geo.coastal[slot], type: portTypes[i] }));

  return {
    layout,
    hexes: tiles.map((resource, i) => ({ resource, number: numbers[i] })),
    ports,
    robber: tiles.indexOf('desert'),
  };
}
