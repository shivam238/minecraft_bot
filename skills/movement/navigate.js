'use strict';

const { goals } = require('mineflayer-pathfinder');

// ─── Shared helper ────────────────────────────────────────────────────────────

/**
 * Navigate to a Vec3-like position using pathfinder.
 * Shared by multiple skills — keeps timeout/abort logic in one place.
 */
async function _moveTo(bot, position, range, signal) {
  return new Promise((resolve, reject) => {
    const abortHandler = () => {
      try { bot.pathfinder.stop(); } catch (_) {}
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    const goal = new goals.GoalNear(position.x, position.y, position.z, range);
    bot.pathfinder.setGoal(goal);

    const onPathUpdate = (results) => {
      if (results.status === 'arrived' || results.status === 'noPath') {
        bot.removeListener('goal_reached', onReached);
        bot.removeListener('path_update', onPathUpdate);
        if (signal) signal.removeEventListener('abort', abortHandler);
        if (results.status === 'noPath') reject(new Error('Cannot find path to position'));
        else resolve();
      }
    };

    const onReached = () => {
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('path_update', onPathUpdate);
      if (signal) signal.removeEventListener('abort', abortHandler);
      resolve();
    };

    bot.once('goal_reached', onReached);
    bot.on('path_update', onPathUpdate);
  });
}

/** Returns true if a block is any type of log. */
function _isLog(block) {
  return block && (block.name.endsWith('_log') || block.name === 'log');
}

// ─── walkToPosition ───────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const walkToPosition = {
  id: 'movement.walkToPosition',
  description: 'Navigate to a specific {x,y,z} position using pathfinder',
  async execute(bot, params, signal) {
    const { position, range = 1 } = params;
    if (!position) throw new Error('walkToPosition requires params.position {x,y,z}');
    await _moveTo(bot, position, range, signal);
  },
};

// ─── walkToNearestTree ────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 *
 * Fix #2: Expanding radius search 64 → 128 → 256.
 * Accepts optional `maxRadius` param (default 256).
 * Fix #5: Saves discovered tree position to WorldMemory when `params.worldMemory` is provided.
 *         AutonomousAgent injects bot._worldMemory for this purpose.
 */
const walkToNearestTree = {
  id: 'movement.walkToNearestTree',
  description: 'Walk to the nearest tree — expands search radius until found',
  async execute(bot, params, signal) {
    const maxRadius = params.maxRadius || 256;
    const RADII = [64, 128, 256].filter(r => r <= maxRadius);
    if (!RADII.includes(maxRadius) && maxRadius > 0) RADII.push(maxRadius);

    for (const radius of RADII) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

      const block = bot.findBlock({
        matching: _isLog,
        maxDistance: radius,
      });

      if (block) {
        // Fix #5: save to WorldMemory if injected
        const wm = bot._worldMemory;
        if (wm && typeof wm.addLocation === 'function') {
          wm.addLocation('tree', 'tree', block.position, {
            biome: wm.currentBiome || 'unknown',
            discoveredAt: Date.now(),
          });
        }

        await _moveTo(bot, block.position, 3, signal);
        return; // success
      }

      // Not found at this radius — log and try wider
      if (radius < maxRadius) {
        bot._autonomousLog && bot._autonomousLog(`[walkToNearestTree] No tree within ${radius} — expanding to ${RADII[RADII.indexOf(radius) + 1] || maxRadius}`);
      }
    }

    // All radii exhausted
    throw new Error(`Cannot find a tree within ${maxRadius} blocks`);
  },
};

// ─── exploreForTree ───────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 *
 * Fix #2 + #4: Persistent forest exploration.
 * Explores in random directions with increasing radius until a log block is found.
 * Saves to WorldMemory when found so future gather_wood goals don't explore.
 */
