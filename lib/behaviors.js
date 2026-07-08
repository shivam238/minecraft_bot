const { goals } = require('mineflayer-pathfinder');
const { state, Priorities } = require('./state');
const { getConfig } = require('./config');
const { stopCurrentTasks, clearAllIntervals } = require('./lifecycle');
const {
  safeSetGoal,
  isPathSafe,
  releaseMovementKeys,
  isCurrentGroundSafe,
  isDirectionSafe,
  isPanicDirectionClear,
  isNearVoidEdge,
  isFallingIntoVoid,
} = require('./pathfinding');
const { clearSleepListener, wakeUp, findNearbyBed, walkToBedAndSleep, isEntitySleeping } = require('./sleep');
const { autoDeposit, findNearbyChest } = require('./storage');
const log = require('./logger');

function isAFKActive() {
  const bot = state.bot;
  return bot && bot.entity && state.botState === 'afk' && !bot.pvp.target && !bot.isSleeping;
}

// Returns true if the bot is standing on a block that should not be jumped on
// (farmland = crops destroyed by jumping, dripstone = damage)
const SENSITIVE_GROUND = [
  'farmland', 'pointed_dripstone', 'dripstone_block',
  'soul_sand', 'soul_soil',
];
function isOnSensitiveGround() {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;
  const pos = bot.entity.position;
  const ground = bot.blockAt(pos.offset(0, -0.1, 0)) || bot.blockAt(pos.offset(0, -1, 0));
  if (!ground) return false;
  return SENSITIVE_GROUND.some((name) => ground.name.includes(name));
}

async function smoothLook(targetYaw, targetPitch, steps = 10, interval = 50) {
  const bot = state.bot;
  if (!bot || !bot.entity) return;

  const wrap = (val) => Math.atan2(Math.sin(val), Math.cos(val));
  const currentYaw = bot.entity.yaw;
  const currentPitch = bot.entity.pitch;
  const yawDiff = wrap(targetYaw - currentYaw);
  const pitchDiff = targetPitch - currentPitch;

  for (let i = 1; i <= steps; i++) {
    if (!isAFKActive()) return;
    const nextYaw = currentYaw + yawDiff * (i / steps);
    const nextPitch = currentPitch + pitchDiff * (i / steps);
    try {
      await bot.look(nextYaw, nextPitch, true);
    } catch (_) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function getNaturalLookAngles() {
  const bot = state.bot;
  if (!bot || !bot.entity) return null;

  if (Math.random() < 0.3) {
    const entity = bot.nearestEntity(
      (e) =>
        (e.type === 'player' || e.type === 'mob' || e.type === 'passive') &&
        e.position.distanceTo(bot.entity.position) < 12 &&
        !state.memory.recentTargetEntities.slice(0, 2).includes(e.id)
    );
    if (entity) {
      const delta = entity.position
        .offset(0, entity.height || 1.6, 0)
        .minus(bot.entity.position.offset(0, bot.entity.height || 1.6, 0));
      const targetYaw = Math.atan2(-delta.x, -delta.z) + (Math.random() * 2 - 1) * 0.1;
      const groundDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
      const targetPitch =
        Math.atan2(delta.y, groundDist) + (Math.random() * 2 - 1) * 0.1;

      if (!state.memory.recentTargetEntities.includes(entity.id)) {
        state.memory.recentTargetEntities.unshift(entity.id);
        if (state.memory.recentTargetEntities.length > 5) {
          state.memory.recentTargetEntities.pop();
        }
      }
      return { yaw: targetYaw, pitch: targetPitch };
    }
  }

  return {
    yaw: bot.entity.yaw + (Math.random() * 2 - 1) * (Math.PI / 4),
    pitch: Math.max(-0.6, Math.min(0.6, bot.entity.pitch + (Math.random() * 2 - 1) * (Math.PI / 12))),
  };
}

async function runLookAction() {
  const angles = getNaturalLookAngles();
  if (angles && isAFKActive()) {
    await smoothLook(angles.yaw, angles.pitch, Math.floor(5 + Math.random() * 10), Math.floor(40 + Math.random() * 20));
  }
}

async function runLookSwingAction() {
  const angles = getNaturalLookAngles();
  if (!angles || !isAFKActive()) return;
  await smoothLook(angles.yaw, angles.pitch, Math.floor(5 + Math.random() * 10), Math.floor(40 + Math.random() * 20));
  if (isAFKActive()) {
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    state.bot.swingArm('right');
  }
}

async function runDirectWalk() {
  const bot = state.bot;
  if (!isAFKActive() || bot.pathfinder.isMoving()) return;
  if (!isCurrentGroundSafe()) return;

  // Pick a safe world-yaw to walk toward by testing 8 candidate angles randomly.
  // We always end up pressing 'forward' after rotating to this yaw, so the validated
  // direction always matches the actual movement direction — no key/direction mismatch.
  const baseYaw = bot.entity.yaw;
  const candidates = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4,
                      Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4];
  const shuffled = candidates.slice().sort(() => Math.random() - 0.5);

  let chosenYaw = null;
  for (const offset of shuffled) {
    const candidateYaw = baseYaw + offset;
    if (isDirectionSafe(candidateYaw, 2.5)) {
      chosenYaw = candidateYaw;
      break;
    }
  }

  // No safe direction found — stay put
  if (chosenYaw === null) return;

  const doSprint = Math.random() < 0.35;
  const duration = 400 + Math.floor(Math.random() * 800);

  // Rotate to face the validated safe direction, then walk forward
  await smoothLook(chosenYaw + (Math.random() * 0.2 - 0.1), (Math.random() * 2 - 1) * 0.15, 4, 30);

  // Re-check safety after turning (position may have shifted slightly)
  if (!isAFKActive() || !isCurrentGroundSafe() || !isDirectionSafe(bot.entity.yaw, 2)) {
    releaseMovementKeys();
    return;
  }

  // Always forward — we already rotated to face the safe direction
  bot.setControlState('forward', true);
  if (doSprint) bot.setControlState('sprint', true);

  try {
    await new Promise((resolve) => setTimeout(resolve, duration));
  } finally {
    releaseMovementKeys();
  }

  // Only jump if still safe — never jump on void edge or farmland/dripstone
  if (isAFKActive() && isCurrentGroundSafe() && !isOnSensitiveGround() && isDirectionSafe(bot.entity.yaw, 1.5) && Math.random() < 0.2) {
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (state.bot) state.bot.setControlState('jump', false);
    }, 150);
  }
}

