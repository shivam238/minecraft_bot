require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const autoeat = require('mineflayer-auto-eat').plugin || require('mineflayer-auto-eat').loader;
const fs = require('fs');
const path = require('path');
const vec3 = require('vec3');
const AIManager = require('./ai/AIManager');

const configPath = path.join(__dirname, 'config.json');

// Default Config Structure
let config = {
  host: "SHIBU2.aternos.me",
  port: 25565,
  username: "LazyBoy",
  owners: ["darkeeidea"],
  randomChatEnabled: false,
  followMaxDistance: 30,
  afkRadius: 2,
  creeperAvoidDistance: 8,
  autoSleep: true,
  autoDefense: true,
  ai: {
    enabled: false,
    apiKey: "",
    primaryModel: "google/gemini-2.5-flash",
    fallbackModel: "meta-llama/llama-3-8b-instruct:free",
    timeoutMs: 8000,
    cacheTTL: 10000,
    cacheMaxSize: 50,
    rateLimitMaxRequests: 5,
    rateLimitWindowMs: 60000,
    temperature: 0.7,
    maxTokens: 300,
    cacheCleanupIntervalMs: 30000
  }
};

let aiManager;
let isSaving = false;

// Load persistent configuration with structure validation/repair
function loadConfig() {
  const defaultConfig = {
    host: "SHIBU2.aternos.me",
    port: 25565,
    username: "LazyBoy",
    owners: ["darkeeidea"],
    randomChatEnabled: false,
    followMaxDistance: 30,
    afkRadius: 2,
    creeperAvoidDistance: 8,
    autoSleep: true,
    autoDefense: true,
    ai: {
      enabled: false,
      apiKey: "",
      primaryModel: "google/gemini-2.5-flash",
      fallbackModel: "meta-llama/llama-3-8b-instruct:free",
      timeoutMs: 8000,
      cacheTTL: 10000,
      cacheMaxSize: 50,
      rateLimitMaxRequests: 5,
      rateLimitWindowMs: 60000,
      temperature: 0.7,
      maxTokens: 300,
      cacheCleanupIntervalMs: 30000
    }
  };

  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, 'utf8').trim();
      if (fileContent === "") {
        config = { ...defaultConfig };
        saveConfig();
        console.log("📝 Empty configuration file. Restored default values.");
      } else {
        const parsed = JSON.parse(fileContent);
        // Merge loaded config with default config to ensure all required fields are present
        config = { ...defaultConfig, ...parsed };

        // Validate and sanitize config values
        config.host = typeof config.host === 'string' ? config.host : "SHIBU2.aternos.me";
        config.port = Number(config.port) || 25565;
        config.username = typeof config.username === 'string' && config.username.trim() !== "" ? config.username : "LazyBoy";
        config.owners = Array.isArray(config.owners) ? config.owners : ["darkeeidea"];
        config.randomChatEnabled = !!config.randomChatEnabled;
        config.followMaxDistance = Number(config.followMaxDistance) || 30;
        config.afkRadius = Number(config.afkRadius) || 2;
        config.creeperAvoidDistance = Number(config.creeperAvoidDistance) || 8;
        config.autoSleep = !!config.autoSleep;
        config.autoDefense = !!config.autoDefense;

        // AI specific config validation
        config.ai = typeof config.ai === 'object' ? config.ai : {};
        config.ai.enabled = !!config.ai.enabled;
        config.ai.apiKey = typeof config.ai.apiKey === 'string' ? config.ai.apiKey : "";
        config.ai.primaryModel = typeof config.ai.primaryModel === 'string' && config.ai.primaryModel.trim() !== "" ? config.ai.primaryModel : "google/gemini-2.5-flash";
        config.ai.fallbackModel = typeof config.ai.fallbackModel === 'string' && config.ai.fallbackModel.trim() !== "" ? config.ai.fallbackModel : "meta-llama/llama-3-8b-instruct:free";
        config.ai.timeoutMs = Number(config.ai.timeoutMs) || 8000;
        config.ai.cacheTTL = Number(config.ai.cacheTTL) || 10000;
        config.ai.cacheMaxSize = Number(config.ai.cacheMaxSize) || 50;
        config.ai.rateLimitMaxRequests = Number(config.ai.rateLimitMaxRequests) || 5;
        config.ai.rateLimitWindowMs = Number(config.ai.rateLimitWindowMs) || 60000;
        config.ai.temperature = typeof config.ai.temperature === 'number' ? config.ai.temperature : 0.7;
        config.ai.maxTokens = Number(config.ai.maxTokens) || 300;
        config.ai.cacheCleanupIntervalMs = Number(config.ai.cacheCleanupIntervalMs) || 30000;

        if (aiManager) {
          aiManager.updateConfig(config);
        }

        console.log("📂 Configuration loaded successfully.");
      }
    } else {
      config = { ...defaultConfig };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log("📝 Created default config.json.");
    }
  } catch (err) {
    console.error("❌ Error loading config (corrupted file). Re-writing defaults:", err);
    config = { ...defaultConfig };
    saveConfig();
  }
}

// Save persistent configuration
function saveConfig() {
  try {
    isSaving = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("💾 Configuration saved successfully.");
    // Reset isSaving after a short delay
    setTimeout(() => { isSaving = false; }, 500);
  } catch (err) {
    console.error("❌ Error saving config:", err);
    isSaving = false;
  }
}

// Load config immediately
loadConfig();

// Initialize AI Manager
aiManager = new AIManager(config);

const authPassword = process.env.PASSWORD || ""; // Securely loaded via environment variable

// Priorities Scale (1 = highest, 8 = lowest)
const Priorities = {
  EMERGENCY_SURVIVAL: 1,
  CREEPER_ESCAPE: 2,
  COMBAT: 3,
  SLEEPING: 4,
  FOLLOWING: 5,
  GUARDING: 6,
  AFK: 7,
  IDLE: 8
};

// Memory System
const memory = {
  lastAFKActions: [],       // Array of strings (last 5 AFK actions)
  recentPositions: [],      // Array of Vec3 objects (last 8 safe positions)
  lastLookedDirection: null, // { yaw, pitch }
  recentTargetEntities: [], // Array of entity IDs (last 5 looked-at entities)
  lastCombatTarget: null     // Entity ID or name of last target
};

