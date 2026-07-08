const vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { state } = require('./state');
const log = require('./logger');

function areGoalsEqual(g1, g2) {
  if (!g1 && !g2) return true;
  if (!g1 || !g2) return false;
  if (g1.constructor !== g2.constructor) return false;
  if (g1.x !== g2.x || g1.y !== g2.y || g1.z !== g2.z) return false;
  if (g1.range !== g2.range) return false;
  if (g1.radius !== g2.radius) return false;
  if (g1.entity && g2.entity) {
    if (g1.entity.id !== g2.entity.id) return false;
  } else if (g1.entity || g2.entity) {
    return false;
  }
  return true;
}

function isPathSafe(start, end, checkBridges = false) {
  const bot = state.bot;
  if (!bot) return false;

  const dist = start.distanceTo(end);
  const steps = Math.ceil(dist / 0.5);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const checkPos = start.plus(end.minus(start).scaled(t));

    let hasSolidGround = false;
    for (let dy = 0; dy >= -4; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0));
      if (
        block &&
        (block.boundingBox === 'block' || block.name.includes('slab') || block.name.includes('stairs') || block.name.includes('chest') || block.name.includes('farmland') || block.name.includes('path') || block.name.includes('water')) &&
        !block.name.includes('air') &&
        !block.name.includes('lava')
      ) {
        hasSolidGround = true;
        break;
      }
    }
    if (!hasSolidGround) return false;

    const feetBlock = bot.blockAt(checkPos);
    const headBlock = bot.blockAt(checkPos.offset(0, 1, 0));
    if (!feetBlock || !headBlock) return false;

    // Only block lava in the path — pathfinder handles solid terrain navigation
    if (feetBlock.name.includes('lava') || headBlock.name.includes('lava')) return false;

    if (checkBridges) {
      const dir = end.minus(start).normalize();
      const leftDir = new vec3(-dir.z, 0, dir.x).normalize();
      const rightDir = new vec3(dir.z, 0, -dir.x).normalize();
      let leftSolid = false;
      let rightSolid = false;

      for (let dy = 0; dy >= -4; dy--) {
        const leftBlock = bot.blockAt(checkPos.plus(leftDir).offset(0, dy, 0));
        if (
          leftBlock &&
          (leftBlock.boundingBox === 'block' || leftBlock.name.includes('slab') || leftBlock.name.includes('stairs') || leftBlock.name.includes('chest') || leftBlock.name.includes('farmland') || leftBlock.name.includes('path') || leftBlock.name.includes('water')) &&
          !leftBlock.name.includes('air') &&
          !leftBlock.name.includes('lava')
        ) {
          leftSolid = true;
        }
        const rightBlock = bot.blockAt(checkPos.plus(rightDir).offset(0, dy, 0));
        if (
          rightBlock &&
          (rightBlock.boundingBox === 'block' || rightBlock.name.includes('slab') || rightBlock.name.includes('stairs') || rightBlock.name.includes('chest') || rightBlock.name.includes('farmland') || rightBlock.name.includes('path') || rightBlock.name.includes('water')) &&
          !rightBlock.name.includes('air') &&
          !rightBlock.name.includes('lava')
        ) {
          rightSolid = true;
        }
      }
      if (!leftSolid && !rightSolid) return false;
    }
  }
  return true;
}

// Check if a block name is lava/void (truly deadly)
function isDangerous(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air' ||
    name.includes('lava');
}

function safeSetGoal(goal, dynamic = false) {
  const bot = state.bot;
  if (!bot) return false;

  if (bot.pathfinder && areGoalsEqual(bot.pathfinder.goal, goal)) {
    return true;
  }

  if (goal) {
    let targetPos = null;
    let isEntityGoal = false;
    if (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
      targetPos = new vec3(goal.x, goal.y, goal.z);
    } else if (goal.entity && goal.entity.position) {
      targetPos = goal.entity.position;
      isEntityGoal = true;
    }

    if (targetPos) {
      let groundBlock = bot.blockAt(targetPos.offset(0, -0.1, 0));
      if (!groundBlock || groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air') {
        groundBlock = bot.blockAt(targetPos);
      }
      const feetBlock   = bot.blockAt(targetPos);

      if (groundBlock && feetBlock) {
        // Only block goals where ground is truly void/lava or feet block is lava
        let groundDangerous = isDangerous(groundBlock.name);
        
        // If following an entity, ground being air is normal (they can jump/climb/hover)
        if (isEntityGoal && (groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air')) {
          groundDangerous = false;
        }

        const feetDangerous   = feetBlock.name.includes('lava');

        if (groundDangerous || feetDangerous) {
          log.warn(
            `safeSetGoal blocked unsafe goal at ${targetPos} (ground=${groundBlock.name}, feet=${feetBlock.name})`
          );
          return false;
        }
      }
    }
  }

  try {
    bot.pathfinder.setGoal(goal, dynamic);
    return true;
  } catch (err) {
    log.fail('safeSetGoal error', err);
    return false;
  }
}

function setBedGoal(bed) {
  const bot = state.bot;
  if (!bot || !bed) return false;
  try {
    // A bed can be interacted with from a short distance. Using GoalNear with a range of 1.5
    // blocks allows the bot to navigate to a block adjacent to the bed, reliably triggering goal_reached.
    bot.pathfinder.setGoal(
      new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1.5)
    );
    return true;
  } catch (err) {
    log.fail('Bed navigation error', err);
    return false;
  }
}