async function runWalkAction() {
  const bot = state.bot;
  if (!bot || !bot.entity || bot.pathfinder.isMoving()) return;

  // Save home position the very first time we wander
  if (!state.homePosition) {
    state.homePosition = bot.entity.position.clone();
    log.info(`Home position set: ${Math.round(state.homePosition.x)}, ${Math.round(state.homePosition.y)}, ${Math.round(state.homePosition.z)}`);
  }

  const home = state.homePosition;
  const hdx = home.x - bot.entity.position.x;
  const hdz = home.z - bot.entity.position.z;
  const distFromHome = Math.sqrt(hdx * hdx + hdz * hdz);
  const homeAngle = Math.atan2(hdz, hdx); // angle pointing back to home

  // Too far from home — pathfind directly back before doing anything else
  if (distFromHome > 15) {
    log.info(`Too far from home (${Math.round(distFromHome)}m) — returning`);
    safeSetGoal(new goals.GoalNear(home.x, home.y, home.z, 3));
    const startTime = Date.now();
    while (isAFKActive() && bot.pathfinder.isMoving() && Date.now() - startTime < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (bot.pathfinder.isMoving()) try { bot.pathfinder.stop(); } catch (_) {}
    return;
  }

  let targetPos = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    // Dynamically scale down distance as attempts fail
    const maxDist = Math.max(4, 12 - attempt * 0.5);
    const minDist = Math.max(2.0, 5 - attempt * 0.2);
    const dist = minDist + Math.random() * (maxDist - minDist);

    // When far from home (>8m), bias 70% of attempts toward home direction (±45°)
    // This naturally pulls the bot back toward center without forcing it
    let angle;
    if (distFromHome > 8 && Math.random() < 0.70) {
      angle = homeAngle + (Math.random() * Math.PI / 2 - Math.PI / 4);
    } else {
      angle = Math.random() * Math.PI * 2;
    }

    const possibleTarget = bot.entity.position.offset(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
    if (isPathSafe(bot.entity.position, possibleTarget, false)) {
      targetPos = possibleTarget;
      break;
    }
  }

  if (targetPos && isAFKActive()) {
    const sneak = Math.random() < 0.15;
    if (sneak) bot.setControlState('sneak', true);
    safeSetGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 0.5));

    const startTime = Date.now();
    while (isAFKActive() && bot.pathfinder.isMoving() && Date.now() - startTime < 6000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (sneak) bot.setControlState('sneak', false);

    // Stop pathfinder if it timed out/is still active to prevent locking subsequent cycles
    if (bot.pathfinder.isMoving()) {
      try {
        bot.pathfinder.stop();
      } catch (_) {}
    }

    if (isAFKActive() && Math.random() < 0.25) {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (state.bot) state.bot.setControlState('jump', false);
      }, 150);
    } else if (isAFKActive() && Math.random() < 0.5) {
      bot.swingArm('right');
    }
  } else if (isAFKActive()) {
    await runDirectWalk();
  }
}

async function runSprintBurst() {
  const bot = state.bot;
  if (!isAFKActive() || bot.pathfinder.isMoving() || !isCurrentGroundSafe()) return;

  // Check forward direction is safe before sprinting — sprint is fast and edges are fatal
  if (!isDirectionSafe(bot.entity.yaw, 3)) return;

  const duration = 300 + Math.floor(Math.random() * 500);
  await smoothLook(bot.entity.yaw + (Math.random() * 0.6 - 0.3), (Math.random() * 2 - 1) * 0.1, 3, 25);

  if (!isAFKActive() || !isCurrentGroundSafe() || !isDirectionSafe(bot.entity.yaw, 2)) {
    releaseMovementKeys();
    return;
  }

  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  try {
    await new Promise((resolve) => setTimeout(resolve, duration));
  } finally {
    releaseMovementKeys();
  }
}

async function performMicroAction() {
  const bot = state.bot;
  if (!isAFKActive()) return;

  const roll = Math.random();
  if (roll < 0.12) {
    // Crouch dance!
    const dancers = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < dancers; i++) {
      if (!isAFKActive()) break;
      bot.setControlState('sneak', true);
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 150));
      bot.setControlState('sneak', false);
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
    }
  } else if (roll < 0.28) {
    // Small jump — skip if standing on crops/dripstone
    if (!isOnSensitiveGround()) {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (state.bot) state.bot.setControlState('jump', false);
      }, 150);
      if (Math.random() < 0.4) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (isAFKActive()) bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');
      }
    }
  } else if (roll < 0.45) {
    // Swing arm/punch multiple times
    const swings = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < swings; i++) {
      if (!isAFKActive()) break;
      bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 200));
    }
  } else if (roll < 0.60 && isCurrentGroundSafe()) {
    const dir = Math.random() < 0.5 ? 'left' : 'right';
    bot.setControlState(dir, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    } finally {
      if (bot) bot.setControlState(dir, false);
    }
  } else if (roll < 0.72 && isCurrentGroundSafe()) {
    bot.setControlState('back', true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 250));
    } finally {
      if (bot) bot.setControlState('back', false);
    }
  } else if (roll < 0.85) {
    // Minor look adjustment
    const yaw = bot.entity.yaw + (Math.random() * 0.4 - 0.2);
    const pitch = Math.max(-0.6, Math.min(0.6, bot.entity.pitch + (Math.random() * 0.2 - 0.1)));
    await smoothLook(yaw, pitch, 3, 30);
  }
}


