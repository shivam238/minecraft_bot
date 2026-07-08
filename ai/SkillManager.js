'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} SkillDefinition
 * @property {string} id - Dot-notation e.g. 'mining.mineCoal'
 * @property {string} description
 * @property {Function} execute - async (bot, params, signal) => void
 * @property {string[]} [requiredItems] - Item names needed before executing
 * @property {Object} [metadata] - Extra info (category, author, version)
 */

/**
 * SkillManager is the central registry for all bot skills.
 * Skills are registered as modules and invoked by TaskQueue via `execute()`.
 *
 * Design rules:
 * - SkillManager never controls Mineflayer directly — skills do.
 * - Skills must be pure async functions (bot, params, signal) => void
 * - SkillManager validates preconditions (required items) before calling execute
 *
 * @fires SkillManager#skillRegistered
 * @fires SkillManager#skillExecuting
 */
class SkillManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, SkillDefinition>} */
    this.skills = new Map();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a skill.
   * @param {SkillDefinition} skillDef
   */
  register(skillDef) {
    if (!skillDef.id || typeof skillDef.execute !== 'function') {
      throw new Error('SkillDefinition requires id and execute function');
    }
    this.skills.set(skillDef.id, skillDef);
    log.info(`[SkillManager] Registered: ${skillDef.id}`);
    /** @event SkillManager#skillRegistered */
    this.emit('skillRegistered', skillDef);
  }

  /**
   * Register multiple skills at once.
   * @param {SkillDefinition[]} skillDefs
   */
  registerMany(skillDefs) {
    for (const def of skillDefs) this.register(def);
  }

  /**
   * Execute a skill by ID.
   * @param {string} skillId
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [params={}]
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async execute(skillId, bot, params = {}, signal = null) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    // Validate preconditions
    if (skill.requiredItems && skill.requiredItems.length > 0) {
      const missing = skill.requiredItems.filter(item =>
        !bot.inventory.items().some(i => i.name === item)
      );
      if (missing.length > 0) {
        throw new Error(`Skill ${skillId} requires: ${missing.join(', ')}`);
      }
    }

    log.info(`[SkillManager] Executing: ${skillId}`);
    /** @event SkillManager#skillExecuting */
    this.emit('skillExecuting', skill, params);

    await skill.execute(bot, params, signal);
  }

  /**
   * Check if a skill exists.
   * @param {string} skillId
   * @returns {boolean}
   */
  has(skillId) {
    return this.skills.has(skillId);
  }

  /**
   * Get a skill definition without executing it.
   * @param {string} skillId
   * @returns {SkillDefinition|undefined}
   */
  get(skillId) {
    return this.skills.get(skillId);
  }

  /**
   * List all registered skill IDs.
   * @returns {string[]}
   */
  list() {
    return [...this.skills.keys()];
  }

  /**
   * List skills filtered by category prefix.
   * @param {string} category - e.g. 'mining'
   * @returns {SkillDefinition[]}
   */
  listByCategory(category) {
    return [...this.skills.values()].filter(s => s.id.startsWith(`${category}.`));
  }

  /**
   * Summary of registered skills for status display.
   * @returns {Object}
   */
  getSummary() {
    const categories = {};
    for (const skill of this.skills.values()) {
      const cat = skill.id.split('.')[0];
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(skill.id);
    }
    return { total: this.skills.size, categories };
  }

  /**
   * Auto-load all skills from the skills/ directory.
   * Each skill file must export a SkillDefinition or array of SkillDefinitions.
   * @param {string} skillsDir - Absolute path to skills directory
   */
  loadDirectory(skillsDir) {
    const fs = require('fs');
    const path = require('path');

    const traverse = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          try {
            const exported = require(fullPath);
            if (Array.isArray(exported)) {
              this.registerMany(exported);
            } else if (exported && typeof exported === 'object' && exported.id) {
              this.register(exported);
            }
          } catch (err) {
            log.warn(`[SkillManager] Failed to load ${fullPath}: ${err.message}`);
          }
        }
      }
    };

    traverse(skillsDir);
    log.ok(`[SkillManager] Loaded ${this.skills.size} skills from ${skillsDir}`);
  }
}

module.exports = SkillManager;
