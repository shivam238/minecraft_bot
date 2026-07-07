class Memory {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.chatHistory = [];
    this.lastIntents = [];
  }

  addMessage(role, content, name = null) {
    const sanitizedContent = typeof content === 'string' ? content.substring(0, 1000) : '';
    this.chatHistory.push({ role, content: sanitizedContent, name });
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
}

module.exports = Memory;