// Sneak + slow look around + unsneak — like peeking at something
async function runCrouchPeek() {
  const bot = state.bot;
  if (!isAFKActive()) return;

  bot.setControlState('sneak', true);
  // Slowly scan left then right while crouching
  const baseYaw = bot.entity.yaw;
  await smoothLook(baseYaw + (Math.random() * 0.6 + 0.3), (Math.random() * 2 - 1) * 0.3, 8, 60);
  if (!isAFKActive()) { bot.setControlState('sneak', false); return; }
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
  if (!isAFKActive()) { bot.setControlState('sneak', false); return; }
  await smoothLook(baseYaw - (Math.random() * 0.6 + 0.3), (Math.random() * 2 - 1) * 0.2, 8, 60);
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
  bot.setControlState('sneak', false);
}

// Sprint-jump sequence — 2–3 jumps while running forward (parkour feel)
async function runJumpWalk() {
  const bot = state.bot;
  if (!isAFKActive() || bot.pathfinder.isMoving() || !isCurrentGroundSafe()) return;
  // Never jump on farmland / dripstone
  if (isOnSensitiveGround()) return;

  const targetYaw = bot.entity.yaw + (Math.random() * 0.5 - 0.25);

  // Sprint+jump carries 4+ blocks of momentum — need 7-block runway to be safe
  if (!isDirectionSafe(targetYaw, 7)) return;

  await smoothLook(targetYaw, -0.1, 3, 25);
  if (!isAFKActive() || !isCurrentGroundSafe() || !isDirectionSafe(targetYaw, 7)) return;
  if (isOnSensitiveGround()) return;

  const jumps = 2 + Math.floor(Math.random() * 2); // 2 or 3 jumps
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);

  for (let i = 0; i < jumps; i++) {
    // Check 5 blocks ahead before each jump — abort entire sequence if unsafe
    if (!isAFKActive() || !isCurrentGroundSafe() || !isDirectionSafe(bot.entity.yaw, 5)) {
      releaseMovementKeys();
      return;
    }
    if (isOnSensitiveGround()) { releaseMovementKeys(); return; }
    bot.setControlState('jump', true);
    await new Promise((r) => setTimeout(r, 100));
    bot.setControlState('jump', false);
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 150));
  }

  releaseMovementKeys();
}

// Look at a nearby interesting block (chest, furnace, crafting table, ore, etc.)
async function runLookAtBlock() {
  const bot = state.bot;
  if (!isAFKActive()) return;

  const interestingBlocks = [
    'chest', 'furnace', 'crafting_table', 'enchanting_table',
    'anvil', 'diamond_ore', 'gold_ore', 'iron_ore', 'coal_ore',
    'emerald_ore', 'bookshelf', 'beacon', 'bed',
  ];

  const block = bot.findBlock({
    matching: (b) => interestingBlocks.some((name) => b.name.includes(name)),
    maxDistance: 16,
  });

  if (!block) {
    await runLookAction(); // fallback
    return;
  }

  const delta = block.position.offset(0.5, 0.5, 0.5)
    .minus(bot.entity.position.offset(0, bot.entity.height || 1.6, 0));
  const targetYaw = Math.atan2(-delta.x, -delta.z) + (Math.random() * 0.15 - 0.075);
  const groundDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
  const targetPitch = Math.max(-0.8, Math.min(0.8, Math.atan2(delta.y, groundDist)));

  await smoothLook(targetYaw, targetPitch, 8, 50);
  if (isAFKActive()) {
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 600));
    // Occasionally "interact" gesture — arm swing while looking at it
    if (Math.random() < 0.4) bot.swingArm('right');
  }
}

// Slow idle look — up, forward, down, side — like stretching/zoning out
async function runIdleLook() {
  const bot = state.bot;
  if (!isAFKActive()) return;

  const baseYaw = bot.entity.yaw;
  const sequence = [
    { yaw: baseYaw, pitch: -0.4 + Math.random() * 0.2 },          // look up
    { yaw: baseYaw + (Math.random() * 0.4 - 0.2), pitch: 0.1 },   // forward
    { yaw: baseYaw + (Math.random() * 0.8 - 0.4), pitch: 0.35 },  // look down-ish
    { yaw: baseYaw + (Math.random() * 0.6 + 0.3), pitch: 0 },     // look side
  ];

  for (const target of sequence) {
    if (!isAFKActive()) break;
    await smoothLook(target.yaw, target.pitch, 6, 70);
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
  }
}

function touchServerActivity() {
  state.lastServerActivityTime = Date.now();
}

async function runKeepAlive(force = false) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity || bot.isSleeping) return;

  const idleMs = Date.now() - (state.lastServerActivityTime || 0);
  if (!force && idleMs < config.maxIdleBeforeKeepAliveMs) return;

  try {
    const yaw = bot.entity.yaw + (Math.random() * 2 - 1) * 0.4;
    const pitch = Math.max(-0.5, Math.min(0.5, bot.entity.pitch + (Math.random() * 2 - 1) * 0.15));
    await bot.look(yaw, pitch, true);
    bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');

    if (isCurrentGroundSafe() && Math.random() < 0.35) {
      bot.setControlState('forward', true);
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 200));
      bot.setControlState('forward', false);
    }

    touchServerActivity();
    log.info(`Keep-alive sent (${Math.round(idleMs / 1000)}s since last activity)`);
  } catch (err) {
    log.fail('Keep-alive failed', err);
  }
}

function startKeepAliveLoop() {
  const config = getConfig();
  if (state.keepAliveInterval) {
    clearInterval(state.keepAliveInterval);
    state.keepAliveInterval = null;
  }

  touchServerActivity();
  const intervalMs = Math.max(45000, config.keepAliveIntervalMs);
  state.keepAliveInterval = setInterval(() => {
    runKeepAlive(true);
  }, intervalMs);

  log.ok(`Keep-alive loop started (every ${Math.round(intervalMs / 1000)}s)`);
}