// Bot State
let botState = 'afk'; // States: 'idle', 'afk', 'following', 'guard'
let guardPosition = null;
let followTarget = null;
let bot;
let currentPriority = Priorities.IDLE;

// State control variables
let lastCreeperEscapePos = null;
let lastCreeperEscapeTime = 0;
let lastEmergencyActionTime = 0;
let lastMemoryUpdateTime = 0;
let lastAFKActionType = null;

// Hostile mobs to target in combat
const hostileMobs = [
  'zombie', 'skeleton', 'spider', 'zombie_villager', 'husk', 
  'stray', 'drowned', 'witch', 'phantom'
];

// Global Interval and Listener references to prevent leaks/duplicates
let smartAFKInterval = null;
let chatInterval = null;
let priorityManagerInterval = null;
let sleepCheckInterval = null;
let autoDefenseInterval = null;
let reconnectTimeout = null;
let sleepGoalReachedListener = null;

function clearAllIntervals() {
  if (smartAFKInterval) { clearTimeout(smartAFKInterval); smartAFKInterval = null; }
  if (chatInterval) { clearInterval(chatInterval); chatInterval = null; }
  if (priorityManagerInterval) { clearInterval(priorityManagerInterval); priorityManagerInterval = null; }
  if (sleepCheckInterval) { clearInterval(sleepCheckInterval); sleepCheckInterval = null; }
  if (autoDefenseInterval) { clearInterval(autoDefenseInterval); autoDefenseInterval = null; }
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
}

function stopCurrentTasks() {
  if (bot) {
    bot.pathfinder.stop();
    bot.pvp.stop();
    
    // Remove sleep listeners if registered
    if (sleepGoalReachedListener) {
      bot.removeListener('goal_reached', sleepGoalReachedListener);
      sleepGoalReachedListener = null;
    }

    if (bot.isSleeping) {
      bot.wake().catch((err) => console.error("❌ Wake error:", err));
    }
  }
}

function cleanupBot() {
  clearAllIntervals();
  stopCurrentTasks();
  if (bot) {
    bot.removeAllListeners();
    try {
      bot.end();
    } catch (err) {
      // already ended
    }
    bot = null;
  }
}

// Get name of the priority (useful for logging)
function getPriorityName(p) {
  for (const [key, value] of Object.entries(Priorities)) {
    if (value === p) return key;
  }
  return 'UNKNOWN';
}

// Get the nearby creeper (within escape distance)
function getNearbyCreeper() {
  if (!bot || !bot.entity) return null;
  const avoidDist = config.creeperAvoidDistance !== undefined ? config.creeperAvoidDistance : 8;
  return bot.nearestEntity(e => 
    e.type === 'mob' && 
    e.name === 'creeper' && 
    bot.entity.position.distanceTo(e.position) < avoidDist
  );
}

// Get the nearby hostile mob (excluding creepers, endermen, and slimes, within 6 blocks)
function getNearbyHostileMob() {
  if (!bot || !bot.entity) return null;
  return bot.nearestEntity(e => 
    e.type === 'mob' && 
    hostileMobs.includes(e.name) && 
    bot.entity.position.distanceTo(e.position) < 6
  );
}

// Find a bed nearby (within 40 blocks)
function findNearbyBed() {
  if (!bot) return null;
  return bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 40 });
}

// Helper to determine the current highest active priority
function getCurrentPriority() {
  if (!bot || !bot.entity) return Priorities.IDLE;

  // 1. Emergency Survival: HP low, we have a safe position to run to
  if (bot.health > 0 && bot.health < 6 && memory.recentPositions.length > 0) {
    return Priorities.EMERGENCY_SURVIVAL;
  }

  // 2. Creeper Escape: Creeper is close and autoDefense is enabled
  if (config.autoDefense && getNearbyCreeper()) {
    return Priorities.CREEPER_ESCAPE;
  }

  // 3. Combat: Target is active, or hostile mob is nearby and autoDefense is enabled
  if (config.autoDefense && (bot.pvp.target || getNearbyHostileMob())) {
    return Priorities.COMBAT;
  }

  // 4. Sleeping: isSleeping OR (autoSleep is true, it is night, state is afk, and a bed is nearby)
  if (bot.isSleeping || (config.autoSleep && bot.time && bot.time.isNight && botState === 'afk' && findNearbyBed())) {
    return Priorities.SLEEPING;
  }

  // 5. Following
  // Note: We do NOT require bot.players[followTarget] here because the player entity
  // may not be loaded yet (e.g. just joined or out of render range briefly).
  // executePriorityLogic handles the missing-entity case gracefully.
  if (botState === 'following' && followTarget) {
    return Priorities.FOLLOWING;
  }

  // 6. Guarding
  if (botState === 'guard' && guardPosition) {
    return Priorities.GUARDING;
  }

  // 7. AFK
  if (botState === 'afk') {
    return Priorities.AFK;
  }

  return Priorities.IDLE;
}

// Handle transition between priorities
function handlePriorityTransition(oldPriority, newPriority) {
  // Suspend auto-eat during high-priority (Emergency, Creeper Escape, Combat) states
  const wasHighPriority = oldPriority <= Priorities.COMBAT;
  const isHighPriority = newPriority <= Priorities.COMBAT;

  if (isHighPriority && !wasHighPriority) {
    if (bot.autoEat) {
      bot.autoEat.disableAuto();
      bot.autoEat.cancelEat();
      console.log("🍖 AutoEat suspended for high-priority action.");
    }
  } else if (!isHighPriority && wasHighPriority) {
    if (bot.autoEat) {
      bot.autoEat.enableAuto();
      console.log("🍖 AutoEat resumed.");
    }
  }

  // Stop pathfinder to allow the new priority to set its goal
  if (bot.pathfinder) {
    bot.pathfinder.stop();
  }

  // Clean up PvP if leaving combat
  if (oldPriority === Priorities.COMBAT && bot.pvp) {
    bot.pvp.stop();
  }

  // Clean up sleep listener if leaving sleep
  if (oldPriority === Priorities.SLEEPING) {
    if (sleepGoalReachedListener) {
      bot.removeListener('goal_reached', sleepGoalReachedListener);
      sleepGoalReachedListener = null;
    }
    if (bot.isSleeping) {
      bot.wake().catch((err) => console.error("❌ Wake error on transition:", err));
    }
  }
}

