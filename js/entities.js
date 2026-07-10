import { BUILDINGS, UNITS, UNIT_UPGRADES, TECHS, AGES, RESOURCE_TYPES, STARTING_RESOURCES, STARTING_POP_CAP, TILE } from './data.js';

let nextEntityId = 1;

export class Player {
  constructor(id, name, isAI) {
    this.id = id;
    this.name = name;
    this.isAI = isAI;
    this.resources = { ...STARTING_RESOURCES };
    this.popCap = STARTING_POP_CAP;
    this.age = 0;
    this.ageResearch = null; // {timeLeft, total}
    this.buildings = [];
    this.units = [];
    this.techsResearched = new Set();
    this.unitLine = { Militia: 'Militia', Archer: 'Archer', Scout: 'Scout' }; // 目前該兵種線最新型態
    this.bonus = {}; // class -> {attack, armor, speedMul}
    this.defeated = false;
  }

  currentPop() {
    return this.units.length;
  }

  canAfford(cost) {
    for (const k in cost) {
      if ((this.resources[k] || 0) < cost[k]) return false;
    }
    return true;
  }

  pay(cost) {
    for (const k in cost) {
      this.resources[k] -= cost[k];
    }
  }

  getBonus(cls) {
    return this.bonus[cls] || { attack: 0, armor: 0, speedMul: 1 };
  }

  applyTechEffect(effect) {
    const b = this.bonus[effect.class] || { attack: 0, armor: 0, speedMul: 1 };
    if (effect.attack) b.attack += effect.attack;
    if (effect.armor) b.armor += effect.armor;
    if (effect.speedMul) b.speedMul *= effect.speedMul;
    this.bonus[effect.class] = b;
  }

  unitStats(type) {
    const base = UNITS[type];
    const bonus = this.getBonus(base.class);
    return {
      ...base,
      attack: base.attack + bonus.attack,
      armor: base.armor + bonus.armor,
      speed: base.speed * bonus.speedMul,
    };
  }
}

export function createUnit(owner, type, x, y) {
  const base = UNITS[type];
  return {
    id: nextEntityId++,
    kind: 'unit',
    owner,
    type,
    x, y,
    hp: base.hp,
    maxHp: base.hp,
    stats: base,
    radius: base.radius,
    path: [],
    task: null,
    attackCooldown: 0,
    carry: { type: null, amount: 0 },
    selected: false,
    facing: 0,
    repathTimer: 0,
    flashTimer: 0,
  };
}

export function createBuilding(owner, type, x, y, opts = {}) {
  const def = BUILDINGS[type];
  const maxHp = def.hp;
  const constructing = !opts.instant;
  return {
    id: nextEntityId++,
    kind: 'building',
    owner,
    type,
    x, y,
    hp: constructing ? Math.max(1, Math.floor(maxHp * 0.1)) : maxHp,
    maxHp,
    def,
    sizeTiles: def.size,
    constructing,
    builders: 0,
    trainQueue: [],
    trainProgress: 0,
    research: null,
    selected: false,
    rally: null,
    flashTimer: 0,
  };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function buildingRadius(building) {
  return (building.sizeTiles * TILE) / 2;
}

export function moveUnitTowardsPath(unit, dt) {
  if (!unit.path || unit.path.length === 0) return true;
  let remaining = unit.stats.speed * dt;
  while (remaining > 0 && unit.path.length > 0) {
    const wp = unit.path[0];
    const dx = wp.x - unit.x;
    const dy = wp.y - unit.y;
    const d = Math.hypot(dx, dy);
    if (d <= remaining) {
      unit.x = wp.x;
      unit.y = wp.y;
      remaining -= d;
      unit.path.shift();
    } else {
      unit.x += (dx / d) * remaining;
      unit.y += (dy / d) * remaining;
      unit.facing = Math.atan2(dy, dx);
      remaining = 0;
    }
  }
  return unit.path.length === 0;
}

export function damageOf(attackerStats, targetStats, targetClass) {
  let atk = attackerStats.attack;
  if (attackerStats.bonusVs && attackerStats.bonusVs[targetClass]) {
    atk += attackerStats.bonusVs[targetClass];
  }
  const dmg = atk - targetStats.armor;
  return Math.max(1, dmg);
}

export function unitClassOf(unit) {
  return unit.stats.class;
}

export function effectiveStats(unit) {
  return unit.owner.unitStats(unit.type);
}

// 建築物整個佔地格都會被地圖標記為阻擋，A* 無法直接走到建築中心；
// 回傳建築物外緣（略帶緩衝）的一點，讓單位可以合法走到附近再判定距離。
// 優先嘗試朝向 fromX/fromY 的方向，若該點恰好落在鄰近建築的佔地內（建築密集擺放時常見），
// 依序嘗試其他七個方位，避免單位卡在原地永遠走不到。
export function approachPoint(map, building, fromX, fromY) {
  const half = buildingRadius(building);
  const pad = 10;
  let dx0 = fromX - building.x;
  let dy0 = fromY - building.y;
  if (Math.abs(dx0) < 0.01 && Math.abs(dy0) < 0.01) { dx0 = 1; dy0 = 0; }
  const baseAngle = Math.atan2(dy0, dx0);
  const angleOffsets = [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, -3 * Math.PI / 4, 3 * Math.PI / 4, Math.PI];
  const candidates = angleOffsets.map((off) => {
    const ang = baseAngle + off;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const scale = (half + pad) / Math.max(Math.abs(dx), Math.abs(dy));
    return { x: building.x + dx * scale, y: building.y + dy * scale };
  });
  if (map) {
    for (const c of candidates) {
      const { tx, ty } = map.worldToTile(c.x, c.y);
      if (!map.isBlocked(tx, ty)) return c;
    }
  }
  return candidates[0];
}

export const _data = { BUILDINGS, UNITS, UNIT_UPGRADES, TECHS, AGES, RESOURCE_TYPES };