// Pick up nearby dropped items and auto-deposit to chest when full
async function runPickupItems() {
  const bot = state.bot;
  if (!isAFKActive() || bot.pathfinder.isMoving()) return;

  // Find nearest dropped item within 16 blocks
  const item = bot.nearestEntity(
    (e) =>
      e.name === 'item' &&
      bot.entity.position.distanceTo(e.position) < 16
  );

  if (!item) {
    // No items on ground — check if inventory is full enough to deposit
    await autoDeposit(bot);
    return;
  }

  log.info(`Pickup: spotted item at ${Math.round(item.position.x)},${Math.round(item.position.y)},${Math.round(item.position.z)}`);
  // Use pathfinder directly — it handles terrain safely, safeSetGoal rejects floating item positions
  try { bot.pathfinder.setGoal(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)); } catch (_) { return; }

  const startTime = Date.now();
  while (isAFKActive() && bot.pathfinder.isMoving() && Date.now() - startTime < 5000) {
    // Stop early if item was already picked up (entity gone)
    if (!bot.entities[item.id]) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (bot.pathfinder.isMoving()) try { bot.pathfinder.stop(); } catch (_) {}

  // After picking up, deposit if inventory is getting full
  await autoDeposit(bot);
}

function pickAFKActionType(forceWalk) {
  if (forceWalk) return 'walk';
  const types = ['look', 'idle_look', 'look_swing', 'look_block', 'crouch_peek', 'jump_walk', 'sprint_burst', 'direct_walk', 'pickup_items', 'walk'];
  const thresholds = [0.02, 0.05, 0.08, 0.11, 0.15, 0.23, 0.35, 0.55, 0.72, 1.0];
  const rand = Math.random();
  for (let i = 0; i < thresholds.length; i++) {
    if (rand < thresholds[i]) return types[i];
  }
  return 'walk';
}

async function runAFKCycle(forceWalk = false) {
  if (!isAFKActive()) return;

  let actionType = pickAFKActionType(forceWalk);
  if (!forceWalk && actionType === state.lastAFKActionType) {
    actionType = pickAFKActionType(false);
  }
  state.lastAFKActionType = actionType;

  state.memory.lastAFKActions.unshift(actionType);
  if (state.memory.lastAFKActions.length > 5) state.memory.lastAFKActions.pop();

  switch (actionType) {
    case 'look': await runLookAction(); break;
    case 'idle_look': await runIdleLook(); break;
    case 'look_swing': await runLookSwingAction(); break;
    case 'look_block': await runLookAtBlock(); break;
    case 'walk': await runWalkAction(); break;
    case 'direct_walk': await runDirectWalk(); break;
    case 'sprint_burst': await runSprintBurst(); break;
    case 'crouch_peek': await runCrouchPeek(); break;
    case 'jump_walk': await runJumpWalk(); break;
    case 'pickup_items': await runPickupItems(); break;
    default: await runLookAction(); break;
  }

  if (isAFKActive()) await performMicroAction();
  touchServerActivity();
}

function scheduleNextAFK(isFirstCycle = false) {
  if (state.smartAFKInterval) {
    clearTimeout(state.smartAFKInterval);
    state.smartAFKInterval = null;
  }
  if (!state.bot || !state.bot.entity) return;

  const multiplier = state.afkSpeedMultiplier || 1.0;
  let delay = isFirstCycle
    ? 800 + Math.random() * 1200
    : (1000 + Math.random() * 2000) / multiplier;

  state.smartAFKInterval = setTimeout(async () => {
    if (isAFKActive()) await runAFKCycle(isFirstCycle);
    scheduleNextAFK();
  }, delay);
}

function getNearbyCreeper() {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return null;
  const avoidDist = config.creeperAvoidDistance;
  return bot.nearestEntity(
    (e) =>
      e.type === 'mob' &&
      e.name === 'creeper' &&
      bot.entity.position.distanceTo(e.position) < avoidDist
  );
}

function getNearbyHostileMob() {
  const bot = state.bot;
  const { hostileMobs } = require('./state');
  if (!bot || !bot.entity) return null;
  return bot.nearestEntity(
    (e) =>
      e.type === 'mob' &&
      hostileMobs.includes(e.name) &&
      bot.entity.position.distanceTo(e.position) < 6
  );
}

function findSafeEscapePosition(creeper) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return null;

  const botPos = bot.entity.position;
  const dir = botPos.minus(creeper.position);
  dir.y = 0;
  const normDir = dir.normalize();
  const angles = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2];
  const avoidDist = config.creeperAvoidDistance;
  const distances = [avoidDist + 2, avoidDist, Math.max(4, avoidDist - 2)];

  for (const dist of distances) {
    for (const angle of angles) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotatedX = normDir.x * cos - normDir.z * sin;
      const rotatedZ = normDir.x * sin + normDir.z * cos;

      for (let dy = 2; dy >= -3; dy--) {
        const checkPos = botPos.offset(rotatedX * dist, dy, rotatedZ * dist);
        const feetBlock = bot.blockAt(checkPos);
        const headBlock = bot.blockAt(checkPos.offset(0, 1, 0));
        let groundBlock = bot.blockAt(checkPos.offset(0, -0.1, 0));
        if (!groundBlock || groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air') {
          groundBlock = bot.blockAt(checkPos);
        }

        if (feetBlock && headBlock && groundBlock) {
          const feetOk =
            feetBlock.boundingBox === 'empty' ||
            feetBlock.name.includes('air') ||
            feetBlock.name.includes('grass');
          const headOk =
            headBlock.boundingBox === 'empty' ||
            headBlock.name.includes('air') ||
            headBlock.name.includes('grass');
          const groundOk =
            (groundBlock.boundingBox === 'block' || groundBlock.name.includes('slab') || groundBlock.name.includes('stairs') || groundBlock.name.includes('farmland') || groundBlock.name.includes('path') || groundBlock.name.includes('chest')) &&
            !groundBlock.name.includes('air') &&
            !groundBlock.name.includes('lava') &&
            !groundBlock.name.includes('water');

          if (feetOk && headOk && groundOk) return checkPos;
        }
      }
    }
  }
  return null;
}

