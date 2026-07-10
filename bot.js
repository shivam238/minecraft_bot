// ==========================================================
//  Lightweight Minecraft AFK Bot (mineflayer based)
//  - Connects to your server
//  - Randomly walks / jumps / looks around so it doesn't
//    sit perfectly still
//  - Auto-reconnects if kicked or disconnected
//  - Tuned to run inside very small resource caps
//    (e.g. 128 MiB RAM / 25% CPU containers)
// ==========================================================

const mineflayer = require('mineflayer');

// ---------- Config: seedha yahan apni values daalo ----------
const HOST = 'your-server.address.here';   // server ka address
const PORT = 25565;                        // server ka port
const USERNAME = 'AFKBot';                 // bot ka in-game naam
const VERSION = false;                     // e.g. '1.20.4', ya false auto-detect ke liye
const RECONNECT_DELAY_MS = 10_000;                       // wait before reconnecting
const MIN_ACTION_INTERVAL = 8_000;                        // min ms between random actions
const MAX_ACTION_INTERVAL = 20_000;                       // max ms between random actions

let bot;
let actionTimer;

function createBot() {
  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    hideErrors: true,          // don't dump big stack traces (saves CPU/log spam)
    checkTimeoutInterval: 60_000,
  });

  bot.on('spawn', () => {
    console.log(`[+] Bot spawned and connected to ${HOST}:${PORT}`);
    scheduleNextAction();
  });

  bot.on('kicked', (reason) => {
    console.log('[!] Kicked from server:', reason);
  });

  bot.on('error', (err) => {
    console.log('[!] Connection error:', err.message);
  });

  bot.on('end', () => {
    console.log(`[!] Disconnected. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    clearTimeout(actionTimer);
    setTimeout(createBot, RECONNECT_DELAY_MS);
  });
}

// Random light movement so the bot doesn't stand perfectly frozen.
function scheduleNextAction() {
  const delay =
    MIN_ACTION_INTERVAL +
    Math.random() * (MAX_ACTION_INTERVAL - MIN_ACTION_INTERVAL);

  actionTimer = setTimeout(() => {
    doRandomAction();
    scheduleNextAction();
  }, delay);
}

function doRandomAction() {
  if (!bot || !bot.entity) return;

  const actions = ['jump', 'turn', 'walk'];
  const choice = actions[Math.floor(Math.random() * actions.length)];

  try {
    if (choice === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
    } else if (choice === 'turn') {
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * 0.5;
      bot.look(yaw, pitch, true);
    } else if (choice === 'walk') {
      const dir = Math.random() < 0.5 ? 'forward' : 'back';
      bot.setControlState(dir, true);
      setTimeout(() => bot.setControlState(dir, false), 800);
    }
  } catch (e) {
    console.log('[!] Action failed:', e.message);
  }
}

createBot();
