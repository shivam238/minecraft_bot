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
        (block.boundingBox === 'block' || block.name.includes('slab') || block.name.includes('stairs') || block.name.includes('chest') || block.name.includes('farmland') || block.name.includes('path')) &&
        !block.name.includes('air') &&
        !block.name.includes('lava') &&
        !block.name.includes('water')
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
          (leftBlock.boundingBox === 'block' || leftBlock.name.includes('slab') || leftBlock.name.includes('stairs') || leftBlock.name.includes('chest') || leftBlock.name.includes('farmland') || leftBlock.name.includes('path')) &&
          !leftBlock.name.includes('air') &&
          !leftBlock.name.includes('lava') &&
          !leftBlock.name.includes('water')
        ) {
          leftSolid = true;
        }
        const rightBlock = bot.blockAt(checkPos.plus(rightDir).offset(0, dy, 0));
        if (
          rightBlock &&
          (rightBlock.boundingBox === 'block' || rightBlock.name.includes('slab') || rightBlock.name.includes('stairs') || rightBlock.name.includes('chest') || rightBlock.name.includes('farmland') || rightBlock.name.includes('path')) &&
          !rightBlock.name.includes('air') &&
          !rightBlock.name.includes('lava') &&
          !rightBlock.name.includes('water')
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
    if (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
      targetPos = new vec3(goal.x, goal.y, goal.z);
    } else if (goal.entity && goal.entity.position) {
      targetPos = goal.entity.position;
    }

    if (targetPos) {
      let groundBlock = bot.blockAt(targetPos.offset(0, -0.1, 0));
      if (!groundBlock || groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air') {
        groundBlock = bot.blockAt(targetPos);
      }
      const feetBlock   = bot.blockAt(targetPos);

      if (groundBlock && feetBlock) {
        // Only block goals where ground is truly void/lava or feet block is lava/water
        const groundDangerous = isDangerous(groundBlock.name);
        const feetDangerous   = feetBlock.name.includes('lava') || feetBlock.name.includes('water');

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
    bot.pathfinder.setGoal(
      new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z)
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
  let groundBlock = bot.blockAt(pos.offset(0, -0.1, 0));
  if (!groundBlock || groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'void_air') {
    groundBlock = bot.blockAt(pos);
  }
  if (!groundBlock) return false;
  // Allow any non-void, non-liquid block — including farmland, slabs, crops, etc.
  const n = groundBlock.name;
  return n !== 'air' && n !== 'cave_air' && n !== 'void_air' &&
    !n.includes('lava') && !n.includes('water');
}

module.exports = {
  areGoalsEqual,
  isPathSafe,
  safeSetGoal,
  setBedGoal,
  releaseMovementKeys,
  isCurrentGroundSafe,
};