function updateMemory() {
  const bot = state.bot;
  if (!bot || !bot.entity) return;

  const now = Date.now();
  if (now - state.lastMemoryUpdateTime <= 2000) return;
  state.lastMemoryUpdateTime = now;

  const pos = bot.entity.position.clone();
  let groundBlock = bot.blockAt(pos.offset(0, -0.1, 0));
  if (!groundBlock || groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air') {
    groundBlock = bot.blockAt(pos);
  }
  if (
    groundBlock &&
    (groundBlock.boundingBox === 'block' || groundBlock.name.includes('slab') || groundBlock.name.includes('stairs') || groundBlock.name.includes('farmland') || groundBlock.name.includes('path') || groundBlock.name.includes('chest')) &&
    !groundBlock.name.includes('air') &&
    !groundBlock.name.includes('lava') &&
    !groundBlock.name.includes('water')
  ) {
    const lastSaved = state.memory.recentPositions[0];
    if (!lastSaved || lastSaved.distanceTo(pos) > 1.5) {
      state.memory.recentPositions.unshift(pos);
      if (state.memory.recentPositions.length > 8) state.memory.recentPositions.pop();
    }
  }

  const currentTarget = bot.nearestEntity(
    (e) =>
      (e.type === 'player' || e.type === 'mob' || e.type === 'passive') &&
      e.position.distanceTo(bot.entity.position) < 12
  );
  if (currentTarget && !state.memory.recentTargetEntities.includes(currentTarget.id)) {
    state.memory.recentTargetEntities.unshift(currentTarget.id);
    if (state.memory.recentTargetEntities.length > 5) {
      state.memory.recentTargetEntities.pop();
    }
  }
}

// Accept pre-computed values from runPriorityManagerTick to avoid calling
// isFallingIntoVoid / getNearbyCreeper twice per 200 ms tick.
function getCurrentPriority(precomputed = {}) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return Priorities.IDLE;

  // Highest: actively falling into void with no solid ground below
  const fallingIntoVoid = 'fallingIntoVoid' in precomputed ? precomputed.fallingIntoVoid : isFallingIntoVoid();
  if (fallingIntoVoid) return Priorities.VOID_ESCAPE;

  // Critically low health — retreat immediately
  if (bot.health > 0 && bot.health < 6) return Priorities.EMERGENCY_SURVIVAL;

  const nearbyCreeper = 'nearbyCreeper' in precomputed ? precomputed.nearbyCreeper : getNearbyCreeper();
  if (config.autoDefense && nearbyCreeper) return Priorities.CREEPER_ESCAPE;

  // Panic: owner hit the bot recently
  if (state.panicActive) {
    if (Date.now() > state.panicEndTime) {
      state.panicActive = false;
      state.panicFromPos = null;
      state.panicFromName = null;
      releaseMovementKeys();
    } else {
      return Priorities.PANICKING;
    }
  }
  if (config.autoDefense && (bot.pvp.target)) return Priorities.COMBAT;
  if (bot.isSleeping || state.botState === 'sleeping') {
    return Priorities.SLEEPING;
  }
  if (state.botState === 'following' && state.followTarget) return Priorities.FOLLOWING;
  if (state.botState === 'guard' && state.guardPosition) return Priorities.GUARDING;
  if (state.botState === 'afk') return Priorities.AFK;
  return Priorities.IDLE;
}

function handlePriorityTransition(oldPriority, newPriority) {
  const bot = state.bot;
  const wasHighPriority = oldPriority <= Priorities.COMBAT;
  const isHighPriority = newPriority <= Priorities.COMBAT;

  // Void escape: immediately kill all movement
  if (newPriority === Priorities.VOID_ESCAPE) {
    releaseMovementKeys();
    if (bot && bot.pathfinder) {
      try { bot.pathfinder.stop(); } catch (_) {}
    }
    log.warn('VOID ESCAPE — all movement stopped');
    return;
  }

  // Panic transition: stop current action so panic run takes over cleanly
  if (newPriority === Priorities.PANICKING) {
    if (bot && bot.pathfinder) {
      try { bot.pathfinder.stop(); } catch (_) {}
    }
    releaseMovementKeys();
    return;
  }

  // Leaving panic: stop sprinting
  if (oldPriority === Priorities.PANICKING) {
    releaseMovementKeys();
  }

  if (isHighPriority && !wasHighPriority && bot.autoEat) {
    bot.autoEat.disableAuto();
    bot.autoEat.cancelEat();
    log.info('AutoEat suspended for high-priority action');
  } else if (!isHighPriority && wasHighPriority && bot.autoEat) {
    bot.autoEat.enableAuto();
    log.info('AutoEat resumed');
  }

  // Don't stop pathfinder when entering COMBAT — pvp uses pathfinder to chase targets
  if (bot.pathfinder && newPriority !== Priorities.SLEEPING && newPriority !== Priorities.COMBAT) bot.pathfinder.stop();
  if (oldPriority === Priorities.COMBAT && bot.pvp) bot.pvp.stop();
  if (oldPriority === Priorities.FOLLOWING) state.lastFollowGoalTime = 0;

  if (oldPriority === Priorities.SLEEPING) {
    clearSleepListener();
    if (bot.isSleeping) {
      bot.wake().catch((err) => log.fail('Wake on priority transition', err));
    }
    if (isHighPriority) {
      state.botState = 'afk';
    }
  }

  if (newPriority === Priorities.AFK) {
    scheduleNextAFK(true);
  }
}

/**
 * Find the closest known safe position from recent memory.
 * Falls back to position[0] if distance comparison fails.
 */
