'use strict';

const EventEmitter = require('events');
const path = require('path');
const log = require('../lib/logger');

const WorldMemory = require('./WorldMemory');
const NeedsSystem = require('./NeedsSystem');
const GoalManager = require('./GoalManager');
const Planner = require('./Planner');
const TaskQueue = require('./TaskQueue');
const SkillManager = require('./SkillManager');
const Reflection = require('./Reflection');
const DecisionEngine = require('./DecisionEngine');

/**
 * AutonomousAgent — top-level orchestrator.
 *
 * Bug fixes in this revision:
 *  #1  Queue-growth on replan: _onDecision now calls taskQueue.replacePlan()
 *      instead of clearPending() + enqueue(). replacePlan() atomically aborts
 *      the running task, wipes all pending, and loads a fresh plan.
 *  #3  Reflection 'redirect' action: handled in _onTaskFailed — fails the
 *      current goal and creates a different goal (e.g. explore_forest).
 *  #5  WorldMemory injection: bot._worldMemory is set so skills can save
 *      discovered trees/ores without importing WorldMemory themselves.
 *  #7  Before every new plan: cancel current execution, clear pending,
 *      fail the old goal. Only ONE active goal at any time.
 *
 * Public API is unchanged from the previous version.
 *
 * @fires AutonomousAgent#started
 * @fires AutonomousAgent#stopped
 * @fires AutonomousAgent#goalActivated
 */