function releaseMovementKeys() {
  const bot = state.bot;
  if (!bot) return;
  for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
    try {
      bot.setControlState(key, false);
    } catch (_) {
      /* ignore */
    }
  }
}

function isCurrentGroundSafe() {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;
  const pos = bot.entity.position;

  // Look up to 3 blocks below — handles mid-jump, stairs, and step-ups.
  // Pathfinder manages actual navigation safety; we only block on true void/lava.
  let nullCount = 0;
  let checksCount = 0;
  for (let dy = -0.1; dy >= -3; dy -= 0.9) {
    checksCount++;
    const block = bot.blockAt(pos.offset(0, dy, 0));
    if (!block) {
      nullCount++;
      continue;
    }
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') continue;
    if (n.includes('lava')) return false;
    return true; // solid block found within 3 blocks below
  }
  
  if (nullCount === checksCount) {
    return true; // All blocks unloaded — assume safe (bot is standing on it)
  }
  return false; // nothing below — truly unsafe
}

/**
 * Check if moving in the direction of `yaw` for up to `distBlocks` blocks is safe
 * (i.e. solid ground within 2 blocks below every step along that heading).
 * Used before pressing direct movement keys to detect void edges.
 */
function isDirectionSafe(yaw, distBlocks = 2.5) {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;

  // mineflayer yaw: forward direction in world coords
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const steps = Math.ceil(distBlocks / 0.5);

  for (let i = 1; i <= steps; i++) {
    const checkPos = bot.entity.position.offset(dx * i * 0.5, 0, dz * i * 0.5);
    let hasSolid = false;
    // Only allow up to 1 block of drop — void worlds have nothing below at all
    for (let dy = 0; dy >= -1; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0));
      if (
        block &&
        (block.boundingBox === 'block' || block.name.includes('slab') || block.name.includes('stairs')) &&
        !block.name.includes('air') &&
        !block.name.includes('lava') &&
        !block.name.includes('water')
      ) {
        hasSolid = true;
        break;
      }
    }
    if (!hasSolid) return false;
  }
  return true;
}

/**
 * Check if moving in direction `yaw` for `distBlocks` will NOT step on sensitive
 * blocks — farmland, dripstone, soul_sand, soul_soil.
 * Returns false if any block in path is sensitive (would trample crops / hurt bot).
 */
const FARM_SENSITIVE = ['farmland', 'pointed_dripstone', 'dripstone_block', 'soul_sand', 'soul_soil'];
function isDirectionFarmSafe(yaw, distBlocks = 3) {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const steps = Math.ceil(distBlocks / 0.5);

  for (let i = 1; i <= steps; i++) {
    const checkPos = bot.entity.position.offset(dx * i * 0.5, 0, dz * i * 0.5);
    // Check the block being stepped on (at feet level and one below for slopes)
    for (let dy = 0; dy >= -1; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0));
      if (block && FARM_SENSITIVE.some((n) => block.name.includes(n))) return false;
    }
  }
  return true;
}

/**
 * Full walkability check for panic flee: checks BOTH void safety AND wall clearance.
 *
 * isDirectionSafe() only guarantees there's ground below — it returns true even when a
 * solid wall is at feet/head level, causing the bot to run straight into blocks.
 * This function adds:
 *   - Wall detection: rejects directions where a 2-block-high wall blocks the path
 *   - Step-up: allows 1-block step-ups (bot can climb a single block)
 *   - Void safety: rejects directions where there's no ground below
 */
