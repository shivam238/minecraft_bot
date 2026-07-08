/**
 * farming.js — Autonomous crop farming loop
 *
 * Flow:
 *  1. Scan nearby farmland for mature crops → harvest them
 *  2. Scan empty farmland → plant seeds from inventory
 *  3. If harvested crops, deposit to nearest chest
 *  4. If no seeds in inventory, try fetching from nearest chest
 *  5. Repeat on next cycle (driven by behaviors.js interval)
 */

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { state } = require('./state');
const { getConfig } = require('./config');
const { safeSetGoal } = require('./pathfinding');
const { findNearbyChest } = require('./storage');
const log = require('./logger');

// ─── Crop definitions ────────────────────────────────────────────────────────
// blockName: Minecraft block name on the ground
// seedItem:  Item name the bot needs to plant it
// maxAge:    Age value when fully grown
const CROPS = [
  { blockName: 'wheat',     seedItem: 'wheat_seeds',    maxAge: 7 },
  { blockName: 'carrots',   seedItem: 'carrot',         maxAge: 7 },
  { blockName: 'potatoes',  seedItem: 'potato',         maxAge: 7 },
  { blockName: 'beetroots', seedItem: 'beetroot_seeds', maxAge: 3 },
];

// Items produced by harvesting (we want to deposit these)
const HARVEST_ITEMS = new Set([
  'wheat', 'wheat_seeds',
  'carrot', 'potato', 'beetroot', 'beetroot_seeds',
]);

// ─── State guards ─────────────────────────────────────────────────────────────
let farmingBusy = false; // prevent overlapping cycles

function isFarmingEnabled() {
  return getConfig().farming === true;
}

