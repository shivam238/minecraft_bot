const https = require('https');

// All supported providers — tried in order if previous one fails
const PROVIDER_CONFIGS = [
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    // uses primaryModel/fallbackModel from config — handled separately
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/mineflayer/mineflayer',
      'X-Title': 'Mineflayer AI Bot',
    },
  },
  {
    name: 'Gemini',
    envKey: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
  },
  {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
  },
  {
    name: 'Grok',
    envKey: 'GROK_API_KEY',
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-3-mini-fast',
  },
];

class ProviderManager {
  constructor(config) {
    this.config = config;
  }

  updateConfig(newConfig) {
    this.config = newConfig;
  }

  // Returns the OpenRouter key (env or config.json fallback)
  getApiKey() {
    return process.env.OPENROUTER_API_KEY || (this.config.ai && this.config.ai.apiKey);
  }

  // Returns true if ANY provider key is available (env or config.json)
  hasAnyKey() {
    // Check all env-based provider keys
    if (PROVIDER_CONFIGS.some((p) => !!process.env[p.envKey])) return true;
    // Also accept config.json apiKey as OpenRouter fallback
    return !!(this.config.ai && this.config.ai.apiKey);
  }

  getTimeout() {
    return (this.config.ai && this.config.ai.timeoutMs) || 8000;
  }

  getModels() {
    return {
      primary: (this.config.ai && this.config.ai.primaryModel) || 'google/gemini-2.5-flash',
      fallback: (this.config.ai && this.config.ai.fallbackModel) || 'meta-llama/llama-3-8b-instruct:free',
    };
  }

  buildHeaders(apiKey, extra = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extra,
    };
  }

  buildRequestBody(model, messages) {
    const temperature =
      this.config.ai && this.config.ai.temperature !== undefined
        ? this.config.ai.temperature
        : 0.7;
    const maxTokens = (this.config.ai && this.config.ai.maxTokens) || 300;
    return JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
  }

  async executeRequest(url, options, timeoutMs) {
    if (typeof globalThis.fetch === 'function') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }
        return await response.json();
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error(`Request timeout after ${timeoutMs}ms`);
        throw err;
      }
    } else {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const reqOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers: options.headers || {},
          timeout: timeoutMs,
        };
        const req = https.request(reqOptions, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(new Error(`Failed to parse JSON: ${e.message}`)); }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
        if (options.body) req.write(options.body);
        req.end();
      });
    }
  }

  // Call a specific URL/model/key combination
  async callEndpoint(url, apiKey, model, messages, extraHeaders = {}) {
    const headers = this.buildHeaders(apiKey, extraHeaders);
    const body = this.buildRequestBody(model, messages);
    return this.executeRequest(url, { method: 'POST', headers, body }, this.getTimeout());
  }

  // Legacy method — still used by AIManager's internal retry logic for OpenRouter
  async callOpenRouter(apiKey, model, messages) {
    return this.callEndpoint(
      'https://openrouter.ai/api/v1/chat/completions',
      apiKey,
      model,
      messages,
      { 'HTTP-Referer': 'https://github.com/mineflayer/mineflayer', 'X-Title': 'Mineflayer AI Bot' }
    );
  }

  parseProviderResponse(data, modelName) {
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return { success: true, model: modelName, content: data.choices[0].message.content };
    }
    throw new Error(`Invalid response structure from model ${modelName}`);
  }

  // Try every configured provider in order until one succeeds.
  // Optional `processCallback(content)` callback is called with raw content string;
  // if it throws (e.g. JSON parse or schema validation failure) that provider
  // is treated as failed and the next one is tried.
  // Returns { model, content, value } where value is what processCallback() returned
  // (or undefined if no process callback was supplied).
  async callWithFallbackChain(messages, processCallback = null) {
    const { primary, fallback } = this.getModels();
    const errors = [];

    for (const provider of PROVIDER_CONFIGS) {
      // Resolve key: env var first, then config.json fallback for OpenRouter
      const key =
        process.env[provider.envKey] ||
        (provider.name === 'OpenRouter'
          ? this.config.ai && this.config.ai.apiKey
          : null);
      if (!key) continue;

      if (provider.name === 'OpenRouter') {
        // OpenRouter: try primary model, then fallback model
        for (const [modelName, isLast] of [[primary, false], [fallback, true]]) {
          try {
            console.log(`🤖 [AI] Trying OpenRouter → ${modelName}`);
            const data = await this.callOpenRouter(key, modelName, messages);
            const result = this.parseProviderResponse(data, modelName);
            const value = processCallback ? processCallback(result.content) : undefined;
            console.log(`✅ [AI] OpenRouter responded (${modelName})`);
            return { model: modelName, content: result.content, value };
          } catch (err) {
            const label = isLast ? 'OpenRouter (both models)' : `OpenRouter primary (${modelName})`;
            console.warn(`⚠️ [AI] ${label} failed: ${err.message}`);
            if (isLast) errors.push(`OpenRouter: ${err.message}`);
            // if not last, loop continues to fallback model
          }
        }
      } else {
        try {
          console.log(`🤖 [AI] Trying ${provider.name} → ${provider.model}`);
          const data = await this.callEndpoint(
            provider.url, key, provider.model, messages, provider.extraHeaders || {}
          );
          const result = this.parseProviderResponse(data, provider.model);
          const value = processCallback ? processCallback(result.content) : undefined;
          console.log(`✅ [AI] ${provider.name} responded (${provider.model})`);
          return { model: provider.model, content: result.content, value };
        } catch (err) {
          console.warn(`⚠️ [AI] ${provider.name} failed: ${err.message}`);
          errors.push(`${provider.name}: ${err.message}`);
        }
      }
    }

    throw new Error(`All providers failed — ${errors.join(' | ')}`);
  }

  // Check which providers are currently configured (for status display)
  getConfiguredProviders() {
    return PROVIDER_CONFIGS.filter((p) => !!process.env[p.envKey]).map((p) => p.name);
  }
}

module.exports = ProviderManager;
