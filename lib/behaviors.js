const { goals } = require('mineflayer-pathfinder');
const { state, Priorities } = require('./state');
const { getConfig } = require('./config');
const { stopCurrentTasks, clearAllIntervals } = require('./lifecycle');
const {
  safeSetGoal,
  isPathSafe,
  releaseMovementKeys,
  isCurrentGroundSafe,
} = require('./pathfinding');
const { clearSleepListener, wakeUp } = require('./sleep');
const log = require('./logger');

function isAFKActive() {
  const bot = state.bot;
  return bot && bot.entity && state.botState === 'afk' && !bot.pvp.target && !bot.isSleeping;
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

  const directions = ['forward', 'back', 'left', 'right'];
  const primary = directions[Math.floor(Math.random() * directions.length)];
  const strafe = directions[Math.floor(Math.random() * 2) + 2];
  const doSprint = Math.random() < 0.35;
  const duration = 400 + Math.floor(Math.random() * 800);

  const yawMap = {
    forward: bot.entity.yaw,
    back: bot.entity.yaw + Math.PI,
    left: bot.entity.yaw + Math.PI / 2,
    right: bot.entity.yaw - Math.PI / 2,
  };
  await smoothLook(yawMap[primary] + (Math.random() * 0.3 - 0.15), (Math.random() * 2 - 1) * 0.2, 4, 30);

  if (!isAFKActive() || !isCurrentGroundSafe()) {
    releaseMovementKeys();
    return;
  }

  bot.setControlState(primary, true);
  if (Math.random() < 0.3) bot.setControlState(strafe, true);
  if (doSprint) bot.setControlState('sprint', true);

  try {
    await new Promise((resolve) => setTimeout(resolve, duration));
  } finally {
    releaseMovementKeys();
  }

  if (isAFKActive() && isCurrentGroundSafe() && Math.random() < 0.2) {
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (state.bot) state.bot.setControlState('jump', false);
    }, 150);
  }
}

