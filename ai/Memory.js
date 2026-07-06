class Memory {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.chatHistory = []; // Array of { role: 'user'|'assistant', name?: string, content: string }
    this.lastIntents = [];  // Array of { intent: string, timestamp: number }
  }

  addMessage(role, content, name = null) {
    this.chatHistory.push({ role, content, name });
    if (this.chatHistory.length > this.maxSize) {
      this.chatHistory.shift();
    }
  }

  addIntent(intent) {
    this.lastIntents.push({ intent, timestamp: Date.now() });
    if (this.lastIntents.length > 5) {
      this.lastIntents.shift();
    }
  }

  getHistory() {
    return this.chatHistory;
  }

  getLastIntents() {
    return this.lastIntents;
  }

  clear() {
    this.chatHistory = [];
    this.lastIntents = [];
  }
}

module.exports = Memory;
