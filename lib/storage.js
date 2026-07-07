const { goals } = require('mineflayer-pathfinder');
const { state } = require('./state');
const { safeSetGoal } = require('./pathfinding');
const log = require('./logger');

// Items bot should KEEP and never deposit
const KEEP_NAMES = [
  'sword', 'axe', 'pickaxe', 'shovel', 'hoe',      // tools & weapons
  'helmet', 'chestplate', 'leggings', 'boots',       // armor
  'bow', 'crossbow', 'shield', 'trident',             // ranged
  'bread', 'apple', 'beef', 'porkchop', 'chicken',   // food
  'mutton', 'rabbit', 'cod', 'salmon', 'potato',
  'carrot', 'melon', 'berry', 'mushroom', 'cookie',
  'cake', 'pie', 'stew', 'soup', 'milk',
  'golden_apple', 'chorus_fruit',
];

function shouldKeepItem(item) {
  const n = item.name.toLowerCase();
  return KEEP_NAMES.some(k => n.includes(k));
}

/**
 * Find the nearest chest/trapped_chest within maxRadius blocks.
 * Returns the block object or null.
 */
function findNearbyChest(bot, maxRadius = 12) {
  try {
    const chestIds = ['chest', 'trapped_chest'].flatMap(name => {
      const b = bot.registry.blocksByName[name];
      return b ? [b.id] : [];
    });
    if (!chestIds.length) return null;
    return bot.findBlock({ matching: chestIds, maxDistance: maxRadius });
  } catch (_) {
    return null;
  }
}

/**
 * Walk to chestBlock, open it, deposit non-essential items, close.
 * Returns { deposited: number, reason?: string }
 */
async function depositToChest(bot, chestBlock) {
  if (!bot || !bot.entity || !chestBlock) return { deposited: 0, reason: 'no_chest' };

  // Walk close enough to open the chest
  const goal = new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z);
  safeSetGoal(goal);

  // Wait until within reach (max 8s)
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await new Promise(r => setTimeout(r, 150));
    if (!bot.pathfinder.isMoving()) break;
  }
  try { bot.pathfinder.stop(); } catch (_) {}

  // Check we're close enough (within 4 blocks)
  const dist = bot.entity.position.distanceTo(chestBlock.position);
  if (dist > 4.5) return { deposited: 0, reason: 'too_far' };

  let chest;
  try {
    chest = await bot.openContainer(chestBlock);
  } catch (err) {
    log.warn(`storage: could not open chest — ${err.message}`);
    return { deposited: 0, reason: 'open_failed' };
  }

  let deposited = 0;
  const items = bot.inventory.items().filter(i => !shouldKeepItem(i));

  for (const item of items) {
    try {
      await chest.deposit(item.type, null, item.count);
      deposited += item.count;
      await new Promise(r => setTimeout(r, 80)); // small delay between deposits
    } catch (err) {
      // Chest full or other error — stop depositing
      log.warn(`storage: deposit stopped — ${err.message}`);
      break;
    }
  }

  try { chest.close(); } catch (_) {}
  return { deposited };
}

/**
 * Auto-deposit logic: called when bot picks up items.
 * Only runs if bot is in AFK/idle mode and a chest is nearby.
 */
let lastDepositTime = 0;
const DEPOSIT_COOLDOWN_MS = 15000; // don't open chest more than once per 15s

async function autoDeposit(bot) {
  if (!bot || !bot.entity) return;
  if (state.botState !== 'afk' && state.botState !== 'idle') return;
  if (Date.now() - lastDepositTime < DEPOSIT_COOLDOWN_MS) return;

  const invItems = bot.inventory.items().filter(i => !shouldKeepItem(i));
  if (invItems.length < 8) return; // not worth a chest trip yet

  const chest = findNearbyChest(bot);
  if (!chest) return;

  lastDepositTime = Date.now();
  log.info(`storage: ${invItems.length} depositable items — heading to chest`);
  try {
    bot.chat('Samaan rakh ke aata hoon...');
  } catch (_) {}

  const result = await depositToChest(bot, chest);
  if (result.deposited > 0) {
    log.ok(`storage: deposited ${result.deposited} items`);
    try { bot.chat(`✅ Samaan rakh diya! (${result.deposited} items)`); } catch (_) {}
  }
}

module.exports = { findNearbyChest, depositToChest, autoDeposit, shouldKeepItem };
