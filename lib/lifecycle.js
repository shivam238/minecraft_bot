const net = require('net');
const { state, RECONNECT_DELAYS } = require('./state');
const { clearSleepListener } = require('./sleep');
const { releaseMovementKeys } = require('./pathfinding');
const log = require('./logger');

let reconnectDeps = null;

function initReconnect(createBotFn, getConfig) {
  reconnectDeps = { createBotFn, getConfig };
}

function clearAllIntervals() {
  if (state.smartAFKInterval) {
    clearTimeout(state.smartAFKInterval);
    state.smartAFKInterval = null;
  }
  if (state.chatInterval) {
    clearInterval(state.chatInterval);
    state.chatInterval = null;
  }
  if (state.priorityManagerInterval) {
    clearInterval(state.priorityManagerInterval);
    state.priorityManagerInterval = null;
  }
  if (state.keepAliveInterval) {
    clearInterval(state.keepAliveInterval);
    state.keepAliveInterval = null;
  }
  if (state.playerSleepCheckInterval) {
    clearInterval(state.playerSleepCheckInterval);
    state.playerSleepCheckInterval = null;
  }
  if (state.entityUpdateSleepHandler && state.bot) {
    state.bot.removeListener('entityUpdate', state.entityUpdateSleepHandler);
    state.entityUpdateSleepHandler = null;
  }
}

function temporaryLeave(createBotFn, durationMs = 30000) {
  if (state.temporaryLeaveActive) return;
  state.temporaryLeaveActive = true;
  state.lastTemporaryLeaveTime = Date.now();

  const bot = state.bot;
  if (!bot || !state.loggedIn) {
    state.temporaryLeaveActive = false;
    return;
  }

  log.info(`Player sleeping — leaving for ${durationMs / 1000}s`);
  try { bot.chat('good night everyone :)'); } catch (_) {}

  // Intentional disconnect — suppress auto-reconnect
  clearAllIntervals();
  state.isIntentionalDisconnect = true;
  state.loggedIn = false;
  try { bot.end(); } catch (_) {}
  state.bot = null;

  setTimeout(() => {
    if (state.lifecycle !== 'running') {
      state.temporaryLeaveActive = false;
      return;
    }
    log.info('Temporary leave over — rejoining...');
    state.isIntentionalDisconnect = false;
    state.disconnectInProgress = false;
    state.temporaryLeaveActive = false;
    createBotFn();
  }, durationMs);
}

function stopCurrentTasks() {
  const bot = state.bot;
  if (!bot) return;

  if (bot.pathfinder) try { bot.pathfinder.stop(); } catch (_) {}
  if (bot.pvp) try { bot.pvp.stop(); } catch (_) {}
  clearSleepListener();

  if (bot.isSleeping) {
    bot.wake().catch((err) => log.fail('Wake error during task stop', err));
  }
}

function cleanupBot() {
  clearAllIntervals();
  stopCurrentTasks();

  const bot = state.bot;
  if (bot) {
    if (!state.isReconnecting && state.loggedIn) {
      state.isIntentionalDisconnect = true;
    }
    bot.removeAllListeners();
    try {
      bot.end();
    } catch (_) {
      /* already ended */
    }
    state.bot = null;
  }
}

function clearReconnectTimer() {
  if (state.reconnectTimeout) {
    clearTimeout(state.reconnectTimeout);
    state.reconnectTimeout = null;
  }
}

