'use strict';

const log = require('../../lib/logger');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Attacks the nearest hostile mob using mineflayer-pvp.
 */
const attackNearestMob = {
  id: 'combat.attackNearestMob',
  description: 'Attack the nearest hostile mob using pvp plugin',
  async execute(bot, params, signal) {
    const HOSTILES = ['zombie','skeleton','spider','creeper','witch','phantom','drowned','husk','stray','pillager'];
    const maxDist = params.maxDistance || 16;

    const mob = bot.nearestEntity(e =>
      e.type === 'mob' &&
      HOSTILES.includes(e.name) &&
      bot.entity.position.distanceTo(e.position) < maxDist
    );
    if (!mob) throw new Error('No hostile mob in range');

    log.info(`[combat.attackNearestMob] Attacking ${mob.name}`);
    bot.pvp.attack(mob);

    // Wait until mob is dead or we abort
    const deadline = Date.now() + 30000;
    while (bot.pvp.target && Date.now() < deadline) {
      if (signal && signal.aborted) {
        try { bot.pvp.stop(); } catch (_) {}
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      await new Promise(r => setTimeout(r, 500));
    }
    try { bot.pvp.stop(); } catch (_) {}
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Flees from the nearest hostile mob.
 */
const fleeMob = {
  id: 'combat.fleeMob',
  description: 'Run away from the nearest hostile mob',
  async execute(bot, params, signal) {
    const mob = bot.nearestEntity(e => e.type === 'mob' && bot.entity.position.distanceTo(e.position) < 10);
    if (!mob) return;

    const botPos = bot.entity.position;
    const mobPos = mob.position;
    const dx = botPos.x - mobPos.x;
    const dz = botPos.z - mobPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;

    const fleeTarget = {
      x: botPos.x + (dx / dist) * 20,
      y: botPos.y,
      z: botPos.z + (dz / dist) * 20,
    };

    const { goals } = require('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalNear(fleeTarget.x, fleeTarget.y, fleeTarget.z, 2));

    const deadline = Date.now() + 10000;
    while (bot.pathfinder.isMoving() && Date.now() < deadline) {
      if (signal && signal.aborted) { try { bot.pathfinder.stop(); } catch (_) {} throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      await new Promise(r => setTimeout(r, 200));
    }
    try { bot.pathfinder.stop(); } catch (_) {}
    log.info('[combat.fleeMob] Flee complete');
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Equips the best weapon from inventory.
 */
const equipWeapon = {
  id: 'combat.equipWeapon',
  description: 'Equip the best melee weapon in inventory',
  async execute(bot, params, signal) {
    const WEAPONS = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
      'netherite_axe','diamond_axe','iron_axe'];
    for (const wName of WEAPONS) {
      const w = bot.inventory.items().find(i => i.name === wName);
      if (w) {
        await bot.equip(w, 'hand');
        log.info(`[combat.equipWeapon] Equipped ${wName}`);
        return;
      }
    }
    log.info('[combat.equipWeapon] No weapon found');
  },
};

module.exports = [attackNearestMob, fleeMob, equipWeapon];
