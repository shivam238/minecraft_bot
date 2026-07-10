require('dotenv').config();

const { spawnSync, spawn } = require('child_process');
const readline = require('readline');

// ---------------------------------------------------------------------------
// keep_alive — starts keep_alive.py (Flask on :8080) so UptimeRobot can ping
// ---------------------------------------------------------------------------
let keepAliveChild = null;
const KEEP_ALIVE_MAX_RESTARTS = 3;
let keepAliveRestarts = 0;

function spawnKeepAlive() {
  const child = spawn('python3', ['keep_alive.py'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => {
    const msg = d.toString();
    // suppress Flask's routine dev-server noise
    if (!msg.includes('WARNING') && !msg.includes('Press CTRL+C')) {
      process.stderr.write(msg);
    }
  });

  // Non-fatal: if python3 can't be spawned, log and continue without keep-alive
  child.on('error', (err) => {
    console.warn(`[keep_alive] Failed to spawn python3: ${err.message} — bot continues without keep-alive.`);
    keepAliveChild = null;
  });

  child.on('exit', (code, signal) => {
    keepAliveChild = null;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // intentional shutdown
    console.warn(`[keep_alive] process exited (code=${code}) — keep-alive is offline.`);
    // One-shot bounded restart to survive transient failures
    if (keepAliveRestarts < KEEP_ALIVE_MAX_RESTARTS) {
      keepAliveRestarts++;
      const delay = keepAliveRestarts * 5000;
      console.warn(`[keep_alive] Restarting in ${delay / 1000}s (attempt ${keepAliveRestarts}/${KEEP_ALIVE_MAX_RESTARTS})...`);
      setTimeout(() => { keepAliveChild = spawnKeepAlive(); }, delay);
    } else {
      console.warn('[keep_alive] Max restarts reached — running without keep-alive until next bot restart.');
    }
  });

  return child;
}

function startKeepAlive() {
  keepAliveChild = spawnKeepAlive();
  return keepAliveChild;
}

function stopKeepAlive() {
  if (keepAliveChild) {
    keepAliveChild.kill('SIGTERM');
    keepAliveChild = null;
  }
}
const AIManager = require('./ai/AIManager');
const { loadConfig, getConfig } = require('./lib/config');
const { buildLifecycleApi } = require('./lib/botFactory');
const { initReconnect, startBot, stopBot, isRunning } = require('./lib/lifecycle');
const { state } = require('./lib/state');
const log = require('./lib/logger');

let aiManager;

function printLifecycleHelp() {
  console.log('');
  console.log('Lifecycle commands (console):');
  console.log('  start   — connect and run the bot');
  console.log('  stop    — fully stop (clears timers, disconnects, no reconnect)');
  console.log('  status  — show lifecycle and connection state');
  console.log('  help    — show this help');
  console.log('');
  console.log('In-game owner command: !shutdown — full stop while connected');
  console.log('');
}

function printStatus() {
  const config = getConfig();
  const connected = state.bot && state.loggedIn;
  console.log(`Lifecycle: ${state.lifecycle}`);
  console.log(`Connected: ${connected ? 'yes' : 'no'}`);
  console.log(`Bot state: ${state.botState}`);
  console.log(`Server: ${config.host}:${config.port}`);
  console.log(`Username: ${config.username}`);
  console.log(`Reconnect attempt: ${state.reconnectAttempt}`);
}

function setupConsole(lifecycleApi) {
  // On Railway/headless environments stdin is not a TTY — skip interactive console
  if (!process.stdin.isTTY) {
    log.info('No TTY detected (Railway/headless) — console input disabled.');
    return null;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  printLifecycleHelp();

  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    switch (cmd) {
      case 'start':
        if (lifecycleApi.start()) log.ok('Start command succeeded');
        else log.info('Start command had no effect');
        break;
      case 'stop':
        if (lifecycleApi.stop('console')) log.ok('Stop command succeeded');
        else log.info('Stop command had no effect');
        break;
      case 'status':
        printStatus();
        break;
      case 'help':
        printLifecycleHelp();
        break;
      case '':
        break;
      default:
        log.warn(`Unknown console command: ${cmd}. Type "help".`);
    }
  });

  // Prevent stdin close from killing the process on headless envs
  rl.on('close', () => {
    log.info('Console readline closed — bot continues running.');
  });

  return rl;
}

function setupSignalHandlers(lifecycleApi, rl) {
  const shutdown = (signal) => {
    log.info(`${signal} received — stopping bot gracefully`);
    lifecycleApi.stop(signal);
    stopKeepAlive();
    if (rl) rl.close();
    // Give bot 2s to cleanly disconnect before exiting
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function setupGlobalErrorGuards() {
  // Prevent any uncaught error from crashing the Railway process
  process.on('uncaughtException', (err) => {
    log.fail('Uncaught exception (bot continues)', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.warn(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`);
  });
}

function main() {
  // Catch-all guards — must be first
  setupGlobalErrorGuards();

  // Start Flask keep-alive server so UptimeRobot can prevent free-tier sleep
  startKeepAlive();

  loadConfig((config) => {
    if (aiManager) aiManager.updateConfig(config);
  });

  aiManager = new AIManager(getConfig());
  const { createBot, lifecycleApi } = buildLifecycleApi(aiManager);

  initReconnect(createBot, getConfig);
  const rl = setupConsole(lifecycleApi);
  setupSignalHandlers(lifecycleApi, rl);

  log.info('Minecraft bot ready. Auto-starting...');
  startBot(createBot, aiManager);
}

main();

