import { BUILDINGS, UNITS, UNIT_UPGRADES, TECHS, AGES, MAX_POP_CAP, TILE } from './data.js';
import { createUnit, createBuilding, dist, buildingRadius, moveUnitTowardsPath, damageOf, effectiveStats, approachPoint } from './entities.js';

const AGGRO_RANGE = 6 * TILE;
const ATTACK_INTERVAL = { infantry: 1.5, cavalry: 1.4, archer: 1.9, villager: 2.2 };

export function findDropOff(player, resourceType, fx, fy) {
  let best = null;
  let bestD = Infinity;
  for (const b of player.buildings) {
    if (b.constructing) continue;
    if (!b.def.dropOff || !b.def.dropOff.includes(resourceType)) continue;
    const d = dist({ x: fx, y: fy }, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function pathTo(map, unit, tx, ty) {
  const p = map.findPath(unit.x, unit.y, tx, ty);
  unit.path = p || [];
}

function pathToBuilding(map, unit, building) {
  const ap = approachPoint(map, building, unit.x, unit.y);
  pathTo(map, unit, ap.x, ap.y);
}

export function issueMove(map, unit, x, y) {
  unit.task = { type: 'move' };
  pathTo(map, unit, x, y);
}

export function issueGather(map, unit, resource) {
  unit.task = { type: 'gather', resource, resourceType: resource.type, phase: 'toResource' };
  pathTo(map, unit, resource.x, resource.y);
}

export function issueGatherFarm(map, unit, farm) {
  unit.task = { type: 'gatherFarm', farm, phase: 'toFarm' };
  pathTo(map, unit, farm.x, farm.y);
}

export function issueBuild(map, unit, building) {
  unit.task = { type: 'build', building };
  pathToBuilding(map, unit, building);
}

export function issueAttack(map, unit, target) {
  unit.task = { type: 'attack', target };
  unit.path = [];
}

export function findNearestEnemy(state, ownerId, x, y, range) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.id === ownerId) continue;
    for (const u of p.units) {
      const d = dist({ x, y }, u);
      if (d <= range && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    for (const b of p.buildings) {
      const d = dist({ x, y }, b);
      if (d <= range && d < bestD) {
        bestD = d;
        best = b;
      }
    }
  }
  return best;
}

function spawnProjectile(state, unit, target, dmg) {
  const stats = effectiveStats(unit);
  const speed = stats.projectileSpeed || 300;
  state.projectiles.push({
    x: unit.x, y: unit.y, targetRefX: target.x, targetRefY: target.y,
    target, dmg, speed, owner: unit.owner,
  });
}

function dealDamage(state, target, dmg, attackerOwner) {
  target.hp -= dmg;
  target.flashTimer = 0.15;
  if (target.hp <= 0) {
    removeEntity(state, target);
  }
}

export function removeEntity(state, entity) {
  const owner = entity.owner;
  if (entity.kind === 'unit') {
    const i = owner.units.indexOf(entity);
    if (i >= 0) owner.units.splice(i, 1);
  } else {
    const i = owner.buildings.indexOf(entity);
    if (i >= 0) owner.buildings.splice(i, 1);
    state.map.setFootprint(entity.x, entity.y, entity.sizeTiles, false);
  }
}

function targetRadiusOf(target) {
  return target.kind === 'building' ? buildingRadius(target) : target.radius;
}

function updateAttackTask(state, unit, dt) {
  const task = unit.task;
  const target = task.target;
  if (target.hp <= 0 || (target.kind === 'unit' ? target.owner.units.indexOf(target) < 0 : target.owner.buildings.indexOf(target) < 0)) {
    unit.task = null;
    unit.path = [];
    return;
  }
  const stats = effectiveStats(unit);
  const rangeNeeded = stats.range + unit.radius + targetRadiusOf(target) + 2;
  const d = dist(unit, target);
  if (d > rangeNeeded) {
    unit.repathTimer -= dt;
    if (unit.path.length === 0 || unit.repathTimer <= 0) {
      const dest = target.kind === 'building' ? approachPoint(state.map, target, unit.x, unit.y) : target;
      pathTo(state.map, unit, dest.x, dest.y);
      unit.repathTimer = 0.7;
    }
    moveUnitTowardsPath(unit, dt);
  } else {
    unit.path = [];
    unit.facing = Math.atan2(target.y - unit.y, target.x - unit.x);
    if (unit.attackCooldown <= 0) {
      const targetClass = target.kind === 'unit' ? target.stats.class : 'building';
      const targetArmor = target.kind === 'unit' ? effectiveStats(target).armor : 0;
      const dmg = damageOf(stats, { armor: targetArmor }, targetClass);
      if (stats.range > 0) {
        spawnProjectile(state, unit, target, dmg);
      } else {
        dealDamage(state, target, dmg, unit.owner);
      }
      unit.attackCooldown = ATTACK_INTERVAL[stats.class] || 1.6;
    }
  }
}

function updateGatherTask(state, unit, dt) {
  const map = state.map;
  const task = unit.task;
  const stats = effectiveStats(unit);
  if (task.phase === 'toResource') {
    if (!task.resource || task.resource.amount <= 0) {
      const alt = map.nearestResource(task.resourceType, unit.x, unit.y);
      if (!alt) {
        unit.task = null;
        return;
      }
      task.resource = alt;
      pathTo(map, unit, alt.x, alt.y);
    }
    const arrived = moveUnitTowardsPath(unit, dt);
    if (arrived) {
      const d = dist(unit, task.resource);
      if (d <= task.resource.radius + unit.radius + 6) {
        task.phase = 'gathering';
      } else {
        pathTo(map, unit, task.resource.x, task.resource.y);
      }
    }
  } else if (task.phase === 'gathering') {
    const res = task.resource;
    if (!res || res.amount <= 0) {
      task.phase = 'toDropoff';
      task.dropoff = findDropOff(unit.owner, task.resourceType, unit.x, unit.y);
      if (task.dropoff) pathToBuilding(map, unit, task.dropoff);
      return;
    }
    const take = Math.min(stats.gatherRate * dt, res.amount, stats.carryCap - unit.carry.amount);
    res.amount -= take;
    unit.carry.type = task.resourceType;
    unit.carry.amount += take;
    if (res.amount <= 0) map.removeResource(res);
    if (unit.carry.amount >= stats.carryCap - 0.001 || res.amount <= 0) {
      task.phase = 'toDropoff';
      task.dropoff = findDropOff(unit.owner, task.resourceType, unit.x, unit.y);
      if (task.dropoff) pathToBuilding(map, unit, task.dropoff);
    }
  } else if (task.phase === 'toDropoff') {
    if (!task.dropoff || task.dropoff.hp <= 0) {
      task.dropoff = findDropOff(unit.owner, task.resourceType, unit.x, unit.y);
      if (task.dropoff) pathToBuilding(map, unit, task.dropoff);
      else return;
    }
    const arrived = moveUnitTowardsPath(unit, dt);
    if (arrived) {
      const d = dist(unit, task.dropoff);
      if (d <= buildingRadius(task.dropoff) + unit.radius + 6) {
        unit.owner.resources[unit.carry.type] = (unit.owner.resources[unit.carry.type] || 0) + unit.carry.amount;
        unit.carry.amount = 0;
        if (task.resource && task.resource.amount > 0) {
          task.phase = 'toResource';
          pathTo(map, unit, task.resource.x, task.resource.y);
        } else {
          const alt = map.nearestResource(task.resourceType, unit.x, unit.y);
          if (alt) {
            task.resource = alt;
            task.phase = 'toResource';
            pathTo(map, unit, alt.x, alt.y);
          } else {
            unit.task = null;
          }
        }
      } else {
        pathToBuilding(map, unit, task.dropoff);
      }
    }
  }
}

function updateGatherFarmTask(state, unit, dt) {
  const map = state.map;
  const task = unit.task;
  const stats = effectiveStats(unit);
  const farm = task.farm;
  if (!farm || farm.hp <= 0 || farm.foodLeft <= 0) {
    unit.task = null;
    return;
  }
  if (task.phase === 'toFarm') {
    const arrived = moveUnitTowardsPath(unit, dt);
    if (arrived) {
      const d = dist(unit, farm);
      if (d <= buildingRadius(farm) + unit.radius + 6) {
        task.phase = 'gathering';
      } else {
        pathToBuilding(map, unit, farm);
      }
    }
  } else if (task.phase === 'gathering') {
    const take = Math.min(stats.gatherRate * dt, farm.foodLeft, stats.carryCap - unit.carry.amount);
    farm.foodLeft -= take;
    unit.carry.type = 'food';
    unit.carry.amount += take;
    if (unit.carry.amount >= stats.carryCap - 0.001 || farm.foodLeft <= 0) {
      task.phase = 'toDropoff';
      task.dropoff = findDropOff(unit.owner, 'food', unit.x, unit.y);
      if (task.dropoff) pathToBuilding(map, unit, task.dropoff);
    }
  } else if (task.phase === 'toDropoff') {
    if (!task.dropoff || task.dropoff.hp <= 0) {
      task.dropoff = findDropOff(unit.owner, 'food', unit.x, unit.y);
      if (task.dropoff) pathToBuilding(map, unit, task.dropoff);
      else return;
    }
    const arrived = moveUnitTowardsPath(unit, dt);
    if (arrived) {
      const d = dist(unit, task.dropoff);
      if (d <= buildingRadius(task.dropoff) + unit.radius + 6) {
        unit.owner.resources.food += unit.carry.amount;
        unit.carry.amount = 0;
        if (farm.foodLeft > 0) {
          task.phase = 'toFarm';
          pathToBuilding(map, unit, farm);
        } else {
          unit.task = null;
        }
      } else {
        pathToBuilding(map, unit, task.dropoff);
      }
    }
  }
  if (farm.foodLeft <= 0) {
    removeEntity(state, farm);
  }
}

function updateBuildTask(state, unit, dt) {
  const building = unit.task.building;
  if (!building || building.hp <= 0) {
    unit.task = null;
    return;
  }
  const arrived = moveUnitTowardsPath(unit, dt);
  if (arrived) {
    const d = dist(unit, building);
    if (d > buildingRadius(building) + unit.radius + 8) {
      pathToBuilding(state.map, unit, building);
      return;
    }
    if (!building.constructing) {
      unit.task = null;
      return;
    }
    const rate = (building.maxHp * 0.9) / (building.def.buildTime || 10);
    building.hp = Math.min(building.maxHp, building.hp + rate * dt);
    if (building.hp >= building.maxHp) {
      building.hp = building.maxHp;
      building.constructing = false;
      unit.task = null;
    }
  }
}

export function updateUnit(state, unit, dt) {
  if (unit.flashTimer > 0) unit.flashTimer -= dt;
  if (unit.attackCooldown > 0) unit.attackCooldown -= dt;

  if (!unit.task) {
    const cls = unit.stats.class;
    if (cls !== 'villager') {
      const enemy = findNearestEnemy(state, unit.owner.id, unit.x, unit.y, AGGRO_RANGE);
      if (enemy) {
        issueAttack(state.map, unit, enemy);
      }
    }
    return;
  }

  switch (unit.task.type) {
    case 'move': {
      const arrived = moveUnitTowardsPath(unit, dt);
      if (arrived) unit.task = null;
      break;
    }
    case 'attack':
      updateAttackTask(state, unit, dt);
      break;
    case 'gather':
      updateGatherTask(state, unit, dt);
      break;
    case 'gatherFarm':
      updateGatherFarmTask(state, unit, dt);
      break;
    case 'build':
      updateBuildTask(state, unit, dt);
      break;
    default:
      unit.task = null;
  }
}

function findRallyPoint(building) {
  const r = buildingRadius(building) + 24;
  return { x: building.x + r, y: building.y + r };
}

export function spawnTrainedUnit(state, player, building, type) {
  const rp = building.rally || findRallyPoint(building);
  const unit = createUnit(player, type, rp.x, rp.y);
  player.units.push(unit);
  return unit;
}

export function updateBuilding(state, player, building, dt) {
  if (building.flashTimer > 0) building.flashTimer -= dt;
  if (!building.constructing) {
    if (building.trainQueue.length > 0) {
      const item = building.trainQueue[0];
      if (player.currentPop() < player.popCap) {
        building.trainProgress += dt;
        if (building.trainProgress >= item.totalTime) {
          spawnTrainedUnit(state, player, building, item.type);
          building.trainQueue.shift();
          building.trainProgress = 0;
        }
      }
    }
    if (building.research) {
      building.research.timeLeft -= dt;
      if (building.research.timeLeft <= 0) {
        applyResearch(player, building.research);
        building.research = null;
      }
    }
  }
}

export function applyResearch(player, research) {
  if (research.kind === 'tech') {
    const tech = TECHS[research.key];
    player.applyTechEffect(tech.effect);
    player.techsResearched.add(research.key);
  } else if (research.kind === 'upgrade') {
    const upDef = UNIT_UPGRADES[research.key];
    const oldType = upDef.from;
    const newType = research.key;
    for (const rootKey in player.unitLine) {
      if (player.unitLine[rootKey] === oldType) player.unitLine[rootKey] = newType;
    }
    for (const u of player.units) {
      if (u.type === oldType) {
        const newBase = UNITS[newType];
        const ratio = u.hp / u.maxHp;
        u.type = newType;
        u.stats = newBase;
        u.maxHp = newBase.hp;
        u.hp = Math.max(1, Math.round(newBase.hp * ratio));
        u.radius = newBase.radius;
      }
    }
  }
}

export function startAgeUp(player) {
  const nextAge = AGES[player.age + 1];
  if (!nextAge || player.ageResearch) return false;
  if (!player.canAfford(nextAge.nextCost)) return false;
  player.pay(nextAge.nextCost);
  player.ageResearch = { timeLeft: nextAge.researchTime, total: nextAge.researchTime, toAge: player.age + 1 };
  return true;
}

export function updatePlayerAge(player, dt) {
  if (player.ageResearch) {
    player.ageResearch.timeLeft -= dt;
    if (player.ageResearch.timeLeft <= 0) {
      player.age = player.ageResearch.toAge;
      player.ageResearch = null;
    }
  }
}

export function startTraining(player, building, type) {
  const def = UNITS[type];
  if (!def) return false;
  if (!player.canAfford(def.cost || {})) return false;
  if (building.trainQueue.length >= 10) return false;
  player.pay(def.cost || {});
  building.trainQueue.push({ type, totalTime: def.trainTime || 10 });
  return true;
}

export function startBuildingConstruction(state, player, type, x, y) {
  const def = BUILDINGS[type];
  if (!player.canAfford(def.cost || {})) return null;
  if (!state.map.canPlaceFootprint(x, y, def.size)) return null;
  player.pay(def.cost || {});
  const b = createBuilding(player, type, x, y);
  if (def.isFarm) b.foodLeft = def.foodAmount;
  player.buildings.push(b);
  state.map.setFootprint(x, y, def.size, true);
  return b;
}

export function startResearchTech(player, building, key) {
  const tech = TECHS[key];
  if (!tech || building.research || player.techsResearched.has(key)) return false;
  if (!player.canAfford(tech.cost)) return false;
  player.pay(tech.cost);
  building.research = { kind: 'tech', key, timeLeft: tech.time, total: tech.time };
  return true;
}

export function startUnitUpgrade(player, building, key) {
  const up = UNIT_UPGRADES[key];
  if (!up || building.research) return false;
  if (!player.canAfford(up.cost)) return false;
  player.pay(up.cost);
  building.research = { kind: 'upgrade', key, timeLeft: up.time, total: up.time };
  return true;
}

export function updateProjectiles(state, dt) {
  const arrived = [];
  for (const p of state.projectiles) {
    const dx = p.target.x - p.x;
    const dy = p.target.y - p.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;
    if (d <= step || d < 4) {
      if (p.target.hp > 0) dealDamage(state, p.target, p.dmg, p.owner);
      arrived.push(p);
    } else {
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
    }
  }
  if (arrived.length) {
    state.projectiles = state.projectiles.filter((p) => !arrived.includes(p));
  }
}

export function recalcPopCap(player) {
  let cap = 0;
  for (const b of player.buildings) {
    if (b.constructing) continue;
    if (b.def.pop) cap += b.def.pop;
  }
  player.popCap = Math.min(MAX_POP_CAP, Math.max(5, cap));
}
