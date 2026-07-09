import { TILE, AGES, BUILDINGS, UNITS, UNIT_UPGRADES, TECHS, MAX_POP_CAP } from './data.js';
import { generateMap } from './map.js';
import { Player, createUnit, createBuilding, dist, buildingRadius, effectiveStats } from './entities.js';
import {
  issueMove, issueGather, issueGatherFarm, issueBuild, issueAttack,
  startBuildingConstruction, startTraining, startAgeUp, startResearchTech, startUnitUpgrade,
  updateUnit, updateBuilding, updatePlayerAge, updateProjectiles, recalcPopCap,
} from './sim.js';
import { createAIState, updateAI } from './ai.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const topbarEls = {
  wood: document.getElementById('resWood'),
  food: document.getElementById('resFood'),
  gold: document.getElementById('resGold'),
  pop: document.getElementById('resPop'),
  ageName: document.getElementById('ageName'),
  ageProgressWrap: document.getElementById('ageProgressWrap'),
  ageProgressFill: document.getElementById('ageProgressFill'),
};
const selectionInfoEl = document.getElementById('selectionInfo');
const actionButtonsEl = document.getElementById('actionButtons');
const gameOverOverlay = document.getElementById('gameOverOverlay');
const gameOverText = document.getElementById('gameOverText');
const restartBtn = document.getElementById('restartBtn');

const BUILD_ICON = {
  TownCenter: '🏛️', House: '🏠', Barracks: '⚔️', ArcheryRange: '🏹', Stable: '🐎',
  Blacksmith: '🔨', Farm: '🌾', LumberCamp: '🪓', MiningCamp: '⛏️',
};
const UNIT_ICON = {
  Villager: '🧑‍🌾', Militia: '🗡️', Swordsman: '🗡️', LongSwordsman: '🗡️',
  Spearman: '🔱', Archer: '🏹', Crossbowman: '🏹', Scout: '🐴', Knight: '🐴',
};
const UNIT_LABEL = {
  Villager: 'V', Militia: 'M', Swordsman: 'S', LongSwordsman: 'L',
  Spearman: 'Sp', Archer: 'A', Crossbowman: 'C', Scout: 'Sc', Knight: 'K',
};

let state, human, ai, aiState, camera, selection, placement, uiTimer;
let dragStart = null;
let dragCurrent = null;
let mouseWorld = { x: 0, y: 0 };
const keys = {};

function costText(cost) {
  return Object.entries(cost || {}).map(([k, v]) => `${k === 'wood' ? '木' : k === 'food' ? '食' : '金'}${v}`).join(' ');
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

function placeStartingBuilding(player, type, x, y) {
  const b = createBuilding(player, type, x, y, { instant: true });
  player.buildings.push(b);
  state.map.setFootprint(x, y, b.sizeTiles, true);
  return b;
}

function initGame() {
  const gen = generateMap();
  human = new Player(0, '玩家', false);
  ai = new Player(1, '電腦', true);
  state = { map: gen.map, players: [human, ai], projectiles: [], time: 0, ended: false, winner: null };

  placeStartingBuilding(human, 'TownCenter', gen.playerStart.x, gen.playerStart.y);
  placeStartingBuilding(ai, 'TownCenter', gen.aiStart.x, gen.aiStart.y);

  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    human.units.push(createUnit(human, 'Villager', gen.playerStart.x + Math.cos(ang) * 60, gen.playerStart.y + Math.sin(ang) * 60));
    ai.units.push(createUnit(ai, 'Villager', gen.aiStart.x + Math.cos(ang) * 60, gen.aiStart.y + Math.sin(ang) * 60));
  }
  recalcPopCap(human);
  recalcPopCap(ai);

  aiState = createAIState(gen.aiStart.x, gen.aiStart.y);

  camera = { x: gen.playerStart.x - window.innerWidth / 2, y: gen.playerStart.y - window.innerHeight / 2 };
  clampCamera();
  selection = [];
  placement = null;
  uiTimer = 0;
  gameOverOverlay.classList.add('hidden');
  refreshUI();
}

