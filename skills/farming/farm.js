'use strict';

const log = require('../../lib/logger');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Harvests mature crops (wheat, carrots, potatoes, beetroot).
 */
const harvestCrops = {
  id: 'farming.harvestCrops',
  description: 'Harvest all mature crops in the area',
  async execute(bot, params, signal) {
    const { goals } = require('mineflayer-pathfinder');
    const maxRadius = params.radius || 16;
    const MATURE_CROPS = {
      wheat: 7,
      carrots: 7,
      potatoes: 7,
      beetroots: 3,
    };

    let harvested = 0;
    const deadline = Date.now() + 60000;

    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

      // Find a mature crop
      let targetBlock = null;
      for (const [cropName, matureAge] of Object.entries(MATURE_CROPS)) {
        const found = bot.findBlock({
          matching: (b) => {
            if (!b.name.includes(cropName)) return false;
            const ageProp = b.getProperties()?.age;
            return ageProp !== undefined && parseInt(ageProp) >= matureAge;
          },
          maxDistance: maxRadius,
        });
        if (found) { targetBlock = found; break; }
      }

      if (!targetBlock) {
        log.info(`[farming.harvestCrops] No mature crops found. Harvested: ${harvested}`);
        break;
      }

      // Navigate to crop
      bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));
      const movDeadline = Date.now() + 5000;
      while (bot.pathfinder.isMoving() && Date.now() < movDeadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      try { bot.pathfinder.stop(); } catch (_) {}

      // Dig
      try {
        if (bot.canDigBlock(targetBlock)) {
          await bot.dig(targetBlock);
          harvested++;
        }
      } catch (_) {}

      await new Promise(r => setTimeout(r, 200));
    }

    log.info(`[farming.harvestCrops] Harvested ${harvested} crops`);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Replants seeds on farmland after harvesting.
 */
const replantCrops = {
  id: 'farming.replantCrops',
  description: 'Replant seeds on empty farmland',
  async execute(bot, params, signal) {
    const { goals, goals: { GoalNear } } = require('mineflayer-pathfinder');
    const maxRadius = params.radius || 16;

    const SEED_MAP = {
      wheat_seeds: 'wheat',
      carrot: 'carrots',
      potato: 'potatoes',
      beetroot_seeds: 'beetroots',
    };

    let planted = 0;
    const deadline = Date.now() + 60000;

    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

      // Find empty farmland
      const farmland = bot.findBlock({
        matching: (b) => b.name === 'farmland',
        maxDistance: maxRadius,
      });
      if (!farmland) break;

      // Check if already planted
      const above = bot.blockAt(farmland.position.offset(0, 1, 0));
      if (above && above.name !== 'air' && above.name !== 'cave_air') {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      // Find a seed to plant
      let seed = null;
      for (const [seedName] of Object.entries(SEED_MAP)) {
        seed = bot.inventory.items().find(i => i.name === seedName);
        if (seed) break;
      }
      if (!seed) break; // No seeds left

      // Navigate to farmland
      bot.pathfinder.setGoal(new GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 1));
      const movDeadline = Date.now() + 4000;
      while (bot.pathfinder.isMoving() && Date.now() < movDeadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      try { bot.pathfinder.stop(); } catch (_) {}

      // Plant
      try {
        await bot.equip(seed, 'hand');
        await bot.placeBlock(farmland, { x: 0, y: 1, z: 0 });
        planted++;
      } catch (_) {}

      await new Promise(r => setTimeout(r, 300));
    }

    log.info(`[farming.replantCrops] Planted ${planted} seeds`);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Waters farmland using a water bucket.
 */
const waterFarmland = {
  id: 'farming.waterFarmland',
  description: 'Use a water bucket to hydrate dry farmland',
  async execute(bot, params, signal) {
    const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
    if (!bucket) throw new Error('No water bucket in inventory');

    const dryFarmland = bot.findBlock({
      matching: (b) => b.name === 'farmland',
      maxDistance: 16,
    });
    if (!dryFarmland) throw new Error('No farmland found to water');

    await bot.equip(bucket, 'hand');
    await bot.placeBlock(dryFarmland, { x: 0, y: 1, z: 0 });
    log.info('[farming.waterFarmland] Watered farmland');
  },
};

module.exports = [harvestCrops, replantCrops, waterFarmland];