function isPanicDirectionClear(yaw, distBlocks = 2.5) {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;

  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const steps = Math.ceil(distBlocks / 0.5);

  const isSolid = (b) =>
    b &&
    (b.boundingBox === 'block' || b.name.includes('slab') || b.name.includes('stairs')) &&
    !b.name.includes('air') && !b.name.includes('lava') && !b.name.includes('water');

  for (let i = 1; i <= steps; i++) {
    const p = bot.entity.position.offset(dx * i * 0.5, 0, dz * i * 0.5);

    const bFeet  = bot.blockAt(p);                    // dy = 0  (bot's feet)
    const bHead  = bot.blockAt(p.offset(0, 1, 0));    // dy = +1 (bot's head)
    const bTop   = bot.blockAt(p.offset(0, 2, 0));    // dy = +2 (above head — for step-up)
    const bBelow = bot.blockAt(p.offset(0, -1, 0));   // dy = -1 (ground below feet)

    // Unloaded chunk — treat as blocked to be safe
    if (!bFeet || !bBelow) return false;

    const feetBlocked = isSolid(bFeet);
    const headBlocked = isSolid(bHead);

    if (feetBlocked && headBlocked) {
      // Solid wall 2+ blocks tall — cannot pass at all
      return false;
    }

    if (feetBlocked && !headBlocked) {
      // 1-block step-up: bot can climb if there's head clearance above the step
      // (bTop being null = unloaded chunk = unknown; treat as clear to avoid false positives)
      if (isSolid(bTop)) return false; // no room above the step
      // Step-up is ok; the step itself is the ground — void safety satisfied
      continue;
    }

    // Feet are clear — require solid ground at or 1 block below (handles step-downs)
    if (!isSolid(bBelow)) {
      // Allow 1-block step-down: check if solid ground exists 2 blocks below feet
      const bBelow2 = bot.blockAt(p.offset(0, -2, 0));
      if (!isSolid(bBelow2)) return false; // void or 2+ block drop — too dangerous
    }
  }
  return true;
}

/**
 * Returns true if the bot is actively falling with no solid block within 6 blocks below.
 * Used to trigger the VOID_ESCAPE emergency priority.
 *
 * Null blocks (unloaded chunks) are treated as "safe/unknown" to avoid false-positive
 * emergency stops when the world hasn't loaded yet.
 */
function isFallingIntoVoid() {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;

  const vel = bot.entity.velocity;
  // Must be falling meaningfully (negative Y velocity)
  if (!vel || vel.y >= -0.1) return false;

  const pos = bot.entity.position;
  let nullCount = 0;
  for (let dy = 0; dy >= -6; dy--) {
    const block = bot.blockAt(pos.offset(0, dy, 0));

    // Unloaded chunk — treat as unknown/safe to avoid false positives
    if (!block) {
      nullCount++;
      continue;
    }

    if (
      (block.boundingBox === 'block' || block.name.includes('slab') || block.name.includes('stairs')) &&
      !block.name.includes('air')
    ) {
      return false; // there IS something below — not voiding
    }
  }

  // If most blocks below were null (chunk unloaded), don't trigger void escape
  if (nullCount >= 4) return false;

  return true; // falling with nothing but air/void below for 6+ blocks
}

/**
 * Returns true if there is a void/drop edge within `checkDist` blocks in
 * the direction of `yaw` — meaning the next step would put the bot at risk
 * of falling off.  Used to decide whether to keep sneak pressed while fleeing:
 *   - near edge  → sneak ON  (prevents stepping off)
 *   - clear path → sneak OFF (allows climbing 1-block steps)
 */
function isNearVoidEdge(yaw, checkDist = 1.5) {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;

  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const steps = Math.ceil(checkDist / 0.5);

  const isSolid = (b) =>
    b &&
    (b.boundingBox === 'block' || b.name.includes('slab') || b.name.includes('stairs')) &&
    !b.name.includes('air') && !b.name.includes('lava') && !b.name.includes('water');

  for (let i = 1; i <= steps; i++) {
    const p = bot.entity.position.offset(dx * i * 0.5, 0, dz * i * 0.5);
    const bFeet  = bot.blockAt(p);
    const bBelow = bot.blockAt(p.offset(0, -1, 0));

    // If feet-level block is solid (a step-up), no edge here
    if (isSolid(bFeet)) continue;

    // Feet are air — check for ground below; if none, it's an edge
    if (!isSolid(bBelow)) return true;
  }
  return false;
}

module.exports = {
  areGoalsEqual,
  isPathSafe,
  safeSetGoal,
  setBedGoal,
  releaseMovementKeys,
  isCurrentGroundSafe,
  isDirectionSafe,
  isDirectionFarmSafe,
  isPanicDirectionClear,
  isNearVoidEdge,
  isFallingIntoVoid,
};
