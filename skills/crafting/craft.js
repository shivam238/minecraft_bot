'use strict';

const log = require('../../lib/logger');

/**
 * Shared helper: find a crafting table within range or in inventory.
 * @param {import('mineflayer').Bot} bot
 * @param {number} [maxDistance=8]
 * @returns {Object|null} block or null
 */
function findCraftingTable(bot, maxDistance = 8) {
  return bot.findBlock({
    matching: (b) => b.name === 'crafting_table',
    maxDistance,
  });
}

/**
 * Shared helper: navigate to and open a crafting table.
 * @param {import('mineflayer').Bot} bot
 * @param {AbortSignal} signal
 */
async function openNearestCraftingTable(bot, signal) {
  const { goals } = require('mineflayer-pathfinder');
  const block = findCraftingTable(bot);
  if (!block) throw new Error('No crafting table found within range');

  bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
  await waitForPath(bot, 5000, signal);

  const window = await bot.openBlock(block);
  return { block, window };
}

/**
 * Wait for pathfinder to finish or timeout.
 */
async function waitForPath(bot, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (bot.pathfinder.isMoving() && Date.now() < deadline) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    await new Promise(r => setTimeout(r, 100));
  }
}

// ─── Craft Wooden Planks ─────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftPlanks = {
  id: 'crafting.craftPlanks',
  description: 'Craft wooden planks from logs (2x2 grid, no table needed)',
  async execute(bot, params, signal) {
    const count = params.count || 4;
    const logTypes = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log'];
    const log_ = bot.inventory.items().find(i => logTypes.some(n => i.name === n));
    if (!log_) throw new Error('No logs in inventory to craft planks');

    const recipe = bot.recipesFor(bot.registry.itemsByName.oak_planks.id, null, 1, null)[0];
    if (!recipe) throw new Error('Cannot find planks recipe');
    await bot.craft(recipe, Math.ceil(count / 4), null);
    log.info(`[crafting.craftPlanks] Crafted planks`);
  },
};

// ─── Craft Crafting Table ─────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftCraftingTable = {
  id: 'crafting.craftCraftingTable',
  description: 'Craft a crafting table from 4 planks',
  async execute(bot, params, signal) {
    const tableItem = bot.registry.itemsByName['crafting_table'];
    if (!tableItem) throw new Error('crafting_table not found in registry');
    const recipes = bot.recipesFor(tableItem.id, null, 1, null);
    if (!recipes || recipes.length === 0) throw new Error('No recipe for crafting_table');
    await bot.craft(recipes[0], 1, null);
    log.info('[crafting.craftCraftingTable] Crafted crafting table');
  },
};

// ─── Open Crafting Table ──────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const openCraftingTable = {
  id: 'crafting.openCraftingTable',
  description: 'Navigate to and open the nearest crafting table',
  async execute(bot, params, signal) {
    const { window } = await openNearestCraftingTable(bot, signal);
    // Close immediately — this skill just ensures we can reach the table
    if (window) await bot.closeWindow(window);
  },
};

// ─── Craft Pickaxe ───────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftPickaxe = {
  id: 'crafting.craftPickaxe',
  description: 'Craft a pickaxe of specified material tier',
  async execute(bot, params, signal) {
    const material = params.material || 'wooden';
    const nameMap = {
      wooden: 'wooden_pickaxe',
      stone: 'stone_pickaxe',
      iron: 'iron_pickaxe',
      golden: 'golden_pickaxe',
      diamond: 'diamond_pickaxe',
      netherite: 'netherite_pickaxe',
    };
    const itemName = nameMap[material] || 'wooden_pickaxe';
    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (!itemId) throw new Error(`Unknown pickaxe material: ${material}`);

    const craftingTable = findCraftingTable(bot);
    const recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    if (!recipes || recipes.length === 0) throw new Error(`No recipe for ${itemName} — needs crafting table?`);

    if (craftingTable) {
      const { goals } = require('mineflayer-pathfinder');
      bot.pathfinder.setGoal(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2));
      await waitForPath(bot, 5000, signal);
    }

    await bot.craft(recipes[0], 1, craftingTable);
    log.info(`[crafting.craftPickaxe] Crafted ${itemName}`);
  },
};

