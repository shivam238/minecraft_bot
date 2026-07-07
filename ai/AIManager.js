const Memory = require('./Memory');
const ProviderManager = require('./ProviderManager');

// Helper function to safely parse JSON from AI response, handling markdown blocks and whitespace
function parseJSONResponse(text) {
  if (!text) {
    throw new Error('Empty response text');
  }
  try {
    return JSON.parse(text.trim());
  } catch (e) {
    // Try extracting JSON block if wrapped in markdown formatting
    const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch (e2) {
        // Continue
      }
    }
    // Try finding outer braces
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch (e3) {
        // Continue
      }
    }
    throw new Error(`Failed to parse AI output as JSON. Output was: ${text}`);
  }
}

class AIManager {
  constructor(config) {
    this.config = config;
    this.memory = new Memory(10);
    this.provider = new ProviderManager(config);
    this.cache = new Map(); // Cache key -> { value, timestamp }
    this.userRequestTimes = new Map(); // Username -> Array of timestamps
    this.cacheCleanupInterval = null;
    this.startCacheCleanup();
  }

  // Update configuration dynamically (e.g. if config.json changes)
  updateConfig(newConfig) {
    this.config = newConfig;
    this.provider.updateConfig(newConfig);
    this.startCacheCleanup();
  }

  startCacheCleanup() {
    this.stopCacheCleanup();
    if (!this.cache) return;

    const intervalMs = (this.config.ai && this.config.ai.cacheCleanupIntervalMs) || 30000;
    if (intervalMs > 0) {
      this.cacheCleanupInterval = setInterval(() => {
        this.cleanupCache();
      }, intervalMs);
    }
  }