function clampCamera() {
  const worldW = state.map.w * TILE;
  const worldH = state.map.h * TILE;
  camera.x = Math.max(-100, Math.min(worldW - canvas.width + 100, camera.x));
  camera.y = Math.max(-100, Math.min(worldH - canvas.height + 100, camera.y));
}

function screenToWorld(sx, sy) {
  return { x: sx + camera.x, y: sy + camera.y };
}

function pickEntity(wx, wy) {
  let bestUnit = null;
  let bestUD = Infinity;
  for (const p of state.players) {
    for (const u of p.units) {
      const d = Math.hypot(u.x - wx, u.y - wy);
      if (d <= u.radius + 4 && d < bestUD) {
        bestUD = d;
        bestUnit = u;
      }
    }
  }
  if (bestUnit) return { kind: 'unit', ref: bestUnit };
  for (const p of state.players) {
    for (const b of p.buildings) {
      const r = buildingRadius(b);
      if (Math.abs(b.x - wx) <= r && Math.abs(b.y - wy) <= r) return { kind: 'building', ref: b };
    }
  }
  for (const r of state.map.resources) {
    const d = Math.hypot(r.x - wx, r.y - wy);
    if (d <= r.radius + 8) return { kind: 'resource', ref: r };
  }
  return null;
}

function handleLeftClickSelect(wx, wy) {
  const pick = pickEntity(wx, wy);
  if (pick && pick.kind !== 'resource') {
    selection = [pick.ref];
  } else {
    selection = [];
  }
  refreshUI();
}

function handleBoxSelect(x1, y1, x2, y2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const found = human.units.filter((u) => u.x >= minX && u.x <= maxX && u.y >= minY && u.y <= maxY);
  if (found.length > 0) {
    selection = found;
  } else {
    handleLeftClickSelect((minX + maxX) / 2, (minY + maxY) / 2);
    return;
  }
  refreshUI();
}

function currentLineType(player, root) {
  return player.unitLine[root] || root;
}

function handleRightClickCommand(wx, wy) {
  if (placement) {
    placement = null;
    refreshUI();
    return;
  }
  const myUnits = selection.filter((e) => e.kind === 'unit' && e.owner === human);
  if (myUnits.length === 0) {
    const myBuilding = selection.find((e) => e.kind === 'building' && e.owner === human && e.def.trains);
    if (myBuilding) myBuilding.rally = { x: wx, y: wy };
    return;
  }
  const pick = pickEntity(wx, wy);
  if (pick && pick.kind === 'unit' && pick.ref.owner !== human) {
    for (const u of myUnits) issueAttack(state.map, u, pick.ref);
  } else if (pick && pick.kind === 'building' && pick.ref.owner !== human) {
    for (const u of myUnits) issueAttack(state.map, u, pick.ref);
  } else if (pick && pick.kind === 'resource') {
    for (const u of myUnits) {
      if (u.stats.class === 'villager') issueGather(state.map, u, pick.ref);
      else issueMove(state.map, u, pick.ref.x, pick.ref.y);
    }
  } else if (pick && pick.kind === 'building' && pick.ref.owner === human && pick.ref.def.isFarm && pick.ref.foodLeft > 0) {
    for (const u of myUnits) {
      if (u.stats.class === 'villager') issueGatherFarm(state.map, u, pick.ref);
    }
  } else if (pick && pick.kind === 'building' && pick.ref.owner === human && pick.ref.constructing) {
    for (const u of myUnits) {
      if (u.stats.class === 'villager') issueBuild(state.map, u, pick.ref);
    }
  } else {
    let i = 0;
    const n = myUnits.length;
    for (const u of myUnits) {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      const off = n > 1 ? Math.min(28, n * 3) : 0;
      issueMove(state.map, u, wx + Math.cos(ang) * off, wy + Math.sin(ang) * off);
      i++;
    }
  }
}

