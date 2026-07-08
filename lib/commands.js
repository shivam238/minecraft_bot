const { goals } = require('mineflayer-pathfinder');
const { state } = require('./state');
const { getConfig, saveConfig } = require('./config');
const { stopCurrentTasks } = require('./lifecycle');
const { scheduleNextAFK } = require('./behaviors');
const { safeSetGoal } = require('./pathfinding');
const { walkToBedAndSleep, wakeUp, findNearbyBed } = require('./sleep');
const { findNearbyChest, depositToChest } = require('./storage');
const log = require('./logger');

async function executeIntent(intent, parameters, senderUsername) {
  const bot = state.bot;
  if (!bot) return;

  switch (intent) {
    case 'follow': {
      const target = parameters.target || senderUsername;
      stopCurrentTasks();
      state.botState = 'following';
      state.followTarget = target;
      log.ok(`AI follow: ${target}`);
      break;
    }
    case 'guard':
      stopCurrentTasks();
      state.botState = 'guard';
      state.guardPosition = bot.entity.position.clone();
      log.ok('AI guard at current position');
      break;
    case 'afk':
      stopCurrentTasks();
      state.botState = 'afk';
      log.ok('AI smart AFK mode enabled');
      break;
    case 'stop':
      stopCurrentTasks();
      state.botState = 'idle';
      log.ok('AI stopped all tasks');
      break;
    case 'goto': {
      const coords = parameters.coordinates;
      if (coords && !isNaN(coords.x) && !isNaN(coords.y) && !isNaN(coords.z)) {
        stopCurrentTasks();
        state.botState = 'idle';
        log.ok(`AI goto ${coords.x}, ${coords.y}, ${coords.z}`);
        safeSetGoal(new goals.GoalBlock(coords.x, coords.y, coords.z));
      }
      break;
    }
    case 'sleep':
      stopCurrentTasks();
      state.botState = 'sleeping';
      walkToBedAndSleep({
        onSuccess: () => log.ok('AI sleep completed'),
        onFail: (reason) => {
          log.fail(`AI sleep failed (${reason})`);
          state.botState = 'afk';
        },
        onNoBed: () => {
          log.fail('AI sleep: no bed found');
          state.botState = 'afk';
        },
        onNavFail: () => {
          log.fail('AI sleep: navigation failed');
          state.botState = 'afk';
        },
      });
      break;
    case 'wake': {
      const result = await wakeUp();
      if (result.success) state.botState = 'afk';
      break;
    }
    case 'drop': {
      const invItems = bot.inventory.items();
      for (const item of invItems) {
        try {
          await bot.tossStack(item);
        } catch (err) {
          log.fail(`Failed to drop ${item.name}`, err);
        }
      }
      log.ok(`AI dropped ${invItems.length} item stack(s)`);
      break;
    }
    case 'tpa':
      bot.chat(`/tpa ${parameters.target || senderUsername}`);
      log.ok(`AI tpa to ${parameters.target || senderUsername}`);
      break;
    case 'accept':
      bot.chat('/tpaccept');
      log.ok('AI accepted teleport');
      break;
    case 'status':
      sendStatus(bot);
      break;
    default:
      break;
  }
}

function sendStatus(bot) {
  const pos = bot.entity.position;
  const items = bot.inventory.items();
  const invSummary = items.map((i) => `${i.count}x ${i.name}`).join(', ') || 'empty';
  bot.chat(
    `❤️ HP: ${bot.health}/20 | 🍖 Food: ${bot.food}/20 | 📍 Pos: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | State: ${state.botState}`
  );
  const invText = `Inventory: ${invSummary}`;
  bot.chat(invText.length > 100 ? `${invText.substring(0, 97)}...` : invText);
}