const exploreForTree = {
  id: 'movement.exploreForTree',
  description: 'Explore in expanding circles until a tree is found and saved to WorldMemory',
  async execute(bot, params, signal) {
    const { radiusStart = 128, maxRadius = 512 } = params;

    let currentRadius = radiusStart;
    const stepSize = 64;
    const maxIterations = 20; // hard cap on moves to prevent infinite wandering
    let iterations = 0;

    while (currentRadius <= maxRadius && iterations < maxIterations) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      iterations++;

      // First check if a tree is now visible from current position
      const nearbyLog = bot.findBlock({
        matching: _isLog,
        maxDistance: 64,
      });

      if (nearbyLog) {
        // Found! Save to WorldMemory
        const wm = bot._worldMemory;
        if (wm && typeof wm.addLocation === 'function') {
          wm.addLocation('tree', 'tree', nearbyLog.position, {
            biome: wm.currentBiome || 'unknown',
            discoveredAt: Date.now(),
          });
        }
        // Walk to it
        await _moveTo(bot, nearbyLog.position, 3, signal);
        return;
      }

      // Move in a random direction by currentRadius
      const pos = bot.entity.position;
      const angle = Math.random() * Math.PI * 2;
      const dist = currentRadius * (0.5 + Math.random() * 0.5);
      const target = {
        x: pos.x + Math.sin(angle) * dist,
        y: pos.y,
        z: pos.z + Math.cos(angle) * dist,
      };

      try {
        await _moveTo(bot, target, 5, signal);
      } catch (err) {
        // noPath is fine — try a different direction next iteration
        if (err.name === 'AbortError') throw err;
      }

      // After moving, check again
      const afterLog = bot.findBlock({ matching: _isLog, maxDistance: 64 });
      if (afterLog) {
        const wm = bot._worldMemory;
        if (wm && typeof wm.addLocation === 'function') {
          wm.addLocation('tree', 'tree', afterLog.position, {
            biome: wm.currentBiome || 'unknown',
            discoveredAt: Date.now(),
          });
        }
        await _moveTo(bot, afterLog.position, 3, signal);
        return;
      }

      // Expand radius for next iteration
      currentRadius = Math.min(currentRadius + stepSize, maxRadius);
    }

    throw new Error(`exploreForTree: no tree found within ${maxRadius} blocks after ${iterations} iterations`);
  },
};

// ─── walkToNearestOre ────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const walkToNearestOre = {
  id: 'movement.walkToNearestOre',
  description: 'Walk to the nearest visible ore block (expands radius)',
  async execute(bot, params, signal) {
    const { oreName = 'coal_ore' } = params;
    const RADII = [16, 32, 64];

    for (const radius of RADII) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const block = bot.findBlock({
        matching: (b) => b.name.includes(oreName) || b.name === oreName,
        maxDistance: radius,
      });
      if (block) {
        await _moveTo(bot, block.position, 2, signal);
        return;
      }
    }
    throw new Error(`Cannot find ${oreName} within ${RADII[RADII.length - 1]} blocks`);
  },
};

// ─── explore ─────────────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const explore = {
  id: 'movement.explore',
  description: 'Explore the world in a given direction/radius',
  async execute(bot, params, signal) {
    const { radius = 64, direction = null } = params;
    const pos = bot.entity.position;

    let angle;
    if (direction === 'north') angle = Math.PI;
    else if (direction === 'south') angle = 0;
    else if (direction === 'east') angle = Math.PI / 2;
    else if (direction === 'west') angle = -Math.PI / 2;
    else angle = Math.random() * Math.PI * 2;

    const dist = radius * (0.5 + Math.random() * 0.5);
    const target = {
      x: pos.x + Math.sin(angle) * dist,
      y: pos.y,
      z: pos.z + Math.cos(angle) * dist,
    };

    try {
      await _moveTo(bot, target, 5, signal);
    } catch (err) {
      // noPath is non-fatal for explore — just return normally
      if (err.name === 'AbortError') throw err;
    }
  },
};

// ─── descendToYLevel ─────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const descendToYLevel = {
  id: 'movement.descendToYLevel',
  description: 'Descend to a specific Y level by navigating downward',
  async execute(bot, params, signal) {
    const { targetY = -54 } = params;
    const maxIterations = 200;
    let iterations = 0;

    while (bot.entity.position.y > targetY + 1) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (++iterations > maxIterations) throw new Error('descendToYLevel: max iterations exceeded');

      const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (!below || below.name === 'air' || below.name === 'cave_air') {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      try { await bot.dig(below); } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }
  },
};

module.exports = [walkToPosition, walkToNearestTree, exploreForTree, walkToNearestOre, explore, descendToYLevel];
