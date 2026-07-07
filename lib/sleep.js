const { state } = require('./state');
const { setBedGoal } = require('./pathfinding');
const log = require('./logger');

function clearSleepListener() {
  const bot = state.bot;
  if (bot && state.sleepGoalReachedListener) {
    bot.removeListener('goal_reached', state.sleepGoalReachedListener);
    state.sleepGoalReachedListener = null;
  }
}

function findNearbyBed(maxDistance = 40) {
  const bot = state.bot;
  if (!bot) return null;
  return bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance });
}

async function attemptSleep(bed, maxDistance = 4) {
  const bot = state.bot;
  if (!bot || !bot.entity || !bed) return { success: false, reason: 'no_bot_or_bed' };

  const dist = bot.entity.position.distanceTo(bed.position);
  if (dist >= maxDistance) {
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

  state.sleepGoalReachedListener = async () => {
    state.sleepGoalReachedListener = null;
    if (!state.bot || !state.bot.entity) return;

    const freshBed =
      state.bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance: 8 }) || bed;
    const result = await attemptSleep(freshBed, options.sleepDistance || 4);

    if (result.success) {
      if (options.onSuccess) options.onSuccess();
    } else if (options.onFail) {
      options.onFail(result.reason);
    }
  };

  bot.once('goal_reached', state.sleepGoalReachedListener);
  log.info('Walking to bed...');
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

module.exports = {
  clearSleepListener,
  findNearbyBed,
  attemptSleep,
  walkToBedAndSleep,
  wakeUp,
};