// Execute state-specific continuous loop logic (run every 200ms)
function executePriorityLogic(priority) {
  if (!bot || !bot.entity) return;

  switch (priority) {
    case Priorities.EMERGENCY_SURVIVAL:
      const nowEmergency = Date.now();
      if (nowEmergency - lastEmergencyActionTime > 3000) {
        const safePos = memory.recentPositions[0];
        if (safePos) {
          console.log(`🚑 Emergency Survival: Retreating to safe position: ${Math.round(safePos.x)}, ${Math.round(safePos.y)}, ${Math.round(safePos.z)}`);
          safeSetGoal(new goals.GoalNear(safePos.x, safePos.y, safePos.z, 1));
          lastEmergencyActionTime = nowEmergency;
        }
      }
      break;

    case Priorities.CREEPER_ESCAPE:
      const creeper = getNearbyCreeper();
      if (creeper) {
        const nowCreeper = Date.now();
        if (nowCreeper - lastCreeperEscapeTime > 3000) {
          const escapePos = findSafeEscapePosition(creeper);
          if (escapePos) {
            console.log(`⚠️ Creeper Escape: Evading to ${Math.round(escapePos.x)}, ${Math.round(escapePos.y)}, ${Math.round(escapePos.z)}`);
            safeSetGoal(new goals.GoalNear(Math.round(escapePos.x), Math.round(escapePos.y), Math.round(escapePos.z), 1));
            lastCreeperEscapeTime = nowCreeper;
          } else {
            console.log("⚠️ Creeper Escape: No safe escape position found!");
          }
        }
      }
      break;

    case Priorities.COMBAT:
      const target = bot.pvp.target || getNearbyHostileMob();
      if (target && !bot.pvp.target) {
        bot.pvp.attack(target);
        console.log(`⚔️ Combat: Attacking hostile mob: ${target.name}`);
      }
      break;

    case Priorities.SLEEPING:
      if (!bot.isSleeping && !sleepGoalReachedListener) {
        const bed = findNearbyBed();
        if (bed) {
          console.log("🛌 Walking to bed (Sleep priority)...");
          safeSetGoal(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
          sleepGoalReachedListener = async () => {
            sleepGoalReachedListener = null;
            if (bot && bot.entity) {
              const dist = bot.entity.position.distanceTo(bed.position);
              if (dist < 3) {
                try {
                  await bot.sleep(bed);
                  console.log("💤 Sleeping successfully.");
                } catch (err) {
                  console.error("❌ Sleep failed:", err);
                }
              }
            }
          };
          bot.once('goal_reached', sleepGoalReachedListener);
        }
      }
      break;

    case Priorities.FOLLOWING: {
      const targetPlayer = bot.players[followTarget];
      if (!targetPlayer) {
        // Player not in server's player list at all — stop following
        const offlineTarget = followTarget;
        console.log(`[Follow] ${offlineTarget} is not online. Stopping follow.`);
        stopCurrentTasks();
        botState = 'idle';
        followTarget = null;
        bot.chat(`❌ ${offlineTarget} is not online.`);
      } else if (!targetPlayer.entity) {
        // Player exists but entity not loaded yet (chunk not loaded / too far)
        // Just wait — do NOT stop the pathfinder, let it continue its last goal
        // or stay still until the entity loads in next tick
        console.log(`[Follow] Waiting for ${followTarget}'s entity to load...`);
      } else {
        const dist = bot.entity.position.distanceTo(targetPlayer.entity.position);
        const maxDist = config.followMaxDistance || 30;
        if (dist > maxDist) {
          bot.chat(`⚠️ You are too far (>${maxDist} blocks)! Stopping follow.`);
          stopCurrentTasks();
          botState = 'idle';
        } else {
          safeSetGoal(new goals.GoalFollow(targetPlayer.entity, 2), true);
        }
      }
      break;
    }

    case Priorities.GUARDING:
      if (guardPosition) {
        const dist = bot.entity.position.distanceTo(guardPosition);
        if (dist > 3 && !bot.pathfinder.isMoving()) {
          safeSetGoal(new goals.GoalNear(guardPosition.x, guardPosition.y, guardPosition.z, 1));
        }
      }
      break;

    case Priorities.AFK:
      // AFK logic is driven by the recursive timeout scheduleNextAFK()
      break;

    case Priorities.IDLE:
    default:
      break;
  }
}

// 5Hz Priority Manager Tick Loop
function runPriorityManagerTick() {
  if (!bot || !bot.entity) return;

  // 1. Void / Liquid Safety Check
  const pos = bot.entity.position;
  const feetBlock = bot.blockAt(pos);
  const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
  
  const standingInLiquid = feetBlock && (feetBlock.name.includes('lava') || feetBlock.name.includes('water'));
  const standingOnUnsafe = !groundBlock || groundBlock.name.includes('air') || groundBlock.name.includes('lava') || groundBlock.name.includes('water');
  
  if (standingInLiquid || standingOnUnsafe) {
    if (bot.pathfinder.isMoving()) {
      console.log("⚠️ Void/Liquid Safety: Bot is on an unsafe block, stopping pathfinder!");
      bot.pathfinder.stop();
    }
  }

  // 2. Memory System Updates
  updateMemory();

  // 3. Evaluate Priority Transitions
  const newPriority = getCurrentPriority();
  if (newPriority !== currentPriority) {
    console.log(`[PriorityManager] Transitioning priority from ${getPriorityName(currentPriority)} -> ${getPriorityName(newPriority)}`);
    handlePriorityTransition(currentPriority, newPriority);
    currentPriority = newPriority;
  }

  // 4. Run active priority logic
  executePriorityLogic(currentPriority);
}

// Memory system background updates
function updateMemory() {
  if (!bot || !bot.entity) return;
  const now = Date.now();
  
  if (now - lastMemoryUpdateTime > 2000) {
    lastMemoryUpdateTime = now;
    
    // Save current position if it is on a solid safe ground block
    const pos = bot.entity.position.clone();
    const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
    if (groundBlock && groundBlock.boundingBox === 'block' && 
        !groundBlock.name.includes('air') && 
        !groundBlock.name.includes('lava') && 
        !groundBlock.name.includes('water')) {
      
      const lastSaved = memory.recentPositions[0];
      if (!lastSaved || lastSaved.distanceTo(pos) > 1.5) {
        memory.recentPositions.unshift(pos);
        if (memory.recentPositions.length > 8) {
          memory.recentPositions.pop();
        }
      }
    }
    
    // Track target entities in memory
    const currentTarget = bot.nearestEntity(e => 
      (e.type === 'player' || e.type === 'mob' || e.type === 'passive') && 
      e.position.distanceTo(bot.entity.position) < 12
    );
    if (currentTarget) {
      if (!memory.recentTargetEntities.includes(currentTarget.id)) {
        memory.recentTargetEntities.unshift(currentTarget.id);
        if (memory.recentTargetEntities.length > 5) {
          memory.recentTargetEntities.pop();
        }
      }
    }
  }
}

// Tiny head correction for idling AFK cycles
async function runTinyHeadCorrection() {
  if (!bot || !bot.entity || !isAFKActive()) return;
  const yawOffset = (Math.random() * 2 - 1) * 0.05;
  const pitchOffset = (Math.random() * 2 - 1) * 0.03;
  const targetYaw = bot.entity.yaw + yawOffset;
  const targetPitch = Math.max(-0.6, Math.min(0.6, bot.entity.pitch + pitchOffset));
  await smoothLook(targetYaw, targetPitch, 4, 30);
}

// Find a safe spot away from a creeper, checking ground and space availability
function findSafeEscapePosition(creeper) {
  if (!bot || !bot.entity) return null;
  const botPos = bot.entity.position;
  const creeperPos = creeper.position;
  const dir = botPos.minus(creeperPos);
  dir.y = 0; // Keep horizontal direction
  const normDir = dir.normalize();

  // Angles to try: direct away, then slightly left/right, up to 90 degrees
  const angles = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2];
  const avoidDist = config.creeperAvoidDistance !== undefined ? config.creeperAvoidDistance : 8;
  const distances = [avoidDist + 2, avoidDist, Math.max(4, avoidDist - 2)];

  for (const dist of distances) {
    for (const angle of angles) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotatedX = normDir.x * cos - normDir.z * sin;
      const rotatedZ = normDir.x * sin + normDir.z * cos;

      // Check different heights (same level, up 1, up 2, down 1, down 2, down 3)
      for (let dy = 2; dy >= -3; dy--) {
        const checkPos = botPos.offset(rotatedX * dist, dy, rotatedZ * dist);
        const feetBlock = bot.blockAt(checkPos);
        const headBlock = bot.blockAt(checkPos.offset(0, 1, 0));
        const groundBlock = bot.blockAt(checkPos.offset(0, -1, 0));

        if (feetBlock && headBlock && groundBlock) {
          const isFeetPassable = feetBlock.boundingBox === 'empty' || feetBlock.name.includes('air') || feetBlock.name.includes('grass');
          const isHeadPassable = headBlock.boundingBox === 'empty' || headBlock.name.includes('air') || headBlock.name.includes('grass');
          const isGroundSolid = groundBlock.boundingBox === 'block' && !groundBlock.name.includes('air') && !groundBlock.name.includes('lava') && !groundBlock.name.includes('water');

          if (isFeetPassable && isHeadPassable && isGroundSolid) {
            return checkPos;
          }
        }
      }
    }
  }
  // Fallback if no safe block is found: return null to prevent blind offsets (void danger)
  return null;
}

