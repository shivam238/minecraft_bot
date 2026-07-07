const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const autoEatModule = require('mineflayer-auto-eat');
const autoeat = autoEatModule.plugin || autoEatModule.loader;

const { state } = require('./state');
const { getConfig } = require('./config');
const {
  cleanupBot,
  handleDisconnect,
  scheduleReconnect,
  temporaryLeave,
} = require('./lifecycle');
const { startSmartLoops } = require('./behaviors');
const { handleChat } = require('./commands');
const log = require('./logger');

const authPassword = process.env.PASSWORD || '';

// Cooldown between temporary leaves (90s) to avoid re-triggering on rejoin
const SLEEP_LEAVE_COOLDOWN_MS = 90000;

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

function tryLeaveForSleep(createBotFn, username) {
  if (state.temporaryLeaveActive) return;
  const now = Date.now();
  if (now - state.lastTemporaryLeaveTime < SLEEP_LEAVE_COOLDOWN_MS) return;
  log.info(`${username} went to sleep — leaving for 30s`);
  temporaryLeave(createBotFn, 30000);
}

function startPlayerSleepWatch(createBotFn) {
  if (state.playerSleepCheckInterval) {
    clearInterval(state.playerSleepCheckInterval);
    state.playerSleepCheckInterval = null;
  }

  const bot = state.bot;
  if (!bot) return;

  // Event-based: fires immediately when any entity's metadata updates
  // Remove old handler first so repeated spawns don't stack listeners
  if (state.entityUpdateSleepHandler) {
    bot.removeListener('entityUpdate', state.entityUpdateSleepHandler);
    state.entityUpdateSleepHandler = null;
  }
  state.entityUpdateSleepHandler = (entity) => {
    if (!state.loggedIn || state.temporaryLeaveActive) return;
    const player = Object.values(bot.players || {}).find(
      (p) => p.entity && p.entity.id === entity.id && p.username !== bot.username
    );
    if (player && isEntitySleeping(entity)) {
      tryLeaveForSleep(createBotFn, player.username);
    }
  };
  bot.on('entityUpdate', state.entityUpdateSleepHandler);

  // Fallback poll every 3s (catches cases entityUpdate misses)
  state.playerSleepCheckInterval = setInterval(() => {
    if (!bot || !state.loggedIn || state.temporaryLeaveActive) return;
    const sleeping = Object.values(bot.players || {}).find((p) => {
      if (!p.entity || p.username === bot.username) return false;
      return isEntitySleeping(p.entity);
    });
    if (sleeping) tryLeaveForSleep(createBotFn, sleeping.username);
  }, 3000);
}

function createBot(aiManager, lifecycleApi) {
  if (state.lifecycle !== 'running' && state.lifecycle !== 'reconnecting') {
    log.info('createBot skipped — lifecycle not active');
    return;
  }

  // Self-reference used to reconnect after temporary leaves
  const createSelf = () => createBot(aiManager, lifecycleApi);

  if (state.bot) {
    log.warn('Existing bot instance found — cleaning up before reconnect');
    cleanupBot();
  }

  const config = getConfig();
  state.isIntentionalDisconnect = false;
  state.disconnectInProgress = false;
  state.loggedIn = false;

  const botName = config.username;
  state.bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: botName,
    version: false,
  });

  const bot = state.bot;
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoeat);

  bot.on('login', () => {
    log.ok(`${botName} logged in`);
    state.loggedIn = true;
    state.lastSuccessfulLoginTime = Date.now();
    state.reconnectAttempt = 0;
    state.isReconnecting = false;
    state.disconnectInProgress = false;
    state.isIntentionalDisconnect = false;
    state.lifecycle = 'running';
  });

  bot.on('spawn', () => {
    log.ok(`${botName} spawned — features active`);
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['rotten_flesh', 'spider_eye', 'pufferfish'],
    };
    startSmartLoops();
    startPlayerSleepWatch(createSelf);
  });

  bot.on('death', () => {
    log.warn(`${botName} died — respawning`);
    bot.respawn();
  });

  bot.on('wake', () => {
    log.info('Bot woke up');
    if (state.botState === 'sleeping') {
      state.botState = 'afk';
    }
  });

  bot.on('kicked', (reason) => {
    log.warn(`Kicked: ${reason && reason.toString ? reason.toString() : reason}`);
    handleDisconnect('kicked', { reason });
  });

  bot.on('error', (err) => {
    log.fail('Connection error', err);
    handleDisconnect('error', { error: err });
  });

  bot.on('end', () => {
    log.warn('Connection ended');
    handleDisconnect('end');
  });

  bot.on('autoeat_started', (item) => {
    log.info(`AutoEat: eating ${item.name}`);
  });

  bot.on('stoppedAttacking', () => {
    if (bot.autoEat) bot.autoEat.enableAuto();
  });

  bot.on('entityHurt', (entity) => {
    const configNow = getConfig();
    if (!configNow.autoDefense || entity !== bot.entity) return;

    const target = bot.nearestEntity(
      (e) =>
        (e.type === 'player' || e.type === 'mob') &&
        bot.entity.position.distanceTo(e.position) < 8
    );

    if (!target) return;
    if (target.type === 'player' && configNow.owners.includes(target.username)) {
      log.info(`Ignored hit from owner ${target.username}`);
      return;
    }
    if (!bot.pvp.target) {
      bot.pvp.attack(target);
      log.info(`Retaliating against ${target.username || target.name}`);
    }
  });

  bot.on('chat', async (username, message) => {
    await handleChat(username, message, aiManager, lifecycleApi);
  });

  bot.on('message', (jsonMsg) => {
    if (!authPassword) return;
    const text = jsonMsg.toString();
    if (text.includes('/login') || text.includes('log in')) {
      bot.chat(`/login ${authPassword}`);
      log.ok('Sent login command');
    } else if (text.includes('/register')) {
      bot.chat(`/register ${authPassword} ${authPassword}`);
      log.ok('Sent register command');
    }
  });

  log.info(`Connecting to ${config.host}:${config.port} as ${botName}...`);
}

function buildLifecycleApi(aiManager) {
  const create = () => createBot(aiManager, lifecycleApi);

  const lifecycleApi = {
    start: () => {
      const { startBot } = require('./lifecycle');
      return startBot(create, aiManager);
    },
    stop: (reason) => {
      const { stopBot } = require('./lifecycle');
      return stopBot(aiManager, reason);
    },
    isRunning: () => {
      const { isRunning } = require('./lifecycle');
      return isRunning();
    },
    scheduleReconnect: () => scheduleReconnect(create, getConfig),
  };

  return { createBot: create, lifecycleApi };
}

module.exports = { createBot, buildLifecycleApi };