canvas.addEventListener('mousedown', (e) => {
  if (state.ended) return;
  const world = screenToWorld(e.offsetX, e.offsetY);
  if (e.button === 0) {
    if (placement) {
      tryPlaceBuilding(world.x, world.y);
      return;
    }
    dragStart = { x: e.offsetX, y: e.offsetY };
    dragCurrent = dragStart;
  } else if (e.button === 2) {
    handleRightClickCommand(world.x, world.y);
  }
});
canvas.addEventListener('mousemove', (e) => {
  mouseWorld = screenToWorld(e.offsetX, e.offsetY);
  if (dragStart) dragCurrent = { x: e.offsetX, y: e.offsetY };
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (placement) return;
  if (dragStart) {
    const dx = Math.abs(dragCurrent.x - dragStart.x);
    const dy = Math.abs(dragCurrent.y - dragStart.y);
    const w1 = screenToWorld(dragStart.x, dragStart.y);
    const w2 = screenToWorld(dragCurrent.x, dragCurrent.y);
    if (dx > 6 || dy > 6) {
      handleBoxSelect(w1.x, w1.y, w2.x, w2.y);
    } else {
      handleLeftClickSelect(w1.x, w1.y);
    }
  }
  dragStart = null;
  dragCurrent = null;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Escape') {
    placement = null;
    refreshUI();
  }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

function tryPlaceBuilding(wx, wy) {
  const def = BUILDINGS[placement.type];
  const { tx, ty } = state.map.worldToTile(wx, wy);
  const c = state.map.tileCenter(tx, ty);
  if (!state.map.canPlaceFootprint(c.x, c.y, def.size)) return;
  if (!human.canAfford(def.cost)) return;
  const b = startBuildingConstruction(state, human, placement.type, c.x, c.y);
  if (!b) return;
  const builders = selection.filter((e) => e.kind === 'unit' && e.owner === human && e.stats.class === 'villager');
  for (const v of builders) issueBuild(state.map, v, b);
  placement = null;
  refreshUI();
}

function panCamera(dt) {
  const speed = 480 * dt;
  if (keys['w'] || keys['arrowup']) camera.y -= speed;
  if (keys['s'] || keys['arrowdown']) camera.y += speed;
  if (keys['a'] || keys['arrowleft']) camera.x -= speed;
  if (keys['d'] || keys['arrowright']) camera.x += speed;
  clampCamera();
}

function update(dt) {
  state.time += dt;
  for (const p of state.players) {
    const unitsCopy = p.units.slice();
    for (const u of unitsCopy) updateUnit(state, u, dt);
    const buildingsCopy = p.buildings.slice();
    for (const b of buildingsCopy) updateBuilding(state, p, b, dt);
    updatePlayerAge(p, dt);
    recalcPopCap(p);
  }
  updateProjectiles(state, dt);
  updateAI(state, ai, aiState, human, dt);

  selection = selection.filter((e) => (e.kind === 'unit' ? e.owner.units.includes(e) : e.owner.buildings.includes(e)));

  if (!state.ended) {
    const humanAlive = human.buildings.length > 0 || human.units.length > 0;
    const aiAlive = ai.buildings.length > 0 || ai.units.length > 0;
    if (!humanAlive) { state.ended = true; state.winner = ai; }
    else if (!aiAlive) { state.ended = true; state.winner = human; }
    if (state.ended) showGameOver();
  }

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.25;
    refreshUI();
  }
}

function showGameOver() {
  gameOverText.textContent = state.winner === human ? '勝利！你征服了對手' : '戰敗……基地已被摧毀';
  gameOverOverlay.classList.remove('hidden');
}
restartBtn.addEventListener('click', () => { initGame(); });