// Helper to execute intent-based actions determined by AI
async function executeIntent(intent, parameters, senderUsername) {
  if (!bot) return;
  switch (intent) {
    case 'follow':
      const followTargetPlayer = parameters.target || senderUsername;
      stopCurrentTasks();
      botState = 'following';
      followTarget = followTargetPlayer;
      console.log(`🏃 Following ${followTargetPlayer} (AI intent)`);
      break;

    case 'guard':
      stopCurrentTasks();
      botState = 'guard';
      guardPosition = bot.entity.position.clone();
      console.log(`🛡️ Guarding here (AI intent)`);
      break;

    case 'afk':
      stopCurrentTasks();
      botState = 'afk';
      console.log(`🤖 Smart AFK Mode ON (AI intent)`);
      break;

    case 'stop':
      stopCurrentTasks();
      botState = 'idle';
      console.log(`🛑 Stood still. Stopped all tasks (AI intent)`);
      break;

    case 'goto':
      if (parameters.coordinates) {
        const { x, y, z } = parameters.coordinates;
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          stopCurrentTasks();
          botState = 'idle';
          console.log(`🧭 Moving to: ${x}, ${y}, ${z} (AI intent)`);
          safeSetGoal(new goals.GoalBlock(x, y, z));
        }
      }
      break;

    case 'sleep':
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 40 });
      if (bed) {
        console.log('🛌 Walking to bed (AI intent)...');
        stopCurrentTasks();
        safeSetGoal(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
        
        sleepGoalReachedListener = async () => {
          sleepGoalReachedListener = null;
          const dist = bot.entity.position.distanceTo(bed.position);
          if (dist < 3) {
            try {
              await bot.sleep(bed);
              console.log("💤 Sleeping (AI intent)...");
            } catch (err) {
              console.error(`❌ Cannot sleep: ${err.message}`);
            }
          }
        };
        bot.once('goal_reached', sleepGoalReachedListener);
      }
      break;

    case 'wake':
      if (bot.isSleeping) {
        try {
          await bot.wake();
          console.log("☀️ Woke up (AI intent).");
        } catch (err) {
          console.error(`❌ Cannot wake up: ${err.message}`);
        }
      }
      break;

    case 'drop':
      const invItems = bot.inventory.items();
      if (invItems.length > 0) {
        console.log(`Dropping ${invItems.length} items (AI intent)...`);
        for (const item of invItems) {
          try {
            await bot.tossStack(item);
          } catch (err) {
            console.error(`❌ Failed to drop ${item.name}:`, err);
          }
        }
      }
      break;

    case 'tpa':
      const tpaPlayer = parameters.target || senderUsername;
      bot.chat(`/tpa ${tpaPlayer}`);
      break;

    case 'accept':
      bot.chat('/tpaccept');
      break;

    case 'status':
      const health = bot.health;
      const food = bot.food;
      const pos = bot.entity.position;
      const items = bot.inventory.items();
      const invSummary = items.map(i => `${i.count}x ${i.name}`).join(', ') || 'empty';
      
      bot.chat(`❤️ HP: ${health}/20 | 🍖 Food: ${food}/20 | 📍 Pos: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | State: ${botState}`);
      const invText = `Inventory: ${invSummary}`;
      bot.chat(invText.length > 100 ? invText.substring(0, 97) + '...' : invText);
      break;

    case 'say':
    case 'none':
    default:
      break;
  }
}

