const https = require('https');

class ProviderManager {
  constructor(config) {
    this.config = config;
  }

  // Update configuration dynamically (e.g. if config.json changes)
  updateConfig(newConfig) {
    this.config = newConfig;
  }

  // Retrieve the API key from env or config
  getApiKey() {
    return process.env.OPENROUTER_API_KEY || (this.config.ai && this.config.ai.apiKey);
  }

  // Get network request timeout in milliseconds
  getTimeout() {
    return (this.config.ai && this.config.ai.timeoutMs) || 8000;
  }

  // Get models configured for primary and fallback
  getModels() {
    return {
      primary: (this.config.ai && this.config.ai.primaryModel) || 'google/gemini-2.5-flash',
      fallback: (this.config.ai && this.config.ai.fallbackModel) || 'meta-llama/llama-3-8b-instruct:free'
    };
  }

  // Build standard API headers
  buildHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/mineflayer/mineflayer',
      'X-Title': 'Mineflayer AI Bot'
    };
  }

  // Build stringified request body
  buildRequestBody(model, messages) {
    const temperature = (this.config.ai && this.config.ai.temperature) !== undefined
      ? this.config.ai.temperature
      : 0.7;
    const maxTokens = (this.config.ai && this.config.ai.maxTokens) || 300;

    return JSON.stringify({
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens
    });
  }

  // Robust request handler with AbortController timeout logic
  async executeRequest(url, options, timeoutMs) {
    if (typeof globalThis.fetch === 'function') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }
        return await response.json();
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw err;
      }
    } else {
      // Standard Node.js HTTPS request fallback
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const reqOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers: options.headers || {},
          timeout: timeoutMs
        };

        const req = https.request(reqOptions, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Failed to parse JSON response: ${e.message}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request timeout after ${timeoutMs}ms`));
        });

        if (options.body) {
          req.write(options.body);
        }
        req.end();
      });
    }
  }

  // Request completions using specified model
  async callOpenRouter(apiKey, model, messages) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const headers = this.buildHeaders(apiKey);
    const body = this.buildRequestBody(model, messages);
    const timeout = this.getTimeout();

    return await this.executeRequest(url, {
      method: 'POST',
      headers: headers,
      body: body
    }, timeout);
  }

  // Parse and validate the response structure from provider
  parseProviderResponse(data, modelName) {
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return {
        success: true,
        model: modelName,
        content: data.choices[0].message.content
      };
    }
    throw new Error(`Invalid response structure from model ${modelName}`);
  }

  // Primary model execution with failover to fallback model
  async getAIResponse(messages) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('No OpenRouter API key configured. Set process.env.OPENROUTER_API_KEY or configure in config.json.');
    }

    const { primary, fallback } = this.getModels();

    console.log(`🤖 [AI Provider] Querying Primary Model: ${primary}`);
    try {
      const data = await this.callOpenRouter(apiKey, primary, messages);
      return this.parseProviderResponse(data, primary);
    } catch (primaryError) {
      console.warn(`⚠️ [AI Provider] Primary model failed: ${primaryError.message}. Retrying with Fallback: ${fallback}`);
      
      try {
        const data = await this.callOpenRouter(apiKey, fallback, messages);
        return this.parseProviderResponse(data, fallback);
      } catch (fallbackError) {
        console.error(`❌ [AI Provider] Fallback model also failed: ${fallbackError.message}`);
        throw new Error(`Failover failed. Primary error: ${primaryError.message}. Fallback error: ${fallbackError.message}`);
      }
    }
  }
}

module.exports = ProviderManager;
