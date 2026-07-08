'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {'pending'|'running'|'done'|'failed'|'cancelled'} TaskStatus
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} skillId
 * @property {Object} parameters
 * @property {TaskStatus} status
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [endedAt]
 * @property {string} [failReason]
 * @property {number} timeout
 * @property {string} goalId
 * @property {string} [planId] - Which plan version created this task
 */

let _taskCounter = 0;
function genTaskId() {
  return `task_${Date.now()}_${++_taskCounter}`;
}

/**
 * TaskQueue — execution engine for the autonomous agent.
 *
 * Bug fixes in this revision:
 *  #1  Queue grows forever on replan → `replacePlan()` atomically cancels
 *      the running task + wipes pending before loading the new plan.
 *  #6  Hard cap lowered to 10 pending tasks; consecutive duplicate skill IDs
 *      are silently dropped on enqueue.
 *
 * @fires TaskQueue#taskStarted
 * @fires TaskQueue#taskCompleted
 * @fires TaskQueue#taskFailed
 * @fires TaskQueue#queueEmpty
 */
class TaskQueue extends EventEmitter {
  /**
   * @param {import('./SkillManager')} skillManager
   * @param {Object} [options]
   * @param {number} [options.defaultTimeout=60000]
   * @param {number} [options.maxQueueSize=10]   ← hard cap (fix #6)
   */
  constructor(skillManager, options = {}) {
    super();
    if (!skillManager) throw new Error('TaskQueue requires a SkillManager instance');
    this.skillManager = skillManager;
    this.defaultTimeout = options.defaultTimeout || 60000;
    // Fix #6: cap pending tasks at 10
    this.maxQueueSize = options.maxQueueSize || 10;

    /** @type {Task[]} Full task history + pending list */
    this.queue = [];
    this._running = false;
    this._abortController = null;
    this._currentTask = null;

    // Fix #1: track which plan version is currently active
    // Any task whose planId doesn't match _activePlanId is a zombie.
    this._activePlanId = null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a task at the back of the queue.
   * Silently drops the task if:
   *  - pending queue is already at max (fix #6)
   *  - the last pending task has the same skillId (consecutive duplicate, fix #6)
   *
   * @param {string} skillId
   * @param {Object} [parameters={}]
   * @param {Object} [options={}]
   * @param {string} [options.planId]   - Plan version this task belongs to
   * @param {number} [options.timeout]
   * @param {string} [options.goalId]
   * @returns {Task}
   */
  enqueue(skillId, parameters = {}, options = {}) {
    const pending = this.queue.filter(t => t.status === 'pending');

    // Fix #6a: hard cap on pending queue depth
    if (pending.length >= this.maxQueueSize) {
      log.warn(`[TaskQueue] Queue full (${pending.length}/${this.maxQueueSize}) — dropping ${skillId}`);
      // Return a dummy task object so callers don't need to null-check
      return this._makeDummyTask(skillId, parameters, options);
    }

    // Fix #6b: no consecutive duplicate skill IDs
    if (pending.length > 0 && pending[pending.length - 1].skillId === skillId) {
      log.warn(`[TaskQueue] Duplicate consecutive skill dropped: ${skillId}`);
      return this._makeDummyTask(skillId, parameters, options);
    }

    const task = this._makeTask(skillId, parameters, options);
    this.queue.push(task);
    log.info(`[TaskQueue] Enqueued: ${skillId} (pending: ${pending.length + 1})`);
    return task;
  }

  /**
   * Prepend a task (high-priority insertion at front of pending queue).
   * @param {string} skillId
   * @param {Object} [parameters={}]
   * @param {Object} [options={}]
   * @returns {Task}
   */
  prepend(skillId, parameters = {}, options = {}) {
    const pending = this.queue.filter(t => t.status === 'pending');
    if (pending.length >= this.maxQueueSize) {
      log.warn(`[TaskQueue] Queue full — prepend dropped: ${skillId}`);
      return this._makeDummyTask(skillId, parameters, options);
    }
    const task = this._makeTask(skillId, parameters, options);
    // Insert before the first pending task
    const firstPendingIdx = this.queue.findIndex(t => t.status === 'pending');
    if (firstPendingIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(firstPendingIdx, 0, task);
    }
    log.info(`[TaskQueue] Prepended: ${skillId} (pending: ${pending.length + 1})`);
    return task;
  }

  /**
   * Fix #1 + #7: Atomically replace the entire plan.
   *   1. Abort the currently running task.
   *   2. Clear all pending tasks.
   *   3. Assign a new planId.
   *   4. Enqueue all steps of the new plan.
   *
   * This is the ONLY safe way to start a new plan. Never call enqueue() for
   * a new plan while an old one is running without calling replacePlan() first.
   *
   * @param {{skillId:string, parameters:Object, timeout?:number, goalId?:string}[]} steps
   * @param {string} goalId
   * @returns {Task[]} The newly created tasks
   */
  replacePlan(steps, goalId) {
    // 1. Cancel running task
    if (this._abortController) {
      log.info('[TaskQueue] replacePlan — aborting current task');
      this._abortController.abort();
    }
    // 2. Wipe all pending tasks
    this._clearAllPending();

    // 3. New plan version
    const planId = `plan_${Date.now()}`;
    this._activePlanId = planId;

    // 4. Enqueue new steps — bypass cap check since this IS the intended plan
    const tasks = [];
    let lastSkillId = null;
    for (const step of steps) {
      // Still enforce consecutive duplicate guard
      if (step.skillId === lastSkillId) {
        log.warn(`[TaskQueue] replacePlan: skipping consecutive duplicate ${step.skillId}`);
        continue;
      }
      // Enforce hard cap even during replacePlan
      const pendingNow = this.queue.filter(t => t.status === 'pending').length;
      if (pendingNow >= this.maxQueueSize) {
        log.warn(`[TaskQueue] replacePlan: pending cap reached at step ${step.skillId}`);
        break;
      }
      const task = this._makeTask(step.skillId, step.parameters || {}, {
        timeout: step.timeout,
        goalId,
        planId,
      });
      this.queue.push(task);
      tasks.push(task);
      lastSkillId = step.skillId;
    }

    log.info(`[TaskQueue] replacePlan: ${tasks.length} tasks loaded for goal ${goalId} (planId: ${planId})`);
    return tasks;
  }

  /**
   * Start the execution loop. Safe to call when already running.
   * @param {import('mineflayer').Bot} bot
   */
  async start(bot) {
    if (this._running) return;
    this.bot = bot;
    this._running = true;
    log.info('[TaskQueue] Execution loop started');
    this._run().catch(err => log.warn(`[TaskQueue] Run loop crashed: ${err.message}`));
  }

  /**
   * Stop the execution loop and cancel the currently running task.
   */
  async stop() {
    this._running = false;
    if (this._abortController) {
      this._abortController.abort();
    }
    if (this._currentTask && this._currentTask.status === 'running') {
      this._currentTask.status = 'cancelled';
    }
    log.info('[TaskQueue] Stopped');
  }

  /**
   * Clear all pending (not yet started) tasks.
   * Does NOT cancel the currently running task. For full plan replacement
   * use replacePlan() instead.
   */
  clearPending() {
    this._clearAllPending();
  }

  /** @returns {number} */
  get length() {
    return this.queue.filter(t => t.status === 'pending').length;
  }

  /** @returns {Task|null} */
  get currentTask() {
    return this._currentTask;
  }

  /** @returns {Object[]} */
  getSnapshot() {
    return this.queue
      .filter(t => t.status === 'pending' || t.status === 'running')
      .map(t => ({
        id: t.id,
        skillId: t.skillId,
        status: t.status,
        goalId: t.goalId,
        planId: t.planId,
      }));
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  async _run() {
    while (this._running) {
      const task = this._dequeue();

      if (!task) {
        /** @event TaskQueue#queueEmpty */
        this.emit('queueEmpty');
        await this._sleep(500);
        continue;
      }

      // Fix #1: skip zombie tasks (from a superseded plan)
      if (task.planId && task.planId !== this._activePlanId) {
        log.info(`[TaskQueue] Skipping zombie task ${task.skillId} (plan ${task.planId} superseded)`);
        task.status = 'cancelled';
        continue;
      }

      await this._executeTask(task);
    }
  }

  _dequeue() {
    const idx = this.queue.findIndex(t => t.status === 'pending');
    if (idx === -1) return null;
    return this.queue[idx];
  }

  async _executeTask(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    this._currentTask = task;
    this._abortController = new AbortController();

    log.info(`[TaskQueue] Executing: ${task.skillId}`);
    /** @event TaskQueue#taskStarted */
    this.emit('taskStarted', task);

    const timeoutHandle = setTimeout(() => {
      if (this._abortController) this._abortController.abort();
    }, task.timeout);

    try {
      await this.skillManager.execute(
        task.skillId,
        this.bot,
        task.parameters,
        this._abortController.signal
      );
      task.status = 'done';
      task.endedAt = Date.now();
      log.info(`[TaskQueue] Done: ${task.skillId} (${task.endedAt - task.startedAt}ms)`);
      /** @event TaskQueue#taskCompleted */
      this.emit('taskCompleted', task);
    } catch (err) {
      task.endedAt = Date.now();
      if (err.name === 'AbortError' || err.message === 'aborted') {
        task.status = 'cancelled';
        log.info(`[TaskQueue] Cancelled: ${task.skillId}`);
      } else {
        task.status = 'failed';
        task.failReason = err.message;
        log.warn(`[TaskQueue] Failed: ${task.skillId} — ${err.message}`);
        /** @event TaskQueue#taskFailed */
        this.emit('taskFailed', task, err);
      }
    } finally {
      clearTimeout(timeoutHandle);
      this._currentTask = null;
      this._abortController = null;
    }
  }

  _clearAllPending() {
    const before = this.queue.filter(t => t.status === 'pending').length;
    this.queue = this.queue.filter(t => t.status !== 'pending');
    if (before > 0) log.info(`[TaskQueue] Cleared ${before} pending tasks`);
  }

  _makeTask(skillId, parameters, options = {}) {
    return {
      id: genTaskId(),
      skillId,
      parameters,
      status: 'pending',
      createdAt: Date.now(),
      timeout: options.timeout || this.defaultTimeout,
      goalId: options.goalId || null,
      planId: options.planId || this._activePlanId,
    };
  }

  /** Returns a non-queued dummy so callers don't need null-checks. */
  _makeDummyTask(skillId, parameters, options = {}) {
    return {
      id: genTaskId(),
      skillId,
      parameters,
      status: 'cancelled',
      createdAt: Date.now(),
      timeout: options.timeout || this.defaultTimeout,
      goalId: options.goalId || null,
      planId: null,
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TaskQueue;
