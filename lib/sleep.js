const { state } = require('./state');
const { setBedGoal } = require('./pathfinding');
const log = require('./logger');

function clearSleepListener() {
  const bot = state.bot;
  if (bot && state.sleepGoalReachedListener) {
    bot.removeListener('goal_reached', state.sleepGoalReachedListener);
    state.sleepGoalReachedListener = null;
  }
  if (state.sleepPollInterval) {
    clearInterval(state.sleepPollInterval);
    state.sleepPollInterval = null;
  }
}

function findNearbyBed(maxDistance = 40) {
  const bot = state.bot;
  if (!bot) return null;
  return bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance });
}

async function attemptSleep(bed, maxDistance = 5) {
  const bot = state.bot;
  if (!bot || !bot.entity || !bed) return { success: false, reason: 'no_bot_or_bed' };

  const dist = bot.entity.position.distanceTo(bed.position);
  if (dist > maxDistance) {
    log.warn(`Sleep attempt: too far from bed (${Math.round(dist)} blocks)`);
    return { success: false, reason: 'too_far' };
  }

  try {
    await bot.sleep(bed);
    log.ok('Sleep successful');
    return { success: true };
  } catch (err) {
    log.fail('Sleep failed', err);
    return { success: false, reason: err.message };
  }
}

function walkToBedAndSleep(options = {}) {
  const bot = state.bot;
  if (!bot || !bot.entity) return false;

  const bed = options.bed || findNearbyBed(options.searchDistance || 40);
  if (!bed) {
    if (options.onNoBed) options.onNoBed();
    return false;
  }

  clearSleepListener();
  if (!setBedGoal(bed)) {
    if (options.onNavFail) options.onNavFail();
    return false;
  }

  log.info('Walking to bed...');
  const startTime = Date.now();
  const MAX_WAIT = 25000; // 25s total
  const SLEEP_REACH = 3.5;  // bed reach distance

  state.sleepPollInterval = setInterval(async () => {
    // Abort if bot gone or state changed
    if (!state.bot || !state.bot.entity) {
      clearSleepListener();
      return;
    }
    if (state.botState !== 'sleeping') {
      clearSleepListener();
      return;
    }
    if (state.bot.isSleeping) {
      clearSleepListener();
      return;
    }

    // Find freshest bed nearby, fall back to original
    const freshBed =
      state.bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance: 8 }) || bed;
    const dist = state.bot.entity.position.distanceTo(freshBed.position);

    if (dist <= SLEEP_REACH) {
      // Close enough — stop pathfinder and sleep
      clearSleepListener();
      try { state.bot.pathfinder.stop(); } catch (_) {}
      const result = await attemptSleep(freshBed, SLEEP_REACH + 1);
      if (result.success) {
        if (options.onSuccess) options.onSuccess();
      } else if (options.onFail) {
        options.onFail(result.reason);
      }
      return;
    }

    // Timeout — give up
    if (Date.now() - startTime > MAX_WAIT) {
      clearSleepListener();
      log.warn(`Sleep: navigation timeout after ${Math.round(MAX_WAIT / 1000)}s (${Math.round(dist)} blocks from bed)`);
      if (options.onFail) options.onFail('nav_timeout');
      return;
    }

    // Pathfinder stopped early — retry navigation
    if (!state.bot.pathfinder.isMoving()) {
      log.info('Sleep: pathfinder stopped, retrying...');
      setBedGoal(freshBed);
    }
  }, 500);

  return true;
}


async function wakeUp() {
  const bot = state.bot;
  if (!bot || !bot.isSleeping) return { success: false, reason: 'not_sleeping' };

  try {
    await bot.wake();
    log.ok('Woke up successfully');
    return { success: true };
  } catch (err) {
    log.fail('Wake failed', err);
    return { success: false, reason: err.message };
  }
}

function isEntitySleeping(entity) {
  if (!entity) return false;
  // mineflayer sets entity.sleeping directly on newer versions
  if (entity.sleeping === true) return true;
  // Minecraft protocol: metadata index 6 = Pose, value 2 = SLEEPING
  // mineflayer stores metadata entries as objects: { type, value }
  const meta6 = entity.metadata && entity.metadata[6];
  if (meta6 !== undefined && meta6 !== null) {
    const pose = typeof meta6 === 'object' ? meta6.value : meta6;
    if (pose === 2) return true;
  }
  return false;
}

module.exports = {
  clearSleepListener,
  findNearbyBed,
  attemptSleep,
  walkToBedAndSleep,
  wakeUp,
  isEntitySleeping,
};