async function handleOwnerCommand(username, message, aiManager, lifecycleApi) {
  const bot = state.bot;
  const config = getConfig();
  if (!bot || !bot.entity) return;

  if (!message.startsWith('!')) return false;

  const args = message.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  log.info(`Owner command: ${username} -> !${command} ${args.join(' ')}`);

  switch (command) {
    case 'help':
      bot.chat(
        'Commands: !status !follow(!come) !guard !afk !reset !stop !goto x y z !sleep !wake !drop !store(!chest) !tpa [name] !accept !say [msg] !speed slow|normal|fast|turbo !polite !addowner [name] !removeowner [name] !shutdown'
      );
      return true;

    case 'status':
      sendStatus(bot);
      return true;

    case 'come':
    case 'follow':
      stopCurrentTasks();
      state.botState = 'following';
      state.followTarget = username;
      bot.chat(`🏃 Following ${username}`);
      log.ok(`Follow started: ${username}`);
      return true;

    case 'guard':
      stopCurrentTasks();
      state.botState = 'guard';
      state.guardPosition = bot.entity.position.clone();
      bot.chat(
        `🛡️ Guarding here: ${Math.round(state.guardPosition.x)}, ${Math.round(state.guardPosition.y)}, ${Math.round(state.guardPosition.z)}`
      );
      log.ok('Guard mode enabled');
      return true;

    case 'afk':
      stopCurrentTasks();
      state.botState = 'afk';
      scheduleNextAFK(true);
      bot.chat('🤖 Smart AFK Mode ON.');
      log.ok('AFK mode enabled');
      return true;

    case 'polite':
      state.politeMode = !state.politeMode;
      if (state.politeMode) {
        // Stop any active PVP against players immediately
        if (bot.pvp && bot.pvp.target && bot.pvp.target.type === 'player') {
          bot.pvp.stop();
        }
        bot.chat('😇 Polite mode ON — I won\'t attack any player!');
        log.ok('Polite mode enabled');
      } else {
        bot.chat('⚔️ Polite mode OFF — PVP mode re-enabled!');
        log.ok('Polite mode disabled');
      }
      return true;

    case 'reset':
      stopCurrentTasks();
      state.politeMode = false;
      state.botState = 'afk';
      scheduleNextAFK(true);
      bot.chat(`🔄 Reset! AFK mode restarted (speed: ${state.afkSpeedMultiplier}x). Polite mode cleared.`);
      log.ok('AFK reset by owner (polite mode cleared)');
      return true;

    case 'speed': {
      const preset = (args[0] || '').toLowerCase();
      const presets = { slow: 0.5, normal: 1.0, fast: 2.0, turbo: 3.0 };
      if (!presets[preset]) {
        bot.chat('Usage: !speed slow | normal | fast | turbo');
        return true;
      }
      state.afkSpeedMultiplier = presets[preset];
      bot.chat(`⚡ AFK speed set to ${preset} (${state.afkSpeedMultiplier}x). Use !reset to apply now.`);
      log.ok(`AFK speed set to ${preset} (${state.afkSpeedMultiplier}x)`);
      return true;
    }

    case 'stop':
      stopCurrentTasks();
      state.botState = 'idle';
      bot.chat('🛑 Stood still. Stopped all tasks.');
      log.ok('All tasks stopped');
      return true;

    case 'store':
    case 'chest': {
      const nearChest = findNearbyChest(bot, 20);
      if (!nearChest) {
        bot.chat('❌ Koi chest nahi mila 20 blocks mein.');
        return true;
      }
      bot.chat('📦 Samaan chest mein rakh raha hoon...');
      stopCurrentTasks();
      const prevState = state.botState;
      state.botState = 'idle';
      depositToChest(bot, nearChest).then(result => {
        if (result.deposited > 0) {
          bot.chat(`✅ ${result.deposited} items chest mein rakh diye!`);
        } else {
          bot.chat(`❌ Kuch nahi rakha (${result.reason || 'unknown'})`);
        }
        state.botState = prevState;
        if (prevState === 'afk') scheduleNextAFK(true);
      }).catch(err => {
        log.fail('store command', err);
        state.botState = prevState;
      });
      return true;
    }

    case 'shutdown':
      bot.chat('🛑 Shutting down bot. Use console "start" or !start after restart to reconnect.');
      log.ok('Shutdown requested by owner');
      lifecycleApi.stop('owner command');
      return true;

    case 'start':
      if (lifecycleApi.isRunning()) {
        bot.chat('ℹ️ Bot is already running.');
      } else {
        bot.chat('ℹ️ Start must be issued from the console when the bot is disconnected.');
      }
      return true;

    case 'goto': {
      const x = parseFloat(args[0]);
      const y = parseFloat(args[1]);
      const z = parseFloat(args[2]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        stopCurrentTasks();
        state.botState = 'idle';
        bot.chat(`🧭 Moving to: ${x}, ${y}, ${z}`);
        const ok = safeSetGoal(new goals.GoalBlock(x, y, z));
        log.action('goto', `${x}, ${y}, ${z}`, ok);
      } else {
        bot.chat('Usage: !goto <x> <y> <z>');
      }
      return true;
    }

    case 'sleep': {
      const bed = findNearbyBed(40);
      if (!bed) {
        bot.chat('❌ No bed found within 40 blocks.');
        log.fail('Sleep: no bed found');
        return true;
      }
      bot.chat('🛌 Walking to bed...');
      stopCurrentTasks();
      state.botState = 'sleeping';
      walkToBedAndSleep({
        bed,
        onSuccess: () => bot.chat('💤 Sleeping...'),
        onFail: (reason) => {
          bot.chat(`❌ Cannot sleep: ${reason}`);
          state.botState = 'afk';
        },
        onNavFail: () => {
          bot.chat('❌ Cannot navigate to bed.');
          state.botState = 'afk';
        },
      });
      return true;
    }

    case 'wake': {
      if (!bot.isSleeping) {
        bot.chat("❌ I'm not sleeping.");
        return true;
      }
      const result = await wakeUp();
      if (result.success) {
        bot.chat('☀️ Woke up.');
        state.botState = 'afk';
      } else {
        bot.chat(`❌ Cannot wake up: ${result.reason}`);
      }
      return true;
    }

    case 'drop': {
      const invItems = bot.inventory.items();
      if (invItems.length === 0) {
        bot.chat('Inventory empty.');
        return true;
      }
      bot.chat(`Dropping ${invItems.length} items...`);
      for (const item of invItems) {
        try {
          await bot.tossStack(item);
        } catch (err) {
          log.fail(`Failed to drop ${item.name}`, err);
        }
      }
      log.ok(`Dropped ${invItems.length} item stack(s)`);
      return true;
    }

    case 'say':
      if (args.length > 0) bot.chat(args.join(' '));
      return true;

    case 'tpa': {
      const tpaPlayer = args[0] || username;
      bot.chat(`/tpa ${tpaPlayer}`);
      bot.chat(`Sent teleport request to ${tpaPlayer}`);
      log.ok(`TPA sent to ${tpaPlayer}`);
      return true;
    }

    case 'accept':
      bot.chat('/tpaccept');
      bot.chat('Accepted teleport request.');
      log.ok('Teleport accepted');
      return true;

    case 'addowner': {
      const newOwner = args[0];
      if (newOwner && !config.owners.includes(newOwner)) {
        config.owners.push(newOwner);
        saveConfig();
        bot.chat(`Added ${newOwner} to owners.`);
        log.ok(`Owner added: ${newOwner}`);
      } else {
        bot.chat('Invalid owner or already present.');
      }
      return true;
    }

    case 'removeowner': {
      const removeName = args[0];
      if (!removeName) return true;
      const idx = config.owners.indexOf(removeName);
      if (idx > -1) {
        config.owners.splice(idx, 1);
        saveConfig();
        bot.chat(`Removed ${removeName} from owners.`);
        log.ok(`Owner removed: ${removeName}`);
      } else {
        bot.chat(`${removeName} is not an owner.`);
      }
      return true;
    }

    default:
      bot.chat('Unknown command. Type !help.');
      return true;
  }
}