// ─── Craft Axe ───────────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftAxe = {
  id: 'crafting.craftAxe',
  description: 'Craft an axe of specified material tier',
  async execute(bot, params, signal) {
    const material = params.material || 'wooden';
    const nameMap = {
      wooden: 'wooden_axe', stone: 'stone_axe', iron: 'iron_axe',
      golden: 'golden_axe', diamond: 'diamond_axe',
    };
    const itemName = nameMap[material] || 'wooden_axe';
    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (!itemId) throw new Error(`Unknown axe material: ${material}`);

    const craftingTable = findCraftingTable(bot);
    const recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    if (!recipes || recipes.length === 0) throw new Error(`No recipe for ${itemName}`);

    if (craftingTable) {
      const { goals } = require('mineflayer-pathfinder');
      bot.pathfinder.setGoal(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2));
      await waitForPath(bot, 5000, signal);
    }

    await bot.craft(recipes[0], 1, craftingTable);
    log.info(`[crafting.craftAxe] Crafted ${itemName}`);
  },
};

// ─── Craft Shovel ─────────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftShovel = {
  id: 'crafting.craftShovel',
  description: 'Craft a shovel of specified material tier',
  async execute(bot, params, signal) {
    const material = params.material || 'wooden';
    const nameMap = {
      wooden: 'wooden_shovel', stone: 'stone_shovel', iron: 'iron_shovel',
      golden: 'golden_shovel', diamond: 'diamond_shovel',
    };
    const itemName = nameMap[material] || 'wooden_shovel';
    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (!itemId) throw new Error(`Unknown shovel material: ${material}`);

    const craftingTable = findCraftingTable(bot);
    const recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    if (!recipes || recipes.length === 0) throw new Error(`No recipe for ${itemName}`);

    await bot.craft(recipes[0], 1, craftingTable);
    log.info(`[crafting.craftShovel] Crafted ${itemName}`);
  },
};

// ─── Craft Furnace ────────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 */
const craftFurnace = {
  id: 'crafting.craftFurnace',
  description: 'Craft a furnace from 8 cobblestone',
  async execute(bot, params, signal) {
    const furnaceId = bot.registry.itemsByName['furnace']?.id;
    if (!furnaceId) throw new Error('furnace not in registry');

    const craftingTable = findCraftingTable(bot);
    const recipes = bot.recipesFor(furnaceId, null, 1, craftingTable);
    if (!recipes || recipes.length === 0) throw new Error('No furnace recipe found');

    if (craftingTable) {
      const { goals } = require('mineflayer-pathfinder');
      bot.pathfinder.setGoal(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2));
      await waitForPath(bot, 5000, signal);
    }

    await bot.craft(recipes[0], 1, craftingTable);
    log.info('[crafting.craftFurnace] Crafted furnace');
  },
};

// ─── Smelt Item ───────────────────────────────────────────────────────────────

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Smelts items in a nearby furnace.
 */
const smeltItem = {
  id: 'crafting.smeltItem',
  description: 'Smelt an item in a nearby furnace',
  async execute(bot, params, signal) {
    const { item = 'iron_ore', count = 8 } = params;
    const furnaceBlock = bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 16 });
    if (!furnaceBlock) throw new Error('No furnace found within 16 blocks');

    const { goals } = require('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
    await waitForPath(bot, 5000, signal);

    const furnace = await bot.openFurnace(furnaceBlock);
    const rawItem = bot.inventory.items().find(i => i.name === item);
    const fuel = bot.inventory.items().find(i =>
      i.name.includes('coal') || i.name.includes('log') || i.name.includes('planks')
    );

    if (!rawItem) { await bot.closeWindow(furnace); throw new Error(`No ${item} in inventory`); }
    if (!fuel) { await bot.closeWindow(furnace); throw new Error('No fuel in inventory'); }

    await furnace.putInput(rawItem.type, null, Math.min(count, rawItem.count));
    await furnace.putFuel(fuel.type, null, Math.min(count, fuel.count));

    // Wait for smelting
    const waitMs = count * 10000; // ~10s per item
    const deadline = Date.now() + Math.min(waitMs, 60000);
    while (Date.now() < deadline) {
      if (signal && signal.aborted) { await bot.closeWindow(furnace); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      const outputCount = furnace.outputItem() ? furnace.outputItem().count : 0;
      if (outputCount >= count) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    // Take output
    if (furnace.outputItem()) {
      await furnace.takeOutput();
    }
    await bot.closeWindow(furnace);
    log.info(`[crafting.smeltItem] Smelted ${item}`);
  },
};

module.exports = [craftPlanks, craftCraftingTable, openCraftingTable, craftPickaxe, craftAxe, craftShovel, craftFurnace, smeltItem];