function findClosestSafePosition() {
  const bot = state.bot;
  const positions = state.memory.recentPositions;
  if (!positions.length || !bot || !bot.entity) return null;

  let closest = positions[0];
  let closestDist = bot.entity.position.distanceTo(positions[0]);
  for (let i = 1; i < positions.length; i++) {
    const d = bot.entity.position.distanceTo(positions[i]);
    if (d < closestDist) {
      closestDist = d;
      closest = positions[i];
    }
  }
  return closest;
}

function executePriorityLogic(priority) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return;

  switch (priority) {
    case Priorities.VOID_ESCAPE: {
      // All movement was already stopped in handlePriorityTransition.
      // If we landed somewhere safe, memory will have a position — try to reach it.
      const now = Date.now();
      if (now - state.lastEmergencyActionTime > 2000) {
        releaseMovementKeys();
        if (bot.pathfinder) {
          try { bot.pathfinder.stop(); } catch (_) {}
        }
        const safePos = findClosestSafePosition();
        if (safePos) {
          log.warn(`Void escape: pathfinding to last safe pos ${Math.round(safePos.x)}, ${Math.round(safePos.y)}, ${Math.round(safePos.z)}`);
          safeSetGoal(new goals.GoalNear(safePos.x, safePos.y, safePos.z, 2));
        }
        state.lastEmergencyActionTime = now;
      }
      break;
    }
    case Priorities.EMERGENCY_SURVIVAL: {
      const now = Date.now();
      if (now - state.lastEmergencyActionTime > 2000) {
        // Smarter: go to the closest known safe position, not just most recent
        const safePos = findClosestSafePosition();
        if (safePos) {
          log.warn(`Emergency retreat to closest safe pos: ${Math.round(safePos.x)}, ${Math.round(safePos.y)}, ${Math.round(safePos.z)}`);
          safeSetGoal(new goals.GoalNear(safePos.x, safePos.y, safePos.z, 1));
          state.lastEmergencyActionTime = now;
        } else {
          // No known safe position — just stop moving and release all keys
          releaseMovementKeys();
          if (bot.pathfinder) {
            try { bot.pathfinder.stop(); } catch (_) {}
          }
          state.lastEmergencyActionTime = now;
          log.warn('Emergency survival: no safe positions in memory — halting');
        }
      }
      break;
    }
    case Priorities.PANICKING: {
      const now = Date.now();

      // Always stop pathfinder — panic uses raw key control like real passive mobs
      if (bot.pathfinder.isMoving()) {
        try { bot.pathfinder.stop(); } catch (_) {}
      }

      // Track attacker's live position so flee direction stays accurate
      if (state.panicFromName) {
        const attacker = bot.players[state.panicFromName];
        if (attacker && attacker.entity) {
          state.panicFromPos = attacker.entity.position.clone();
        }
      }

      // Scared mid-panic chat messages every 2.5–4s
      if (now - state.lastPanicChatTime > 2500 + Math.random() * 1500) {
        const mid = ['bhai pleaseee!!', 'ow!!', 'stop stop STOP!!',
                     'kyu maar rha hai!!', 'AHHH!!', 'nooo!!', '😭😭'];
        bot.chat(mid[Math.floor(Math.random() * mid.length)]);
        state.lastPanicChatTime = now;
      }

      // --- Direct-key flee (runs every tick = every 200ms, like a passive mob) ---
      const fromPos = state.panicFromPos || bot.entity.position;

      // Base direction: directly away from attacker
      let dx = bot.entity.position.x - fromPos.x;
      let dz = bot.entity.position.z - fromPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.5) {
        // Attacker at same spot — random direction
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a); dz = Math.sin(a);
      } else {
        dx /= dist; dz /= dist;
      }

      // Zig-zag: smooth sin-wave perpendicular offset so the bot weaves like a chicken
      const zigAmount = Math.sin(now / 250) * 0.9;
      const tx = dx + (-dz * zigAmount);
      const tz = dz + (dx * zigAmount);
      const fleeYaw = Math.atan2(-tx, -tz);
      const straightYaw = Math.atan2(-dx, -dz);

      // Ground safety first — if we're already on an unsafe tile, stop everything
      // and let the void/liquid safety system handle it rather than sprinting off an edge
      if (!isCurrentGroundSafe()) {
        releaseMovementKeys();
        break;
      }

      // Pick best runnable yaw.
      // Walk speed (~4.3 m/s) with 2.5-block check is safe enough to prevent void falls.
      // NO sneak — sneak prevents stepping up 1-block height differences, freezing the bot.
      // NO sprint — sprint (5.6 m/s) moves >1m per 200ms tick, outrunning safety checks.
      const WALK_REACH = 2.5;

      let runYaw = null;

      // Use isPanicDirectionClear — checks BOTH void safety AND wall/block clearance.
      // isDirectionSafe alone returns true for walls (ground exists below), causing the bot
      // to run straight into blocks instead of going around them.
      // 1. Zigzag flee direction
      if (isPanicDirectionClear(fleeYaw, WALK_REACH)) runYaw = fleeYaw;
      // 2. Straight away from attacker
      if (runYaw === null && isPanicDirectionClear(straightYaw, WALK_REACH)) runYaw = straightYaw;
      // 3. Fan out ±45°/90°/135°/180° until a clear direction is found
      if (runYaw === null) {
        for (let i = 1; i <= 4; i++) {
          const spread = (Math.PI / 4) * i;
          for (const sign of [1, -1]) {
            const tryYaw = straightYaw + spread * sign;
            if (isPanicDirectionClear(tryYaw, WALK_REACH)) { runYaw = tryYaw; break; }
          }
          if (runYaw !== null) break;
        }
      }

      if (runYaw !== null) {
        bot.look(runYaw, 0, true);
        // Smart sneak: ON only when the next 1.5 blocks in the flee direction
        // have a void edge — prevents falling off while still allowing step-ups.
        const edgeAhead = isNearVoidEdge(runYaw, 1.5);
        bot.setControlState('sneak', edgeAhead);
        bot.setControlState('sprint', false);
        bot.setControlState('forward', true);
      } else {
        // Nowhere safe to run — freeze in place
        releaseMovementKeys();
      }
      break;
    }
    case Priorities.CREEPER_ESCAPE: {
      const creeper = getNearbyCreeper();
      if (creeper) {
        const now = Date.now();
        if (now - state.lastCreeperEscapeTime > 3000) {
          const escapePos = findSafeEscapePosition(creeper);
          if (escapePos) {
            log.warn(`Creeper escape to ${Math.round(escapePos.x)}, ${Math.round(escapePos.y)}, ${Math.round(escapePos.z)}`);
            safeSetGoal(
              new goals.GoalNear(Math.round(escapePos.x), Math.round(escapePos.y), Math.round(escapePos.z), 1)
            );
            state.lastCreeperEscapeTime = now;
          } else {
            log.warn('Creeper escape: no safe position found');
          }
        }
      }
      break;
    }
    case Priorities.COMBAT: {
      // Bot only reaches here if bot.pvp.target is already set by an event
      // (self-defense, owner defense, or owner assist in botFactory.js).
      const pvpTarget = bot.pvp.target;
      if (pvpTarget) {
        // pvp is active — manually pathfind toward target so bot actually chases
        const dist = bot.entity.position.distanceTo(pvpTarget.position);
        if (dist > 3.5) {
          // Use direct pathfinder (bypass safeSetGoal void check) since combat = intentional movement
          try {
            bot.pathfinder.setGoal(
              new goals.GoalFollow(pvpTarget, 2), true
            );
          } catch (_) {}
        }
      } else {
        // pvp dropped target — check if it ran away (still alive, just out of pvp range)
        const last = state.lastCombatTarget;
        const stillValid = last &&
          bot.entities[last.id] &&
          bot.entities[last.id].isValid !== false &&
          bot.entity.position.distanceTo(last.position) < 24;

        if (stillValid) {
          // Chase and re-engage — target ran away
          bot.pvp.attack(last);
          log.info(`Chase: re-engaging ${last.name || last.type} (ran away)`);
        } else {
          // Target dead or too far — drop out of COMBAT
          state.lastCombatTarget = null;
          state.currentPriority = Priorities.IDLE;
        }
      }
      break;
    }
    case Priorities.SLEEPING:
      // Auto-sleep disabled — bot only lands here if manually put to sleep
      break;
    case Priorities.FOLLOWING: {
      const targetPlayer = bot.players[state.followTarget];
      if (!targetPlayer) {
        const offlineTarget = state.followTarget;
        log.warn(`Follow stopped — ${offlineTarget} is offline`);
        stopCurrentTasks();
        state.botState = 'afk';
        state.followTarget = null;
        bot.chat(`❌ ${offlineTarget} is not online. Reverting to AFK.`);
        scheduleNextAFK(true);
      } else if (!targetPlayer.entity) {
        log.info(`Follow waiting for ${state.followTarget}'s entity to load`);
      } else {
        const dist = bot.entity.position.distanceTo(targetPlayer.entity.position);
        const maxDist = config.followMaxDistance;

        if (dist > maxDist) {
          // Too far — try pet-style teleport via /tpa (like a tamed wolf)
          const now = Date.now();
          const lastTpa = state.lastTpaTime || 0;
          if (now - lastTpa > 8000) { // cooldown 8s to avoid spam
            state.lastTpaTime = now;
            try { bot.chat(`/tpa ${state.followTarget}`); } catch (_) {}
            log.info(`Pet teleport: /tpa ${state.followTarget} (dist=${Math.round(dist)}m)`);
          }
        } else if (dist <= 2.5) {
          // Already close enough — no need to pathfind
          if (bot.pathfinder.isMoving()) try { bot.pathfinder.stop(); } catch (_) {}
        } else {
          const now = Date.now();
          const stuck = !bot.pathfinder.isMoving() &&
            (now - (state.lastFollowGoalTime || 0)) > 3000;

          if (stuck) {
            // Pathfinder gave up (no path found) — force a fresh attempt
            try { bot.pathfinder.stop(); } catch (_) {}
            state.lastFollowGoalTime = now;
          }

          if (stuck || !bot.pathfinder.isMoving()) {
            safeSetGoal(new goals.GoalFollow(targetPlayer.entity, 2), true);
            if (!state.lastFollowGoalTime) state.lastFollowGoalTime = now;
          }
        }
      }
      break;
    }
    case Priorities.GUARDING:
      if (state.guardPosition) {
        const dist = bot.entity.position.distanceTo(state.guardPosition);
        if (dist > 3 && !bot.pathfinder.isMoving()) {
          safeSetGoal(
            new goals.GoalNear(state.guardPosition.x, state.guardPosition.y, state.guardPosition.z, 1)
          );
        }
      }
      break;
    default:
      break;
  }
}

