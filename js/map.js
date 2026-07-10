import { TILE, MAP_W, MAP_H } from './data.js';

let nextResId = 1;

export class GameMap {
  constructor() {
    this.w = MAP_W;
    this.h = MAP_H;
    this.blocked = new Uint8Array(this.w * this.h);
    this.resources = [];
  }

  idx(tx, ty) {
    return ty * this.w + tx;
  }

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  isBlocked(tx, ty) {
    if (!this.inBounds(tx, ty)) return true;
    return this.blocked[this.idx(tx, ty)] === 1;
  }

  worldToTile(x, y) {
    return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) };
  }

  tileCenter(tx, ty) {
    return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
  }

  setFootprint(centerX, centerY, sizeTiles, value) {
    const { tx, ty } = this.worldToTile(centerX, centerY);
    const half = Math.floor(sizeTiles / 2);
    for (let dy = -half; dy < sizeTiles - half; dy++) {
      for (let dx = -half; dx < sizeTiles - half; dx++) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (this.inBounds(nx, ny)) this.blocked[this.idx(nx, ny)] = value ? 1 : 0;
      }
    }
  }

  canPlaceFootprint(centerX, centerY, sizeTiles) {
    const { tx, ty } = this.worldToTile(centerX, centerY);
    const half = Math.floor(sizeTiles / 2);
    for (let dy = -half; dy < sizeTiles - half; dy++) {
      for (let dx = -half; dx < sizeTiles - half; dx++) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!this.inBounds(nx, ny) || this.isBlocked(nx, ny)) return false;
      }
    }
    return true;
  }

  addResource(type, x, y, amount) {
    const r = { id: nextResId++, type, x, y, amount, maxAmount: amount, radius: 14 };
    this.resources.push(r);
    return r;
  }

  removeResource(r) {
    const i = this.resources.indexOf(r);
    if (i >= 0) this.resources.splice(i, 1);
  }

  nearestResource(type, x, y, excludeDepleted = true) {
    let best = null;
    let bestD = Infinity;
    for (const r of this.resources) {
      if (r.type !== type) continue;
      if (excludeDepleted && r.amount <= 0) continue;
      const d = (r.x - x) ** 2 + (r.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  // A* 尋路，回傳世界座標路徑點陣列（不含起點）
  findPath(sx, sy, ex, ey) {
    const start = this.worldToTile(sx, sy);
    const end = this.worldToTile(ex, ey);
    if (!this.inBounds(end.tx, end.ty)) return [];
    if (start.tx === end.tx && start.ty === end.ty) return [{ x: ex, y: ey }];

    const key = (tx, ty) => ty * this.w + tx;
    const open = new Map();
    const closed = new Set();
    const gScore = new Map();
    const fScore = new Map();
    const parent = new Map();

    const h = (tx, ty) => Math.abs(tx - end.tx) + Math.abs(ty - end.ty);

    const startKey = key(start.tx, start.ty);
    gScore.set(startKey, 0);
    fScore.set(startKey, h(start.tx, start.ty));
    open.set(startKey, { tx: start.tx, ty: start.ty });

    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
    ];

    let iterations = 0;
    const maxIterations = 4000;

    // 允許目標格本身即使被阻擋也可視為可達邊界（用於攻擊/採集移動到目標旁）
    const endBlockedButTarget = this.isBlocked(end.tx, end.ty);

    while (open.size > 0 && iterations < maxIterations) {
      iterations++;
      let curKey = null;
      let curF = Infinity;
      for (const [k, v] of open) {
        const f = fScore.get(k) ?? Infinity;
        if (f < curF) {
          curF = f;
          curKey = k;
        }
      }
      const cur = open.get(curKey);
      open.delete(curKey);
      closed.add(curKey);

      if (cur.tx === end.tx && cur.ty === end.ty) {
        const path = [];
        let ck = curKey;
        while (parent.has(ck)) {
          const p = parent.get(ck);
          const t = { tx: ck % this.w, ty: Math.floor(ck / this.w) };
          path.push(this.tileCenter(t.tx, t.ty));
          ck = p;
        }
        path.reverse();
        if (path.length > 0) path[path.length - 1] = { x: ex, y: ey };
        else path.push({ x: ex, y: ey });
        return path;
      }

      for (const [dx, dy, cost] of dirs) {
        const nx = cur.tx + dx;
        const ny = cur.ty + dy;
        if (!this.inBounds(nx, ny)) continue;
        const isTarget = nx === end.tx && ny === end.ty;
        if (this.isBlocked(nx, ny) && !(isTarget && endBlockedButTarget)) continue;
        const nk = key(nx, ny);
        if (closed.has(nk)) continue;
        const tentativeG = (gScore.get(curKey) ?? Infinity) + cost;
        if (tentativeG < (gScore.get(nk) ?? Infinity)) {
          parent.set(nk, curKey);
          gScore.set(nk, tentativeG);
          fScore.set(nk, tentativeG + h(nx, ny));
          if (!open.has(nk)) open.set(nk, { tx: nx, ty: ny });
        }
      }
    }
    return null; // 找不到路徑
  }
}

function scatterCluster(map, type, cx, cy, count, spread, amount) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.random() * spread;
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist;
    nodes.push(map.addResource(type, x, y, amount));
  }
  return nodes;
}

export function generateMap() {
  const map = new GameMap();
  const worldW = map.w * TILE;
  const worldH = map.h * TILE;

  const playerStart = { x: 3 * TILE, y: (map.h - 3) * TILE };
  const aiStart = { x: (map.w - 3) * TILE, y: 3 * TILE };

  for (const start of [playerStart, aiStart]) {
    scatterCluster(map, 'wood', start.x + (start === playerStart ? 220 : -220), start.y + (start === playerStart ? -60 : 60), 10, 90, 250);
    scatterCluster(map, 'gold', start.x + (start === playerStart ? 260 : -260), start.y + (start === playerStart ? 40 : -40), 4, 40, 700);
    scatterCluster(map, 'food', start.x + (start === playerStart ? 60 : -60), start.y + (start === playerStart ? -260 : 260), 5, 50, 250);
  }

  // 中央中立資源
  scatterCluster(map, 'wood', worldW / 2, worldH / 2, 14, 200, 250);
  scatterCluster(map, 'gold', worldW / 2 + 150, worldH / 2 - 100, 4, 60, 700);
  scatterCluster(map, 'gold', worldW / 2 - 150, worldH / 2 + 100, 4, 60, 700);
  scatterCluster(map, 'food', worldW / 2 - 100, worldH / 2 - 150, 4, 60, 250);
  scatterCluster(map, 'food', worldW / 2 + 100, worldH / 2 + 150, 4, 60, 250);

  return { map, playerStart, aiStart };
}
