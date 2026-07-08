'use strict';

const EventEmitter = require('events');
const log = require('../lib/logger');

/**
 * @typedef {Object} Plan
 * @property {string} goalId
 * @property {string} goalType
 * @property {{skillId:string, parameters:Object, timeout?:number}[]} steps
 * @property {number} createdAt
 */

/**
 * Planner converts high-level Goals into ordered sequences of Tasks.
 *
 * Bug fixes in this revision:
 *  #4  gather_wood plan is now WorldMemory-aware:
 *        IF tree known in memory  → walkToPosition + chopWood
 *        ELSE                     → walkToNearestTree (expand radius) + chopWood
 *  #4  New goal type 'explore_forest' generates an expanding-radius scan
 *      that tells the movement skill to persist until a tree is found.
 *  #5  World-memory query used in ore plans (already present, confirmed).
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
   * Returns null if no plan can be formed.
   *
   * @param {import('./GoalManager').Goal} goal
   * @param {import('mineflayer').Bot} bot - Read-only
   * @returns {Plan|null}
   */
  plan(goal, bot) {
    if (!goal || !bot) return null;

    try {
      let steps;
      switch (goal.type) {
        case 'survive':        steps = this._planSurvive(goal, bot); break;
        case 'gather_food':    steps = this._planGatherFood(goal, bot); break;
        case 'gather_wood':    steps = this._planGatherWood(goal, bot); break;  // fix #4
        case 'explore_forest': steps = this._planExploreForest(goal, bot); break; // fix #4
        case 'mine_coal':      steps = this._planMine(goal, bot, 'coal_ore', 'coal'); break;
        case 'mine_iron':      steps = this._planMine(goal, bot, 'iron_ore', 'iron_ingot'); break;
        case 'mine_diamonds':  steps = this._planMineDiamonds(goal, bot); break;
        case 'craft_tools':    steps = this._planCraftTools(goal, bot); break;
        case 'craft_furnace':  steps = this._planCraftFurnace(goal, bot); break;
        case 'build_shelter':  steps = this._planBuildShelter(goal, bot); break;
        case 'explore':        steps = this._planExplore(goal, bot); break;
        case 'farm':           steps = this._planFarm(goal, bot); break;
        case 'smelt':          steps = this._planSmelt(goal, bot); break;
        case 'sleep':          steps = this._planSleep(goal, bot); break;
        case 'deposit_items':  steps = this._planDepositItems(goal, bot); break;
        default:
          log.warn(`[Planner] Unknown goal type: ${goal.type}`);
          return null;
      }

      if (!steps || steps.length === 0) {
        log.warn(`[Planner] No steps generated for goal: ${goal.type}`);
        return null;
      }

      // Validate all skill IDs exist in SkillManager
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

  /**
   * Fix #4 + #5: World-memory-aware tree gathering.
   *
   * Priority:
   *  1. Known tree in WorldMemory → walk there directly
   *  2. Tree visible nearby       → walkToNearestTree (expand radius skill)
   *  3. No tree known             → explore_forest first (via Reflection redirect)
   *     Here we still attempt walkToNearestTree with a wide radius (256) and let
   *     the skill's expanding-radius logic find one; Reflection handles the failure
   *     case by redirecting to explore_forest.
   */
  _planGatherWood(goal, bot) {
    const count = goal.parameters.count || 20;

    // Fix #5: query WorldMemory for known trees first
    const knownTree = bot.entity
      ? this.worldMemory.findNearest('tree', bot.entity.position)
      : null;

    if (knownTree) {
      log.info(`[Planner] Known tree at ${JSON.stringify(knownTree.position)} — walking there`);
      return [
        {
          skillId: 'movement.walkToPosition',
          parameters: { position: knownTree.position, range: 4 },
          timeout: 45000,
        },
        {
          skillId: 'mining.chopWood',
          parameters: { count },
          timeout: 90000,
        },
      ];
    }

    // No tree in memory — use expanding-radius search skill
    // The skill will scan 64 → 128 → 256 blocks, so give it a long timeout
    return [
      {
        skillId: 'movement.walkToNearestTree',
        parameters: { maxRadius: 256 },  // skill now supports expanding radius
        timeout: 90000,
      },
      {
        skillId: 'mining.chopWood',
        parameters: { count },
        timeout: 90000,
      },
    ];
  }

  /**
   * Fix #4: explore_forest goal — scan in expanding circles until a tree is found,
   * then save it to WorldMemory. After that, gather_wood can succeed.
   */
  _planExploreForest(goal, bot) {
    const radiusStart = goal.parameters.radiusStart || 128;
    const maxRadius = goal.parameters.maxRadius || 512;

    return [
      {
        skillId: 'movement.exploreForTree',
        parameters: { radiusStart, maxRadius },
        timeout: 300000, // 5 min max — this is a long search
      },
    ];
  }

  _planMine(goal, bot, oreBlock, oreType) {
    const count = goal.parameters.count || 10;
    // Fix #5: query WorldMemory for known ore positions
    const knownOre = bot.entity
      ? this.worldMemory.findNearest('ore', bot.entity.position, oreType)
      : null;
    const steps = [];

    if (knownOre) {
      steps.push({
        skillId: 'movement.walkToPosition',
        parameters: { position: knownOre.position, range: 3 },
        timeout: 30000,
      });
    } else {
      steps.push({
        skillId: 'movement.walkToNearestOre',
        parameters: { oreName: oreBlock },
        timeout: 60000,
      });
    }
    steps.push({ skillId: 'mining.mine', parameters: { blockName: oreBlock, count }, timeout: 120000 });
    return steps;
  }

  _planMineDiamonds(goal, bot) {
    const count = goal.parameters.count || 5;
    return [
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
    return [{ skillId: 'crafting.craftFurnace', parameters: {}, timeout: 20000 }];
  }

  _planBuildShelter(goal, bot) {
    return [{ skillId: 'building.buildBasicShelter', parameters: {}, timeout: 180000 }];
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
    return [{ skillId: 'crafting.smeltItem', parameters: { item, count }, timeout: 120000 }];
  }

  _planSleep(goal, bot) {
    return [{ skillId: 'survival.sleep', parameters: {}, timeout: 30000 }];
  }

  _planDepositItems(goal, bot) {
    return [{ skillId: 'utility.depositToChest', parameters: {}, timeout: 30000 }];
  }
}

module.exports = Planner;
