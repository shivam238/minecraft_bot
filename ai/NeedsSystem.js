'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'NONE'} Urgency
 */

/**
 * @typedef {Object} NeedState
 * @property {string} id - Unique need identifier
 * @property {string} label - Human-readable label
 * @property {Urgency} urgency - Current urgency level
 * @property {number} value - Current numeric value (0–100 scale internally)
 * @property {string} [reason] - Why this need is urgent
 */

const URGENCY_WEIGHTS = {
  CRITICAL: 100,
  HIGH: 70,
  MEDIUM: 40,
  LOW: 15,
  NONE: 0,
};

/**
 * NeedsSystem evaluates the bot's survival state every tick and emits
 * `needsChanged` when the urgency landscape shifts. Other modules (DecisionEngine,
 * GoalManager) subscribe to react accordingly.
 *
 * Needs tracked:
 *   - hunger        : food level
 *   - health        : HP
 *   - inventory     : slot usage (full = can't pick up items)
 *   - toolDurability: held tool near breaking
 *   - armor         : missing or broken armor
 *   - danger        : nearby hostile mobs
 *   - night         : darkness / time-of-day
 *   - weather       : thunder / storm
 *
 * @fires NeedsSystem#needsChanged
 * @fires NeedsSystem#criticalNeed
 */
