'use strict';

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Mines a specific block type until `count` items are collected.
 */
const mine = {
  id: 'mining.mine',
  description: 'Mine a specific block type until count items collected',
  async execute(bot, params, signal) {
    const { blockName, count = 1 } = params;
    if (!blockName) throw new Error('mining.mine requires params.blockName');

    let collected = 0;
    const maxAttempts = count * 5;
    let attempts = 0;

    while (collected < count && attempts < maxAttempts) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      attempts++;

      const block = bot.findBlock({
        matching: (b) => b.name === blockName || b.name.includes(blockName),
        maxDistance: 6,
      });

      if (!block) {
        // Try to move toward the ore
        const farBlock = bot.findBlock({
          matching: (b) => b.name === blockName || b.name.includes(blockName),
          maxDistance: 20,
        });
        if (!farBlock) throw new Error(`Cannot find ${blockName} within range`);

        const { goals } = require('mineflayer-pathfinder');
        bot.pathfinder.setGoal(new goals.GoalNear(farBlock.position.x, farBlock.position.y, farBlock.position.z, 3));
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Equip best pickaxe if mining stone/ore
      const isMineableWithPick = !blockName.includes('log') && !blockName.includes('dirt') && !blockName.includes('sand');
      if (isMineableWithPick) {
        const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
        if (pick) await bot.equip(pick, 'hand').catch(() => {});
      }

      try {
        if (!bot.canDigBlock(block)) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        await bot.dig(block);
        collected++;
      } catch (err) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (collected < count) {
      throw new Error(`mining.mine: only collected ${collected}/${count} ${blockName}`);
    }
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Chops wood logs — walks to them if needed.
 */
const chopWood = {
  id: 'mining.chopWood',
  description: 'Chop wood logs from trees',
  async execute(bot, params, signal) {
    const count = params.count || 10;
    await mine.execute(bot, { blockName: 'log', count }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Mines coal ore.
 */
const mineCoal = {
  id: 'mining.mineCoal',
  description: 'Mine coal ore blocks',
  async execute(bot, params, signal) {
    const count = params.count || 8;
    await mine.execute(bot, { blockName: 'coal_ore', count }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Mines iron ore.
 */
const mineIron = {
  id: 'mining.mineIron',
  description: 'Mine iron ore blocks',
  async execute(bot, params, signal) {
    const count = params.count || 8;
    await mine.execute(bot, { blockName: 'iron_ore', count }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Mines diamond ore — requires iron pickaxe.
 */
const mineDiamond = {
  id: 'mining.mineDiamond',
  description: 'Mine diamond ore (requires iron or better pickaxe)',
  requiredItems: ['iron_pickaxe'],
  async execute(bot, params, signal) {
    const count = params.count || 5;
    await mine.execute(bot, { blockName: 'diamond_ore', count }, signal);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Mines stone (for cobblestone).
 */
const mineStone = {
  id: 'mining.mineStone',
  description: 'Mine stone blocks',
  async execute(bot, params, signal) {
    const count = params.count || 8;
    await mine.execute(bot, { blockName: 'stone', count }, signal);
  },
};

module.exports = [mine, chopWood, mineCoal, mineIron, mineDiamond, mineStone];
