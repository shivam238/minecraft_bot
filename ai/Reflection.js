'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} FailureRecord
 * @property {string} goalType
 * @property {string} skillId
 * @property {string} reason
 * @property {number} timestamp
 * @property {Object} context - snapshot of needs/state at time of failure
 */

/**
 * @typedef {Object} ReflectionResult
 * @property {string} action - 'retry'|'skip'|'replan'|'escalate'
 * @property {string} reason
 * @property {Object} [planAdjustment] - Optional hint for Planner
 */

/**
 * Reflection analyses task/goal failures and determines how to respond:
 * - Retry (transient failure, e.g. network glitch)
 * - Skip (permanently unachievable right now, move on)
 * - Replan (goal is valid but current plan is wrong)
 * - Escalate (critical unrecoverable failure)
 *
 * It also identifies failure patterns over time (e.g. same skill always fails)
 * to prevent infinite retry loops.
 *
 * @fires Reflection#reflected
 */
class Reflection extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxRetries=3] - Max retries before skip/replan
   * @param {number} [options.patternWindowMs=300000] - 5 min window for pattern detection
   * @param {number} [options.patternThreshold=3] - Failures in window before pattern detected
   */
  constructor(options = {}) {
    super();
    this.maxRetries = options.maxRetries || 3;
    this.patternWindowMs = options.patternWindowMs || 300000;
    this.patternThreshold = options.patternThreshold || 3;

    /** @type {FailureRecord[]} */
    this.history = [];

    /** @type {Map<string, number>} goalType+skillId → retry count */
    this.retryCounts = new Map();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Analyse a task failure and return a decision.
   *
   * @param {import('./GoalManager').Goal} goal
   * @param {import('./TaskQueue').Task} task
   * @param {Error} error
   * @param {Object} [context={}] - Snapshot of needs/state at failure time
   * @returns {ReflectionResult}
   */
  reflect(goal, task, error, context = {}) {
    if (!goal || !task || !error) throw new Error('reflect() requires goal, task, and error');

    const record = {
      goalType: goal.type,
      skillId: task.skillId,
      reason: error.message,
      timestamp: Date.now(),
      context,
    };
    this.history.push(record);
    if (this.history.length > 500) this.history.shift();

    log.info(`[Reflection] Analysing failure: ${task.skillId} for goal [${goal.type}] — "${error.message}"`);

    // Determine action
    const result = this._analyse(record, goal, task, error);

    log.info(`[Reflection] Decision: ${result.action} — ${result.reason}`);
    /** @event Reflection#reflected */
    this.emit('reflected', result, record);
    return result;
  }

  /**
   * Record a successful completion (resets retry counters).
   * @param {string} goalType
   * @param {string} skillId
   */
  recordSuccess(goalType, skillId) {
    const key = `${goalType}::${skillId}`;
    this.retryCounts.delete(key);
  }

  /**
   * Get failure patterns (skill IDs that repeatedly fail).
   * @returns {string[]} List of problematic skill IDs
   */
  getFailurePatterns() {
    const window = Date.now() - this.patternWindowMs;
    const counts = {};
    for (const r of this.history) {
      if (r.timestamp < window) continue;
      const k = r.skillId;
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, count]) => count >= this.patternThreshold)
      .map(([skillId]) => skillId);
  }

  /**
   * Full summary for debug/status.
   * @returns {Object}
   */
  getSummary() {
    return {
      totalFailures: this.history.length,
      recentFailures: this.history.slice(-10).map(r => ({
        goalType: r.goalType,
        skillId: r.skillId,
        reason: r.reason,
        ago: `${Math.round((Date.now() - r.timestamp) / 1000)}s ago`,
      })),
      patterns: this.getFailurePatterns(),
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * @param {FailureRecord} record
   * @param {import('./GoalManager').Goal} goal
   * @param {import('./TaskQueue').Task} task
   * @param {Error} error
   * @returns {ReflectionResult}
   */
  _analyse(record, goal, task, error) {
    const key = `${goal.type}::${task.skillId}`;
    const retries = (this.retryCounts.get(key) || 0) + 1;
    this.retryCounts.set(key, retries);

    // Pattern: this skill has failed many times in the recent window
    const patterns = this.getFailurePatterns();
    if (patterns.includes(task.skillId)) {
      return {
        action: 'replan',
        reason: `Failure pattern detected for ${task.skillId} — replanning goal`,
        planAdjustment: { avoidSkill: task.skillId },
      };
    }

    // Exceeded max retries — escalate or skip
    if (retries >= this.maxRetries) {
      const isEssential = ['survive', 'gather_food'].includes(goal.type);
      if (isEssential) {
        return {
          action: 'escalate',
          reason: `Essential goal "${goal.type}" failed ${retries} times — escalating`,
        };
      }
      this.retryCounts.delete(key);
      return {
        action: 'skip',
        reason: `Exceeded max retries (${this.maxRetries}) for ${task.skillId}`,
      };
    }

    // Transient failures — just retry
    if (this._isTransient(error)) {
      return {
        action: 'retry',
        reason: `Transient failure (${error.message}) — retry ${retries}/${this.maxRetries}`,
      };
    }

    // Structural failure (skill precondition, wrong tool, etc.) — replan
    if (this._isPreconditionFailure(error)) {
      return {
        action: 'replan',
        reason: `Precondition failure: ${error.message}`,
      };
    }

    // Default: retry with a small count
    if (retries < this.maxRetries) {
      return {
        action: 'retry',
        reason: `Failure (${error.message}) — retry ${retries}/${this.maxRetries}`,
      };
    }

    return {
      action: 'skip',
      reason: `Unrecoverable failure for ${task.skillId}: ${error.message}`,
    };
  }

  _isTransient(error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('pathfinder') ||
      msg.includes('not loaded') ||
      msg.includes('connection') ||
      msg.includes('busy')
    );
  }

  _isPreconditionFailure(error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('requires') ||
      msg.includes('cannot find') ||
      msg.includes('no ') ||
      msg.includes('missing') ||
      msg.includes('not found')
    );
  }
}

module.exports = Reflection;