class NeedsSystem extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.tickIntervalMs=2000] - Evaluation frequency
   * @param {number} [options.dangerRadius=10] - Mob detection radius
   */
  constructor(options = {}) {
    super();
    this.tickIntervalMs = options.tickIntervalMs || 2000;
    this.dangerRadius = options.dangerRadius || 10;
    this._interval = null;
    this._lastSnapshot = null;

    /** @type {Map<string, NeedState>} */
    this.needs = new Map();
    this._initNeeds();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the evaluation loop.
   * @param {import('mineflayer').Bot} bot
   */
  start(bot) {
    this.bot = bot;
    this.stop();
    this._interval = setInterval(() => this._evaluate(), this.tickIntervalMs);
    log.info('[NeedsSystem] Started');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Get the current state of all needs, sorted by urgency descending.
   * @returns {NeedState[]}
   */
  getAllNeeds() {
    return [...this.needs.values()].sort(
      (a, b) => URGENCY_WEIGHTS[b.urgency] - URGENCY_WEIGHTS[a.urgency]
    );
  }

  /**
   * Get the highest-urgency need.
   * @returns {NeedState|null}
   */
  getMostUrgent() {
    let best = null;
    let bestWeight = -1;
    for (const need of this.needs.values()) {
      const w = URGENCY_WEIGHTS[need.urgency];
      if (w > bestWeight) { bestWeight = w; best = need; }
    }
    return best;
  }

  /**
   * Get urgency level of a specific need by ID.
   * @param {string} needId
   * @returns {Urgency}
   */
  getUrgency(needId) {
    return this.needs.get(needId)?.urgency || 'NONE';
  }

  /**
   * Check if any need meets or exceeds a given urgency.
   * @param {Urgency} urgency
   * @returns {boolean}
   */
  hasUrgencyAtLeast(urgency) {
    const threshold = URGENCY_WEIGHTS[urgency];
    for (const need of this.needs.values()) {
      if (URGENCY_WEIGHTS[need.urgency] >= threshold) return true;
    }
    return false;
  }

  /**
   * Serialisable snapshot of current needs (for logging / Reflection).
   * @returns {Object}
   */
  getSnapshot() {
    const snap = {};
    for (const [id, need] of this.needs.entries()) {
      snap[id] = { urgency: need.urgency, value: need.value, reason: need.reason };
    }
    return snap;
  }

  // ─── Evaluation ──────────────────────────────────────────────────────────────

  _evaluate() {
    if (!this.bot || !this.bot.entity) return;
    const bot = this.bot;

    this._evalHunger(bot);
    this._evalHealth(bot);
    this._evalInventory(bot);
    this._evalToolDurability(bot);
    this._evalArmor(bot);
    this._evalDanger(bot);
    this._evalNight(bot);
    this._evalWeather(bot);

    const snapshot = this.getSnapshot();
    if (JSON.stringify(snapshot) !== JSON.stringify(this._lastSnapshot)) {
      this._lastSnapshot = snapshot;
      /** @event NeedsSystem#needsChanged */
      this.emit('needsChanged', snapshot);

      if (this.hasUrgencyAtLeast('CRITICAL')) {
        const critical = this.getMostUrgent();
        /** @event NeedsSystem#criticalNeed */
        this.emit('criticalNeed', critical);
      }
    }
  }

  _evalHunger(bot) {
    const food = bot.food;
    let urgency = 'NONE';
    let reason = '';
    if (food <= 0) { urgency = 'CRITICAL'; reason = 'Starving — cannot regenerate health'; }
    else if (food < 6) { urgency = 'HIGH'; reason = 'Very hungry — health regen stopped'; }
    else if (food < 10) { urgency = 'MEDIUM'; reason = 'Hungry — eat soon'; }
    else if (food < 14) { urgency = 'LOW'; reason = 'Slightly hungry'; }
    this._set('hunger', 'Hunger', urgency, food, reason);
  }

  _evalHealth(bot) {
    const hp = bot.health;
    let urgency = 'NONE';
    let reason = '';
    if (hp <= 3) { urgency = 'CRITICAL'; reason = 'Near death — flee/heal immediately'; }
    else if (hp <= 6) { urgency = 'HIGH'; reason = 'Low health — avoid combat'; }
    else if (hp <= 10) { urgency = 'MEDIUM'; reason = 'Damaged — seek food/shelter'; }
    else if (hp < 16) { urgency = 'LOW'; reason = 'Slightly damaged'; }
    this._set('health', 'Health', urgency, hp, reason);
  }

  _evalInventory(bot) {
    const slots = bot.inventory.slots.filter(Boolean).length;
    const total = 36; // survival inventory
    const pct = slots / total;
    let urgency = 'NONE';
    let reason = '';
    if (pct >= 1.0) { urgency = 'HIGH'; reason = 'Inventory full — cannot collect'; }
    else if (pct >= 0.85) { urgency = 'MEDIUM'; reason = 'Inventory almost full'; }
    else if (pct >= 0.70) { urgency = 'LOW'; reason = 'Inventory filling up'; }
    this._set('inventory', 'Inventory', urgency, Math.round(pct * 100), reason);
  }

  _evalToolDurability(bot) {
    const held = bot.heldItem;
    let urgency = 'NONE';
    let reason = '';
    if (held && held.durabilityUsed !== undefined && held.maxDurability) {
      const remaining = held.maxDurability - held.durabilityUsed;
      const pct = remaining / held.maxDurability;
      if (pct < 0.05) { urgency = 'HIGH'; reason = `${held.name} about to break`; }
      else if (pct < 0.15) { urgency = 'MEDIUM'; reason = `${held.name} durability low`; }
      else if (pct < 0.30) { urgency = 'LOW'; reason = `${held.name} durability moderate`; }
    }
    this._set('toolDurability', 'Tool Durability', urgency,
      held ? (held.maxDurability ? Math.round(((held.maxDurability - held.durabilityUsed) / held.maxDurability) * 100) : 100) : 100,
      reason);
  }

  _evalArmor(bot) {
    const armorSlots = [5, 6, 7, 8]; // head, chest, legs, feet in mineflayer slot indices
    const worn = armorSlots.filter(s => bot.inventory.slots[s]).length;
    let urgency = 'NONE';
    let reason = '';
    if (worn === 0) { urgency = 'MEDIUM'; reason = 'No armor equipped'; }
    else if (worn < 3) { urgency = 'LOW'; reason = 'Missing armor pieces'; }
    this._set('armor', 'Armor', urgency, Math.round((worn / 4) * 100), reason);
  }

  _evalDanger(bot) {
    const HOSTILE = ['zombie','skeleton','spider','creeper','witch','phantom','drowned','husk','stray','pillager','ravager'];
    let urgency = 'NONE';
    let reason = '';
    let count = 0;
    try {
      for (const entity of Object.values(bot.entities)) {
        if (entity.type === 'mob' && HOSTILE.includes(entity.name)) {
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < this.dangerRadius) count++;
        }
      }
      if (count >= 3) { urgency = 'HIGH'; reason = `${count} hostile mobs nearby`; }
      else if (count >= 1) { urgency = 'MEDIUM'; reason = `Hostile mob within ${this.dangerRadius}m`; }
    } catch (_) {}
    this._set('danger', 'Danger', urgency, count, reason);
  }

  _evalNight(bot) {
    let urgency = 'NONE';
    let reason = '';
    try {
      const t = bot.time?.timeOfDay;
      if (t !== undefined) {
        if (t >= 13000 && t <= 23000) {
          urgency = 'LOW';
          reason = 'Night — hostile mobs spawn outside';
        }
      }
    } catch (_) {}
    this._set('night', 'Night', urgency, 0, reason);
  }

  _evalWeather(bot) {
    let urgency = 'NONE';
    let reason = '';
    try {
      if (bot.thunderState > 0) { urgency = 'LOW'; reason = 'Thunderstorm active'; }
    } catch (_) {}
    this._set('weather', 'Weather', urgency, 0, reason);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  _initNeeds() {
    const defs = ['hunger','health','inventory','toolDurability','armor','danger','night','weather'];
    for (const id of defs) {
      this.needs.set(id, { id, label: id, urgency: 'NONE', value: 0, reason: '' });
    }
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {Urgency} urgency
   * @param {number} value
   * @param {string} reason
   */
  _set(id, label, urgency, value, reason) {
    this.needs.set(id, { id, label, urgency, value, reason });
  }
}

module.exports = NeedsSystem;