function scheduleReconnect(delay) {
  if (reconnectTimeout) {
    console.log("🔄 Reconnection already scheduled.");
    return;
  }
  cleanupBot();
  console.log(`🔌 Scheduling reconnection in ${delay / 1000}s...`);
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    createBot();
  }, delay);
}

function createBot() {
  cleanupBot();

  const botName = config.username || "LazyBoy";

  bot = mineflayer.createBot({
    host: config.host || "SHIBU2.aternos.me",
    port: config.port || 25565,
    username: botName,
    version: false,
  });

  // Load necessary Mineflayer plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoeat);

  bot.on('login', () => console.log(`✅ ${botName} Logged In successfully!`));
  
  bot.on('spawn', () => {
    console.log(`✅ ${botName} Spawned - Intelligent AI Mode Active`);
    
    // Configure mineflayer-auto-eat settings
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14, // Eat when hunger drops below 7 bars
      bannedFood: ['rotten_flesh', 'spider_eye', 'pufferfish'],
    };

    // Start smart loops and intervals
    startSmartLoops();
  });

  bot.on('death', () => {
    console.log(`💀 ${botName} died! Respawning automatically...`);
    bot.respawn();
  });

  // Auto-reconnect handling on connection events (with single schedule protection)
  bot.on('kicked', (reason) => { 
    console.log('⚠️ Kicked:', reason); 
    clearAllIntervals();
    const delay = 25000 + Math.floor(Math.random() * 5000);
    scheduleReconnect(delay);
  });

  bot.on('error', (err) => { 
    console.error('❌ Error event:', err); 
    clearAllIntervals();
    const delay = 15000 + Math.floor(Math.random() * 5000);
    scheduleReconnect(delay);
  });

  bot.on('end', () => { 
    console.log('🔌 Connection ended...'); 
    clearAllIntervals();
    const delay = 10000 + Math.floor(Math.random() * 5000);
    scheduleReconnect(delay);
  });

  // Logging when auto-eating triggers
  bot.on('autoeat_started', (item) => {
    console.log(`🍖 AutoEat: Started eating ${item.name}`);
  });

  // Re-enable auto-eating when combat finishes
  bot.on('stoppedAttacking', () => {
    console.log("⚔️ Combat ended: stoppedAttacking event received.");
    bot.autoEat.enableAuto();
  });

  // Self-defense / Fight Back when attacked
  bot.on('entityHurt', (entity) => {
    if (!config.autoDefense) return;
    if (entity === bot.entity) {
      const target = bot.nearestEntity(e => 
        (e.type === 'player' || e.type === 'mob') && 
        bot.entity.position.distanceTo(e.position) < 8
      );
      
      if (target) {
        // Safe check: Do not attack authorized owners
        if (target.type === 'player' && config.owners.includes(target.username)) {
          console.log(`🛡️ Ignored hit from owner: ${target.username}`);
          return;
        }
        
        // Attack if not already engaged
        if (!bot.pvp.target) {
          bot.pvp.attack(target);
          console.log(`⚔️ Retaliating against ${target.username || target.name}`);
        }
      }
    }
  });

  // Command parser for Chat interface
  bot.on('chat', async (username, message) => {
    // Check if player is authorized owner
    if (!config.owners.includes(username)) return;

    if (message.startsWith('!')) {
      const args = message.slice(1).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      console.log(`💬 Owner Command: ${username} -> !${command} ${args.join(' ')}`);

      switch (command) {
        case 'help':
          bot.chat("Commands: !status, !follow, !guard, !afk, !stop, !goto x y z, !sleep, !wake, !drop, !tpa [name], !accept, !say [msg], !addowner [name], !removeowner [name]");
          break;

        case 'status':
          const health = bot.health;
          const food = bot.food;
          const pos = bot.entity.position;
          const items = bot.inventory.items();
          const invSummary = items.map(i => `${i.count}x ${i.name}`).join(', ') || 'empty';
          
          bot.chat(`❤️ HP: ${health}/20 | 🍖 Food: ${food}/20 | 📍 Pos: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | State: ${botState}`);
          const invText = `Inventory: ${invSummary}`;
          bot.chat(invText.length > 100 ? invText.substring(0, 97) + '...' : invText);
          break;

        case 'come':
        case 'follow':
          stopCurrentTasks();
          botState = 'following';
          followTarget = username;
          bot.chat(`🏃 Following ${username}`);
          break;

        case 'guard':
          stopCurrentTasks();
          botState = 'guard';
          guardPosition = bot.entity.position.clone();
          bot.chat(`🛡️ Guarding here: ${Math.round(guardPosition.x)}, ${Math.round(guardPosition.y)}, ${Math.round(guardPosition.z)}`);
          break;

        case 'afk':
          stopCurrentTasks();
          botState = 'afk';
          bot.chat("🤖 Smart AFK Mode ON.");
          break;

        case 'stop':
          stopCurrentTasks();
          botState = 'idle';
          bot.chat("🛑 Stood still. Stopped all tasks.");
          break;

        case 'goto':
          const x = parseFloat(args[0]);
          const y = parseFloat(args[1]);
          const z = parseFloat(args[2]);
          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            stopCurrentTasks();
            botState = 'idle';
            bot.chat(`🧭 Moving to: ${x}, ${y}, ${z}`);
            safeSetGoal(new goals.GoalBlock(x, y, z));
          } else {
            bot.chat("Usage: !goto <x> <y> <z>");
          }
          break;

        case 'sleep':
          const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 40 });
          if (bed) {
            bot.chat('🛌 Walking to bed...');
            stopCurrentTasks();
            
            safeSetGoal(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
            
            sleepGoalReachedListener = async () => {
              sleepGoalReachedListener = null;
              const dist = bot.entity.position.distanceTo(bed.position);
              if (dist < 3) {
                try {
                  await bot.sleep(bed);
                  bot.chat("💤 Sleeping...");
                } catch (err) {
                  bot.chat(`❌ Cannot sleep: ${err.message}`);
                }
              }
            };
            bot.once('goal_reached', sleepGoalReachedListener);

          } else {
            bot.chat('❌ No bed found within 40 blocks.');
          }
          break;

        case 'wake':
          if (bot.isSleeping) {
            try {
              await bot.wake();
              bot.chat("☀️ Woke up.");
            } catch (err) {
              bot.chat(`❌ Cannot wake up: ${err.message}`);
            }
          } else {
            bot.chat("❌ I'm not sleeping.");
          }
          break;

        case 'drop':
          const invItems = bot.inventory.items();
          if (invItems.length === 0) {
            bot.chat("Inventory empty.");
            return;
          }
          bot.chat(`Dropping ${invItems.length} items...`);
          for (const item of invItems) {
            try {
              await bot.tossStack(item);
            } catch (err) {
              console.error(`❌ Failed to drop ${item.name}:`, err);
            }
          }
          break;

        case 'say':
          if (args.length > 0) {
            bot.chat(args.join(' '));
          }
          break;

        case 'tpa':
          const tpaPlayer = args[0] || username;
          bot.chat(`/tpa ${tpaPlayer}`);
          bot.chat(`Sent teleport request to ${tpaPlayer}`);
          break;

        case 'accept':
          bot.chat('/tpaccept');
          bot.chat('Accepted teleport request.');
          break;

        case 'addowner':
          const newOwner = args[0];
          if (newOwner && !config.owners.includes(newOwner)) {
            config.owners.push(newOwner);
            saveConfig();
            bot.chat(`Added ${newOwner} to owners.`);
          } else {
            bot.chat("Invalid owner or already present.");
          }
          break;

        case 'removeowner':
          const removeName = args[0];
          if (removeName) {
            const idx = config.owners.indexOf(removeName);
            if (idx > -1) {
              config.owners.splice(idx, 1);
              saveConfig();
              bot.chat(`Removed ${removeName} from owners.`);
            } else {
              bot.chat(`${removeName} is not an owner.`);
            }
          }
          break;

        default:
          bot.chat("Unknown command. Type !help.");
          break;
      }
    } else {
      // Process conversational message with AIManager
      try {
        const result = await aiManager.processMessage(bot, botState, followTarget, guardPosition, username, message);
        if (result.response) {
          bot.chat(result.response);
        }
        if (result.intent && result.intent !== 'none' && result.intent !== 'say') {
          console.log(`🤖 [AIManager] Executing intent: ${result.intent} with parameters:`, result.parameters);
          await executeIntent(result.intent, result.parameters, username);
        }
      } catch (err) {
        console.error("❌ Error in AI chat processing:", err);
      }
    }
  });

  // Login support for offline servers
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (authPassword) {
      if (text.includes('/login') || text.includes('log in')) {
        bot.chat(`/login ${authPassword}`);
      } else if (text.includes('/register')) {
        bot.chat(`/register ${authPassword} ${authPassword}`);
      }
    }
  });
}

