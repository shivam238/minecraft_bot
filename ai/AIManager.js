const Memory = require('./Memory');
const ProviderManager = require('./ProviderManager');

function parseJSONResponse(text) {
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
  }

  // Update configuration dynamically (e.g. if config.json changes)
  updateConfig(newConfig) {
    this.config = newConfig;
    this.provider.config = newConfig;
  }

  // Local Rule Engine Fallback parser for NLP when AI is offline or disabled
  parseRuleEngineFallback(username, message) {
    const msg = message.toLowerCase();
    
    let intent = 'say';
    let response = `🤖 [Rule Engine] Received: "${message}"`;
    let parameters = {};

    if (msg.includes('follow') || msg.includes('come')) {
      intent = 'follow';
      // Try to extract name, or fallback to sender
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
      // Attempt to extract 3 numbers
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
      // Default conversational response fallback
      response = `🤖 [Rule Engine] Hello ${username}. My OpenRouter API is offline or key is unconfigured. I am operating under fallback Rules. Use prefix ! for direct command control.`;
    }

    return { response, intent, parameters };
  }

  // Get current system prompt based on bot's live state
  getSystemPrompt(bot, botState, followTarget, guardPosition) {
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

  // Orchestrate prompt construction, api call, and parsing
  async processMessage(bot, botState, followTarget, guardPosition, username, message) {
    this.memory.addMessage('user', message, username);

    const isAIConfigured = !!(process.env.OPENROUTER_API_KEY || (this.config.ai && this.config.ai.apiKey));
    const isAIEnabled = !!(this.config.ai && this.config.ai.enabled);

    // If AI is disabled or not configured, immediately use Rule Engine Fallback
    if (!isAIEnabled || !isAIConfigured) {
      console.log(`🔌 [AIManager] AI is disabled/unconfigured. Falling back to Rule Engine NLP parser...`);
      const fallbackResult = this.parseRuleEngineFallback(username, message);
      this.memory.addMessage('assistant', fallbackResult.response);
      if (fallbackResult.intent && fallbackResult.intent !== 'none') {
        this.memory.addIntent(fallbackResult.intent);
      }
      return fallbackResult;
    }

    // Build the message history for chat completion
    const systemMessage = {
      role: 'system',
      content: this.getSystemPrompt(bot, botState, followTarget, guardPosition)
    };

    const messages = [
      systemMessage,
      ...this.memory.getHistory()
    ];

    try {
      const result = await this.provider.getAIResponse(messages);
      const parsed = parseJSONResponse(result.content);
      
      console.log(`🤖 [AIManager] AI response received: model=${result.model}, intent=${parsed.intent}`);
      
      this.memory.addMessage('assistant', parsed.response || "");
      if (parsed.intent && parsed.intent !== 'none') {
        this.memory.addIntent(parsed.intent);
      }

      return {
        response: parsed.response || "",
        intent: parsed.intent || "none",
        parameters: parsed.parameters || {}
      };
    } catch (err) {
      console.error(`⚠️ [AIManager] AI Provider failover failed: ${err.message}. Falling back to Rule Engine NLP parser...`);
      
      // Ultimate fallback: Rule Engine NLP parser
      const fallbackResult = this.parseRuleEngineFallback(username, message);
      
      // Prefix response to notify user that it's a fallback due to API failure
      fallbackResult.response = `[API Error Fallback] ` + fallbackResult.response;
      
      this.memory.addMessage('assistant', fallbackResult.response);
      if (fallbackResult.intent && fallbackResult.intent !== 'none') {
        this.memory.addIntent(fallbackResult.intent);
      }
      
      return fallbackResult;
    }
  }
}

module.exports = AIManager;
