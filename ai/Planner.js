'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} Plan
 * @property {string} goalId - Which goal this plan serves
 * @property {string} goalType
 * @property {{skillId:string,parameters:Object,timeout?:number}[]} steps - Ordered task sequence
 * @property {number} createdAt
 */

/**
 * Planner converts high-level Goals into ordered sequences of Tasks.
 *
 * ──── Critical Architecture Rule ────────────────────────────────────────────
 * The Planner NEVER calls Mineflayer directly.
 * It only inspects bot state (read-only) to determine what tasks are needed,
 * then returns a Plan object which TaskQueue executes via SkillManager.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plans are deterministic (no LLM/RL required) — based on goal type and
 * current world/needs state. Each planXxx() method encapsulates one goal family.
 *
 * @fires Planner#planCreated
 * @fires Planner#planFailed
 */
class Planner extends EventEmitter {
  /**
   * @param {import('./WorldMemory')} worldMemory
   * @param {import('./NeedsSystem')} needsSystem
   * @param {import('./SkillManager')} skillManager
   */
  constructor(worldMemory, needsSystem, skillManager) {
    super();
    this.worldMemory = worldMemory;
    this.needsSystem = needsSystem;
    this.skillManager = skillManager;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Generate a Plan for the given Goal.
   * Returns null if no plan can be formed (Reflection should handle this).
   *
   * @param {import('./GoalManager').Goal} goal
   * @param {import('mineflayer').Bot} bot - Read-only snapshot
   * @returns {Plan|null}
   */
  plan(goal, bot) {
    if (!goal || !bot) return null;

    try {
      let steps;
      switch (goal.type) {
        case 'survive':
          steps = this._planSurvive(goal, bot);
          break;
        case 'gather_food':
          steps = this._planGatherFood(goal, bot);
          break;
        case 'gather_wood':
          steps = this._planGatherWood(goal, bot);
          break;
        case 'mine_coal':
          steps = this._planMine(goal, bot, 'coal_ore', 'coal');
          break;
        case 'mine_iron':
          steps = this._planMine(goal, bot, 'iron_ore', 'iron_ingot');
          break;
        case 'mine_diamonds':
          steps = this._planMineDiamonds(goal, bot);
          break;
        case 'craft_tools':
          steps = this._planCraftTools(goal, bot);
          break;
        case 'craft_furnace':
          steps = this._planCraftFurnace(goal, bot);
          break;
        case 'build_shelter':
          steps = this._planBuildShelter(goal, bot);
          break;
        case 'explore':
          steps = this._planExplore(goal, bot);
          break;
        case 'farm':
          steps = this._planFarm(goal, bot);
          break;
        case 'smelt':
          steps = this._planSmelt(goal, bot);
          break;
        case 'sleep':
          steps = this._planSleep(goal, bot);
          break;
        case 'deposit_items':
          steps = this._planDepositItems(goal, bot);
          break;
        default:
          log.warn(`[Planner] Unknown goal type: ${goal.type}`);
          return null;
      }

      if (!steps || steps.length === 0) {
        log.warn(`[Planner] No steps generated for goal: ${goal.type}`);
        return null;
      }

      // Validate all skill IDs exist
      for (const step of steps) {
        if (!this.skillManager.has(step.skillId)) {
          log.warn(`[Planner] Skill not found: ${step.skillId} (for goal ${goal.type})`);
          return null;
        }
      }

      const plan = {
        goalId: goal.id,
        goalType: goal.type,
        steps,
        createdAt: Date.now(),
      };

      log.info(`[Planner] Plan created for [${goal.type}] — ${steps.length} steps`);
      /** @event Planner#planCreated */
      this.emit('planCreated', plan, goal);
      return plan;
    } catch (err) {
      log.warn(`[Planner] Planning failed for [${goal.type}]: ${err.message}`);
      /** @event Planner#planFailed */
      this.emit('planFailed', goal, err);
      return null;
    }
  }

  // ─── Plan implementations ────────────────────────────────────────────────────

  _planSurvive(goal, bot) {
    const steps = [];
    const hungerUrgency = this.needsSystem.getUrgency('hunger');
    const healthUrgency = this.needsSystem.getUrgency('health');

    if (hungerUrgency === 'CRITICAL' || hungerUrgency === 'HIGH') {
      steps.push({ skillId: 'survival.eatFood', parameters: {}, timeout: 10000 });
    }
    if (healthUrgency === 'HIGH' || healthUrgency === 'CRITICAL') {
      steps.push({ skillId: 'survival.seekShelter', parameters: {}, timeout: 30000 });
    }
    if (steps.length === 0) {
      // Just eat if possible
      steps.push({ skillId: 'survival.eatFood', parameters: {}, timeout: 10000 });
    }
    return steps;
  }

  _planGatherFood(goal, bot) {
    const count = goal.parameters.count || 10;
    return [
      { skillId: 'survival.eatFood', parameters: { count }, timeout: 30000 },
    ];
  }

  _planGatherWood(goal, bot) {
    const count = goal.parameters.count || 20;
    return [
      { skillId: 'movement.walkToNearestTree', parameters: {}, timeout: 30000 },
      { skillId: 'mining.chopWood', parameters: { count }, timeout: 60000 },
    ];
  }

  _planMine(goal, bot, oreBlock, oreType) {
    const count = goal.parameters.count || 10;
    const knownOre = this.worldMemory.findNearest('ore', bot.entity.position, oreType);
    const steps = [];

    if (knownOre) {
      steps.push({
        skillId: 'movement.walkToPosition',
        parameters: { position: knownOre.position, range: 3 },
        timeout: 30000,
      });
    } else {
      steps.push({ skillId: 'movement.walkToNearestOre', parameters: { oreName: oreBlock }, timeout: 60000 });
    }
    steps.push({ skillId: `mining.mine`, parameters: { blockName: oreBlock, count }, timeout: 120000 });
    return steps;
  }

  _planMineDiamonds(goal, bot) {
    const count = goal.parameters.count || 5;
    return [
      // Need iron pickaxe first
      { skillId: 'mining.mine', parameters: { blockName: 'stone', count: 3 }, timeout: 60000 },
      { skillId: 'movement.descendToYLevel', parameters: { targetY: -54 }, timeout: 120000 },
      { skillId: 'mining.mine', parameters: { blockName: 'diamond_ore', count }, timeout: 300000 },
    ];
  }

  _planCraftTools(goal, bot) {
    const toolType = goal.parameters.toolType || 'wooden';
    return [
      { skillId: 'crafting.openCraftingTable', parameters: {}, timeout: 15000 },
      { skillId: 'crafting.craftPickaxe', parameters: { material: toolType }, timeout: 20000 },
      { skillId: 'crafting.craftAxe', parameters: { material: toolType }, timeout: 20000 },
      { skillId: 'crafting.craftShovel', parameters: { material: toolType }, timeout: 20000 },
    ];
  }

  _planCraftFurnace(goal, bot) {
    return [
      { skillId: 'crafting.craftFurnace', parameters: {}, timeout: 20000 },
    ];
  }

  _planBuildShelter(goal, bot) {
    return [
      { skillId: 'building.buildBasicShelter', parameters: {}, timeout: 180000 },
    ];
  }

  _planExplore(goal, bot) {
    const radius = goal.parameters.radius || 100;
    const direction = goal.parameters.direction || null;
    return [
      { skillId: 'movement.explore', parameters: { radius, direction }, timeout: 120000 },
    ];
  }

  _planFarm(goal, bot) {
    return [
      { skillId: 'farming.harvestCrops', parameters: {}, timeout: 60000 },
      { skillId: 'farming.replantCrops', parameters: {}, timeout: 60000 },
    ];
  }

  _planSmelt(goal, bot) {
    const item = goal.parameters.item || 'iron_ore';
    const count = goal.parameters.count || 8;
    return [
      { skillId: 'crafting.smeltItem', parameters: { item, count }, timeout: 120000 },
    ];
  }

  _planSleep(goal, bot) {
    return [
      { skillId: 'survival.sleep', parameters: {}, timeout: 30000 },
    ];
  }

  _planDepositItems(goal, bot) {
    return [
      { skillId: 'utility.depositToChest', parameters: {}, timeout: 30000 },
    ];
  }
}

module.exports = Planner;
