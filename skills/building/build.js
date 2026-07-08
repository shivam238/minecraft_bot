'use strict';

const log = require('../../lib/logger');

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Builds a minimal 3x3x3 dirt/wood shelter around the bot.
 */
const buildBasicShelter = {
  id: 'building.buildBasicShelter',
  description: 'Build a simple 3x3 shelter at current position',
  async execute(bot, params, signal) {
    const pos = bot.entity.position.floored();
    const { Vec3 } = require('vec3');

    // Find building material
    const MATERIALS = ['dirt','cobblestone','oak_planks','sand','gravel','stone'];
    let material = null;
    for (const m of MATERIALS) {
      material = bot.inventory.items().find(i => i.name === m);
      if (material) break;
    }
    if (!material) throw new Error('No building materials (dirt/cobblestone/planks) in inventory');

    await bot.equip(material, 'hand');

    // Build floor + walls at y, y+1 (2 high walls), roof at y+2
    const floor = [
      [0,0,0],[1,0,0],[2,0,0],
      [0,0,1],        [2,0,1],
      [0,0,2],[1,0,2],[2,0,2],
    ];
    const walls = [
      [0,1,0],[1,1,0],[2,1,0],
      [0,1,2],[1,1,2],[2,1,2],
      [0,1,1],[2,1,1],
    ];
    const roof = [
      [0,2,0],[1,2,0],[2,2,0],
      [0,2,1],[1,2,1],[2,2,1],
      [0,2,2],[1,2,2],[2,2,2],
    ];

    const placeAt = async (dx, dy, dz) => {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const target = new Vec3(pos.x + dx, pos.y + dy, pos.z + dz);
      const existing = bot.blockAt(target);
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') return;

      // Find a solid block adjacent to place against
      const faceOffsets = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
      for (const [fx, fy, fz] of faceOffsets) {
        const refPos = new Vec3(target.x + fx, target.y + fy, target.z + fz);
        const refBlock = bot.blockAt(refPos);
        if (refBlock && refBlock.boundingBox === 'block') {
          try {
            // Re-equip in case the item was used
            const mat = bot.inventory.items().find(i => i.name === material.name);
            if (!mat) return;
            await bot.equip(mat, 'hand');
            await bot.placeBlock(refBlock, new Vec3(-fx, -fy, -fz));
            await new Promise(r => setTimeout(r, 150));
          } catch (_) {}
          return;
        }
      }
    };

    for (const [dx,dy,dz] of [...floor, ...walls, ...roof]) {
      await placeAt(dx, dy, dz);
    }
    log.info('[building.buildBasicShelter] Shelter built');
  },
};

/**
 * @type {import('../../ai/SkillManager').SkillDefinition}
 * Places a single block at a given position.
 */
const placeBlock = {
  id: 'building.placeBlock',
  description: 'Place a specific block at a given position',
  async execute(bot, params, signal) {
    const { position, blockName } = params;
    if (!position || !blockName) throw new Error('building.placeBlock requires position and blockName');

    const item = bot.inventory.items().find(i => i.name === blockName);
    if (!item) throw new Error(`No ${blockName} in inventory`);

    const { Vec3 } = require('vec3');
    const target = new Vec3(position.x, position.y, position.z);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') throw new Error('No solid block below target position');

    await bot.equip(item, 'hand');
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    log.info(`[building.placeBlock] Placed ${blockName} at ${position.x},${position.y},${position.z}`);
  },
};

module.exports = [buildBasicShelter, placeBlock];
