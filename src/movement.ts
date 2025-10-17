import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";

// ========== Type Definitions ==========

/** Axis-aligned direction vector (either x is 0 or z is 0, never both non-zero) */
export type AxisAlignedDirection =
  | { x: 1; y: 0; z: 0 }
  | { x: -1; y: 0; z: 0 }
  | { x: 0; y: 0; z: 1 }
  | { x: 0; y: 0; z: -1 };

// ========== Position Formatting Functions ==========

export function formatBotPosition(pos: Vec3): string {
  return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

export function formatBlockPosition(pos: Vec3): string {
  // Blocks are always at integer coordinates, but we show the center at .5
  return `(${Math.floor(pos.x) + 0.5}, ${Math.floor(pos.y) + 0.5}, ${Math.floor(pos.z) + 0.5})`;
}

// ========== Block Checking Functions ==========

/**
 * Check if a block is empty (air, water, or lava - things we can move through)
 */
export function isBlockEmpty(block: Block | null): boolean {
  if (!block) return true;
  return block.name === 'air' || block.name === 'water' || block.name === 'lava';
}

/**
 * Get the blocks ahead of the bot's head and feet
 */
export function getBlocksAhead(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection
): { blockAheadOfHead: Block | null; blockAheadOfFeet: Block | null } {
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());

  return { blockAheadOfHead, blockAheadOfFeet };
}

// ========== Basic Movement Helper Functions ==========

/**
 * Get the distance from the bot to the target
 */
export function getDistance(bot: Bot, target: Vec3): number {
  return bot.entity.position.distanceTo(target);
}

/**
 * Get the next axis-aligned direction to move toward target
 * Returns a vector where either x is 0 or z is 0 (never both non-zero)
 */
export function getNextDirection(bot: Bot, target: Vec3): AxisAlignedDirection {
  const currentPos = bot.entity.position;
  const dx = target.x - currentPos.x;
  const dz = target.z - currentPos.z;

  // Choose the axis with larger absolute difference
  if (Math.abs(dx) > Math.abs(dz)) {
    // Move along X axis
    return dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
  } else {
    // Move along Z axis
    return dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
  }
}

// ========== Jump Helper Functions ==========

export async function jumpAndWaitToBeInAir(bot: Bot): Promise<void> {
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 100)); // Initial jump delay
  await new Promise(r => setTimeout(r, 200)); // Wait to be airborne
}

export async function waitToLandFromAir(bot: Bot): Promise<void> {
  bot.setControlState('jump', false);
  await new Promise(r => setTimeout(r, 300)); // Wait to land
}

// ========== Small Obstacle Jump ==========

export type JumpResult =
  | { success: true }
  | { success: false; error: string };

export async function jumpOverSmallObstacleIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection,
  target: Vec3
): Promise<JumpResult> {
  // Check all relevant blocks
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);
  const blockAboveHead = bot.blockAt(currentPos.offset(0, 2, 0).floor());
  const blockAheadHeadPlusOne = bot.blockAt(currentPos.offset(direction.x, 2, direction.z).floor());

  // Build block situation string (used in all error messages)
  const blockSituation = `Block ahead of feet: ${blockAheadOfFeet?.name || 'null'}, ` +
    `ahead of head: ${blockAheadOfHead?.name || 'null'}, ` +
    `above head: ${blockAboveHead?.name || 'null'}, ` +
    `planned head dest (ahead+up): ${blockAheadHeadPlusOne?.name || 'null'}`;

  const feetClear = isBlockEmpty(blockAheadOfFeet);
  const headClear = isBlockEmpty(blockAheadOfHead);
  const aboveHeadClear = !blockAboveHead || blockAboveHead.name === 'air';
  const plannedHeadDestClear = !blockAheadHeadPlusOne || blockAheadHeadPlusOne.name === 'air';

  // Early returns for conditions that prevent jumping
  if (feetClear) {
    return {
      success: false,
      error: `Jump not attempted: feet ahead are clear (no obstacle to jump over). ${blockSituation}`
    };
  }

  if (!headClear) {
    return {
      success: false,
      error: `Jump not attempted: block ahead of head is not clear. ${blockSituation}`
    };
  }

  if (!aboveHeadClear) {
    return {
      success: false,
      error: `Jump not attempted: block above head is not clear (no room to jump). ${blockSituation}`
    };
  }

  if (!plannedHeadDestClear) {
    return {
      success: false,
      error: `Jump not attempted: planned head destination (ahead+up) is not clear. ${blockSituation}`
    };
  }

  // All conditions met - attempt the jump
  const startPos = currentPos.clone();
  const startDist = startPos.distanceTo(target);

  bot.setControlState('jump', true);
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 100));
  bot.setControlState('jump', false);
  bot.setControlState('forward', false);
  await new Promise(r => setTimeout(r, 50));

  const endPos = bot.entity.position;
  const endDist = endPos.distanceTo(target);
  const progress = startDist - endDist;

  // If we didn't make progress, the jump failed
  if (progress < 0.3) {
    const currentBlockAboveHead = bot.blockAt(endPos.offset(0, 1, 0).floor());
    return {
      success: false,
      error: `Jump failed - made only ${progress.toFixed(2)} blocks progress. ` +
        `Before: ${formatBotPosition(startPos)}, ` +
        `After: ${formatBotPosition(endPos)}. ` +
        `Block above bot head now: ${currentBlockAboveHead?.name || 'null'}. ${blockSituation}`
    };
  }

  return {success: true};
}
