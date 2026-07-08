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
 * AutonomousAgent is the top-level orchestrator for the autonomous Minecraft AI.
 *
 * It wires all sub-systems together:
 *   NeedsSystem → DecisionEngine → GoalManager → Planner → TaskQueue → SkillManager
 *                                                         ↑
 *                                              Reflection (failure handling)
 *
 * Integration with existing bot:
 *   - Created alongside (not replacing) AIManager
 *   - Activated via `agent.attach(bot)` after bot spawns
 *   - Deactivated via `agent.detach()` on bot end/disconnect
 *   - Respects existing `state.botState` — agent pauses when botState is
 *     'following', 'sleeping', or combat priority is active
 *
 * @fires AutonomousAgent#started
 * @fires AutonomousAgent#stopped
 * @fires AutonomousAgent#goalActivated
 */
class AutonomousAgent extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true] - Master switch
   * @param {boolean} [options.autoStart=true] - Start automatically on attach
   * @param {string} [options.skillsDir] - Override skills directory path
   */
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.autoStart = options.autoStart !== false;
    this.skillsDir = options.skillsDir || path.join(__dirname, '..', 'skills');

    this.bot = null;
    this._stateCheckInterval = null;
    this._running = false;

    // Instantiate all subsystems
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

    this._wireEvents();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Attach the agent to a live bot instance (call on bot 'spawn').
   * @param {import('mineflayer').Bot} bot
   */
  attach(bot) {
    if (!this.enabled) {
      log.info('[AutonomousAgent] Disabled — not attaching');
      return;
    }
    this.bot = bot;
    log.ok('[AutonomousAgent] Attached to bot');

    // Load all skills from the skills/ directory
    this.skillManager.loadDirectory(this.skillsDir);

    if (this.autoStart) this.start();
  }

  /**
   * Start the autonomous loop.
   */
  async start() {
    if (this._running || !this.bot) return;
    this._running = true;

    this.needsSystem.start(this.bot);
    this.decisionEngine.start(this.bot);
    await this.taskQueue.start(this.bot);

    // State-guard: pause agent when bot is in follow/combat/sleep modes
    this._stateCheckInterval = setInterval(() => this._checkBotState(), 1000);

    log.ok('[AutonomousAgent] Started');
    /** @event AutonomousAgent#started */
    this.emit('started');
  }

  /**
   * Stop the autonomous loop (does not destroy subsystems).
   */
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
    /** @event AutonomousAgent#stopped */
    this.emit('stopped');
  }

  /**
   * Detach from the current bot (call on bot 'end').
   */
  async detach() {
    await this.stop();
    this.bot = null;
    log.info('[AutonomousAgent] Detached from bot');
  }

  /**
   * Manually add a goal (e.g. from a chat command).
   * @param {string} type
   * @param {string} description
   * @param {Object} [parameters={}]
   * @param {number} [priority=50]
   * @returns {import('./GoalManager').Goal}
   */
  addGoal(type, description, parameters = {}, priority = 50) {
    return this.goalManager.addGoal(type, description, parameters, priority);
  }

  /**
   * Status report for !aistatus command.
   * @returns {Object}
   */
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
    // Decision → create or activate goal → plan → enqueue tasks
    this.decisionEngine.on('decision', (decision) => this._onDecision(decision));
    this.decisionEngine.on('idle', () => log.info('[AutonomousAgent] Idle — no goals'));

    // Task failures → Reflection
    this.taskQueue.on('taskFailed', (task, err) => this._onTaskFailed(task, err));

    // Task completion → record success
    this.taskQueue.on('taskCompleted', (task) => {
      if (task.goalId) {
        const goal = this.goalManager.goals.get(task.goalId);
        if (goal && goal.type) {
          this.reflection.recordSuccess(goal.type, task.skillId);
        }
      }
    });

    // Goal completed
    this.goalManager.on('goalCompleted', (goal) => {
      log.ok(`[AutonomousAgent] Goal completed: ${goal.description}`);
    });

    // Critical needs → immediate evaluation
    this.needsSystem.on('criticalNeed', (need) => {
      log.warn(`[AutonomousAgent] Critical need: ${need.label} — ${need.reason}`);
      this.decisionEngine.evaluateNow();
    });
  }

  // ─── Internal Handlers ───────────────────────────────────────────────────────

  /**
   * @param {Object} decision - From DecisionEngine
   */
  _onDecision(decision) {
    // If decision references an existing goal, activate it
    let goal;
    if (decision.existingGoalId) {
      try {
        goal = this.goalManager.activateGoal(decision.existingGoalId);
      } catch (err) {
        log.warn(`[AutonomousAgent] Could not activate goal: ${err.message}`);
        return;
      }
    } else {
      // Create a new goal
      goal = this.goalManager.addGoal(
        decision.goalType,
        decision.reason,
        decision.parameters || {},
        decision.priority || 50
      );
      goal = this.goalManager.activateGoal(goal.id);
    }

    /** @event AutonomousAgent#goalActivated */
    this.emit('goalActivated', goal);

    // Plan the goal
    if (!this.bot) return;
    const plan = this.planner.plan(goal, this.bot);

    if (!plan) {
      this.goalManager.failGoal(goal.id, 'Planner could not create a plan');
      return;
    }

    // Enqueue all tasks
    this.taskQueue.clearPending();
    let lastTaskId = null;
    for (const step of plan.steps) {
      const task = this.taskQueue.enqueue(step.skillId, step.parameters, {
        timeout: step.timeout,
        goalId: goal.id,
      });
      lastTaskId = task.id;
    }

    // When queue drains, mark goal complete (we check the last task)
    const onComplete = (task) => {
      if (task.id === lastTaskId) {
        this.taskQueue.removeListener('taskCompleted', onComplete);
        this.goalManager.completeGoal(goal.id);
      }
    };
    this.taskQueue.on('taskCompleted', onComplete);
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
        this.goalManager.failGoal(goal.id, result.reason);
        // Re-add goal so DecisionEngine picks it up again
        this.goalManager.addGoal(goal.type, goal.description, goal.parameters, goal.priority);
        break;
      case 'skip':
        log.warn(`[AutonomousAgent] Skipping goal: ${goal.description}`);
        this.goalManager.failGoal(goal.id, result.reason);
        break;
      case 'escalate':
        log.warn(`[AutonomousAgent] Escalating goal failure: ${goal.description}`);
        this.goalManager.failGoal(goal.id, result.reason);
        // Add a survive goal with highest priority
        this.goalManager.addGoal('survive', 'Emergency survival', {}, 1);
        this.decisionEngine.evaluateNow();
        break;
    }
  }

  /**
   * Guard: pause agent when bot is controlled by the existing priority system.
   */
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
        log.info('[AutonomousAgent] Bot priority system active — suspending task execution');
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