  stopCacheCleanup() {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }
  }

  cleanupCache() {
    if (!this.cache) {
      this.stopCacheCleanup();
      return;
    }
    const now = Date.now();
    const ttl = (this.config.ai && this.config.ai.cacheTTL) || 10000;
    let expiredCount = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > ttl) {
        this.cache.delete(key);
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      console.log(`🧹 [AIManager] Cleaned up ${expiredCount} expired cache entries.`);
    }
  }

  // Check if AI is configured (any provider key is present)
  isAIConfigured() {
    return this.provider.hasAnyKey();
  }

  // Check if AI is enabled in configuration
  isAIEnabled() {
    return !!(this.config.ai && this.config.ai.enabled);
  }

  // Rate limiting check per user
  checkRateLimit(username) {
    const now = Date.now();
    if (!this.userRequestTimes.has(username)) {
      this.userRequestTimes.set(username, []);
    }
    const timestamps = this.userRequestTimes.get(username);
    
    const windowMs = (this.config.ai && this.config.ai.rateLimitWindowMs) || 60000;
    const maxRequests = (this.config.ai && this.config.ai.rateLimitMaxRequests) || 5;
    
    // Filter timestamps to keep only those within current window
    const filtered = timestamps.filter(t => now - t < windowMs);
    this.userRequestTimes.set(username, filtered);
    
    if (filtered.length >= maxRequests) {
      return false; // Rate limit exceeded
    }
    
    filtered.push(now);
    return true;
  }

  // Get cached response if still valid (TTL check)
  getFromCache(key) {
    if (!this.cache.has(key)) return null;
    const entry = this.cache.get(key);
    const ttl = (this.config.ai && this.config.ai.cacheTTL) || 10000;
    
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  // Store response in cache with size bounds check
  setInCache(key, value) {
    const maxSize = (this.config.ai && this.config.ai.cacheMaxSize) || 50;
    if (this.cache.size >= maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  // Validate the intent and structure of the parsed response
  validateResponse(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Parsed response is not an object');
    }
    if (typeof parsed.response !== 'string') {
      throw new Error('Response is missing or not a string');
    }
    const allowedIntents = [
      'follow', 'guard', 'afk', 'stop', 'goto', 'sleep', 
      'wake', 'drop', 'tpa', 'accept', 'status', 'say', 'none'
    ];
    if (!allowedIntents.includes(parsed.intent)) {
      throw new Error(`Invalid intent returned: ${parsed.intent}`);
    }
    if (parsed.parameters && typeof parsed.parameters !== 'object') {
      throw new Error('Parameters is not an object');
    }
    if (parsed.intent === 'goto') {
      const coords = parsed.parameters && parsed.parameters.coordinates;
      if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number' || typeof coords.z !== 'number') {
        throw new Error('goto intent requires coordinates {x, y, z}');
      }
    }
    if ((parsed.intent === 'follow' || parsed.intent === 'tpa') && (!parsed.parameters || !parsed.parameters.target)) {
      throw new Error(`${parsed.intent} intent requires parameters.target`);
    }
    return parsed;
  }

  // Local Rule Engine Fallback parser for NLP when AI is offline or disabled
  parseRuleEngineFallback(username, message) {
    const msg = message.toLowerCase();
    
    let intent = 'say';
    let response = `🤖 [Rule Engine] Received: "${message}"`;
    let parameters = {};

    if (msg.includes('follow') || msg.includes('come')) {
      intent = 'follow';
      const words = msg.split(/\s+/);
      const idx = words.findIndex(w => w === 'follow' || w === 'come');
      let target = username;
      if (idx !== -1 && words[idx + 1] && words[idx + 1] !== 'me') {
        target = words[idx + 1].replace(/[^\w]/g, '');
      }
      parameters.target = target;
      response = `🏃 [Rule Engine] Understood. Following ${target}.`;
    } else if (msg.includes('guard') || msg.includes('protect') || msg.includes('stay here')) {
      intent = 'guard';
      response = `🛡️ [Rule Engine] Understood. Guarding my current position.`;
    } else if (msg.includes('afk') || msg.includes('wander') || msg.includes('relax')) {
      intent = 'afk';
      response = `🤖 [Rule Engine] Understood. Entering smart AFK mode.`;
    } else if (msg.includes('stop') || msg.includes('halt') || msg.includes('stand still')) {
      intent = 'stop';
      response = `🛑 [Rule Engine] Understood. Stopping all tasks.`;
    } else if (msg.includes('goto') || msg.includes('go to') || msg.includes('move to')) {
      intent = 'goto';
      const coords = message.match(/-?\d+(\.\d+)?/g);
      if (coords && coords.length >= 3) {
        const x = parseFloat(coords[0]);
        const y = parseFloat(coords[1]);
        const z = parseFloat(coords[2]);
        parameters.coordinates = { x, y, z };
        response = `🧭 [Rule Engine] Understood. Heading to: ${x}, ${y}, ${z}`;
      } else {
        intent = 'say';
        response = `🧭 [Rule Engine] Failed to parse coordinates. Usage example: go to 100 64 -200`;
      }
    } else if (msg.includes('sleep') || msg.includes('bed')) {
      intent = 'sleep';
      response = `🛌 [Rule Engine] Understood. Searching for a bed to sleep.`;
    } else if (msg.includes('wake')) {
      intent = 'wake';
      response = `☀️ [Rule Engine] Understood. Waking up.`;
    } else if (msg.includes('drop') || msg.includes('toss')) {
      intent = 'drop';
      response = `📦 [Rule Engine] Understood. Dropping inventory items.`;
    } else if (msg.includes('tpa') || msg.includes('teleport to')) {
      intent = 'tpa';
      const words = msg.split(/\s+/);
      const idx = words.findIndex(w => w === 'tpa' || w === 'teleport');
      let target = username;
      if (idx !== -1 && words[idx + 1] && words[idx + 1] !== 'to') {
        target = words[idx + 1].replace(/[^\w]/g, '');
      } else if (idx !== -1 && words[idx + 2]) {
        target = words[idx + 2].replace(/[^\w]/g, '');
      }
      parameters.target = target;
      response = `⚡ [Rule Engine] Understood. Sending teleport request to ${target}.`;
    } else if (msg.includes('accept')) {
      intent = 'accept';
      response = `⚡ [Rule Engine] Understood. Accepting teleport request.`;
    } else if (msg.includes('status') || msg.includes('hp') || msg.includes('health') || msg.includes('inventory')) {
      intent = 'status';
      response = ''; // Executed in bot.js status code
    } else {
      response = `🤖 [Rule Engine] Hello ${username}. My OpenRouter API is offline or key is unconfigured. I am operating under fallback Rules. Use prefix ! for direct command control.`;
    }

    return { response, intent, parameters };
  }

  // Helper to execute Rule Engine fallback and update memory
  executeFallback(username, message, reason) {
    const fallbackResult = this.parseRuleEngineFallback(username, message);

    // Log the full error server-side only — never dump API errors into in-game chat
    // (long messages exceed Minecraft's 256-char limit and disconnect the bot)
    if (reason && reason !== 'AI disabled or unconfigured') {
      console.warn(`[AIManager] Fallback triggered: ${reason}`);
      // Replace the verbose rule-engine message with a short, safe one
      if (fallbackResult.intent === 'say' || !fallbackResult.intent) {
        fallbackResult.response = `AI offline, using commands. (type !help)`;
      }
    }

    this.memory.addMessage('assistant', fallbackResult.response);
    if (fallbackResult.intent && fallbackResult.intent !== 'none') {
      this.memory.addIntent(fallbackResult.intent);
    }

    return fallbackResult;
  }

  // Build current system prompt based on bot's live state
  buildSystemPrompt(bot, botState, followTarget, guardPosition) {
    const items = bot.inventory.items();
    const invSummary = items.map(i => `${i.count}x ${i.name}`).join(', ') || 'empty';

    // Nearby players (excluding the bot itself)
    const nearbyPlayers = Object.values(bot.players || {})
      .filter(p => p.username !== bot.username && p.entity)
      .map(p => {
        const dist = Math.round(bot.entity.position.distanceTo(p.entity.position));
        return `${p.username} (${dist}m away)`;
      });
    const nearbyPlayersStr = nearbyPlayers.length > 0 ? nearbyPlayers.join(', ') : 'none';

    // Nearby hostile mobs
    const hostileNames = ['zombie','skeleton','spider','creeper','witch','phantom','drowned','husk','stray','zombie_villager'];
    const nearbyHostiles = [];
    try {
      const mob = bot.nearestEntity(e =>
        e.type === 'mob' &&
        hostileNames.includes(e.name) &&
        bot.entity.position.distanceTo(e.position) < 20
      );
      if (mob) nearbyHostiles.push(`${mob.name} (${Math.round(bot.entity.position.distanceTo(mob.position))}m)`);
    } catch (_) {}
    const nearbyHostilesStr = nearbyHostiles.length > 0 ? nearbyHostiles.join(', ') : 'none';

    // Weather
    let weather = 'clear';
    try {
      if (bot.isRaining) weather = bot.thunderState > 0 ? 'thunderstorm' : 'raining';
    } catch (_) {}

    // Time
    let timeStr = 'unknown';
    try {
      if (bot.time) {
        const t = bot.time.timeOfDay;
        if (t < 1000 || t > 23000) timeStr = 'sunrise';
        else if (t < 6000) timeStr = 'morning';
        else if (t < 12000) timeStr = 'afternoon';
        else if (t < 13000) timeStr = 'sunset';
        else timeStr = 'night';
      }
    } catch (_) {}

    return `You are a Minecraft bot named "${bot.username}" — a chill, helpful player who talks like a real person.
Respond naturally and casually. You can speak in English or mix in Hinglish if the player does.
Keep replies SHORT (under 80 chars). Never sound like a robot or assistant.
If anyone asks who made you, who is your creator/developer/maker, or "kisne banaya", always say: "Shivam Kumar Mahto ne banaya hai mujhe :)"

You MUST always reply in this exact JSON format:
{
  "response": "what you say in chat (short, natural, under 80 chars)",
  "intent": "follow | guard | afk | stop | goto | sleep | wake | drop | tpa | accept | status | say | none",
  "parameters": {
    "target": "username (for follow/tpa)",
    "coordinates": { "x": number, "y": number, "z": number }
  }
}

Intents:
- follow: follow a player (set parameters.target)
- guard: guard current spot
- afk: start wandering/AFK mode
- stop: stand still, stop everything
- goto: walk to coords (set parameters.coordinates)
- sleep: go find a bed and sleep
- wake: wake up
- drop: drop all items
- tpa: send teleport request (set parameters.target)
- accept: accept a tp request
- status: show HP, food, position
- say: just chat, don't change state
- none: do nothing, just respond

Current state:
- Name: ${bot.username} | Health: ${bot.health}/20 | Food: ${bot.food}/20
- Position: ${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}
- Mode: ${botState}${followTarget ? ` (following ${followTarget})` : ''}${guardPosition ? ` (guarding ${Math.round(guardPosition.x)},${Math.round(guardPosition.y)},${Math.round(guardPosition.z)})` : ''}
- Sleeping: ${bot.isSleeping} | Time: ${timeStr} | Weather: ${weather}
- Nearby players: ${nearbyPlayersStr}
- Nearby hostiles: ${nearbyHostilesStr}
- Inventory: ${invSummary}`;
  }

  // Build the messages history payload including system prompt
  buildMessages(bot, botState, followTarget, guardPosition, username, message) {
    const systemPrompt = this.buildSystemPrompt(bot, botState, followTarget, guardPosition);
    return [
      { role: 'system', content: systemPrompt },
      ...this.memory.getHistory()
    ];
  }

  // Core orchestration entry point
  async processMessage(bot, botState, followTarget, guardPosition, username, message) {
    this.memory.addMessage('user', message, username);

    // Rate Limiting Check
    if (!this.checkRateLimit(username)) {
      console.warn(`⚠️ [AIManager] Rate limit exceeded for user: ${username}. Falling back to Rule Engine...`);
      return this.executeFallback(username, message, 'Rate limit exceeded');
    }

    // In-memory Cache Lookup
    const cacheKey = `${botState}:${followTarget || 'none'}:${message.trim().toLowerCase()}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log(`💾 [AIManager] Cache hit for message: "${message}"`);
      this.memory.addMessage('assistant', cached.response);
      if (cached.intent && cached.intent !== 'none') {
        this.memory.addIntent(cached.intent);
      }
      return cached;
    }

    // Fallback if AI disabled or key missing
    if (!this.isAIEnabled() || !this.isAIConfigured()) {
      console.log(`🔌 [AIManager] AI is disabled/unconfigured. Falling back to Rule Engine NLP parser...`);
      return this.executeFallback(username, message, 'AI disabled or unconfigured');
    }

    const messages = this.buildMessages(bot, botState, followTarget, guardPosition, username, message);
    let responseObj;

    // Try all configured providers in order (OpenRouter → Gemini → OpenAI → Grok).
    // Parse + schema validation runs inside the chain so a bad response from one
    // provider causes the next provider to be tried rather than falling to rule engine.
    try {
      const { model, value } = await this.provider.callWithFallbackChain(messages, (content) => {
        const parsed = parseJSONResponse(content);
        return this.validateResponse(parsed);
      });
      responseObj = value;
      console.log(`🤖 [AIManager] Response validated: model=${model}, intent=${responseObj.intent}`);
    } catch (err) {
      console.error(`❌ [AIManager] All providers failed: ${err.message}`);
      return this.executeFallback(username, message, `AI failure: ${err.message}`);
    }

    // Success path: update memory, cache response, and return
    this.memory.addMessage('assistant', responseObj.response || "");
    if (responseObj.intent && responseObj.intent !== 'none') {
      this.memory.addIntent(responseObj.intent);
    }

    this.setInCache(cacheKey, responseObj);
    return responseObj;
  }

  isTransientError(err) {
    if (!err) return false;
    const message = typeof err === 'string' ? err : (err.message || '');
    
    // Timeout check
    if (message.includes('timeout') || message.includes('Timeout') || message.includes('ETIMEDOUT') || message.includes('ESOCKETTIMEDOUT')) {
      return true;
    }
    
    // Network errors check
    const networkCodes = ['ECONNRESET', 'EADDRINUSE', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN', 'FETCH_ERROR'];
    if (networkCodes.some(code => message.includes(code))) {
      return true;
    }
    if (err.code && networkCodes.includes(err.code)) {
      return true;
    }
    if (message.includes('network error') || message.includes('Network error') || message.includes('fetch failed')) {
      return true;
    }
    
    // HTTP status codes check (429, 5xx)
    const httpStatusMatch = message.match(/HTTP\s+(\d+)/i);
    if (httpStatusMatch) {
      const status = parseInt(httpStatusMatch[1], 10);
      if (status === 429 || (status >= 500 && status < 600)) {
        return true;
      }
    }
    
    return false;
  }
}

module.exports = AIManager;
