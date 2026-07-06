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

  // Check if AI is configured (API key is present)
  isAIConfigured() {
    return !!this.provider.getApiKey();
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
    
    // Prefix fallback response if triggered by failure or rate limiting
    if (reason && reason !== 'AI disabled or unconfigured') {
      fallbackResult.response = `[API Error Fallback: ${reason}] ` + fallbackResult.response;
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
    
    return `You are an intelligent decision-making AI layer inside a Minecraft Mineflayer bot named "${bot.username}".
Your job is to assist the owner and decide what intent/action to execute.

You MUST respond strictly in the following JSON format:
{
  "response": "A short, conversational response to say in the game (keep it under 80 characters, fit in one chat line).",
  "intent": "follow | guard | afk | stop | goto | sleep | wake | drop | tpa | accept | status | say | none",
  "parameters": {
    "target": "username (optional, for follow/tpa)",
    "coordinates": { "x": number, "y": number, "z": number } (optional, for goto)
  }
}

Capability & Intent mappings:
- "follow": Follow a player. Set parameters.target to the username.
- "guard": Guard the current location of the bot.
- "afk": Turn on smart AFK mode (wandering, look/swing).
- "stop": Stop all tasks and stand still (state set to 'idle').
- "goto": Walk to coordinate coordinates. Set parameters.coordinates to {x, y, z}.
- "sleep": Find a bed and sleep.
- "wake": Wake up from sleep.
- "drop": Drop all inventory items.
- "tpa": Teleport request to a player. Set parameters.target.
- "accept": Accept a pending teleport request.
- "status": Show health, food, position, state.
- "say": Conversational chat or answer. Do NOT change state, just talk.
- "none": Do nothing.

Current Live Bot State:
- Bot Username: ${bot.username}
- Health: ${bot.health}/20 | Food: ${bot.food}/20
- Position: x=${Math.round(bot.entity.position.x)}, y=${Math.round(bot.entity.position.y)}, z=${Math.round(bot.entity.position.z)}
- State: ${botState}
- Follow Target: ${followTarget || "none"}
- Guard Position: ${guardPosition ? `x=${Math.round(guardPosition.x)}, y=${Math.round(guardPosition.y)}, z=${Math.round(guardPosition.z)}` : "none"}
- Is Sleeping: ${bot.isSleeping}
- Time of Day: ${bot.time ? (bot.time.isNight ? "Night" : "Day") : "Unknown"}
- Inventory: ${invSummary}

Remember: Keep the response short, friendly, and matching a Minecraft helper bot personality. Always return the correct JSON structure.`;
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

    let primarySuccess = false;

    // Structured retry and model failover with schema validation
    try {
      const apiKey = this.provider.getApiKey();
      const { primary } = this.provider.getModels();
      
      let data;
      try {
        // Query Primary Model (Attempt 1)
        data = await this.provider.callOpenRouter(apiKey, primary, messages);
      } catch (err) {
        if (this.isTransientError(err)) {
          console.warn(`⚠️ [AIManager] Primary model transient error: ${err.message}. Retrying once...`);
          // Query Primary Model (Attempt 2 - Retry)
          data = await this.provider.callOpenRouter(apiKey, primary, messages);
        } else {
          throw err;
        }
      }
      
      const result = this.provider.parseProviderResponse(data, primary);
      const parsed = parseJSONResponse(result.content);
      responseObj = this.validateResponse(parsed);
      primarySuccess = true;
      
      console.log(`🤖 [AIManager] Primary model response parsed & validated: model=${result.model}, intent=${responseObj.intent}`);
    } catch (err) {
      console.warn(`⚠️ [AIManager] Primary model failed: ${err.message}. Transitioning to fallback model...`);
    }

    if (!primarySuccess) {
      try {
        const apiKey = this.provider.getApiKey();
        const { fallback } = this.provider.getModels();
        
        let data;
        try {
          // Query Fallback Model (Attempt 1)
          data = await this.provider.callOpenRouter(apiKey, fallback, messages);
        } catch (err) {
          if (this.isTransientError(err)) {
            console.warn(`⚠️ [AIManager] Fallback model transient error: ${err.message}. Retrying once...`);
            // Query Fallback Model (Attempt 2 - Retry)
            data = await this.provider.callOpenRouter(apiKey, fallback, messages);
          } else {
            throw err;
          }
        }
        
        const result = this.provider.parseProviderResponse(data, fallback);
        const parsed = parseJSONResponse(result.content);
        responseObj = this.validateResponse(parsed);
        
        console.log(`🤖 [AIManager] Fallback model response parsed & validated: model=${result.model}, intent=${responseObj.intent}`);
      } catch (fallbackErr) {
        console.error(`❌ [AIManager] Fallback model failed: ${fallbackErr.message}`);
        
        // Final failover to Rule Engine
        return this.executeFallback(username, message, `AI failure: ${fallbackErr.message}`);
      }
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
