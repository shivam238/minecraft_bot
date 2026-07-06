const https = require('https');

// Helper to make HTTPS requests using standard 'https' module as a fallback if global.fetch is not available,
// or as a robust primary option. Let's use fetch first if available, otherwise fallback to https module.
async function makeRequest(url, options, timeoutMs = 8000) {
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
      throw err;
    }
  } else {
    // Standard Node.js https request fallback
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
        reject(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}

async function callOpenRouter(apiKey, model, messages) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/mineflayer/mineflayer',
    'X-Title': 'Mineflayer AI Bot'
  };

  const body = JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.7,
    max_tokens: 300
  });

  return await makeRequest(url, {
    method: 'POST',
    headers: headers,
    body: body
  }, 8000);
}

class ProviderManager {
  constructor(config) {
    this.config = config;
  }

  async getAIResponse(messages) {
    // Resolve API key
    const apiKey = process.env.OPENROUTER_API_KEY || (this.config.ai && this.config.ai.apiKey);
    if (!apiKey) {
      throw new Error('No OpenRouter API key configured. Set process.env.OPENROUTER_API_KEY or configure in config.json.');
    }

    const primaryModel = (this.config.ai && this.config.ai.primaryModel) || 'google/gemini-2.5-flash';
    const fallbackModel = (this.config.ai && this.config.ai.fallbackModel) || 'meta-llama/llama-3-8b-instruct:free';

    console.log(`🤖 [AI Provider] Querying Primary Model: ${primaryModel}`);
    try {
      const data = await callOpenRouter(apiKey, primaryModel, messages);
      if (data && data.choices && data.choices[0] && data.choices[0].message) {
        return {
          success: true,
          model: primaryModel,
          content: data.choices[0].message.content
        };
      }
      throw new Error('Invalid response structure from primary model');
    } catch (primaryError) {
      console.warn(`⚠️ [AI Provider] Primary model failed: ${primaryError.message}. Retrying with Fallback: ${fallbackModel}`);
      
      try {
        const data = await callOpenRouter(apiKey, fallbackModel, messages);
        if (data && data.choices && data.choices[0] && data.choices[0].message) {
          return {
            success: true,
            model: fallbackModel,
            content: data.choices[0].message.content
          };
        }
        throw new Error('Invalid response structure from fallback model');
      } catch (fallbackError) {
        console.error(`❌ [AI Provider] Fallback model also failed: ${fallbackError.message}`);
        throw new Error(`Failover failed. Primary error: ${primaryError.message}. Fallback error: ${fallbackError.message}`);
      }
    }
  }
}

module.exports = ProviderManager;