async function runWalkAction() {
  const bot = state.bot;
  if (!bot || !bot.entity || bot.pathfinder.isMoving()) return;

  let targetPos = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const dist = 5 + Math.random() * 8;
    const angle = Math.random() * Math.PI * 2;
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

  const duration = 300 + Math.floor(Math.random() * 500);
  await smoothLook(bot.entity.yaw + (Math.random() * 0.6 - 0.3), (Math.random() * 2 - 1) * 0.1, 3, 25);

  if (!isAFKActive() || !isCurrentGroundSafe()) {
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
  if (roll < 0.06) {
    bot.setControlState('sneak', true);
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 800));
    if (bot) bot.setControlState('sneak', false);
  } else if (roll < 0.15) {
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (state.bot) state.bot.setControlState('jump', false);
    }, 150);
  } else if (roll < 0.25) {
    bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');
  } else if (roll < 0.32 && isCurrentGroundSafe()) {
    const dir = Math.random() < 0.5 ? 'left' : 'right';
    bot.setControlState(dir, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    } finally {
      if (bot) bot.setControlState(dir, false);
    }
  } else if (roll < 0.37 && isCurrentGroundSafe()) {
    bot.setControlState('back', true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 250));
    } finally {
      if (bot) bot.setControlState('back', false);
    }
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

  const jumps = 2 + Math.floor(Math.random() * 2); // 2 or 3 jumps
  const targetYaw = bot.entity.yaw + (Math.random() * 0.5 - 0.25);
  await smoothLook(targetYaw, -0.1, 3, 25);
  if (!isAFKActive() || !isCurrentGroundSafe()) return;

  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);

  for (let i = 0; i < jumps; i++) {
    if (!isAFKActive() || !isCurrentGroundSafe()) break;
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

function pickAFKActionType(forceWalk) {
  if (forceWalk) return 'walk';
  //  look        10%
  //  idle_look    8%
  //  look_swing   7%
  //  look_block   8%
  //  walk        25%
  //  direct_walk 18%
  //  sprint_burst 10%
  //  crouch_peek   7%
  //  jump_walk     7%
  const types =      ['look', 'idle_look', 'look_swing', 'look_block', 'walk', 'direct_walk', 'sprint_burst', 'crouch_peek', 'jump_walk'];
  const thresholds = [0.10,   0.18,        0.25,         0.33,         0.58,   0.76,          0.86,           0.93,          1.0];
  const rand = Math.random();
  for (let i = 0; i < thresholds.length; i++) {
    if (rand < thresholds[i]) return types[i];
  }
  return 'look';
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
    case 'look':       await runLookAction();    break;
    case 'idle_look':  await runIdleLook();      break;
    case 'look_swing': await runLookSwingAction(); break;
    case 'look_block': await runLookAtBlock();   break;
    case 'walk':       await runWalkAction();    break;
    case 'direct_walk':await runDirectWalk();    break;
    case 'sprint_burst':await runSprintBurst();  break;
    case 'crouch_peek':await runCrouchPeek();    break;
    case 'jump_walk':  await runJumpWalk();      break;
    default:           await runLookAction();    break;
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
    : (2000 + Math.random() * 3000) / multiplier;

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
        const groundBlock = bot.blockAt(checkPos.offset(0, -1, 0));

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
            groundBlock.boundingBox === 'block' &&
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
  const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
  if (
    groundBlock &&
    groundBlock.boundingBox === 'block' &&
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

function getCurrentPriority() {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return Priorities.IDLE;

  if (bot.health > 0 && bot.health < 6 && state.memory.recentPositions.length > 0) {
    return Priorities.EMERGENCY_SURVIVAL;
  }
  if (config.autoDefense && getNearbyCreeper()) return Priorities.CREEPER_ESCAPE;
  if (config.autoDefense && (bot.pvp.target || getNearbyHostileMob())) return Priorities.COMBAT;
  if (bot.isSleeping) {
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

  if (isHighPriority && !wasHighPriority && bot.autoEat) {
    bot.autoEat.disableAuto();
    bot.autoEat.cancelEat();
    log.info('AutoEat suspended for high-priority action');
  } else if (!isHighPriority && wasHighPriority && bot.autoEat) {
    bot.autoEat.enableAuto();
    log.info('AutoEat resumed');
  }

  if (bot.pathfinder) bot.pathfinder.stop();
  if (oldPriority === Priorities.COMBAT && bot.pvp) bot.pvp.stop();

  if (oldPriority === Priorities.SLEEPING) {
    clearSleepListener();
    if (bot.isSleeping) {
      bot.wake().catch((err) => log.fail('Wake on priority transition', err));
    }
  }
}

function executePriorityLogic(priority) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return;

  switch (priority) {
    case Priorities.EMERGENCY_SURVIVAL: {
      const now = Date.now();
      if (now - state.lastEmergencyActionTime > 3000) {
        const safePos = state.memory.recentPositions[0];
        if (safePos) {
          log.warn(`Emergency retreat to ${Math.round(safePos.x)}, ${Math.round(safePos.y)}, ${Math.round(safePos.z)}`);
          safeSetGoal(new goals.GoalNear(safePos.x, safePos.y, safePos.z, 1));
          state.lastEmergencyActionTime = now;
        }
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
      const target = bot.pvp.target || getNearbyHostileMob();
      if (target && !bot.pvp.target) {
        bot.pvp.attack(target);
        log.info(`Combat: attacking ${target.name}`);
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
        state.botState = 'idle';
        state.followTarget = null;
        bot.chat(`❌ ${offlineTarget} is not online.`);
      } else if (!targetPlayer.entity) {
        log.info(`Follow waiting for ${state.followTarget}'s entity to load`);
      } else {
        const dist = bot.entity.position.distanceTo(targetPlayer.entity.position);
        const maxDist = config.followMaxDistance;
        if (dist > maxDist) {
          bot.chat(`⚠️ You are too far (>${maxDist} blocks)! Stopping follow.`);
          stopCurrentTasks();
          state.botState = 'idle';
        } else {
          safeSetGoal(new goals.GoalFollow(targetPlayer.entity, 2), true);
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

function runPriorityManagerTick() {
  const bot = state.bot;
  if (!bot || !bot.entity) return;

  const pos = bot.entity.position;
  const feetBlock = bot.blockAt(pos);
  const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
  const standingInLiquid =
    feetBlock && (feetBlock.name.includes('lava') || feetBlock.name.includes('water'));
  const standingOnUnsafe =
    !groundBlock ||
    groundBlock.name.includes('air') ||
    groundBlock.name.includes('lava') ||
    groundBlock.name.includes('water');

  if (standingInLiquid || standingOnUnsafe) {
    if (bot.pathfinder.isMoving()) {
      log.warn('Void/liquid safety — stopping pathfinder');
      bot.pathfinder.stop();
    }
    releaseMovementKeys();
  }

  updateMemory();

  const newPriority = getCurrentPriority();
  if (newPriority !== state.currentPriority) {
    const { getPriorityName } = require('./state');
    log.info(
      `Priority ${getPriorityName(state.currentPriority)} -> ${getPriorityName(newPriority)}`
    );
    handlePriorityTransition(state.currentPriority, newPriority);
    state.currentPriority = newPriority;
  }

  executePriorityLogic(state.currentPriority);

  const config = getConfig();
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
  bot.pathfinder.setMovements(movements);
  bot.pvp.movements = movements;

  clearAllIntervals();
  scheduleNextAFK(true);
  startKeepAliveLoop();

  state.chatInterval = setInterval(() => {
    if (!bot.entity || state.botState !== 'afk' || !config.randomChatEnabled) return;
    const msgs = ['sup?', 'anyone on?', 'lol', 'brb', 'nice', 'gg', 'chilling here'];
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
