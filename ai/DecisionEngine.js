'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} Decision
 * @property {string} goalType - Which goal to pursue next
 * @property {Object} parameters - Goal parameters
 * @property {number} priority - Computed priority score
 * @property {string} reason - Why this decision was made
 */

/**
 * DecisionEngine continuously evaluates the bot's current NeedsSystem state
 * and GoalManager's active goals, then selects the highest-priority goal to pursue.
 *
 * Priority Logic (lower number = higher priority):
 *  1. CRITICAL needs → survival goals override everything
 *  2. HIGH needs     → resource gathering
 *  3. Active paused goals (resume before creating new)
 *  4. Default autonomous loop goals
 *
 * The engine runs on a fixed interval and emits `decision` when a new goal
 * should be activated. It does NOT activate goals itself — GoalManager does.
 *
 * @fires DecisionEngine#decision
 * @fires DecisionEngine#idle
 */
class DecisionEngine extends EventEmitter {
  /**
   * @param {import('./GoalManager')} goalManager
   * @param {import('./NeedsSystem')} needsSystem
   * @param {import('./WorldMemory')} worldMemory
   * @param {Object} [options]
   * @param {number} [options.evaluateIntervalMs=5000]
   */
  constructor(goalManager, needsSystem, worldMemory, options = {}) {
    super();
    this.goalManager = goalManager;
    this.needsSystem = needsSystem;
    this.worldMemory = worldMemory;
    this.evaluateIntervalMs = options.evaluateIntervalMs || 5000;
    this._interval = null;
    this.bot = null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the decision loop.
   * @param {import('mineflayer').Bot} bot
   */
  start(bot) {
    this.bot = bot;
    this.stop();
    this._interval = setInterval(() => this._evaluate(), this.evaluateIntervalMs);
    log.info('[DecisionEngine] Started');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Force an immediate evaluation (e.g. on needs change).
   */
  evaluateNow() {
    this._evaluate();
  }

  // ─── Core Evaluation ─────────────────────────────────────────────────────────

  _evaluate() {
    if (!this.bot || !this.bot.entity) return;

    // If a goal is already running, let it finish unless a CRITICAL need overrides it
    const activeGoal = this.goalManager.getActiveGoal();
    if (activeGoal) {
      if (!this._needsCriticalOverride()) return;
      // Critical need — pause current goal, let survival take over
      this.goalManager.pauseActive();
      log.warn('[DecisionEngine] Critical need detected — pausing active goal');
    }

    const decision = this._selectGoal();
    if (!decision) {
      /** @event DecisionEngine#idle */
      this.emit('idle');
      return;
    }

    log.info(`[DecisionEngine] Decision: [${decision.goalType}] — ${decision.reason} (priority ${decision.priority})`);
    /** @event DecisionEngine#decision */
    this.emit('decision', decision);
  }

  /**
   * Determine the best goal to pursue right now.
   * @returns {Decision|null}
   */
  _selectGoal() {
    const candidates = [];

    // 1. Handle CRITICAL survival needs
    const criticalDecision = this._checkCriticalNeeds();
    if (criticalDecision) candidates.push(criticalDecision);

    // 2. Handle HIGH-urgency needs
    const highDecision = this._checkHighNeeds();
    if (highDecision) candidates.push(highDecision);

    // 3. Resume a paused goal if no critical/high need
    if (candidates.length === 0) {
      const paused = this.goalManager.getByStatus('paused');
      if (paused.length > 0) {
        const best = paused.sort((a, b) => a.priority - b.priority)[0];
        candidates.push({
          goalType: best.type,
          parameters: best.parameters,
          priority: best.priority,
          reason: `Resuming paused goal: ${best.description}`,
          existingGoalId: best.id,
        });
      }
    }

    // 4. Pick next pending goal from GoalManager
    if (candidates.length === 0) {
      const next = this.goalManager.getNextGoal();
      if (next) {
        candidates.push({
          goalType: next.type,
          parameters: next.parameters,
          priority: next.priority,
          reason: `Pending goal: ${next.description}`,
          existingGoalId: next.id,
        });
      }
    }

    // 5. Autonomous default behavior loop
    if (candidates.length === 0) {
      const defaultDecision = this._getDefaultDecision();
      if (defaultDecision) candidates.push(defaultDecision);
    }

    if (candidates.length === 0) return null;

    // Select lowest-priority-number (highest importance)
    return candidates.sort((a, b) => a.priority - b.priority)[0];
  }

  _checkCriticalNeeds() {
    const hunger = this.needsSystem.getUrgency('hunger');
    const health = this.needsSystem.getUrgency('health');

    if (health === 'CRITICAL' || hunger === 'CRITICAL') {
      return {
        goalType: 'survive',
        parameters: {},
        priority: 1,
        reason: `CRITICAL: health=${health}, hunger=${hunger}`,
      };
    }
    return null;
  }

  _checkHighNeeds() {
    const hunger = this.needsSystem.getUrgency('hunger');
    const inventory = this.needsSystem.getUrgency('inventory');
    const night = this.needsSystem.getUrgency('night');

    if (hunger === 'HIGH') {
      return { goalType: 'gather_food', parameters: { count: 10 }, priority: 10, reason: 'Hunger is HIGH' };
    }
    if (inventory === 'HIGH') {
      return { goalType: 'deposit_items', parameters: {}, priority: 15, reason: 'Inventory full' };
    }
    if (night === 'LOW') {
      // Check if we have a bed known
      const bed = this.bot ? this.worldMemory.findNearest('bed', this.bot.entity.position) : null;
      if (bed) {
        return { goalType: 'sleep', parameters: {}, priority: 20, reason: 'Night — sleep available' };
      }
    }
    return null;
  }

  _needsCriticalOverride() {
    const health = this.needsSystem.getUrgency('health');
    const hunger = this.needsSystem.getUrgency('hunger');
    return health === 'CRITICAL' || hunger === 'CRITICAL';
  }

  /**
   * Default autonomous survival loop when no explicit goals exist.
   * @returns {Decision|null}
   */
  _getDefaultDecision() {
    if (!this.bot || !this.bot.entity) return null;

    const inv = this.bot.inventory.items();
    const hasFood = inv.some(i =>
      i.name.includes('bread') || i.name.includes('cooked') ||
      i.name.includes('apple') || i.name.includes('carrot')
    );
    const hasPick = inv.some(i => i.name.includes('pickaxe'));
    const hasWood = inv.some(i => i.name.includes('log') || i.name.includes('planks'));
    const hasAxe = inv.some(i => i.name.includes('axe'));

    if (!hasWood && !hasAxe) {
      return { goalType: 'gather_wood', parameters: { count: 20 }, priority: 30, reason: 'No wood — survival basics' };
    }
    if (!hasFood) {
      return { goalType: 'gather_food', parameters: { count: 10 }, priority: 35, reason: 'No food in inventory' };
    }
    if (!hasPick) {
      return { goalType: 'craft_tools', parameters: { toolType: 'wooden' }, priority: 40, reason: 'No pickaxe' };
    }

    // Explore by default
    return { goalType: 'explore', parameters: { radius: 64 }, priority: 80, reason: 'Default: explore world' };
  }
}

module.exports = DecisionEngine;
