'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} FailureRecord
 * @property {string} goalType
 * @property {string} skillId
 * @property {string} reason
 * @property {number} timestamp
 * @property {Object} context
 */

/**
 * @typedef {Object} ReflectionResult
 * @property {string} action - 'retry'|'skip'|'replan'|'escalate'|'redirect'
 * @property {string} reason
 * @property {Object} [planAdjustment]
 * @property {{type:string, description:string, parameters:Object, priority:number}} [redirectGoal]
 *   When action==='redirect', create this goal instead of retrying/replanning.
 */

/**
 * Reflection analyses task/goal failures and determines how to respond.
 *
 * Bug fixes in this revision:
 *  #3  Infinite retry/replan loop:
 *      - Retry counter is now per-goal (not per skill), so all retries for a
 *        goal share the same counter.
 *      - After maxRetries failures of gather_wood/movement.walkToNearestTree,
 *        Reflection redirects to a new 'explore_forest' goal instead of
 *        infinite replanning.
 *      - Pattern detection now counts per (goalType+skillId) in the window,
 *        and triggers 'redirect' rather than another 'replan'.
 *
 * @fires Reflection#reflected
 */
class Reflection extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxRetries=3]
   * @param {number} [options.patternWindowMs=300000]
   * @param {number} [options.patternThreshold=3]
   */
  constructor(options = {}) {
    super();
    this.maxRetries = options.maxRetries || 3;
    this.patternWindowMs = options.patternWindowMs || 300000;
    this.patternThreshold = options.patternThreshold || 3;

    /** @type {FailureRecord[]} */
    this.history = [];

    /**
     * Fix #3: Key is goalType (not goalType::skillId) so all skill failures
     * within the same goal share the retry budget.
     * @type {Map<string, number>}
     */
    this.retryCounts = new Map();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Analyse a task failure and return a decision.
   * @param {import('./GoalManager').Goal} goal
   * @param {import('./TaskQueue').Task} task
   * @param {Error} error
   * @param {Object} [context={}]
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

    log.info(`[Reflection] Analysing: ${task.skillId} for [${goal.type}] — "${error.message}"`);

    const result = this._analyse(record, goal, task, error);

    log.info(`[Reflection] Decision: ${result.action} — ${result.reason}`);
    /** @event Reflection#reflected */
    this.emit('reflected', result, record);
    return result;
  }

  /**
   * Record a successful completion — resets retry counter for the GOAL.
   * @param {string} goalType
   * @param {string} _skillId - accepted for API compatibility, not used
   */
  recordSuccess(goalType, _skillId) {
    this.retryCounts.delete(goalType);
  }

  /**
   * Get (goalType, skillId) pairs that are in a failure pattern.
   * @returns {{goalType:string, skillId:string}[]}
   */
  getFailurePatterns() {
    const window = Date.now() - this.patternWindowMs;
    /** @type {Object.<string,number>} */
    const counts = {};
    for (const r of this.history) {
      if (r.timestamp < window) continue;
      const k = `${r.goalType}::${r.skillId}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, n]) => n >= this.patternThreshold)
      .map(([k]) => {
        const [goalType, skillId] = k.split('::');
        return { goalType, skillId };
      });
  }

  /** @returns {Object} */
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
    // Fix #3: key on goalType only — all skill failures for one goal share budget
    const goalKey = goal.type;
    const retries = (this.retryCounts.get(goalKey) || 0) + 1;
    this.retryCounts.set(goalKey, retries);

    // Fix #3: check failure patterns; redirect instead of infinite replan
    const patterns = this.getFailurePatterns();
    const inPattern = patterns.some(p => p.goalType === goal.type && p.skillId === task.skillId);
    if (inPattern) {
      return this._buildRedirect(goal, task, error,
        `Failure pattern detected for ${task.skillId} — redirecting to alternative goal`);
    }

    // Exceeded max retries
    if (retries >= this.maxRetries) {
      const isEssential = ['survive', 'gather_food'].includes(goal.type);
      if (isEssential) {
        return {
          action: 'escalate',
          reason: `Essential goal "${goal.type}" failed ${retries} times — escalating`,
        };
      }
      // Fix #3: instead of skip/replan loop → redirect to an alternative goal
      this.retryCounts.delete(goalKey);
      return this._buildRedirect(goal, task, error,
        `Max retries (${this.maxRetries}) exhausted for ${goal.type} — redirecting`);
    }

    // Transient failure → retry
    if (this._isTransient(error)) {
      return {
        action: 'retry',
        reason: `Transient (${error.message}) — retry ${retries}/${this.maxRetries}`,
      };
    }

    // Precondition failure (missing item, can't find block) → replan once, then redirect
    if (this._isPreconditionFailure(error)) {
      if (retries < this.maxRetries) {
        return {
          action: 'replan',
          reason: `Precondition failure: ${error.message} — replan (${retries}/${this.maxRetries})`,
        };
      }
      return this._buildRedirect(goal, task, error,
        `Precondition unresolvable after ${retries} attempts — redirecting`);
    }

    // Default: retry
    return {
      action: 'retry',
      reason: `Failure (${error.message}) — retry ${retries}/${this.maxRetries}`,
    };
  }

  /**
   * Fix #3: Build a 'redirect' result that tells AutonomousAgent to
   * create a DIFFERENT goal instead of replanning the same one forever.
   *
   * Goal-specific redirect logic:
   *  - gather_wood / walkToNearestTree → explore_forest
   *  - mine_* / walkToNearestOre      → explore (widen search)
   *  - default                         → explore
   */
  _buildRedirect(goal, task, error, reason) {
    let redirectGoal;

    if (
      goal.type === 'gather_wood' ||
      task.skillId === 'movement.walkToNearestTree' ||
      task.skillId === 'mining.chopWood'
    ) {
      redirectGoal = {
        type: 'explore_forest',
        description: 'Explore to find a forest before gathering wood',
        parameters: { radiusStart: 128, maxRadius: 512, purpose: 'tree' },
        priority: goal.priority - 5, // slightly higher priority than gather_wood
      };
    } else if (
      goal.type.startsWith('mine_') ||
      task.skillId === 'movement.walkToNearestOre'
    ) {
      redirectGoal = {
        type: 'explore',
        description: 'Explore to find ore deposits',
        parameters: { radius: 200 },
        priority: 45,
      };
    } else {
      redirectGoal = {
        type: 'explore',
        description: `Explore after ${goal.type} failed repeatedly`,
        parameters: { radius: 128 },
        priority: 50,
      };
    }

    return {
      action: 'redirect',
      reason,
      redirectGoal,
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
      msg.includes('not found') ||
      msg.includes('within')
    );
  }
}

module.exports = Reflection;
