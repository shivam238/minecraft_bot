'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {'pending'|'running'|'done'|'failed'|'cancelled'} TaskStatus
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} skillId - The skill key to execute (e.g. 'mining.mineCoal')
 * @property {Object} parameters - Arguments forwarded to the skill
 * @property {TaskStatus} status
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [endedAt]
 * @property {string} [failReason]
 * @property {number} timeout - Max ms before task is killed (default 60000)
 * @property {string} goalId - Which goal spawned this task
 */

let _taskCounter = 0;
function genTaskId() {
  return `task_${Date.now()}_${++_taskCounter}`;
}

/**
 * TaskQueue is the execution engine of the autonomous agent.
 * It holds an ordered queue of tasks, pops them one at a time, and
 * delegates each to SkillManager for execution.
 *
 * The queue is intentionally **decoupled** from Planner — Planner pushes tasks,
 * TaskQueue executes them. This separation ensures planning and execution can
 * evolve independently.
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
   * @param {number} [options.maxQueueSize=100]
   */
  constructor(skillManager, options = {}) {
    super();
    if (!skillManager) throw new Error('TaskQueue requires a SkillManager instance');
    this.skillManager = skillManager;
    this.defaultTimeout = options.defaultTimeout || 60000;
    this.maxQueueSize = options.maxQueueSize || 100;

    /** @type {Task[]} Ordered task list (index 0 = next to run) */
    this.queue = [];
    this._running = false;
    this._abortController = null;
    this._currentTask = null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a task at the back of the queue.
   * @param {string} skillId
   * @param {Object} [parameters={}]
   * @param {Object} [options={}]
   * @param {number} [options.timeout]
   * @param {string} [options.goalId]
   * @returns {Task}
   */
  enqueue(skillId, parameters = {}, options = {}) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`TaskQueue full (max ${this.maxQueueSize} tasks)`);
    }
    const task = {
      id: genTaskId(),
      skillId,
      parameters,
      status: 'pending',
      createdAt: Date.now(),
      timeout: options.timeout || this.defaultTimeout,
      goalId: options.goalId || null,
    };
    this.queue.push(task);
    log.info(`[TaskQueue] Enqueued: ${skillId} (queue length: ${this.queue.length})`);
    return task;
  }

  /**
   * Prepend a task (high-priority insertion at front of queue).
   * @param {string} skillId
   * @param {Object} [parameters={}]
   * @param {Object} [options={}]
   * @returns {Task}
   */
  prepend(skillId, parameters = {}, options = {}) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('TaskQueue full');
    }
    const task = {
      id: genTaskId(),
      skillId,
      parameters,
      status: 'pending',
      createdAt: Date.now(),
      timeout: options.timeout || this.defaultTimeout,
      goalId: options.goalId || null,
    };
    this.queue.unshift(task);
    log.info(`[TaskQueue] Prepended: ${skillId} (queue length: ${this.queue.length})`);
    return task;
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
    await this._run();
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
   * Clear all pending (not yet started) tasks from the queue.
   */
  clearPending() {
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.status !== 'pending');
    log.info(`[TaskQueue] Cleared ${before - this.queue.length} pending tasks`);
  }

  /**
   * How many tasks are pending/queued.
   * @returns {number}
   */
  get length() {
    return this.queue.filter(t => t.status === 'pending').length;
  }

  /**
   * Currently running task, or null.
   * @returns {Task|null}
   */
  get currentTask() {
    return this._currentTask;
  }

  /**
   * Serialisable snapshot of the queue.
   * @returns {Object[]}
   */
  getSnapshot() {
    return this.queue.map(t => ({
      id: t.id,
      skillId: t.skillId,
      status: t.status,
      goalId: t.goalId,
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
      await this.skillManager.execute(task.skillId, this.bot, task.parameters, this._abortController.signal);
      task.status = 'done';
      task.endedAt = Date.now();
      log.info(`[TaskQueue] Done: ${task.skillId} (${task.endedAt - task.startedAt}ms)`);
      /** @event TaskQueue#taskCompleted */
      this.emit('taskCompleted', task);
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'aborted') {
        task.status = 'cancelled';
      } else {
        task.status = 'failed';
        task.failReason = err.message;
        log.warn(`[TaskQueue] Failed: ${task.skillId} — ${err.message}`);
        /** @event TaskQueue#taskFailed */
        this.emit('taskFailed', task, err);
      }
      task.endedAt = Date.now();
    } finally {
      clearTimeout(timeoutHandle);
      this._currentTask = null;
      this._abortController = null;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TaskQueue;