function canFarm() {
  const bot = state.bot;
  return (
    bot &&
    bot.entity &&
    isFarmingEnabled() &&
    !farmingBusy &&
    state.botState === 'afk' &&
    !bot.pvp.target &&
    !bot.isSleeping
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Navigate to a block (top face) and wait until arrived or timeout */
async function navToBlock(block, timeoutMs = 12000) {
  const bot = state.bot;
  if (!bot) return false;
  const goal = new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z);
  safeSetGoal(goal);
  const start = Date.now();
  while (bot.pathfinder.isMoving() && Date.now() - start < timeoutMs) {
    if (!canFarm()) { try { bot.pathfinder.stop(); } catch (_) {} return false; }
    await sleep(100);
  }
  return true;
}

/** Get the age property of a crop block (returns number or null) */
function getCropAge(block) {
  const props = block.getProperties ? block.getProperties() : {};
  const age = props.age;
  return age !== undefined ? Number(age) : null;
}

/** Count seed items in inventory */
function seedCount(seedName) {
  const bot = state.bot;
  if (!bot) return 0;
  return bot.inventory.items()
    .filter(i => i.name === seedName)
    .reduce((sum, i) => sum + i.count, 0);
}

/** Check if inventory has any harvest items to deposit */
function hasHarvestedCrops() {
  const bot = state.bot;
  if (!bot) return false;
  return bot.inventory.items().some(i => HARVEST_ITEMS.has(i.name));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Core farming steps ───────────────────────────────────────────────────────

/** Harvest all mature crops within range. Returns count harvested. */
async function harvestMatureCrops(range = 20) {
  const bot = state.bot;
  let harvested = 0;

  for (const crop of CROPS) {
    if (!canFarm()) break;

    const blocks = bot.findBlocks({
      matching: b => b.name === crop.blockName,
      maxDistance: range,
      count: 64,
    });

    for (const pos of blocks) {
      if (!canFarm()) break;
      const block = bot.blockAt(pos);
      if (!block) continue;

      const age = getCropAge(block);
      if (age === null || age < crop.maxAge) continue; // not mature

      const dist = bot.entity.position.distanceTo(pos);
      if (dist > 4) {
        const ok = await navToBlock(block);
        if (!ok) continue;
      }

      if (!canFarm()) break;
      try {
        await bot.dig(block);
        harvested++;
        await sleep(100);
      } catch (err) {
        log.fail(`Farming: failed to harvest ${crop.blockName}`, err);
      }
    }
  }

  if (harvested > 0) log.ok(`Farming: harvested ${harvested} crop(s)`);
  return harvested;
}

/** Plant seeds on all bare farmland within range. Returns count planted. */
async function plantSeeds(range = 20) {
  const bot = state.bot;
  let planted = 0;

  // Find farmland blocks with air above them (empty slots)
  const farmlandBlocks = bot.findBlocks({
    matching: b => b.name === 'farmland',
    maxDistance: range,
    count: 128,
  });

  for (const pos of farmlandBlocks) {
    if (!canFarm()) break;
    const farmBlock = bot.blockAt(pos);
    if (!farmBlock) continue;

    const above = bot.blockAt(pos.offset(0, 1, 0));
    if (!above || above.name !== 'air') continue; // something already planted

    // Find a seed we have for this farmland
    let matched = null;
    for (const crop of CROPS) {
      if (seedCount(crop.seedItem) > 0) {
        matched = crop;
        break;
      }
    }
    if (!matched) break; // no seeds at all

    const dist = bot.entity.position.distanceTo(pos);
    if (dist > 4) {
      const ok = await navToBlock(farmBlock);
      if (!ok) continue;
    }

    if (!canFarm()) break;

    try {
      const seedItem = bot.inventory.items().find(i => i.name === matched.seedItem);
      if (!seedItem) continue;
      await bot.equip(seedItem, 'hand');
      await bot.placeBlock(farmBlock, new Vec3(0, 1, 0));
      planted++;
      await sleep(150);
    } catch (err) {
      // Ignore individual planting failures (block may have been occupied)
    }
  }

  if (planted > 0) log.ok(`Farming: planted ${planted} seed(s)`);
  return planted;
}

/** Deposit harvested crops from inventory into the nearest chest. */
async function depositHarvest() {
  const bot = state.bot;
  if (!hasHarvestedCrops()) return;

  const chest = findNearbyChest(30);
  if (!chest) {
    log.info('Farming: no chest found to deposit crops');
    return;
  }

  const dist = bot.entity.position.distanceTo(chest.position);
  if (dist > 4) {
    await navToBlock(chest);
  }

  if (!canFarm()) return;

  try {
    const chestWindow = await bot.openContainer(chest);
    const harvestItems = bot.inventory.items().filter(i => HARVEST_ITEMS.has(i.name));
    for (const item of harvestItems) {
      try {
        await bot.moveSlotItem(item.slot, chestWindow.inventorySlots().find(s => !s.count)?.index ?? -1);
      } catch (_) {
        // Simpler approach if moveSlotItem fails
        try { await chestWindow.deposit(item.type, null, item.count); } catch (__) {}
      }
    }
    await chestWindow.close();
    log.ok('Farming: deposited harvest to chest');
  } catch (err) {
    log.fail('Farming: chest deposit failed', err);
  }
}

/** Fetch seeds from the nearest chest if inventory is low. */
async function fetchSeedsFromChest(range = 30) {
  const bot = state.bot;
  // Check if we need any seeds
  const neededSeed = CROPS.find(c => seedCount(c.seedItem) === 0);
  if (!neededSeed) return; // we have at least one of every seed type

  const chest = findNearbyChest(range);
  if (!chest) return;

  const dist = bot.entity.position.distanceTo(chest.position);
  if (dist > 4) {
    const ok = await navToBlock(chest);
    if (!ok) return;
  }

  if (!canFarm()) return;

  try {
    const chestWindow = await bot.openContainer(chest);
    for (const crop of CROPS) {
      if (seedCount(crop.seedItem) > 0) continue; // already have this seed

      const chestSlot = chestWindow.slots.find(
        s => s && s.name === crop.seedItem
      );
      if (chestSlot) {
        try {
          await chestWindow.withdraw(chestSlot.type, null, Math.min(chestSlot.count, 64));
          log.info(`Farming: fetched ${crop.seedItem} from chest`);
        } catch (_) {}
      }
    }
    await chestWindow.close();
  } catch (err) {
    log.fail('Farming: fetch seeds from chest failed', err);
  }
}

// ─── Public: main farming cycle ───────────────────────────────────────────────

/**
 * Run one full farming cycle. Called by the behavior loop every N seconds.
 * Safely no-ops when farming is disabled or bot is busy.
 */
async function runFarmingCycle() {
  if (!canFarm()) return;
  farmingBusy = true;

  try {
    state.botState = 'farming';
    log.info('Farming: starting cycle...');

    // Step 1: harvest mature crops
    const harvested = await harvestMatureCrops(20);

    if (!canFarmCheck()) { restoreAfk(); return; }

    // Step 2: deposit if we got something
    if (harvested > 0) await depositHarvest();

    if (!canFarmCheck()) { restoreAfk(); return; }

    // Step 3: fetch seeds if inventory is empty
    await fetchSeedsFromChest(30);

    if (!canFarmCheck()) { restoreAfk(); return; }

    // Step 4: plant on empty farmland
    await plantSeeds(20);

    log.ok('Farming: cycle complete');
  } catch (err) {
    log.fail('Farming cycle error', err);
  } finally {
    restoreAfk();
  }
}

function canFarmCheck() {
  return state.bot && state.bot.entity && isFarmingEnabled() &&
    (state.botState === 'farming' || state.botState === 'afk');
}

function restoreAfk() {
  if (state.botState === 'farming') state.botState = 'afk';
  farmingBusy = false;
}

module.exports = {
  runFarmingCycle,
  isFarmingEnabled,
};