// Helper to check if AFK actions are allowed to execute
function isAFKActive() {
  return bot && bot.entity && botState === 'afk' && !bot.pvp.target && !bot.isSleeping;
}

// Check path safety block-by-block to avoid void, lava, water, and cliffs
function isPathSafe(start, end, checkBridges = false) {
  if (!bot) return false;
  const dist = start.distanceTo(end);
  const steps = Math.ceil(dist / 0.5);
  
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const checkPos = start.plus(end.minus(start).scaled(t));
    
    // Check ground blocks up to 4 blocks down to prevent cliffs/void
    let hasSolidGround = false;
    for (let dy = -1; dy >= -4; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0));
      if (block && block.boundingBox === 'block' && 
          !block.name.includes('air') && 
          !block.name.includes('lava') && 
          !block.name.includes('water')) {
        hasSolidGround = true;
        break;
      }
    }
    if (!hasSolidGround) return false;
    
    const feetBlock = bot.blockAt(checkPos);
    const headBlock = bot.blockAt(checkPos.offset(0, 1, 0));
    
    if (!feetBlock || !headBlock) return false;
    
    const isFeetPassable = feetBlock.boundingBox === 'empty' || 
                           feetBlock.name.includes('air') || 
                           feetBlock.name.includes('grass');
                           
    const isHeadPassable = headBlock.boundingBox === 'empty' || 
                           headBlock.name.includes('air') || 
                           headBlock.name.includes('grass');
                           
    if (!isFeetPassable || !isHeadPassable) return false;

    if (checkBridges) {
      // Check narrow bridge: if the block below is the only ground block,
      // and both sides (left/right relative to direction) are air/void
      const dir = end.minus(start).normalize();
      const leftDir = new vec3(-dir.z, 0, dir.x).normalize();
      const rightDir = new vec3(dir.z, 0, -dir.x).normalize();
      
      let leftSolid = false;
      let rightSolid = false;
      
      for (let dy = -1; dy >= -4; dy--) {
        const leftBlock = bot.blockAt(checkPos.plus(leftDir).offset(0, dy, 0));
        if (leftBlock && leftBlock.boundingBox === 'block' && !leftBlock.name.includes('air') && !leftBlock.name.includes('lava') && !leftBlock.name.includes('water')) {
          leftSolid = true;
        }
        const rightBlock = bot.blockAt(checkPos.plus(rightDir).offset(0, dy, 0));
        if (rightBlock && rightBlock.boundingBox === 'block' && !rightBlock.name.includes('air') && !rightBlock.name.includes('lava') && !rightBlock.name.includes('water')) {
          rightSolid = true;
        }
      }
      
      // If it's a 1-block wide bridge (neither left nor right has solid ground), we consider it unsafe for random AFK walking
      if (!leftSolid && !rightSolid) {
        return false; 
      }
    }
  }
  return true;
}