// Regex patterns that detect "who made / created you" in English + Hindi/Hinglish.
// Tested against: "kisne banaya", "tumhe kisne banaya", "who made you",
// "who is your developer", "aapko kisne bnaya", "bana kaun ne", etc.
const CREATOR_PATTERNS = [
  /kisne\s+b[an]+[ay]+a/i,          // kisne banaya / bnaya / banya
  /b[an]+[ay]+a\s+kisne/i,          // banaya kisne
  /tumh[ae]\s+kisne/i,              // tumhe kisne / tumha kisne
  /aapko\s+kisne/i,                 // aapko kisne
  /kaun\s+(ne\s+)?bana/i,           // kaun ne banaya / kaun bana
  /who\s+(made|created|built)\s+you/i,
  /who\s+is\s+your\s+(creator|developer|maker|owner|author)/i,
  /your\s+(creator|developer|maker|author)/i,
  /tumhara\s+(creator|developer|maker|banaane\s+wala)/i,
  /banane\s+wala/i,
];

function isCreatorQuestion(msg) {
  return CREATOR_PATTERNS.some(re => re.test(msg));
}

async function handleChat(username, message, aiManager, lifecycleApi) {
  const config = getConfig();
  const bot = state.bot;
  if (!bot) return;

  const msgLower = message.toLowerCase();

  // Creator question — anyone can ask, bot name mention not required
  if (isCreatorQuestion(msgLower)) {
    bot.chat('Shivam Kumar Mahto ne banaya hai mujhe :)');
    return;
  }

  // Everything else is owner-only
  if (!config.owners.includes(username)) return;

  // ! commands handled separately
  if (message.startsWith('!')) {
    await handleOwnerCommand(username, message, aiManager, lifecycleApi);
    return;
  }

  // Only respond when the bot's name is mentioned in the message
  const botName = (config.username || 'LazyBoy').toLowerCase();
  if (!msgLower.includes(botName)) return;
  try {
    const result = await aiManager.processMessage(
      bot,
      state.botState,
      state.followTarget,
      state.guardPosition,
      username,
      message
    );
    if (result.response) {
      // Minecraft disconnects the bot if a chat message exceeds 256 chars — hard cap here
      const safe = result.response.slice(0, 250);
      bot.chat(safe);
    }
    if (result.intent && result.intent !== 'none' && result.intent !== 'say') {
      log.info(`AI intent: ${result.intent}`);
      await executeIntent(result.intent, result.parameters || {}, username);
    }
  } catch (err) {
    log.fail('AI chat processing', err);
    bot.chat('AI error, use !help for commands');
  }
}

module.exports = {
  executeIntent,
  handleChat,
  handleOwnerCommand,
};
