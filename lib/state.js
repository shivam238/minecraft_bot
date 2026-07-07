const Priorities = {
  VOID_ESCAPE: 0,        // Highest — bot is actively falling into void
  EMERGENCY_SURVIVAL: 1, // Health critically low
  CREEPER_ESCAPE: 2,
  PANICKING: 2.5,        // Owner hit the bot — flee like a villager
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

// Reconnect delays to avoid rapid retry loops while reconnecting.
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
  panicActive: false,
  panicEndTime: 0,
  panicFromPos: null,     // world position to flee from
  panicFromName: null,    // who triggered the panic
  lastPanicChatTime: 0,
  lastPanicActionTime: 0, // separate from lastEmergencyActionTime to avoid cross-priority interference
  recentSwingers: [],     // [{ entityId, username, pos, time }] — for attacker attribution
  autoSleepCooldown: 0,  // timestamp — don't attempt auto-sleep until after this
  lastMemoryUpdateTime: 0,
  lastAFKActionType: null,
  afkSpeedMultiplier: 1.0, // 0.5 = slow, 1.0 = normal, 2.0 = fast
  temporaryLeaveActive: false,
  lastTemporaryLeaveTime: 0,
  playerSleepCheckInterval: null,
  entityUpdateSleepHandler: null,
  priorityManagerInterval: null,
  homePosition: null,  // saved on first spawn — bot drifts back here when too far
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
