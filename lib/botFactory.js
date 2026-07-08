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
const { isEntitySleeping } = require('./sleep');
const { handleChat } = require('./commands');
const { autoDeposit } = require('./storage');
const log = require('./logger');

// ─── Autonomous AI Agent ────────────────────────────────────────────────────
let _autonomousAgent = null;
try {
  const AutonomousAgent = require('../ai/AutonomousAgent');
  _autonomousAgent = new AutonomousAgent({ enabled: true, autoStart: true });
  log.ok('AutonomousAgent loaded');
} catch (err) {
  log.warn(`AutonomousAgent not loaded: ${err.message}`);
}
// ─────────────────────────────────────────────────────────────────────────────

const authPassword = process.env.PASSWORD || '';

// Cooldown between temporary leaves (90s) to avoid re-triggering on rejoin
const SLEEP_LEAVE_COOLDOWN_MS = 90000;

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
    bot.equip(item, 'hand').then(() => bot.consume()).catch(() => { });
  }
  const eatInterval = setInterval(tryEat, 3000);
  // Clean up on bot end
  bot.once('end', () => clearInterval(eatInterval));

  // Auto armor equip — wear best available armor pieces from inventory
  const ARMOR_SLOTS = [
    { slot: 'head',  names: ['helmet',  'cap'] },
    { slot: 'torso', names: ['chestplate', 'tunic'] },
    { slot: 'legs',  names: ['leggings',   'pants'] },
    { slot: 'feet',  names: ['boots'] },
  ];
  const ARMOR_TIER = { netherite: 5, diamond: 4, iron: 3, golden: 2, chainmail: 2, leather: 1 };
  function equipArmor() {
    if (!state.loggedIn || !bot.entity) return;
    for (const { slot, names } of ARMOR_SLOTS) {
      const current = bot.inventory.slots[{
        head: 5, torso: 6, legs: 7, feet: 8
      }[slot]];
      // Find best armor piece for this slot in inventory
      const best = bot.inventory.items()
        .filter((i) => names.some((n) => i.name.includes(n)))
        .sort((a, b) =>
          (ARMOR_TIER[Object.keys(ARMOR_TIER).find((t) => b.name.includes(t))] || 0) -
          (ARMOR_TIER[Object.keys(ARMOR_TIER).find((t) => a.name.includes(t))] || 0)
        )[0];
      if (!best) continue;
      const currentTier = current
        ? (ARMOR_TIER[Object.keys(ARMOR_TIER).find((t) => current.name.includes(t))] || 0) : 0;
      const bestTier = ARMOR_TIER[Object.keys(ARMOR_TIER).find((t) => best.name.includes(t))] || 0;
      if (bestTier > currentTier) {
        bot.equip(best, slot).catch(() => {});
      }
    }
  }

  bot.on('spawn', () => {
    // Guard against double-spawn: if loops already running, just re-init movements
    const alreadyRunning = !!state.priorityManagerInterval;
    log.ok(`${botName} spawned — features active`);
    // Equip best armor available on spawn
    setTimeout(equipArmor, 1500);
    startSmartLoops();
    startPlayerSleepWatch(createSelf);
    if (alreadyRunning) {
      log.info('Spawn fired again — loops restarted cleanly');
    }
    // Attach autonomous agent (non-blocking, runs alongside existing systems)
    if (_autonomousAgent) {
      try { _autonomousAgent.attach(bot); } catch (err) { log.warn(`AutonomousAgent attach failed: ${err.message}`); }
    }
  });

  bot.on('death', () => {
    log.warn(`${botName} died — respawning`);
    // Clear all combat state so bot doesn't re-chase killer after respawn
    state.lastCombatTarget = null;
    state.panicActive = false;
    state.panicEndTime = 0;
    state.panicFromPos = null;
    state.panicFromName = null;
    state.recentSwingers = [];
    state.recentHurts = [];
    try { if (bot.pvp && bot.pvp.target) bot.pvp.stop(); } catch (_) {}
    bot.respawn();
  });

  bot.on('wake', () => {
    log.info('Bot woke up — resuming AFK');
    if (state.botState === 'sleeping') {
      state.botState = 'afk';
      const { scheduleNextAFK } = require('./behaviors');
      scheduleNextAFK(true);
    }
  });

  bot.on('kicked', (reason) => {
    let reasonText;
    try {
      if (typeof reason === 'string') {
        reasonText = reason;
      } else if (reason && typeof reason === 'object') {
        // Mineflayer passes kick reason as a ChatMessage object or plain object
        reasonText = reason.toString ? reason.toString() : JSON.stringify(reason);
        // Try to extract text from nested JSON (Aternos sends {"text":"..."})
        if (reasonText.startsWith('{')) {
          const parsed = JSON.parse(reasonText);
          reasonText = parsed.text || parsed.translate || JSON.stringify(parsed);
        }
      } else {
        reasonText = String(reason);
      }
    } catch (_) {
      reasonText = String(reason);
    }
    log.warn(`Kicked: ${reasonText}`);
    handleDisconnect('kicked', { reason: reasonText });
  });

  bot.on('error', (err) => {
    log.fail('Connection error', err);
    handleDisconnect('error', { error: err });
  });

  bot.on('end', () => {
    log.warn('Connection ended');
    // Gracefully detach autonomous agent before cleanup
    if (_autonomousAgent) {
      _autonomousAgent.detach().catch(() => {});
    }
    handleDisconnect('end');
  });

  bot.on('stoppedAttacking', () => {
    // combat finished — eating resumes automatically via interval
  });

  // Auto-accept /tpa from owner when in follow mode (pet teleport behavior)
  bot.on('message', (jsonMsg) => {
    try {
      const msg = jsonMsg.toString().toLowerCase();
      const followTarget = state.followTarget;
      if (!followTarget || state.botState !== 'following') return;
      const ownerLower = followTarget.toLowerCase();
      // Essentials/CMI/EssentialsX sends: "<owner> has requested to teleport to you"
      // or "teleport request from <owner>" — accept either
      if ((msg.includes(ownerLower) && msg.includes('teleport')) ||
          (msg.includes(ownerLower) && msg.includes('tpa'))) {
        setTimeout(() => {
          try { bot.chat('/tpaccept'); } catch (_) {}
          log.info(`Pet teleport: auto-accepted tpa from ${followTarget}`);
        }, 500);
      }
    } catch (_) {}
  });

  // Track arm swings to attribute damage to the correct entity
  bot.on('entitySwingArm', (swinger) => {
    if (!bot.entity || swinger.id === bot.entity.id) return;
    const dist = bot.entity.position.distanceTo(swinger.position);
    if (dist > 20) return; // too far to matter

    const now = Date.now();
    const entry = {
      entityId: swinger.id,
      username: swinger.username || null,
      pos: swinger.position.clone(),
      time: now,
    };
    state.recentSwingers = state.recentSwingers
      .filter((s) => now - s.time < 3000)
      .slice(-9);
    state.recentSwingers.push(entry);

    const configNow = getConfig();
    const configOwners = configNow.owners || [];
    if (
      swinger.username &&
      configOwners.includes(swinger.username) &&
      configNow.autoDefense &&
      !state.politeMode &&
      bot.pvp
    ) {
      log.info(`Wolf: owner swing — checking for any mob hurt in last 3s`);
      // Handle case: entityHurt arrived BEFORE entitySwingArm (packet order issue)
      if (!state.recentHurts) state.recentHurts = [];
      const recentHurt = state.recentHurts
        .filter((h) => now - h.time <= 3000)
        .sort((a, b) => b.time - a.time)[0];
      if (recentHurt) {
        if (bot.pvp.target && bot.pvp.target.id !== recentHurt.entity.id) {
          try { bot.pvp.stop(); } catch (_) {}
        }
        bot.pvp.attack(recentHurt.entity);
        log.info(`Wolf mode: attacking ${recentHurt.entity.name || recentHurt.entity.type} (retroactive — hurt before swing)`);
        state.recentHurts = []; // clear so we don't re-attack
      } else {
        // No entityHurt yet (miss or packet delay) — scan nearest mob/hostile within 6 blocks
        // This fires immediately so owner's hits always get a response even if entity wasn't hurt
        setTimeout(() => {
          if (!bot.entity || bot.pvp.target) return; // already fighting
          const configOwnersNow = getConfig().owners || [];
          const scanTarget = bot.nearestEntity(
            (e) =>
              e.id !== bot.entity.id &&                               // not self
              e.type === 'mob' &&                                     // only mobs — never players
              bot.entity.position.distanceTo(e.position) < 6
          );
          if (scanTarget) {
            bot.pvp.attack(scanTarget);
            state.lastCombatTarget = scanTarget;
            log.info(`Wolf: owner swing fallback — attacking nearest ${scanTarget.name || scanTarget.type}`);
          } else {
            log.info(`Wolf: swing recorded, waiting for entityHurt...`);
          }
        }, 150); // small delay to let entityHurt arrive first if it's coming
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
        state.lastCombatTarget = attacker;
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
      const ATTRIBUTION_WINDOW_MS = 3000;
      const now = Date.now();
      const ownerSwing = state.recentSwingers
        .filter((s) => now - s.time <= ATTRIBUTION_WINDOW_MS && configOwners.includes(s.username))
        .sort((a, b) => b.time - a.time)[0];

      if (ownerSwing) {
        // entity IS the exact object — direct attack, no search needed
        if (bot.pvp.target && bot.pvp.target.id !== entity.id) {
          try { bot.pvp.stop(); } catch (_) {}
        }
        equipArmor(); // wear best armor before engaging
        bot.pvp.attack(entity);
        state.lastCombatTarget = entity;
        log.info(`Wolf mode: attacking ${entity.name || entity.type} (owner hit it)`);
      } else {
        // Swing hasn't arrived yet — save hurt entity, entitySwingArm will pick it up
        if (!state.recentHurts) state.recentHurts = [];
        state.recentHurts = state.recentHurts.filter((h) => now - h.time < 3000).slice(-5);
        state.recentHurts.push({ entity, time: now });
        log.info(`Wolf: mob hurt, no swing yet — buffered for retroactive attack`);
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
      try { if (bot.pathfinder && bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch (_) { }
      try { if (bot.pvp && bot.pvp.target) bot.pvp.stop(); } catch (_) { }
      for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
        try { bot.setControlState(key, false); } catch (_) { }
      }

      // Immediately start fleeing — don't wait for the next 200ms priority tick
      try {
        const fromPos = candidate.pos;
        const botPos = bot.entity.position;
        let fdx = botPos.x - fromPos.x;
        let fdz = botPos.z - fromPos.z;
        const fdist = Math.sqrt(fdx * fdx + fdz * fdz);
        if (fdist < 0.5) { const a = Math.random() * Math.PI * 2; fdx = Math.cos(a); fdz = Math.sin(a); }
        else { fdx /= fdist; fdz /= fdist; }
        bot.look(Math.atan2(-fdx, -fdz), 0, true);
        bot.setControlState('forward', true);
      } catch (_) { }

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
      state.lastCombatTarget = target;
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