function drawResourceNode(r) {
  const sx = r.x - camera.x;
  const sy = r.y - camera.y;
  if (sx < -30 || sy < -30 || sx > canvas.width + 30 || sy > canvas.height + 30) return;
  const ratio = r.amount / r.maxAmount;
  if (r.type === 'wood') {
    ctx.fillStyle = `rgba(40,90,45,${0.5 + 0.5 * ratio})`;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 14);
    ctx.lineTo(sx - 11, sy + 9);
    ctx.lineTo(sx + 11, sy + 9);
    ctx.closePath();
    ctx.fill();
  } else if (r.type === 'gold') {
    ctx.fillStyle = `rgba(212,175,55,${0.5 + 0.5 * ratio})`;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 10);
    ctx.lineTo(sx + 10, sy);
    ctx.lineTo(sx, sy + 10);
    ctx.lineTo(sx - 10, sy);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = `rgba(180,50,60,${0.5 + 0.5 * ratio})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ownerColor(owner, alt) {
  if (owner.id === 0) return alt ? '#1d4ed8' : '#3b82f6';
  return alt ? '#b91c1c' : '#ef4444';
}

function drawHpBar(sx, sy, width, ratio, selected) {
  ctx.fillStyle = '#200';
  ctx.fillRect(sx - width / 2, sy, width, 5);
  ctx.fillStyle = ratio > 0.5 ? '#4caf50' : ratio > 0.25 ? '#e6b800' : '#e53935';
  ctx.fillRect(sx - width / 2, sy, width * Math.max(0, ratio), 5);
  if (selected) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - width / 2, sy, width, 5);
  }
}

function drawBuilding(b) {
  const sx = b.x - camera.x;
  const sy = b.y - camera.y;
  const half = (b.sizeTiles * TILE) / 2;
  if (sx < -half - 40 || sy < -half - 40 || sx > canvas.width + 40 || sy > canvas.height + 40) return;
  const isSel = selection.includes(b);
  ctx.globalAlpha = b.constructing ? 0.55 : 1;
  ctx.fillStyle = ownerColor(b.owner, true);
  ctx.strokeStyle = isSel ? '#ffe066' : '#1a1a1a';
  ctx.lineWidth = isSel ? 3 : 2;
  ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
  ctx.strokeRect(sx - half, sy - half, half * 2, half * 2);
  ctx.globalAlpha = 1;
  ctx.font = `${Math.min(22, half)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(BUILD_ICON[b.type] || '?', sx, sy);
  drawHpBar(sx, sy - half - 10, half * 1.6, b.hp / b.maxHp, isSel);
  if (b.constructing) {
    ctx.fillStyle = '#ffe066';
    ctx.font = '11px sans-serif';
    ctx.fillText('建造中', sx, sy + half + 10);
  }
  if (b.research) {
    const ratio = 1 - b.research.timeLeft / b.research.total;
    ctx.fillStyle = '#7cc7ff';
    ctx.fillRect(sx - half, sy + half + 4, half * 2 * ratio, 4);
  }
  if (b.flashTimer > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
  }
}