// Helper to compare pathfinder goals and prevent redundant goal updates
function areGoalsEqual(g1, g2) {
  if (!g1 && !g2) return true;
  if (!g1 || !g2) return false;
  if (g1.constructor !== g2.constructor) return false;

  if (g1.x !== g2.x || g1.y !== g2.y || g1.z !== g2.z) return false;
  if (g1.range !== g2.range) return false;
  if (g1.radius !== g2.radius) return false;
  
  if (g1.entity && g2.entity) {
    if (g1.entity.id !== g2.entity.id) return false;
  } else if (g1.entity || g2.entity) {
    return false;
  }

  return true;
}

// A wrapper for bot.pathfinder.setGoal with pre-flight safety and redundancy checks
function safeSetGoal(goal, dynamic = false) {
  if (!bot) return false;

  // Check redundancy: skip if the new goal is identical to the current active goal
  if (bot.pathfinder && areGoalsEqual(bot.pathfinder.goal, goal)) {
    return true;
  }

  if (goal) {
    let targetPos = null;

    // Extract destination coordinates depending on the type of goal
    if (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
      targetPos = new vec3(goal.x, goal.y, goal.z);
    } else if (goal.entity && goal.entity.position) {
      targetPos = goal.entity.position;
    }

    if (targetPos) {
      const groundBlock = bot.blockAt(targetPos.offset(0, -1, 0));
      const feetBlock = bot.blockAt(targetPos);
      const headBlock = bot.blockAt(targetPos.offset(0, 1, 0));

      // Only perform check if the destination blocks are loaded
      if (groundBlock && feetBlock && headBlock) {
        const isGroundSolid = groundBlock.boundingBox === 'block' && 
                              !groundBlock.name.includes('air') && 
                              !groundBlock.name.includes('lava') && 
                              !groundBlock.name.includes('water');
                              
        const isFeetPassable = feetBlock.boundingBox === 'empty' || 
                               feetBlock.name.includes('air') || 
                               feetBlock.name.includes('grass');
                               
        const isHeadPassable = headBlock.boundingBox === 'empty' || 
                               headBlock.name.includes('air') || 
                               headBlock.name.includes('grass');

        if (!isGroundSolid || !isFeetPassable || !isHeadPassable) {
          console.log(`⚠️ safeSetGoal: Blocked setting goal to unsafe/obstructed position ${targetPos} (Ground: ${groundBlock.name}, Feet: ${feetBlock.name}, Head: ${headBlock.name})`);
          return false;
        }
      }
    }
  }

  try {
    bot.pathfinder.setGoal(goal, dynamic);
    return true;
  } catch (err) {
    console.error("❌ safeSetGoal error:", err);
    return false;
  }
}

// Smoothly transition head angles to feel human-like
async function smoothLook(targetYaw, targetPitch, steps = 10, interval = 50) {
  if (!bot || !bot.entity) return;
  
  const wrap = (val) => Math.atan2(Math.sin(val), Math.cos(val));
  
  let currentYaw = bot.entity.yaw;
  let currentPitch = bot.entity.pitch;
  
  let yawDiff = wrap(targetYaw - currentYaw);
  let pitchDiff = targetPitch - currentPitch;
  
  for (let i = 1; i <= steps; i++) {
    if (!isAFKActive()) return;
    const nextYaw = currentYaw + (yawDiff * (i / steps));
    const nextPitch = currentPitch + (pitchDiff * (i / steps));
    try {
      await bot.look(nextYaw, nextPitch, true);
    } catch (err) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// Generate natural looking angles
function getNaturalLookAngles() {
  if (!bot || !bot.entity) return null;
  
  // 30% chance to look at a nearby entity (not recently focused)
  if (Math.random() < 0.3) {
    const entity = bot.nearestEntity(e => 
      (e.type === 'player' || e.type === 'mob' || e.type === 'passive') && 
      e.position.distanceTo(bot.entity.position) < 12 &&
      !memory.recentTargetEntities.slice(0, 2).includes(e.id)
    );
    if (entity) {
      const yawOffset = (Math.random() * 2 - 1) * 0.1;
      const pitchOffset = (Math.random() * 2 - 1) * 0.1;
      const delta = entity.position.offset(0, entity.height || 1.6, 0).minus(bot.entity.position.offset(0, bot.entity.height || 1.6, 0));
      const targetYaw = Math.atan2(-delta.x, -delta.z) + yawOffset;
      const groundDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
      const targetPitch = Math.atan2(delta.y, groundDist) + pitchOffset;
      
      // Update memory immediately
      if (!memory.recentTargetEntities.includes(entity.id)) {
        memory.recentTargetEntities.unshift(entity.id);
        if (memory.recentTargetEntities.length > 5) memory.recentTargetEntities.pop();
      }
      return { yaw: targetYaw, pitch: targetPitch };
    }
  }
  
  // Small random offset
  const yawOffset = (Math.random() * 2 - 1) * (Math.PI / 4);
  const pitchOffset = (Math.random() * 2 - 1) * (Math.PI / 12);
  
  let targetYaw = bot.entity.yaw + yawOffset;
  let targetPitch = Math.max(-0.6, Math.min(0.6, bot.entity.pitch + pitchOffset));
  
  return { yaw: targetYaw, pitch: targetPitch };
}

async function runLookAction() {
  const angles = getNaturalLookAngles();
  if (angles && isAFKActive()) {
    const steps = Math.floor(5 + Math.random() * 10);
    const interval = Math.floor(40 + Math.random() * 20);
    await smoothLook(angles.yaw, angles.pitch, steps, interval);
  }
}

async function runLookSwingAction() {
  const angles = getNaturalLookAngles();
  if (angles && isAFKActive()) {
    const steps = Math.floor(5 + Math.random() * 10);
    const interval = Math.floor(40 + Math.random() * 20);
    await smoothLook(angles.yaw, angles.pitch, steps, interval);
    
    if (isAFKActive()) {
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
    }
    
    if (isAFKActive()) {
      bot.swingArm('right');
    }
  }
}

async function runWalkAction() {
  if (!bot || !bot.entity || bot.pathfinder.isMoving()) return;
  
  let targetPos = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const dist = 1 + Math.random(); // 1 to 2 blocks
    const angle = Math.random() * Math.PI * 2;
    const dx = Math.cos(angle) * dist;
    const dz = Math.sin(angle) * dist;
    
    const possibleTarget = bot.entity.position.offset(dx, 0, dz);
    if (isPathSafe(bot.entity.position, possibleTarget, true)) {
      targetPos = possibleTarget;
      break;
    }
  }
  
  if (targetPos && isAFKActive()) {
    const sneakChance = Math.random() < 0.15;
    if (sneakChance) {
      bot.setControlState('sneak', true);
    }
    
    safeSetGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 0.2));
    
    const startTime = Date.now();
    while (isAFKActive() && bot.pathfinder.isMoving() && (Date.now() - startTime < 4000)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (sneakChance && bot) {
      bot.setControlState('sneak', false);
    }
    
    if (isAFKActive()) {
      const randAct = Math.random();
      if (randAct < 0.25) {
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) bot.setControlState('jump', false);
        }, 150);
      } else if (randAct < 0.5) {
        bot.swingArm('right');
      }
    }
  }
}

