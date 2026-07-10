import { TILE, UNITS, BUILDINGS, UNIT_UPGRADES, TECHS } from './data.js';
import { issueGather, issueGatherFarm, issueBuild, issueAttack, issueMove, startBuildingConstruction, startTraining, startAgeUp, startResearchTech, startUnitUpgrade, findDropOff } from './sim.js';
import { dist } from './entities.js';

export function createAIState(homeX, homeY) {
  return {
    homeX, homeY,
    tickTimer: 0,
    attackGroupThreshold: 6,
    lastAttackWave: 0,
  };
}

function findBuildSpot(map, refX, refY, sizeTiles) {
  const { tx: rtx, ty: rty } = map.worldToTile(refX, refY);
  for (let radius = 2; radius <= 18; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tx = rtx + dx;
        const ty = rty + dy;
        if (!map.inBounds(tx, ty)) continue;
        const c = map.tileCenter(tx, ty);
        if (map.canPlaceFootprint(c.x, c.y, sizeTiles)) return c;
      }
    }
  }
  return null;
}

function countGatherers(ai) {
  const counts = { wood: 0, food: 0, gold: 0 };
  for (const u of ai.units) {
    if (u.task && u.task.type === 'gather') counts[u.task.resourceType]++;
    else if (u.task && u.task.type === 'gatherFarm') counts.food++;
  }
  return counts;
}

function targetRatio(ai) {
  if (ai.age === 0) return { wood: 0.45, food: 0.4, gold: 0.15 };
  if (ai.age === 1) return { wood: 0.35, food: 0.3, gold: 0.35 };
  return { wood: 0.3, food: 0.25, gold: 0.45 };
}

function assignVillager(state, ai, aiState, villager) {
  const counts = countGatherers(ai);
  const total = Math.max(1, counts.wood + counts.food + counts.gold);
  const ratio = targetRatio(ai);
  let bestType = 'wood';
  let bestDeficit = -Infinity;
  for (const type of ['wood', 'food', 'gold']) {
    const deficit = ratio[type] - counts[type] / total;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      bestType = type;
    }
  }
  const res = state.map.nearestResource(bestType, aiState.homeX, aiState.homeY);
  if (res) {
    issueGather(state.map, villager, res);
    return;
  }
  if (bestType === 'food') {
    for (const b of ai.buildings) {
      if (b.def.isFarm && !b.constructing && b.foodLeft > 0) {
        const already = ai.units.filter((u) => u.task && u.task.farm === b).length;
        if (already < 2) {
          issueGatherFarm(state.map, villager, b);
          return;
        }
      }
    }
    if (ai.canAfford(BUILDINGS.Farm.cost)) {
      const spot = findBuildSpot(state.map, aiState.homeX, aiState.homeY, BUILDINGS.Farm.size);
      if (spot) {
        const b = startBuildingConstruction(state, ai, 'Farm', spot.x, spot.y);
        if (b) {
          issueBuild(state.map, villager, b);
          return;
        }
      }
    }
  }
  const anyRes = state.map.nearestResource('wood', aiState.homeX, aiState.homeY) ||
    state.map.nearestResource('gold', aiState.homeX, aiState.homeY);
  if (anyRes) issueGather(state.map, villager, anyRes);
}

function tryBuild(state, ai, aiState, type) {
  const def = BUILDINGS[type];
  if (!ai.canAfford(def.cost)) return false;
  const builder = ai.units.find((u) => u.stats.class === 'villager' && (!u.task || u.task.type === 'gather' || u.task.type === 'gatherFarm'));
  if (!builder) return false;
  const spot = findBuildSpot(state.map, aiState.homeX, aiState.homeY, def.size);
  if (!spot) return false;
  const b = startBuildingConstruction(state, ai, type, spot.x, spot.y);
  if (!b) return false;
  issueBuild(state.map, builder, b);
  return true;
}

function has(ai, type) {
  return ai.buildings.some((b) => b.type === type);
}

function hasIdleBuilder(ai, type) {
  return ai.buildings.find((b) => b.type === type && !b.constructing && !b.research);
}