function pingServerPort(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function handleDisconnect(eventName, details = {}) {
  if (state.lifecycle === 'stopped' || state.isIntentionalDisconnect) {
    log.info(`Disconnect via ${eventName} ignored (bot stopped or intentional).`);
    return;
  }

  if (state.disconnectInProgress) {
    log.info(`Duplicate disconnect event (${eventName}) ignored.`);
    return;
  }

  state.disconnectInProgress = true;
  state.loggedIn = false;

  const reasonText =
    details.reason && typeof details.reason.toString === 'function'
      ? details.reason.toString()
      : details.reason !== undefined
        ? String(details.reason)
        : 'none';
  const errorText =
    details.error instanceof Error
      ? details.error.message
      : details.error !== undefined
        ? String(details.error)
        : 'none';

  log.warn(`Disconnect via ${eventName} | reason=${reasonText} | error=${errorText}`);
  log.info(`Reconnect attempt #${state.reconnectAttempt + 1} will be scheduled.`);

  clearAllIntervals();
  if (reconnectDeps) {
    scheduleReconnect(reconnectDeps.createBotFn, reconnectDeps.getConfig);
  } else {
    log.fail('Reconnect failed — lifecycle not initialized');
  }
}

function scheduleReconnect(createBotFn, getConfig) {
  if (state.lifecycle !== 'running') {
    log.info('Reconnect skipped — lifecycle is not running.');
    return;
  }

  if (state.isReconnecting) {
    log.info('Reconnection already in progress.');
    return;
  }

  state.isReconnecting = true;
  state.lifecycle = 'reconnecting';
  cleanupBot();

  state.reconnectAttempt += 1;
  const delay =
    RECONNECT_DELAYS[Math.min(state.reconnectAttempt - 1, RECONNECT_DELAYS.length - 1)];
  const nextTime = new Date(Date.now() + delay).toLocaleTimeString();
  log.info(
    `Reconnect #${state.reconnectAttempt} in ${delay / 1000}s (at ~${nextTime})`
  );

  clearReconnectTimer();
  state.reconnectTimeout = setTimeout(async () => {
    state.reconnectTimeout = null;

    if (state.lifecycle !== 'running' && state.lifecycle !== 'reconnecting') {
      state.isReconnecting = false;
      return;
    }

    const config = getConfig();
    const host = config.host;
    const port = config.port;

    log.info(`Pinging ${host}:${port}...`);
    const reachable = await pingServerPort(host, port);

    if (!reachable) {
      log.warn(`Server not reachable. Scheduling retry #${state.reconnectAttempt + 1}.`);
      state.isReconnecting = false;
      scheduleReconnect(createBotFn, getConfig);
      return;
    }

    log.ok(`Server reachable. Connecting (attempt #${state.reconnectAttempt})...`);
    state.isReconnecting = false;
    state.lifecycle = 'running';
    createBotFn();
  }, delay);
}

function startBot(createBotFn, aiManager) {
  if (state.lifecycle === 'running' || state.lifecycle === 'reconnecting') {
    log.info('Start ignored — bot is already running or reconnecting.');
    return false;
  }

  state.lifecycle = 'running';
  state.isIntentionalDisconnect = false;
  state.disconnectInProgress = false;
  state.reconnectAttempt = 0;
  state.isReconnecting = false;

  if (aiManager && typeof aiManager.startCacheCleanup === 'function') {
    aiManager.startCacheCleanup();
  }

  log.ok('Bot lifecycle started.');
  createBotFn();
  return true;
}

function stopBot(aiManager, reason = 'manual') {
  if (state.lifecycle === 'stopped') {
    log.info('Stop ignored — bot is already stopped.');
    return false;
  }

  state.lifecycle = 'stopped';
  state.isIntentionalDisconnect = true;
  state.isReconnecting = false;
  state.disconnectInProgress = false;
  state.loggedIn = false;

  clearReconnectTimer();
  cleanupBot();
  releaseMovementKeys();

  if (aiManager && typeof aiManager.shutdown === 'function') {
    aiManager.shutdown();
  } else if (aiManager && typeof aiManager.stopCacheCleanup === 'function') {
    aiManager.stopCacheCleanup();
  }

  log.ok(`Bot stopped (${reason}).`);
  return true;
}

function isRunning() {
  return state.lifecycle === 'running' || state.lifecycle === 'reconnecting';
}

module.exports = {
  initReconnect,
  clearAllIntervals,
  stopCurrentTasks,
  cleanupBot,
  handleDisconnect,
  scheduleReconnect,
  startBot,
  stopBot,
  isRunning,
  pingServerPort,
  temporaryLeave,
};