/**
 * Check if it's nighttime and automatically walk to a bed and sleep — like a villager.
 * Only sleeps when other players are already sleeping (so night gets skipped).
 * Never sleeps during combat, follow, or panic.
 */
function checkAutoSleep() {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity || !config.autoSleep) return;
  if (bot.isSleeping || state.botState === 'sleeping') return;

  // Never sleep during combat, following, panic, or any high-priority state
  const blockingStates = ['following', 'combat', 'panicking', 'void_escape', 'emergency'];
  if (blockingStates.some((s) => state.botState === s)) return;
  if (state.panicActive) return;
  if (bot.pvp && bot.pvp.target) return;

  if (state.botState !== 'afk' && state.botState !== 'idle') return;
  if (Date.now() < state.autoSleepCooldown) return;

  // Minecraft night: timeOfDay 12542–23460
  const timeOfDay = bot.time && bot.time.timeOfDay;
  if (timeOfDay === undefined || timeOfDay === null) return;
  if (timeOfDay < 12542 || timeOfDay >= 23460) {
    // Daytime — reset cooldown so bot can sleep again tonight
    if (state.autoSleepCooldown > 0) state.autoSleepCooldown = 0;
    if (state.botState === 'sleeping') {
      state.botState = 'afk';
      scheduleNextAFK(true);
    }
    return;
  }

  // Only sleep when ALL other players in server are sleeping.
  // Include players out of render distance — if their entity isn't loaded
  // we can't confirm they're sleeping, so we wait (treat as not sleeping).
  const otherPlayers = Object.values(bot.players).filter(
    (p) => p.username !== bot.username
  );
  if (otherPlayers.length > 0) {
    const everyoneSleeping = otherPlayers.every(
      (p) => p.entity && isEntitySleeping(p.entity)
    );
    if (!everyoneSleeping) return;
  }
  // If no other players at all, bot sleeps alone (still skips night on single-player / empty server)

  const bed = findNearbyBed(40);
  if (!bed) return;

  log.info('Auto-sleep: all others sleeping — heading to bed...');
  stopCurrentTasks();
  state.botState = 'sleeping';
  // Cooldown prevents tight retry loops on failure
  state.autoSleepCooldown = Date.now() + 90000;

  walkToBedAndSleep({
    onSuccess: () => log.ok('Auto-sleep: sleeping'),
    onFail: (reason) => {
      log.warn(`Auto-sleep failed: ${reason}`);
      state.botState = 'afk';
      scheduleNextAFK(true);
    },
    onNoBed: () => {
      log.warn('Auto-sleep: no bed in range');
      state.botState = 'afk';
      scheduleNextAFK(true);
    },
    onNavFail: () => {
      log.warn('Auto-sleep: nav to bed failed');
      state.botState = 'afk';
      scheduleNextAFK(true);
    },
  });
}

