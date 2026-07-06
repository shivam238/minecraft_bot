class Memory {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.chatHistory = []; // Array of { role: 'user'|'assistant', name?: string, content: string }
    this.lastIntents = [];  // Array of { intent: string, timestamp: number }
    this.taskContext = null;
    this.visitedLocations = []; // Bounded array of locations { x, y, z, timestamp }
    this.combatHistory = []; // Bounded array of combat records { target, outcome, timestamp }
    this.ownerState = {}; // Bounded key-value store of owner states
  }

  addMessage(role, content, name = null) {
    // Prevent memory creep by limiting content length
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

  getLastIntents() {
    return this.lastIntents;
  }

  setTaskContext(context) {
    if (typeof context === 'string') {
      this.taskContext = context.substring(0, 1000);
    } else {
      this.taskContext = context;
    }
  }

  getTaskContext() {
    return this.taskContext;
  }

  addLocation(pos) {
    if (!pos || typeof pos.x !== 'number') return;
    this.visitedLocations.push({ x: pos.x, y: pos.y, z: pos.z, timestamp: Date.now() });
    if (this.visitedLocations.length > 10) {
      this.visitedLocations.shift();
    }
  }

  getVisitedLocations() {
    return this.visitedLocations;
  }

  addCombatRecord(record) {
    this.combatHistory.push({ ...record, timestamp: Date.now() });
    if (this.combatHistory.length > 10) {
      this.combatHistory.shift();
    }
  }

  getCombatHistory() {
    return this.combatHistory;
  }

  setOwnerState(username, state) {
    if (!username) return;
    this.ownerState[username] = {
      ...state,
      timestamp: Date.now()
    };
    // Keep ownerState keys bounded
    const keys = Object.keys(this.ownerState);
    if (keys.length > 10) {
      delete this.ownerState[keys[0]];
    }
  }

  getOwnerState(username) {
    return this.ownerState[username] || null;
  }

  clear() {
    this.chatHistory = [];
    this.lastIntents = [];
    this.taskContext = null;
    this.visitedLocations = [];
    this.combatHistory = [];
    this.ownerState = {};
  }
}

module.exports = Memory;
