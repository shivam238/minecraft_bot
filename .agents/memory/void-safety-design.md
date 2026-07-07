---
name: Void safety design
description: How void-fall prevention works in this mineflayer bot; invariants that must not be broken.
---

## The problem
Bot kept walking/sprinting/jumping into void in Skyblock-style worlds. Root causes:
1. Direct movement (setControlState) set keys without checking the direction for void edges.
2. `isPathSafe` allowed 4-block drops — fatal in void worlds.
3. No proactive detection of the bot actively falling.

## Key invariant — direction validation
`runDirectWalk`, `runSprintBurst`, `runJumpWalk` must always:
1. Compute the **world yaw** they intend to move toward.
2. Call `isDirectionSafe(yaw, distance)` on that exact yaw BEFORE pressing any keys.
3. After rotating the bot to that yaw, press **only `forward`** — never `back/left/right` after a yaw-safety check, as those map to different world directions and break the invariant.

**Why:** The direction check is tied to a world-space yaw. If you press `left` after checking `yaw + π/2`, you've moved in a direction that was never validated.

## VOID_ESCAPE priority (0)
- Highest in the system — fires before EMERGENCY_SURVIVAL.
- Triggered by `isFallingIntoVoid()`: velocity.y < -0.1 AND no solid block in 6 blocks below.
- False-positive guard: if ≥4 of those blocks are null (chunk unloaded), suppress the trigger.
- Transition handler: immediately calls `releaseMovementKeys()` + `pathfinder.stop()`.
- Logic: retries pathfinding to `findClosestSafePosition()` every 2s.

## isDirectionSafe
- Checks every 0.5-block step along the yaw direction for up to `distBlocks`.
- Only allows 1-block drop tolerance (not 4) — safe for void worlds.
- Treats null blocks as unsafe (no solid → fail).

## findClosestSafePosition
- Replaces old `recentPositions[0]` — finds the *nearest* known safe position.
- Used in both VOID_ESCAPE and EMERGENCY_SURVIVAL logic.