function runPriorityManagerTick() {
  const bot = state.bot;
  if (!bot || !bot.entity) return;

  const now = Date.now();

  // Prune stale recentSwingers (normally pruned on swing events, but if no swings
  // happen they can linger indefinitely — clean them every tick for free).
  if (state.recentSwingers.length > 0) {
    state.recentSwingers = state.recentSwingers.filter(s => now - s.time < 2000);
  }

  const pos = bot.entity.position;
  const feetBlock = bot.blockAt(pos);
  const standingInLiquid =
    feetBlock && (feetBlock.name.includes('lava') || feetBlock.name.includes('water'));
  const standingOnUnsafe = !isCurrentGroundSafe();
  // Compute once — passed to getCurrentPriority() below to avoid a second call there.
  // Guard creeper scan behind autoDefense so we skip the entity scan when it's off.
  const config = getConfig();
  const fallingIntoVoid = isFallingIntoVoid();
  const nearbyCreeper = config.autoDefense ? getNearbyCreeper() : null;

  // Immediate interception — stop ALL movement the moment we detect void or liquid danger,
  // even before the priority system gets a chance to process it.
  if (standingInLiquid || standingOnUnsafe || fallingIntoVoid) {
    if (bot.pathfinder.isMoving()) {
      if (fallingIntoVoid) {
        log.warn('Void fall detected — emergency stop');
      } else {
        log.warn('Void/liquid safety — stopping pathfinder');
      }
      try { bot.pathfinder.stop(); } catch (_) {}
    }
    releaseMovementKeys();
  }

  updateMemory();
  checkAutoSleep();

  const newPriority = getCurrentPriority({ fallingIntoVoid, nearbyCreeper });
  if (newPriority !== state.currentPriority) {
    const { getPriorityName } = require('./state');
    log.info(
      `Priority ${getPriorityName(state.currentPriority)} -> ${getPriorityName(newPriority)}`
    );
    handlePriorityTransition(state.currentPriority, newPriority);
    state.currentPriority = newPriority;
  }

  executePriorityLogic(state.currentPriority);

  if (Date.now() - (state.lastServerActivityTime || 0) >= config.maxIdleBeforeKeepAliveMs) {
    runKeepAlive(true);
  }
}

function startSmartLoops() {
  const bot = state.bot;
  const config = getConfig();
  const { Movements } = require('mineflayer-pathfinder');

  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1tunnels = false;
  movements.liquidCost = 20;

  // Avoid trampling crops (farmland) and taking dripstone damage
  // blocksToAvoid is a Set of block state IDs that the pathfinder will not walk on
  const AVOID_BLOCK_NAMES = [
    'farmland', 'soul_sand', 'soul_soil',
    'pointed_dripstone', 'dripstone_block',
  ];
  for (const [id, block] of Object.entries(bot.registry.blocks)) {
    if (AVOID_BLOCK_NAMES.some((name) => block.name.includes(name))) {
      movements.blocksToAvoid.add(Number(id));
    }
  }

  bot.pathfinder.setMovements(movements);
  bot.pvp.movements = movements;

  clearAllIntervals();
  scheduleNextAFK(true);
  startKeepAliveLoop();

  state.chatInterval = setInterval(() => {
    if (!bot.entity || state.botState !== 'afk' || !config.randomChatEnabled) return;
    const timeOfDay = bot.time && bot.time.timeOfDay;
    const isNight = timeOfDay !== undefined && timeOfDay >= 12542 && timeOfDay < 23460;
    const msgs = isNight
      ? ['good night', 'gn everyone', 'gn', 'sleepy...', 'gn guys', 'night night']
      : ['sup?', 'anyone on?', 'lol', 'nice', 'gg', 'chilling here'];
    if (Math.random() < 0.65) bot.chat(msgs[Math.floor(Math.random() * msgs.length)]);
  }, 900000 + Math.random() * 600000);

  state.priorityManagerInterval = setInterval(runPriorityManagerTick, 200);
  log.ok('Smart loops started (AFK, priority manager, optional chat)');
}

module.exports = {
  isAFKActive,
  scheduleNextAFK,
  startSmartLoops,
  runPriorityManagerTick,
  getNearbyCreeper,
  getNearbyHostileMob,
};
