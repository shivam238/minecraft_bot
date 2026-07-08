'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} LocationRecord
 * @property {string} type - Category: 'ore','structure','chest','bed','farm','portal','danger','waypoint'
 * @property {string} name - Specific label e.g. 'diamond_ore', 'village', 'spider_spawner'
 * @property {{x:number,y:number,z:number}} position
 * @property {number} timestamp - Unix ms when discovered
 * @property {Object} [meta] - Arbitrary extra data (ore count, chest contents, etc.)
 */

/**
 * WorldMemory stores all spatial knowledge the bot discovers during its lifetime.
 * It maintains indexed lookup tables for O(1) nearest-location queries and emits
 * events when new knowledge is added so other modules can react.
 *
 * @fires WorldMemory#locationAdded
 * @fires WorldMemory#locationUpdated
 */
class WorldMemory extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxPerCategory=200] - Max records stored per category
   * @param {number} [options.maxTotalRecords=2000] - Hard cap on total records
   */
  constructor(options = {}) {
    super();
    this.maxPerCategory = options.maxPerCategory || 200;
    this.maxTotalRecords = options.maxTotalRecords || 2000;

    /** @type {Map<string, LocationRecord[]>} category → records */
    this.index = new Map();

    /** @type {Map<string, string>} biome cache: "x,z" → biome name */
    this.biomeCache = new Map();

    /** @type {string|null} - biome name at current position */
    this.currentBiome = null;

    this._totalRecords = 0;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Record a discovered location.
   * @param {string} type - Category key
   * @param {string} name - Specific label
   * @param {{x:number,y:number,z:number}} position
   * @param {Object} [meta={}]
   * @returns {LocationRecord}
   */
  addLocation(type, name, position, meta = {}) {
    if (!type || !name || !position) {
      throw new Error('WorldMemory.addLocation requires type, name, and position');
    }

    const record = {
      type,
      name,
      position: { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) },
      timestamp: Date.now(),
      meta,
    };

    if (!this.index.has(type)) this.index.set(type, []);
    const bucket = this.index.get(type);

    // Deduplicate: update existing record within 3 blocks
    const existing = bucket.find(r =>
      Math.abs(r.position.x - record.position.x) <= 3 &&
      Math.abs(r.position.y - record.position.y) <= 3 &&
      Math.abs(r.position.z - record.position.z) <= 3 &&
      r.name === name
    );

    if (existing) {
      existing.timestamp = record.timestamp;
      existing.meta = { ...existing.meta, ...meta };
      /** @event WorldMemory#locationUpdated */
      this.emit('locationUpdated', existing);
      return existing;
    }

    // Enforce per-category cap — evict oldest
    if (bucket.length >= this.maxPerCategory) {
      bucket.sort((a, b) => a.timestamp - b.timestamp);
      bucket.shift();
      this._totalRecords--;
    }

    // Enforce global cap
    if (this._totalRecords >= this.maxTotalRecords) {
      this._evictOldestGlobal();
    }

    bucket.push(record);
    this._totalRecords++;

    log.info(`[WorldMemory] Recorded ${type}:${name} @ ${record.position.x},${record.position.y},${record.position.z}`);
    /** @event WorldMemory#locationAdded */
    this.emit('locationAdded', record);
    return record;
  }

  /**
   * Find the nearest known location of a given type (and optionally name).
   * @param {string} type
   * @param {{x:number,y:number,z:number}} fromPos
   * @param {string} [name] - optional filter by name
   * @returns {LocationRecord|null}
   */
  findNearest(type, fromPos, name = null) {
    const bucket = this.index.get(type);
    if (!bucket || bucket.length === 0) return null;

    let best = null;
    let bestDist = Infinity;

    for (const record of bucket) {
      if (name && record.name !== name) continue;
      const dx = record.position.x - fromPos.x;
      const dy = record.position.y - fromPos.y;
      const dz = record.position.z - fromPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        best = record;
      }
    }
    return best;
  }

  /**
   * Find all known locations of a given type within a radius.
   * @param {string} type
   * @param {{x:number,y:number,z:number}} fromPos
   * @param {number} radius
   * @returns {LocationRecord[]}
   */
  findNearby(type, fromPos, radius) {
    const bucket = this.index.get(type);
    if (!bucket) return [];

    return bucket.filter(r => {
      const dx = r.position.x - fromPos.x;
      const dy = r.position.y - fromPos.y;
      const dz = r.position.z - fromPos.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
    });
  }

  /**
   * Retrieve all records in a category, sorted newest-first.
   * @param {string} type
   * @returns {LocationRecord[]}
   */
  getAll(type) {
    const bucket = this.index.get(type);
    if (!bucket) return [];
    return [...bucket].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Remove all records at or very near a specific position (e.g. ore mined out).
   * @param {{x:number,y:number,z:number}} position
   * @param {string} [type] - limit removal to one category
   */
  removeAt(position, type = null) {
    const categories = type ? [type] : [...this.index.keys()];
    for (const cat of categories) {
      const bucket = this.index.get(cat);
      if (!bucket) continue;
      const before = bucket.length;
      const filtered = bucket.filter(r =>
        Math.abs(r.position.x - position.x) > 1 ||
        Math.abs(r.position.y - position.y) > 1 ||
        Math.abs(r.position.z - position.z) > 1
      );
      this.index.set(cat, filtered);
      this._totalRecords -= (before - filtered.length);
    }
  }

  /**
   * Update the bot's known current biome.
   * @param {string} biome
   * @param {{x:number,z:number}} pos
   */
  setBiome(biome, pos) {
    this.currentBiome = biome;
    this.biomeCache.set(`${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`, biome);
  }

  /** @returns {string|null} */
  getCurrentBiome() {
    return this.currentBiome;
  }

  /**
   * Summary of memory contents (for status/debug).
   * @returns {Object}
   */
  getSummary() {
    const summary = {};
    for (const [type, bucket] of this.index.entries()) {
      summary[type] = bucket.length;
    }
    return { total: this._totalRecords, categories: summary };
  }

  /** Purge records older than `maxAgeMs`. */
  pruneOld(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [type, bucket] of this.index.entries()) {
      const before = bucket.length;
      const filtered = bucket.filter(r => r.timestamp >= cutoff);
      this.index.set(type, filtered);
      this._totalRecords -= (before - filtered.length);
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _evictOldestGlobal() {
    let oldestTime = Infinity;
    let oldestType = null;
    let oldestIdx = -1;

    for (const [type, bucket] of this.index.entries()) {
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i].timestamp < oldestTime) {
          oldestTime = bucket[i].timestamp;
          oldestType = type;
          oldestIdx = i;
        }
      }
    }

    if (oldestType !== null && oldestIdx >= 0) {
      this.index.get(oldestType).splice(oldestIdx, 1);
      this._totalRecords--;
    }
  }
}

module.exports = WorldMemory;
