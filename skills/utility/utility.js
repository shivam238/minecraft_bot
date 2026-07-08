'use strict';

const log = require('../../lib/logger');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Deposits all non-essential items into the nearest chest.
 */
const depositToChest = {
  id: 'utility.depositToChest',
  description: 'Deposit all non-essential inventory items into the nearest chest',
  async execute(bot, params, signal) {
    const { goals } = require('mineflayer-pathfinder');

    // Items to keep (never deposit)
    const KEEP = new Set([
      'wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe',
      'wooden_axe','stone_axe','iron_axe','diamond_axe',
      'wooden_sword','stone_sword','iron_sword','diamond_sword',
      'bread','cooked_beef','cooked_pork','cooked_chicken','apple','carrot',
      'torch','water_bucket','flint_and_steel',
    ]);

    const chest = bot.findBlock({ matching: (b) => b.name === 'chest', maxDistance: 16 });
    if (!chest) throw new Error('No chest found within 16 blocks');

    bot.pathfinder.setGoal(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2));
    const deadline = Date.now() + 8000;
    while (bot.pathfinder.isMoving() && Date.now() < deadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise(r => setTimeout(r, 200));
    }
    try { bot.pathfinder.stop(); } catch (_) {}

    const chestWindow = await bot.openBlock(chest);
    const itemsToDeposit = bot.inventory.items().filter(i => !KEEP.has(i.name));

    for (const item of itemsToDeposit) {
      if (signal && signal.aborted) break;
      try { await chestWindow.deposit(item.type, null, item.count); } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    await bot.closeWindow(chestWindow);
    log.info(`[utility.depositToChest] Deposited ${itemsToDeposit.length} stacks`);
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Sends a chat message.
 */
const sendChat = {
  id: 'utility.sendChat',
  description: 'Send a chat message',
  async execute(bot, params, signal) {
    const { message = '' } = params;
    if (!message) return;
    bot.chat(message.substring(0, 256));
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Inspects and reports current bot status.
 */
const reportStatus = {
  id: 'utility.reportStatus',
  description: 'Send a status report to chat',
  async execute(bot, params, signal) {
    const pos = bot.entity.position;
    const msg = `HP:${Math.round(bot.health)} | Food:${bot.food} | Pos:${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} | Inv:${bot.inventory.items().length}/36`;
    bot.chat(msg.substring(0, 256));
  },
};

module.exports = [depositToChest, sendChat, reportStatus];
