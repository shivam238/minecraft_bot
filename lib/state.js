const Priorities = {
  EMERGENCY_SURVIVAL: 1,
  CREEPER_ESCAPE: 2,
  COMBAT: 3,
  SLEEPING: 4,
  FOLLOWING: 5,
  GUARDING: 6,
  AFK: 7,
  IDLE: 8,
};

const hostileMobs = [
  'zombie',
  'skeleton',
  'spider',
  'zombie_villager',
  'husk',
  'stray',
  'drowned',
  'witch',
  'phantom',
];

// Aternos takes 3-5 min to cold-start. Delays ramp up to 5 min so we don't spam.
const RECONNECT_DELAYS = [15000, 30000, 60000, 120000, 180000, 300000];

const state = {
  lifecycle: 'stopped', // stopped | running | reconnecting
  bot: null,
  botState: 'afk',
  guardPosition: null,
  followTarget: null,
  currentPriority: Priorities.IDLE,
  loggedIn: false,
  lastSuccessfulLoginTime: 0,
  isIntentionalDisconnect: false,
  disconnectInProgress: false,
  reconnectAttempt: 0,
  isReconnecting: false,
  reconnectTimeout: null,
  smartAFKInterval: null,
  chatInterval: null,
  keepAliveInterval: null,
  lastServerActivityTime: 0,
  sleepGoalReachedListener: null,
  lastCreeperEscapeTime: 0,
  lastEmergencyActionTime: 0,
  lastMemoryUpdateTime: 0,
  lastAFKActionType: null,
  afkSpeedMultiplier: 1.0, // 0.5 = slow, 1.0 = normal, 2.0 = fast
  temporaryLeaveActive: false,
  lastTemporaryLeaveTime: 0,
  playerSleepCheckInterval: null,
  entityUpdateSleepHandler: null,
  priorityManagerInterval: null,
  memory: {
    lastAFKActions: [],
    recentPositions: [],
    recentTargetEntities: [],
  },
};

function getPriorityName(p) {
  for (const [key, value] of Object.entries(Priorities)) {
    if (value === p) return key;
  }
  return 'UNKNOWN';
}

module.exports = {
  Priorities,
  hostileMobs,
  RECONNECT_DELAYS,
  state,
  getPriorityName,
};
