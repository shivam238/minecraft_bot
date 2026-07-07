const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');

const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 25565,
  username: 'LazyBoy',
  owners: ['darkeeidea'],
  randomChatEnabled: false,
  followMaxDistance: 30,
  creeperAvoidDistance: 8,
  autoSleep: true,
  autoDefense: true,
  keepAliveIntervalMs: 75000,
  maxIdleBeforeKeepAliveMs: 120000,
  ai: {
    enabled: false,
    apiKey: '',
    primaryModel: 'google/gemini-2.5-flash',
    fallbackModel: 'meta-llama/llama-3-8b-instruct:free',
    timeoutMs: 8000,
    cacheTTL: 10000,
    cacheMaxSize: 50,
    rateLimitMaxRequests: 5,
    rateLimitWindowMs: 60000,
    temperature: 0.7,
    maxTokens: 300,
    cacheCleanupIntervalMs: 30000,
  },
};

let config = { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai } };

function deepMerge(target, source) {
  if (Array.isArray(source)) return source.slice();
  if (source && typeof source === 'object') {
    const output = Array.isArray(target) ? [] : { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        output[key] &&
        typeof output[key] === 'object' &&
        !Array.isArray(output[key])
      ) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    }
    return output;
  }
  return source;
}

function sanitizeConfig(raw) {
  const c = deepMerge(DEFAULT_CONFIG, raw);
  c.host = typeof c.host === 'string' ? c.host : DEFAULT_CONFIG.host;
  c.port = Number(c.port) || DEFAULT_CONFIG.port;
  c.username =
    typeof c.username === 'string' && c.username.trim() !== ''
      ? c.username
      : DEFAULT_CONFIG.username;
  c.owners = Array.isArray(c.owners) ? c.owners : [...DEFAULT_CONFIG.owners];
  c.randomChatEnabled = !!c.randomChatEnabled;
  c.followMaxDistance = Number(c.followMaxDistance) || DEFAULT_CONFIG.followMaxDistance;
  c.creeperAvoidDistance = Number(c.creeperAvoidDistance) || DEFAULT_CONFIG.creeperAvoidDistance;
  c.autoSleep = !!c.autoSleep;
  c.autoDefense = !!c.autoDefense;
  c.keepAliveIntervalMs = Number(c.keepAliveIntervalMs) || DEFAULT_CONFIG.keepAliveIntervalMs;
  c.maxIdleBeforeKeepAliveMs =
    Number(c.maxIdleBeforeKeepAliveMs) || DEFAULT_CONFIG.maxIdleBeforeKeepAliveMs;

  c.ai = typeof c.ai === 'object' && c.ai ? c.ai : { ...DEFAULT_CONFIG.ai };
  c.ai.enabled = !!c.ai.enabled;
  c.ai.apiKey = typeof c.ai.apiKey === 'string' ? c.ai.apiKey : '';
  c.ai.primaryModel =
    typeof c.ai.primaryModel === 'string' && c.ai.primaryModel.trim() !== ''
      ? c.ai.primaryModel
      : DEFAULT_CONFIG.ai.primaryModel;
  c.ai.fallbackModel =
    typeof c.ai.fallbackModel === 'string' && c.ai.fallbackModel.trim() !== ''
      ? c.ai.fallbackModel
      : DEFAULT_CONFIG.ai.fallbackModel;
  c.ai.timeoutMs = Number(c.ai.timeoutMs) || DEFAULT_CONFIG.ai.timeoutMs;
  c.ai.cacheTTL = Number(c.ai.cacheTTL) || DEFAULT_CONFIG.ai.cacheTTL;
  c.ai.cacheMaxSize = Number(c.ai.cacheMaxSize) || DEFAULT_CONFIG.ai.cacheMaxSize;
  c.ai.rateLimitMaxRequests =
    Number(c.ai.rateLimitMaxRequests) || DEFAULT_CONFIG.ai.rateLimitMaxRequests;
  c.ai.rateLimitWindowMs =
    Number(c.ai.rateLimitWindowMs) || DEFAULT_CONFIG.ai.rateLimitWindowMs;
  c.ai.temperature =
    typeof c.ai.temperature === 'number' ? c.ai.temperature : DEFAULT_CONFIG.ai.temperature;
  c.ai.maxTokens = Number(c.ai.maxTokens) || DEFAULT_CONFIG.ai.maxTokens;
  c.ai.cacheCleanupIntervalMs =
    Number(c.ai.cacheCleanupIntervalMs) || DEFAULT_CONFIG.ai.cacheCleanupIntervalMs;

  return c;
}

function loadConfig(onUpdate) {
  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, 'utf8').trim();
      if (fileContent === '') {
        config = sanitizeConfig({});
        saveConfig();
        console.log('📝 Empty configuration file. Restored default values.');
      } else {
        config = sanitizeConfig(JSON.parse(fileContent));
        if (onUpdate) onUpdate(config);
        console.log('📂 Configuration loaded successfully.');
      }
    } else {
      config = sanitizeConfig({});
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('📝 Created default config.json.');
    }
  } catch (err) {
    console.error('❌ Error loading config (corrupted file). Re-writing defaults:', err.message);
    config = sanitizeConfig({});
    saveConfig();
  }
  return config;
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('💾 Configuration saved successfully.');
    return true;
  } catch (err) {
    console.error('❌ Error saving config:', err.message);
    return false;
  }
}

function getConfig() {
  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  getConfig,
  setConfig: (next) => {
    config = next;
  },
};
