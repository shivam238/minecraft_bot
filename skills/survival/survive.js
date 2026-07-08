'use strict';

const log = require('../../lib/logger');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Eats the best available food in inventory.
 */
const eatFood = {
  id: 'survival.eatFood',
  description: 'Eat the best food available in inventory',
  async execute(bot, params, signal) {
    const BANNED = new Set(['rotten_flesh','spider_eye','pufferfish','poisonous_potato']);

    // Priority: high-nutrition first
    const priority = ['golden_carrot','cooked_beef','cooked_pork','cooked_mutton',
      'bread','cooked_chicken','cooked_cod','apple','carrot','baked_potato'];

    let food = null;
    for (const name of priority) {
      food = bot.inventory.items().find(i => i.name === name);
      if (food) break;
    }

    // Fallback: any non-banned food item
    if (!food) {
      food = bot.inventory.items().find(i =>
        (i.foodPoints !== undefined && i.foodPoints > 0) && !BANNED.has(i.name)
      );
    }

    if (!food) throw new Error('No food in inventory to eat');
    if (bot.food >= 20) {
      log.info('[survival.eatFood] Already full');
      return;
    }

    await bot.equip(food, 'hand');
    await bot.consume();
    log.info(`[survival.eatFood] Ate ${food.name}`);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Finds a safe indoor location and waits out danger.
 */
const seekShelter = {
  id: 'survival.seekShelter',
  description: 'Find shelter when health is low — stop moving and wait for regen',
  async execute(bot, params, signal) {
    const { goals } = require('mineflayer-pathfinder');

    // Stop all movement
    try { bot.pathfinder.stop(); } catch (_) {}
    for (const key of ['forward','back','left','right','sprint','jump']) {
      bot.setControlState(key, false);
    }

    // Try to find a roofed block (shelter) within 16 blocks
    const pos = bot.entity.position;
    let shelterPos = null;
    for (let r = 2; r <= 16 && !shelterPos; r++) {
      for (let dz = -r; dz <= r && !shelterPos; dz++) {
        for (let dx = -r; dx <= r && !shelterPos; dx++) {
          const check = pos.offset(dx, 0, dz);
          const above = bot.blockAt(check.offset(0, 3, 0));
          const feet = bot.blockAt(check);
          const ground = bot.blockAt(check.offset(0, -1, 0));
          if (
            above && above.name !== 'air' &&
            feet && feet.name === 'air' &&
            ground && ground.boundingBox === 'block'
          ) {
            shelterPos = check;
          }
        }
      }
    }

    if (shelterPos) {
      bot.pathfinder.setGoal(new goals.GoalNear(shelterPos.x, shelterPos.y, shelterPos.z, 1));
      const deadline = Date.now() + 10000;
      while (bot.pathfinder.isMoving() && Date.now() < deadline) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        await new Promise(r => setTimeout(r, 200));
      }
      try { bot.pathfinder.stop(); } catch (_) {}
    }

    // Eat and wait for health regen
    if (bot.food < 16) {
      await eatFood.execute(bot, {}, signal).catch(() => {});
    }

    const waitMs = 8000;
    log.info(`[survival.seekShelter] Waiting ${waitMs}ms for health regen`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (bot.health >= 18) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Finds a bed and sleeps through the night.
 */
const sleep = {
  id: 'survival.sleep',
  description: 'Find a bed and sleep through the night',
  async execute(bot, params, signal) {
    const { goals } = require('mineflayer-pathfinder');

    // Check time — only sleep at night
    const t = bot.time?.timeOfDay;
    const isNight = t !== undefined && (t >= 12542 && t <= 23460);
    if (!isNight) {
      log.info('[survival.sleep] Not night — skipping sleep');
      return;
    }

    const bed = bot.findBlock({
      matching: (b) => b.name.includes('bed'),
      maxDistance: 32,
    });
    if (!bed) throw new Error('No bed found within 32 blocks');

    bot.pathfinder.setGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    const movDeadline = Date.now() + 15000;
    while (bot.pathfinder.isMoving() && Date.now() < movDeadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise(r => setTimeout(r, 200));
    }

    try {
      await bot.sleep(bed);
      log.info('[survival.sleep] Sleeping...');
    } catch (err) {
      throw new Error(`Cannot sleep: ${err.message}`);
    }

    // Wait until morning
    const sleepDeadline = Date.now() + 15000;
    while (bot.isSleeping && Date.now() < sleepDeadline) {
      if (signal && signal.aborted) { await bot.wake(); return; }
      await new Promise(r => setTimeout(r, 500));
    }
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Equips the best armor available in inventory.
 */
const equipArmor = {
  id: 'survival.equipArmor',
  description: 'Equip the best armor available from inventory',
  async execute(bot, params, signal) {
    const SLOTS = [
      { slot: 'head', keywords: ['helmet','cap'] },
      { slot: 'torso', keywords: ['chestplate','tunic'] },
      { slot: 'legs', keywords: ['leggings','pants'] },
      { slot: 'feet', keywords: ['boots'] },
    ];
    const TIERS = { netherite: 5, diamond: 4, iron: 3, golden: 2, chainmail: 2, leather: 1 };

    const getTier = (name) => {
      for (const [mat, tier] of Object.entries(TIERS)) {
        if (name.includes(mat)) return tier;
      }
      return 0;
    };

    for (const { slot, keywords } of SLOTS) {
      const candidates = bot.inventory.items().filter(i =>
        keywords.some(k => i.name.includes(k))
      ).sort((a, b) => getTier(b.name) - getTier(a.name));

      if (candidates.length === 0) continue;
      await bot.equip(candidates[0], slot).catch(() => {});
    }
    log.info('[survival.equipArmor] Armor equipped');
  },
};

module.exports = [eatFood, seekShelter, sleep, equipArmor];