function drawUnit(u) {
  const sx = u.x - camera.x;
  const sy = u.y - camera.y;
  if (sx < -30 || sy < -30 || sx > canvas.width + 30 || sy > canvas.height + 30) return;
  const isSel = selection.includes(u);
  ctx.beginPath();
  ctx.arc(sx, sy, u.radius, 0, Math.PI * 2);
  ctx.fillStyle = ownerColor(u.owner);
  ctx.fill();
  ctx.strokeStyle = isSel ? '#ffe066' : '#111';
  ctx.lineWidth = isSel ? 3 : 1.5;
  ctx.stroke();
  if (u.flashTimer > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(UNIT_LABEL[u.type] || '?', sx, sy + 1);
  if (u.hp < u.maxHp || isSel) drawHpBar(sx, sy - u.radius - 9, u.radius * 2.2, u.hp / u.maxHp, isSel);
  if (u.carry.amount > 0) {
    ctx.fillStyle = u.carry.type === 'wood' ? '#3a6b30' : u.carry.type === 'gold' ? '#d4af37' : '#c0392b';
    ctx.beginPath();
    ctx.arc(sx + u.radius * 0.7, sy - u.radius * 0.7, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawProjectile(p) {
  const sx = p.x - camera.x;
  const sy = p.y - camera.y;
  ctx.fillStyle = '#3a2a10';
  ctx.beginPath();
  ctx.arc(sx, sy, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlacementGhost() {
  if (!placement) return;
  const def = BUILDINGS[placement.type];
  const { tx, ty } = state.map.worldToTile(mouseWorld.x, mouseWorld.y);
  const c = state.map.tileCenter(tx, ty);
  const sx = c.x - camera.x;
  const sy = c.y - camera.y;
  const half = (def.size * TILE) / 2;
  const valid = state.map.canPlaceFootprint(c.x, c.y, def.size) && human.canAfford(def.cost);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = valid ? '#4caf50' : '#e53935';
  ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
  ctx.globalAlpha = 1;
}

function drawSelectionBox() {
  if (!dragStart || !dragCurrent) return;
  const dx = Math.abs(dragCurrent.x - dragStart.x);
  const dy = Math.abs(dragCurrent.y - dragStart.y);
  if (dx < 6 && dy < 6) return;
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth = 1.5;
  const x = Math.min(dragStart.x, dragCurrent.x);
  const y = Math.min(dragStart.y, dragCurrent.y);
  ctx.strokeRect(x, y, dx, dy);
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#3a5f2b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  const startTx = Math.floor(camera.x / TILE);
  const startTy = Math.floor(camera.y / TILE);
  for (let tx = startTx; tx < startTx + canvas.width / TILE + 2; tx++) {
    const sx = tx * TILE - camera.x;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
  }
  for (let ty = startTy; ty < startTy + canvas.height / TILE + 2; ty++) {
    const sy = ty * TILE - camera.y;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
  }

  for (const r of state.map.resources) drawResourceNode(r);
  for (const p of state.players) for (const b of p.buildings) drawBuilding(b);
  for (const p of state.players) for (const u of p.units) drawUnit(u);
  for (const pr of state.projectiles) drawProjectile(pr);
  drawPlacementGhost();
  drawSelectionBox();
}

function ageLabel(ageId) {
  return AGES[ageId].name;
}

function buildBuildingButtons(container) {
  const label = document.createElement('div');
  label.className = 'sectionLabel';
  label.textContent = '建造建築物';
  container.appendChild(label);
  const options = ['House', 'Barracks', 'Farm'];
  if (human.age >= 1) options.push('ArcheryRange', 'Stable', 'Blacksmith', 'LumberCamp', 'MiningCamp');
  for (const type of options) {
    const def = BUILDINGS[type];
    const btn = document.createElement('div');
    const affordable = human.canAfford(def.cost);
    btn.className = 'actBtn' + (affordable ? '' : ' disabled');
    btn.innerHTML = `<div class="icon">${BUILD_ICON[type]}</div><div>${def.name}</div><div class="cost">${costText(def.cost)}</div>`;
    btn.onclick = () => {
      if (!human.canAfford(def.cost)) return;
      placement = { type };
    };
    container.appendChild(btn);
  }
}

function trainButton(container, building, rootOrType, isRoot) {
  const type = isRoot ? currentLineType(human, rootOrType) : rootOrType;
  const def = UNITS[type];
  if (!def) return;
  if (def.requiresAge !== undefined && human.age < def.requiresAge) return;
  const affordable = human.canAfford(def.cost || {}) && building.trainQueue.length < 10;
  const btn = document.createElement('div');
  btn.className = 'actBtn' + (affordable ? '' : ' disabled');
  btn.innerHTML = `<div class="icon">${UNIT_ICON[type]}</div><div>${def.name}</div><div class="cost">${costText(def.cost)}</div>`;
  if (building.trainQueue.length > 0 && building.trainQueue[0].type === type) {
    const ratio = building.trainProgress / building.trainQueue[0].totalTime;
    btn.innerHTML += `<div class="miniProgress" style="width:${ratio * 100}%"></div>`;
  }
  const sameQueued = building.trainQueue.filter((q) => q.type === type).length;
  if (sameQueued > 0) btn.innerHTML += `<div class="queueBadge">${sameQueued}</div>`;
  btn.onclick = () => { startTraining(human, building, type); refreshUI(); };
  container.appendChild(btn);
}

function upgradeButton(container, building, upgradeKey) {
  const up = UNIT_UPGRADES[upgradeKey];
  if (human.age < up.requiresAge) return;
  if (building.research) return;
  const affordable = human.canAfford(up.cost);
  const btn = document.createElement('div');
  btn.className = 'actBtn' + (affordable ? '' : ' disabled');
  btn.innerHTML = `<div class="icon">⬆️</div><div>${up.name}</div><div class="cost">${costText(up.cost)}</div>`;
  btn.onclick = () => { startUnitUpgrade(human, building, upgradeKey); refreshUI(); };
  container.appendChild(btn);
}

function techButton(container, building, key) {
  const tech = TECHS[key];
  if (human.age < tech.requiresAge) return;
  if (human.techsResearched.has(key)) return;
  if (building.research) return;
  const affordable = human.canAfford(tech.cost);
  const btn = document.createElement('div');
  btn.className = 'actBtn' + (affordable ? '' : ' disabled');
  btn.innerHTML = `<div class="icon">🧪</div><div>${tech.name}</div><div class="cost">${costText(tech.cost)}</div>`;
  btn.onclick = () => { startResearchTech(human, building, key); refreshUI(); };
  container.appendChild(btn);
}

function buildAgeUpButton(container, building) {
  const nextAge = AGES[human.age + 1];
  if (!nextAge) return;
  const label = document.createElement('div');
  label.className = 'sectionLabel';
  label.textContent = '時代升級';
  container.appendChild(label);
  const btn = document.createElement('div');
  const affordable = human.canAfford(nextAge.nextCost) && !human.ageResearch;
  btn.className = 'actBtn' + (affordable ? '' : ' disabled');
  btn.innerHTML = `<div class="icon">⏫</div><div>晉級：${nextAge.name}</div><div class="cost">${costText(nextAge.nextCost)}</div>`;
  if (human.ageResearch) {
    const ratio = 1 - human.ageResearch.timeLeft / human.ageResearch.total;
    btn.innerHTML += `<div class="miniProgress" style="width:${ratio * 100}%"></div>`;
  }
  btn.onclick = () => { startAgeUp(human); refreshUI(); };
  container.appendChild(btn);
}

function refreshActionButtons() {
  actionButtonsEl.innerHTML = '';
  const myBuildings = selection.filter((e) => e.kind === 'building' && e.owner === human);
  const myVillagers = selection.filter((e) => e.kind === 'unit' && e.owner === human && e.stats.class === 'villager');

  if (myBuildings.length === 1) {
    const b = myBuildings[0];
    if (b.constructing) {
      const info = document.createElement('div');
      info.className = 'sectionLabel';
      info.textContent = '建築物興建中，需要村民協助施工';
      actionButtonsEl.appendChild(info);
    } else {
      if (b.def.trains) {
        const label = document.createElement('div');
        label.className = 'sectionLabel';
        label.textContent = '訓練單位';
        actionButtonsEl.appendChild(label);
        for (const slot of b.def.trains) {
          const isRoot = Object.prototype.hasOwnProperty.call(human.unitLine, slot);
          trainButton(actionButtonsEl, b, slot, isRoot);
        }
        const upKeys = Object.keys(UNIT_UPGRADES).filter((key) => {
          const up = UNIT_UPGRADES[key];
          if (up.building !== b.type) return false;
          return Object.values(human.unitLine).includes(up.from);
        });
        if (upKeys.length > 0) {
          const upLabel = document.createElement('div');
          upLabel.className = 'sectionLabel';
          upLabel.textContent = '兵種升級';
          actionButtonsEl.appendChild(upLabel);
          for (const key of upKeys) upgradeButton(actionButtonsEl, b, key);
        }
      }
      if (b.def.researches) {
        const label = document.createElement('div');
        label.className = 'sectionLabel';
        label.textContent = '科技研究';
        actionButtonsEl.appendChild(label);
        for (const key of b.def.researches) techButton(actionButtonsEl, b, key);
      }
      if (b.def.canAgeUp) buildAgeUpButton(actionButtonsEl, b);
    }
  }

  if (myVillagers.length > 0 && myBuildings.length === 0) {
    buildBuildingButtons(actionButtonsEl);
  }

  if (myBuildings.length === 0 && myVillagers.length === 0 && selection.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'sectionLabel';
    hint.textContent = '選取單位或建築以查看可用指令';
    actionButtonsEl.appendChild(hint);
  }
}

function refreshSelectionInfo() {
  selectionInfoEl.innerHTML = '';
  if (selection.length === 0) {
    selectionInfoEl.innerHTML = '<div class="placeholder">尚未選取任何單位或建築</div>';
    return;
  }
  if (selection.length === 1) {
    const e = selection[0];
    if (e.kind === 'unit') {
      const stats = effectiveStats(e);
      selectionInfoEl.innerHTML = `
        <div class="name">${UNIT_ICON[e.type] || ''} ${stats.name}${e.owner.isAI ? '（敵方）' : ''}</div>
        <div class="hpbar"><div class="fill" style="width:${(e.hp / e.maxHp) * 100}%"></div></div>
        <div class="stats">
          <span>HP ${Math.ceil(e.hp)}/${e.maxHp}</span>
          <span>攻擊 ${stats.attack}</span>
          <span>護甲 ${stats.armor}</span>
          <span>射程 ${(stats.range / TILE).toFixed(1)}格</span>
        </div>`;
    } else {
      let extra = '';
      if (e.trainQueue && e.trainQueue.length > 0) {
        extra += `<div>訓練佇列：${e.trainQueue.map((q) => UNITS[q.type].name).join('、')}</div>`;
      }
      if (e.research) {
        const rname = e.research.kind === 'tech' ? TECHS[e.research.key].name : UNIT_UPGRADES[e.research.key].name;
        extra += `<div>研究中：${rname}（剩 ${e.research.timeLeft.toFixed(1)}s）</div>`;
      }
      if (e.def.isFarm) extra += `<div>剩餘食物：${Math.ceil(e.foodLeft || 0)}</div>`;
      selectionInfoEl.innerHTML = `
        <div class="name">${BUILD_ICON[e.type] || ''} ${e.def.name}${e.owner.isAI ? '（敵方）' : ''}</div>
        <div class="hpbar"><div class="fill" style="width:${(e.hp / e.maxHp) * 100}%"></div></div>
        <div class="stats"><span>HP ${Math.ceil(e.hp)}/${e.maxHp}</span></div>
        ${extra}`;
    }
    return;
  }
  const counts = {};
  for (const e of selection) {
    const key = e.kind === 'unit' ? e.type : e.type;
    counts[key] = (counts[key] || 0) + 1;
  }
  let html = `<div class="name">已選取 ${selection.length} 個單位</div>`;
  for (const k in counts) {
    const nm = UNITS[k] ? UNITS[k].name : (BUILDINGS[k] ? BUILDINGS[k].name : k);
    html += `<div class="groupItem"><span>${nm}</span><span>${counts[k]}</span></div>`;
  }
  selectionInfoEl.innerHTML = html;
}

function refreshTopbar() {
  topbarEls.wood.textContent = Math.floor(human.resources.wood);
  topbarEls.food.textContent = Math.floor(human.resources.food);
  topbarEls.gold.textContent = Math.floor(human.resources.gold);
  topbarEls.pop.textContent = `${human.currentPop()}/${human.popCap}`;
  topbarEls.ageName.textContent = ageLabel(human.age);
  if (human.ageResearch) {
    topbarEls.ageProgressWrap.classList.remove('hidden');
    const ratio = 1 - human.ageResearch.timeLeft / human.ageResearch.total;
    topbarEls.ageProgressFill.style.width = `${ratio * 100}%`;
  } else {
    topbarEls.ageProgressWrap.classList.add('hidden');
  }
}

function refreshUI() {
  refreshTopbar();
  refreshSelectionInfo();
  refreshActionButtons();
}

let lastTs = null;
function frame(ts) {
  if (lastTs === null) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  dt = Math.min(dt, 0.05);
  if (!state.ended) {
    panCamera(dt);
    update(dt);
  }
  render();
  requestAnimationFrame(frame);
}

resizeCanvas();
initGame();
requestAnimationFrame(frame);
