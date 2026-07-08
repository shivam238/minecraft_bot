'use strict';

const { goals } = require('mineflayer-pathfinder');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Walks the bot to a specific position using pathfinder.
 */
const walkToPosition = {
  id: 'movement.walkToPosition',
  description: 'Navigate to a specific {x,y,z} position using pathfinder',
  async execute(bot, params, signal) {
    const { position, range = 1 } = params;
    if (!position) throw new Error('walkToPosition requires params.position {x,y,z}');

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
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Locates and walks to the nearest tree (any log block).
 */
const walkToNearestTree = {
  id: 'movement.walkToNearestTree',
  description: 'Walk to the nearest tree (any log block)',
  async execute(bot, params, signal) {
    const logTypes = [
      'oak_log','birch_log','spruce_log','jungle_log',
      'acacia_log','dark_oak_log','mangrove_log','cherry_log',
    ];
    const block = bot.findBlock({
      matching: (b) => logTypes.some(n => b.name.includes('log')),
      maxDistance: 64,
    });
    if (!block) throw new Error('Cannot find a tree within 64 blocks');

    return walkToPosition.execute(bot, { position: block.position, range: 3 }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Locates and walks to the nearest visible ore block.
 */
const walkToNearestOre = {
  id: 'movement.walkToNearestOre',
  description: 'Walk to the nearest visible ore block',
  async execute(bot, params, signal) {
    const { oreName = 'coal_ore' } = params;
    const block = bot.findBlock({
      matching: (b) => b.name.includes(oreName) || b.name === oreName,
      maxDistance: 32,
    });
    if (!block) throw new Error(`Cannot find ${oreName} within 32 blocks`);
    return walkToPosition.execute(bot, { position: block.position, range: 2 }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Explores in a random direction within a radius.
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

    return walkToPosition.execute(bot, { position: target, range: 5 }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Descends to a target Y level by digging straight down safely.
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
      if (!below || below.name === 'air') {
        // Already in air — let gravity handle it
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      try {
        await bot.dig(below);
      } catch (err) {
        // Block may already be gone
      }
      await new Promise(r => setTimeout(r, 200));
    }
  },
};

module.exports = [walkToPosition, walkToNearestTree, walkToNearestOre, explore, descendToYLevel];