class AutonomousAgent extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {boolean} [options.autoStart=true]
   * @param {string}  [options.skillsDir]
   */
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.autoStart = options.autoStart !== false;
    this.skillsDir = options.skillsDir || path.join(__dirname, '..', 'skills');

    this.bot = null;
    this._stateCheckInterval = null;
    this._running = false;

    // Sub-systems
    this.worldMemory = new WorldMemory();
    this.needsSystem = new NeedsSystem({ tickIntervalMs: 3000 });
    this.goalManager = new GoalManager();
    this.skillManager = new SkillManager();
    this.planner = new Planner(this.worldMemory, this.needsSystem, this.skillManager);
    this.taskQueue = new TaskQueue(this.skillManager);
    this.reflection = new Reflection({ maxRetries: 3 });
    this.decisionEngine = new DecisionEngine(
      this.goalManager,
      this.needsSystem,
      this.worldMemory,
      { evaluateIntervalMs: 5000 }
    );

    // Fix #7: track the single active plan (goal → last task id)
    this._activePlanLastTaskId = null;
    this._activeGoalCompletionListener = null;

    this._wireEvents();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /** @param {import('mineflayer').Bot} bot */
  attach(bot) {
    if (!this.enabled) {
      log.info('[AutonomousAgent] Disabled — not attaching');
      return;
    }
    this.bot = bot;

    // Fix #5: inject WorldMemory reference so skills can save discoveries
    bot._worldMemory = this.worldMemory;

    log.ok('[AutonomousAgent] Attached to bot');
    this.skillManager.loadDirectory(this.skillsDir);
    if (this.autoStart) this.start();
  }

  async start() {
    if (this._running || !this.bot) return;
    this._running = true;

    this.needsSystem.start(this.bot);
    this.decisionEngine.start(this.bot);
    await this.taskQueue.start(this.bot);

    this._stateCheckInterval = setInterval(() => this._checkBotState(), 1000);

    log.ok('[AutonomousAgent] Started');
    this.emit('started');
  }

  async stop() {
    if (!this._running) return;
    this._running = false;

    this.needsSystem.stop();
    this.decisionEngine.stop();
    await this.taskQueue.stop();

    if (this._stateCheckInterval) {
      clearInterval(this._stateCheckInterval);
      this._stateCheckInterval = null;
    }

    this.goalManager.pauseActive();
    log.info('[AutonomousAgent] Stopped');
    this.emit('stopped');
  }

  async detach() {
    await this.stop();
    if (this.bot) {
      delete this.bot._worldMemory;
      this.bot = null;
    }
    log.info('[AutonomousAgent] Detached from bot');
  }

  /**
   * @param {string} type
   * @param {string} description
   * @param {Object} [parameters={}]
   * @param {number} [priority=50]
   * @returns {import('./GoalManager').Goal}
   */
  addGoal(type, description, parameters = {}, priority = 50) {
    return this.goalManager.addGoal(type, description, parameters, priority);
  }

  /** @returns {Object} */
  getStatus() {
    return {
      enabled: this.enabled,
      running: this._running,
      goals: this.goalManager.getSummary(),
      needs: this.needsSystem.getSnapshot(),
      skills: this.skillManager.getSummary(),
      worldMemory: this.worldMemory.getSummary(),
      taskQueue: this.taskQueue.getSnapshot(),
      reflection: this.reflection.getSummary(),
    };
  }

  // ─── Event Wiring ────────────────────────────────────────────────────────────

  _wireEvents() {
    this.decisionEngine.on('decision', (d) => this._onDecision(d));
    this.decisionEngine.on('idle', () => log.info('[AutonomousAgent] Idle — no goals'));

    this.taskQueue.on('taskFailed', (task, err) => this._onTaskFailed(task, err));
    this.taskQueue.on('taskCompleted', (task) => this._onTaskCompleted(task));

    this.goalManager.on('goalCompleted', (goal) => {
      log.ok(`[AutonomousAgent] Goal completed: ${goal.description}`);
    });

    this.needsSystem.on('criticalNeed', (need) => {
      log.warn(`[AutonomousAgent] Critical need: ${need.label} — ${need.reason}`);
      this.decisionEngine.evaluateNow();
    });
  }

  // ─── Internal Handlers ───────────────────────────────────────────────────────

  /**
   * @param {Object} decision
   */
  _onDecision(decision) {
    // ── Fix #7: Nuke old plan before creating a new one ──────────────────────
    this._cancelActivePlan();

    // Resolve or create goal
    let goal;
    if (decision.existingGoalId) {
      try {
        goal = this.goalManager.activateGoal(decision.existingGoalId);
      } catch (err) {
        log.warn(`[AutonomousAgent] Could not activate goal: ${err.message}`);
        return;
      }
    } else {
      goal = this.goalManager.addGoal(
        decision.goalType,
        decision.reason,
        decision.parameters || {},
        decision.priority || 50
      );
      goal = this.goalManager.activateGoal(goal.id);
    }

    this.emit('goalActivated', goal);

    if (!this.bot) return;

    const plan = this.planner.plan(goal, this.bot);
    if (!plan) {
      this.goalManager.failGoal(goal.id, 'Planner could not create a plan');
      return;
    }

    // ── Fix #1: replacePlan — atomic cancel + load ───────────────────────────
    const tasks = this.taskQueue.replacePlan(plan.steps, goal.id);
    if (tasks.length === 0) {
      this.goalManager.failGoal(goal.id, 'Plan produced no executable tasks');
      return;
    }

    this._activePlanLastTaskId = tasks[tasks.length - 1].id;

    // ── Fix #7: install completion listener; remove stale ones ───────────────
    if (this._activeGoalCompletionListener) {
      this.taskQueue.removeListener('taskCompleted', this._activeGoalCompletionListener);
    }
    const goalId = goal.id;
    const lastId = this._activePlanLastTaskId;
    this._activeGoalCompletionListener = (task) => {
      if (task.id === lastId) {
        this.taskQueue.removeListener('taskCompleted', this._activeGoalCompletionListener);
        this._activeGoalCompletionListener = null;
        try { this.goalManager.completeGoal(goalId); } catch (_) {}
      }
    };
    this.taskQueue.on('taskCompleted', this._activeGoalCompletionListener);

    log.info(`[AutonomousAgent] Plan started — goal [${goal.type}], ${tasks.length} tasks`);
  }

  /**
   * @param {import('./TaskQueue').Task} task
   */
  _onTaskCompleted(task) {
    if (!task.goalId) return;
    const goal = this.goalManager.goals.get(task.goalId);
    if (goal && goal.type) {
      this.reflection.recordSuccess(goal.type, task.skillId);
    }
  }

  /**
   * @param {import('./TaskQueue').Task} task
   * @param {Error} err
   */
  _onTaskFailed(task, err) {
    const goal = task.goalId ? this.goalManager.goals.get(task.goalId) : null;
    if (!goal) return;

    const context = this.needsSystem.getSnapshot();
    const result = this.reflection.reflect(goal, task, err, context);

    switch (result.action) {

      case 'retry':
        log.info(`[AutonomousAgent] Retrying task: ${task.skillId}`);
        this.taskQueue.prepend(task.skillId, task.parameters, {
          timeout: task.timeout,
          goalId: task.goalId,
        });
        break;

      case 'replan':
        log.info(`[AutonomousAgent] Replanning goal: ${goal.type}`);
        // Fix #7: full cancel before re-enqueue
        this._cancelActivePlan();
        this.goalManager.failGoal(goal.id, result.reason);
        // Re-add the same goal — DecisionEngine will pick it up
        this.goalManager.addGoal(goal.type, goal.description, goal.parameters, goal.priority);
        // Trigger immediate re-evaluation instead of waiting 5s
        this.decisionEngine.evaluateNow();
        break;

      case 'skip':
        log.warn(`[AutonomousAgent] Skipping goal: ${goal.description}`);
        this._cancelActivePlan();
        this.goalManager.failGoal(goal.id, result.reason);
        break;

      // Fix #3: Reflection emits 'redirect' when retries exhausted
      case 'redirect': {
        const rg = result.redirectGoal;
        log.warn(`[AutonomousAgent] Redirecting — ${result.reason}`);
        log.info(`[AutonomousAgent] Creating redirect goal: ${rg.type}`);
        this._cancelActivePlan();
        this.goalManager.failGoal(goal.id, result.reason);
        // Add the redirect goal with slightly higher priority so it runs next
        this.goalManager.addGoal(rg.type, rg.description, rg.parameters, rg.priority || 45);
        this.decisionEngine.evaluateNow();
        break;
      }

      case 'escalate':
        log.warn(`[AutonomousAgent] Escalating: ${goal.description}`);
        this._cancelActivePlan();
        this.goalManager.failGoal(goal.id, result.reason);
        this.goalManager.addGoal('survive', 'Emergency survival', {}, 1);
        this.decisionEngine.evaluateNow();
        break;
    }
  }

  /**
   * Fix #7: Cancel current execution + clear pending in one call.
   * Safe to call even when nothing is running.
   */
  _cancelActivePlan() {
    // Remove stale completion listener
    if (this._activeGoalCompletionListener) {
      this.taskQueue.removeListener('taskCompleted', this._activeGoalCompletionListener);
      this._activeGoalCompletionListener = null;
    }
    this._activePlanLastTaskId = null;

    // Abort running + clear pending — uses TaskQueue's internal abort
    this.taskQueue.clearPending();
    if (this.taskQueue._abortController) {
      this.taskQueue._abortController.abort();
    }
  }

  /** Guard: suspend agent when existing priority system is active. */
  _checkBotState() {
    try {
      const { state } = require('../lib/state');
      const bot = state.bot;
      if (!bot) return;

      const blockedStates = ['following', 'sleeping'];
      const isBlocked = (
        blockedStates.includes(state.botState) ||
        (bot.pvp && bot.pvp.target) ||
        bot.isSleeping
      );

      if (isBlocked && this.taskQueue._running) {
        log.info('[AutonomousAgent] Bot priority system active — suspending');
        this.taskQueue.stop();
        this.goalManager.pauseActive();
      } else if (!isBlocked && !this.taskQueue._running && this._running) {
        log.info('[AutonomousAgent] Resuming task execution');
        this.taskQueue.start(this.bot);
        this.decisionEngine.evaluateNow();
      }
    } catch (_) {}
  }
}

module.exports = AutonomousAgent;
