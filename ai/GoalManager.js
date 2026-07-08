'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {'pending'|'active'|'paused'|'completed'|'failed'|'cancelled'} GoalStatus
 */

/**
 * @typedef {Object} Goal
 * @property {string} id - UUID
 * @property {string} type - e.g. 'gather_resources','survive','explore','build','craft'
 * @property {string} description
 * @property {number} priority - Lower = higher priority (0 = most urgent)
 * @property {GoalStatus} status
 * @property {Object} parameters - Goal-specific config
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [completedAt]
 * @property {string} [failReason]
 * @property {number} attempts - How many times this goal was tried
 */

let _idCounter = 0;
function genId() {
  return `goal_${Date.now()}_${++_idCounter}`;
}

/**
 * GoalManager holds the registry of all bot goals and exposes lifecycle methods
 * to add, activate, complete, fail, pause, and cancel them.
 *
 * It does NOT do planning or execution — that belongs to Planner / TaskQueue.
 *
 * @fires GoalManager#goalAdded
 * @fires GoalManager#goalStatusChanged
 * @fires GoalManager#goalCompleted
 * @fires GoalManager#goalFailed
 */
class GoalManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxGoals=50] - Max goals before oldest completed/failed are purged
   */
  constructor(options = {}) {
    super();
    this.maxGoals = options.maxGoals || 50;
    /** @type {Map<string, Goal>} */
    this.goals = new Map();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Add a new goal. Returns the Goal object.
   * @param {string} type
   * @param {string} description
   * @param {Object} [parameters={}]
   * @param {number} [priority=50]
   * @returns {Goal}
   */
  addGoal(type, description, parameters = {}, priority = 50) {
    if (!type || !description) throw new Error('GoalManager.addGoal requires type and description');

    this._enforceCap();

    const goal = {
      id: genId(),
      type,
      description,
      priority,
      status: 'pending',
      parameters,
      createdAt: Date.now(),
      attempts: 0,
    };

    this.goals.set(goal.id, goal);
    log.info(`[GoalManager] Added goal [${goal.type}] "${goal.description}" (priority ${priority})`);
    /** @event GoalManager#goalAdded */
    this.emit('goalAdded', goal);
    return goal;
  }

  /**
   * Get the highest-priority pending or paused goal.
   * @returns {Goal|null}
   */
  getNextGoal() {
    let best = null;
    for (const goal of this.goals.values()) {
      if (goal.status !== 'pending' && goal.status !== 'paused') continue;
      if (!best || goal.priority < best.priority) best = goal;
    }
    return best;
  }

  /**
   * Get the currently active goal (only one at a time).
   * @returns {Goal|null}
   */
  getActiveGoal() {
    for (const goal of this.goals.values()) {
      if (goal.status === 'active') return goal;
    }
    return null;
  }

  /**
   * Activate a goal by ID (marks as 'active', pauses any other active goal).
   * @param {string} goalId
   * @returns {Goal}
   */
  activateGoal(goalId) {
    const goal = this._get(goalId);
    // Pause any currently active goal
    for (const g of this.goals.values()) {
      if (g.status === 'active' && g.id !== goalId) {
        this._setStatus(g, 'paused');
      }
    }
    goal.startedAt = Date.now();
    goal.attempts++;
    this._setStatus(goal, 'active');
    return goal;
  }

  /**
   * Mark a goal as completed.
   * @param {string} goalId
   * @returns {Goal}
   */
  completeGoal(goalId) {
    const goal = this._get(goalId);
    goal.completedAt = Date.now();
    this._setStatus(goal, 'completed');
    /** @event GoalManager#goalCompleted */
    this.emit('goalCompleted', goal);
    return goal;
  }

  /**
   * Mark a goal as failed with a reason.
   * @param {string} goalId
   * @param {string} [reason='Unknown']
   * @returns {Goal}
   */
  failGoal(goalId, reason = 'Unknown') {
    const goal = this._get(goalId);
    goal.failReason = reason;
    this._setStatus(goal, 'failed');
    log.warn(`[GoalManager] Goal failed: "${goal.description}" — ${reason}`);
    /** @event GoalManager#goalFailed */
    this.emit('goalFailed', goal);
    return goal;
  }

  /**
   * Cancel a goal (intentional removal).
   * @param {string} goalId
   * @returns {Goal}
   */
  cancelGoal(goalId) {
    const goal = this._get(goalId);
    this._setStatus(goal, 'cancelled');
    return goal;
  }

  /**
   * Pause the currently active goal (e.g. survival emergency).
   */
  pauseActive() {
    const active = this.getActiveGoal();
    if (active) this._setStatus(active, 'paused');
  }

  /**
   * Get all goals of a given status.
   * @param {GoalStatus} status
   * @returns {Goal[]}
   */
  getByStatus(status) {
    return [...this.goals.values()].filter(g => g.status === status);
  }

  /**
   * Remove a goal from the registry.
   * @param {string} goalId
   */
  remove(goalId) {
    this.goals.delete(goalId);
  }

  /**
   * Serialisable summary for status/Reflection.
   * @returns {Object[]}
   */
  getSummary() {
    return [...this.goals.values()].map(g => ({
      id: g.id,
      type: g.type,
      description: g.description,
      status: g.status,
      priority: g.priority,
      attempts: g.attempts,
      failReason: g.failReason,
    }));
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  _get(goalId) {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`GoalManager: goal not found: ${goalId}`);
    return goal;
  }

  _setStatus(goal, status) {
    const old = goal.status;
    goal.status = status;
    if (old !== status) {
      log.info(`[GoalManager] [${goal.type}] "${goal.description}": ${old} → ${status}`);
      /** @event GoalManager#goalStatusChanged */
      this.emit('goalStatusChanged', goal, old);
    }
  }

  _enforceCap() {
    if (this.goals.size < this.maxGoals) return;
    // Evict oldest completed/failed/cancelled
    const evictable = [...this.goals.values()]
      .filter(g => ['completed','failed','cancelled'].includes(g.status))
      .sort((a, b) => (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt));
    if (evictable.length > 0) {
      this.goals.delete(evictable[0].id);
    }
  }
}

module.exports = GoalManager;