function economyStep(state, ai, aiState) {
  for (const u of ai.units) {
    if (u.stats.class === 'villager' && !u.task) {
      assignVillager(state, ai, aiState, u);
    }
  }

  const villagerCount = ai.units.filter((u) => u.stats.class === 'villager').length;
  const roomLeft = ai.popCap - ai.currentPop();

  if (roomLeft <= 3 && ai.canAfford(BUILDINGS.House.cost)) {
    const pendingHouse = ai.buildings.some((b) => b.type === 'House' && b.constructing);
    if (!pendingHouse) tryBuild(state, ai, aiState, 'House');
  }

  if (!has(ai, 'Barracks')) {
    tryBuild(state, ai, aiState, 'Barracks');
  }

  if (ai.age >= 1) {
    if (!has(ai, 'ArcheryRange')) tryBuild(state, ai, aiState, 'ArcheryRange');
    else if (!has(ai, 'Stable')) tryBuild(state, ai, aiState, 'Stable');
    else if (!has(ai, 'Blacksmith')) tryBuild(state, ai, aiState, 'Blacksmith');
    else if (!has(ai, 'LumberCamp') && villagerCount >= 8) tryBuild(state, ai, aiState, 'LumberCamp');
    else if (!has(ai, 'MiningCamp') && villagerCount >= 10) tryBuild(state, ai, aiState, 'MiningCamp');
  }

  const tc = ai.buildings.find((b) => b.type === 'TownCenter');
  if (tc && !tc.trainQueue.length && villagerCount < 16 && ai.currentPop() < ai.popCap) {
    startTraining(ai, tc, 'Villager');
  }

  if (!ai.ageResearch) {
    if (ai.age === 0 && villagerCount >= 7) startAgeUp(ai);
    else if (ai.age === 1 && villagerCount >= 12) startAgeUp(ai);
  }
}

function militaryStep(state, ai, aiState) {
  const barracks = hasIdleBuilder(ai, 'Barracks');
  if (barracks && barracks.trainQueue.length < 3) {
    const line = ai.unitLine.Militia;
    startTraining(ai, barracks, line);
    if (ai.age >= 1) startTraining(ai, barracks, 'Spearman');
  }
  const archery = hasIdleBuilder(ai, 'ArcheryRange');
  if (archery && archery.trainQueue.length < 3) {
    startTraining(ai, archery, ai.unitLine.Archer);
  }
  const stable = hasIdleBuilder(ai, 'Stable');
  if (stable && stable.trainQueue.length < 2) {
    startTraining(ai, stable, ai.unitLine.Scout);
  }

  const blacksmith = hasIdleBuilder(ai, 'Blacksmith');
  if (blacksmith && ai.age >= 1) {
    const techOrder = ['Forging', 'Fletching', 'ScaleMailArmor', 'BitDesign'];
    for (const key of techOrder) {
      if (!ai.techsResearched.has(key) && ai.canAfford(TECHS[key].cost)) {
        startResearchTech(ai, blacksmith, key);
        break;
      }
    }
  }

  if (barracks && ai.age >= 1 && ai.unitLine.Militia === 'Militia' && ai.canAfford(UNIT_UPGRADES.Swordsman.cost)) {
    startUnitUpgrade(ai, barracks, 'Swordsman');
  }
  if (barracks && ai.age >= 2 && ai.unitLine.Militia === 'Swordsman' && ai.canAfford(UNIT_UPGRADES.LongSwordsman.cost)) {
    startUnitUpgrade(ai, barracks, 'LongSwordsman');
  }
  if (archery && ai.age >= 2 && ai.unitLine.Archer === 'Archer' && ai.canAfford(UNIT_UPGRADES.Crossbowman.cost)) {
    startUnitUpgrade(ai, archery, 'Crossbowman');
  }
  if (stable && ai.age >= 2 && ai.unitLine.Scout === 'Scout' && ai.canAfford(UNIT_UPGRADES.Knight.cost)) {
    startUnitUpgrade(ai, stable, 'Knight');
  }
}

function combatStep(state, ai, aiState, enemy) {
  const idleMilitary = ai.units.filter((u) => u.stats.class !== 'villager' && (!u.task || u.task.type === 'move'));
  if (idleMilitary.length >= aiState.attackGroupThreshold) {
    let target = enemy.buildings.find((b) => b.type === 'TownCenter') || enemy.buildings[0];
    let bestD = target ? dist({ x: aiState.homeX, y: aiState.homeY }, target) : Infinity;
    for (const b of enemy.buildings) {
      const d = dist({ x: aiState.homeX, y: aiState.homeY }, b);
      if (d < bestD) {
        bestD = d;
        target = b;
      }
    }
    if (target) {
      for (const u of idleMilitary) issueAttack(state.map, u, target);
      aiState.attackGroupThreshold = Math.min(16, aiState.attackGroupThreshold + 2);
    }
  }
}

export function updateAI(state, ai, aiState, enemy, dt) {
  aiState.tickTimer -= dt;
  if (aiState.tickTimer > 0) return;
  aiState.tickTimer = 2.0;
  if (ai.defeated) return;

  economyStep(state, ai, aiState);
  militaryStep(state, ai, aiState);
  combatStep(state, ai, aiState, enemy);
}