async function performMicroAction() {
  if (!isAFKActive()) return;
  
  const roll = Math.random();
  if (roll < 0.02) {
    bot.setControlState('sneak', true);
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
    if (bot) bot.setControlState('sneak', false);
  } else if (roll < 0.07) {
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (bot) bot.setControlState('jump', false);
    }, 150);
  } else if (roll < 0.12) {
    bot.swingArm('right');
  }
}

async function runAFKCycle(forceWalk = false) {
  if (!isAFKActive()) return;

  let actionType;
  if (forceWalk) {
    actionType = 'walk';
  } else {
    const rand = Math.random();
    if (rand < 0.45) {
      actionType = 'idle';
    } else if (rand < 0.65) {
      actionType = 'look';
    } else if (rand < 0.80) {
      actionType = 'look_swing';
    } else {
      actionType = 'walk'; // 20% base chance (was 5%)
    }
  }

  // Prevent repeating the same action type consecutively
  if (!forceWalk && actionType === lastAFKActionType) {
    const secondRand = Math.random();
    if (secondRand < 0.45) {
      actionType = 'idle';
    } else if (secondRand < 0.65) {
      actionType = 'look';
    } else if (secondRand < 0.80) {
      actionType = 'look_swing';
    } else {
      actionType = 'walk';
    }
  }
  lastAFKActionType = actionType;

  // Add action to memory
  memory.lastAFKActions.unshift(actionType);
  if (memory.lastAFKActions.length > 5) {
    memory.lastAFKActions.pop();
  }

  if (actionType === 'idle') {
    // 25% chance to perform a tiny head correction during idle state
    if (Math.random() < 0.25) {
      await runTinyHeadCorrection();
    }
  } else if (actionType === 'look') {
    await runLookAction();
  } else if (actionType === 'look_swing') {
    await runLookSwingAction();
  } else if (actionType === 'walk') {
    await runWalkAction();
  }

  if (isAFKActive()) {
    await performMicroAction();
  }
}

function scheduleNextAFK(isFirstCycle = false) {
  if (smartAFKInterval) {
    clearTimeout(smartAFKInterval);
    smartAFKInterval = null;
  }
  
  if (!bot || !bot.entity) return;

  let delay;
  if (isFirstCycle) {
    // First cycle after spawn: start moving quickly (3–8 seconds)
    delay = 3000 + Math.random() * 5000;
  } else {
    delay = 20000 + Math.random() * 40000;
    // 8% chance to trigger a longer idle delay (2 to 4 minutes)
    if (Math.random() < 0.08) {
      delay = 120000 + Math.random() * 120000;
      console.log(`💤 AFK: Taking a longer pause of ${Math.round(delay / 1000)}s.`);
    }
  }

  smartAFKInterval = setTimeout(async () => {
    if (isAFKActive()) {
      await runAFKCycle(isFirstCycle); // forceWalk=true on first cycle after spawn
    }
    scheduleNextAFK(); // subsequent cycles use normal delays
  }, delay);
}

function startSmartLoops() {
  // Pathfinder configuration
  const movements = new Movements(bot);
  movements.canDig = false; 
  movements.allow1by1tunnels = false;
  movements.liquidCost = 20; // Stay out of water/lava if possible
  bot.pathfinder.setMovements(movements);
  bot.pvp.movements = movements; // Align PvP motions with pathfinder settings

  // Clear existing intervals
  clearAllIntervals();

  // Loop 1: Smart AFK movements (Random wanders)
  scheduleNextAFK(true); // isFirstCycle=true: start moving within 3-8s after spawn

  // Loop 2: Smart Bed sleep check at night (during AFK)
  sleepCheckInterval = setInterval(() => {
    if (!bot.entity || botState !== 'afk' || bot.isSleeping || !config.autoSleep) return;
    if (bot.time.isNight) {
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 40 });
      if (bed) {
        stopCurrentTasks();
        safeSetGoal(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
        
        sleepGoalReachedListener = async () => {
          sleepGoalReachedListener = null;
          const dist = bot.entity.position.distanceTo(bed.position);
          if (dist < 3) {
            try {
              await bot.sleep(bed);
              console.log("💤 AFK Sleep Triggered.");
            } catch (err) {
              console.error("❌ AFK Sleep failed:", err);
            }
          }
        };
        bot.once('goal_reached', sleepGoalReachedListener);
      }
    }
  }, 45000);

  // Loop 3: Random Chat (Optional, based on config)
  chatInterval = setInterval(() => {
    if (!bot.entity || botState !== 'afk' || !config.randomChatEnabled) return;
    const msgs = ["sup?", "anyone on?", "lol", "brb", "nice", "gg", "chilling here"];
    if (Math.random() < 0.65) bot.chat(msgs[Math.floor(Math.random() * msgs.length)]);
  }, 900000 + Math.random() * 600000); // 15-25 minutes interval to bypass anti-spammers

  // Loop 4: Priority Manager loop (5Hz check)
  priorityManagerInterval = setInterval(runPriorityManagerTick, 200);
}

createBot();
