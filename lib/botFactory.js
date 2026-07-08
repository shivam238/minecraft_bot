const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;


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
const { autoDeposit } = require('./storage');
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

  // Manual auto-eat — fires every 3s, eats if food < 14
  const BANNED_FOOD = new Set(['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato']);
  function tryEat() {
    if (!state.loggedIn) return;
    if (bot.food >= 14) return;          // full enough
    if (bot.food <= 0) return;           // dead / spectator
    const item = bot.inventory.items().find(
      (i) => i.name.includes('bread') || i.name.includes('cooked') ||
             i.name.includes('carrot') || i.name.includes('potato') ||
             i.name.includes('apple') || i.name.includes('steak') ||
             i.name.includes('pork') || i.name.includes('beef') ||
             i.name.includes('fish') || i.name.includes('melon') ||
             (i.foodPoints !== undefined && !BANNED_FOOD.has(i.name))
    );
    if (!item) return;
    bot.equip(item, 'hand').then(() => bot.consume()).catch(() => {});
  }
  const eatInterval = setInterval(tryEat, 3000);
  // Clean up on bot end
  bot.once('end', () => clearInterval(eatInterval));

  bot.on('spawn', () => {
    log.ok(`${botName} spawned — features active`);
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

  bot.on('stoppedAttacking', () => {
    // combat finished — eating resumes automatically via interval
  });

  // Track arm swings to attribute damage to the correct entity
  bot.on('entitySwingArm', (swinger) => {
    if (!bot.entity || swinger.id === bot.entity.id) return;
    const dist = bot.entity.position.distanceTo(swinger.position);
    if (dist > 20) return; // too far to matter

    const entry = {
      entityId: swinger.id,
      username: swinger.username || null,
      pos: swinger.position.clone(),
      time: Date.now(),
    };
    // Keep only the last 10 swingers; prune entries older than 2s
    state.recentSwingers = state.recentSwingers
      .filter((s) => Date.now() - s.time < 2000)
      .slice(-9);
    state.recentSwingers.push(entry);

    // Wolf mode: owner swings near someone → join immediately (don't wait for entityHurt)
    const configNow = getConfig();
    const configOwners = configNow.owners || [];\
    if (
      swinger.username &&
      configOwners.includes(swinger.username) &&
      configNow.autoDefense &&
      !state.politeMode &&
      bot.pvp
    ) {
      log.info(`Wolf: owner swing detected from ${swinger.username}`);
      const target = bot.nearestEntity(
        (e) =>
          (e.type === 'player' || e.type === 'mob') &&
          e !== bot.entity &&
          !configOwners.includes(e.username) &&
          swinger.position.distanceTo(e.position) < 6  // widened from 4 → 6 blocks
      );
      if (target) {
        if (bot.pvp.target !== target) {
          bot.pvp.attack(target);
          log.info(`Wolf mode: joining ${swinger.username}'s fight against ${target.username || target.name}`);
        }
      } else {
        log.info(`Wolf: owner swung but no target found within 6 blocks`);
      }
    }
  });

  bot.on('entityHurt', (entity) => {
    const configNow = getConfig();
    const configOwners = configNow.owners || [];

    // --- Owner being attacked: defend them ---
    if (
      entity !== bot.entity &&
      entity.username &&
      configOwners.includes(entity.username) &&
      configNow.autoDefense
    ) {
      const ATTRIBUTION_WINDOW_MS = 1500;
      const now = Date.now();
      const candidate = state.recentSwingers
        .filter((s) => now - s.time <= ATTRIBUTION_WINDOW_MS && !configOwners.includes(s.username))
        .sort((a, b) => b.time - a.time)[0];

      // Find attacker: first try recentSwingers, then fallback to nearest entity to the owner
      const attacker = (candidate
        ? bot.nearestEntity((e) => e.id === candidate.entityId)
        : null
      ) || bot.nearestEntity(
        (e) =>
          (e.type === 'player' || e.type === 'mob') &&
          e !== bot.entity &&
          !configOwners.includes(e.username) &&
          entity.position.distanceTo(e.position) < 5  // must be in melee range of owner
      );

      if (attacker && !bot.pvp.target) {
        bot.pvp.attack(attacker);
        const defMsgs = [
          'kya kar rha hai usse!!', 'mat maar usse!!', 'aye!! hands off!!',
          'chhod usse!!', 'NAHI!!', 'tujhe nahi chhodunga!!',
        ];
        bot.chat(defMsgs[Math.floor(Math.random() * defMsgs.length)]);
        log.info(`Owner defense: attacking ${attacker.username || attacker.name} for hurting ${entity.username}`);
      }
      return;
    }

    // --- Wolf mode: owner attacked someone → bot joins the fight ---
    if (
      entity !== bot.entity &&
      !configOwners.includes(entity.username) &&
      configNow.autoDefense &&
      !state.politeMode
    ) {
      const ATTRIBUTION_WINDOW_MS = 1500;
      const now = Date.now();
      const ownerSwing = state.recentSwingers
        .filter((s) => now - s.time <= ATTRIBUTION_WINDOW_MS && configOwners.includes(s.username))
        .sort((a, b) => b.time - a.time)[0];

      if (ownerSwing) {
        const target = bot.nearestEntity((e) => e.id === entity.id) ||
          bot.nearestEntity((e) =>
            (e.type === 'player' || e.type === 'mob') &&
            e !== bot.entity &&
            !configOwners.includes(e.username) &&
            bot.entity.position.distanceTo(e.position) < 20
          );
        if (target && bot.pvp.target !== target) {
          bot.pvp.attack(target);
          log.info(`Wolf mode: joining owner's fight against ${target.username || target.name}`);
        }
      }
      return;
    }

    if (entity !== bot.entity) return;

    // Attribute damage to the most recent swinger within 1.5s — much more accurate than proximity alone
    const ATTRIBUTION_WINDOW_MS = 1500;
    const now = Date.now();
    const candidate = state.recentSwingers
      .filter((s) => now - s.time <= ATTRIBUTION_WINDOW_MS)
      .sort((a, b) => b.time - a.time)[0]; // most recent first

    if (!candidate) return; // no reliable attacker found — ignore

    // Owner hit the bot — panic like a villager instead of fighting back
    if (candidate.username && configOwners.includes(candidate.username)) {
      state.panicActive = true;
      state.panicEndTime = now + 5000 + Math.random() * 4000; // 5–9 seconds
      state.panicFromPos = candidate.pos.clone();
      state.panicFromName = candidate.username;
      state.lastPanicActionTime = 0; // reset so panic movement fires immediately

      // Immediately stop whatever the bot was doing — don't wait for the next 200ms tick
      try { if (bot.pathfinder && bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch (_) {}
      try { if (bot.pvp && bot.pvp.target) bot.pvp.stop(); } catch (_) {}
      for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
        try { bot.setControlState(key, false); } catch (_) {}
      }

      // Immediately start fleeing — don't wait for the next 200ms priority tick
      try {
        const fromPos = candidate.pos;
        const botPos  = bot.entity.position;
        let fdx = botPos.x - fromPos.x;
        let fdz = botPos.z - fromPos.z;
        const fdist = Math.sqrt(fdx * fdx + fdz * fdz);
        if (fdist < 0.5) { const a = Math.random() * Math.PI * 2; fdx = Math.cos(a); fdz = Math.sin(a); }
        else { fdx /= fdist; fdz /= fdist; }
        bot.look(Math.atan2(-fdx, -fdz), 0, true);
        bot.setControlState('forward', true);
      } catch (_) {}

      const scared = [
        'AHH!!', 'OW!!', 'bhai STOP!!', 'kya kar rha hai!!',
        'chhod mujhe!!', 'nooo!!', 'ow ow ow!!', 'HELP!!',
        'ahhh!!!', '😱😱', 'kyun bhai kyun!!', 'AHHHHH',
      ];
      bot.chat(scared[Math.floor(Math.random() * scared.length)]);
      log.info(`Panic triggered by owner ${candidate.username}`);
      return;
    }

    // Non-owner / mob hit — retaliate only if autoDefense is on
    if (!configNow.autoDefense) return;
    // Polite mode: don't fight back against players
    if (state.politeMode && candidate.username) {
      log.info(`Polite mode: not retaliating against player ${candidate.username}`);
      return;
    }
    const target = bot.nearestEntity(
      (e) =>
        (e.type === 'player' || e.type === 'mob') &&
        e.id === candidate.entityId
    ) || bot.nearestEntity(
      (e) =>
        (e.type === 'player' || e.type === 'mob') &&
        bot.entity.position.distanceTo(e.position) < 8
    );
    if (target && !bot.pvp.target) {
      bot.pvp.attack(target);
      log.info(`Retaliating against ${target.username || target.name}`);
    }
  });

  // Auto-deposit items into nearby chest when inventory fills up
  bot.on('playerCollect', (collector) => {
    if (!bot.entity || collector.username !== bot.username) return;
    // Small delay so inventory is updated before we check it
    setTimeout(() => autoDeposit(bot), 500);
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
