require('dotenv').config();

const readline = require('readline');
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

  return rl;
}

function setupSignalHandlers(lifecycleApi, rl) {
  const shutdown = (signal) => {
    log.info(`${signal} received — stopping bot`);
    lifecycleApi.stop(signal);
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function main() {
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
