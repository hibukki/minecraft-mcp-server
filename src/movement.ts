import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import { appendFileSync } from "fs";
import { formatError } from "./bot_log.js";
import logger from "./logger.js";
import { tryMiningOneBlock } from "./tryMiningOneBlock.js";

export type MiningResult =
  | { success: true; blocksMined: number }
  | { success: false; blocksMined: number; error: string };


export type PillarResult =
  | { success: true; pillaredUpBlocks: number; movedBlocksCloser: number }
  | { success: false; pillaredUpBlocks: number; movedBlocksCloser: number; error: string };

export type MineForwardResult =
  | { success: true; blocksMined: number }
  | { success: false; blocksMined: number; error: string };

export type MineDownOneStepResult =
  | { success: true }
  | { success: false; error: string };

type MineUpOneStepResult =
  | { success: true }
  | { success: false; error: string };

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
  return `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
}

// ========== Block Checking Functions ==========

/**
 * Check if a block is empty (air, water, lava, or passable blocks like flowers - things we can move through)
 */
export function isBlockEmpty(block: Block | null): boolean {
  if (!block) return true;
  // Check for air, water, lava
  if (block.name === 'air' || block.name === 'water' || block.name === 'lava') return true;
  // Check for passable blocks (flowers, tall grass, etc.) which have no collision
  if (block.boundingBox === 'empty') return true;
  return false;
}

/**
 * Check if there's a clear line of sight from one position to another
 * Uses recursive pathfinding to detect obstructing blocks
 *
 * @param bot - The bot instance
 * @param fromPos - Starting position (block coordinates)
 * @param toPos - Target position (block coordinates)
 * @param maxBlocksToTest - Maximum number of blocks to check (default 100) to prevent long runtime
 * @param visited - Internal: Set of visited positions to avoid re-checking
 * @returns Object with clear flag and array of blocking blocks if path is not clear
 */
export function isPathClear(
  bot: Bot,
  fromPos: Vec3,
  toPos: Vec3,
  maxBlocksToTest: number = 100,
  visited: Set<string> = new Set()
): { clear: boolean; blockingBlocks: Block[] } {
  // Create a key for this position
  const key = `${Math.floor(fromPos.x)},${Math.floor(fromPos.y)},${Math.floor(fromPos.z)}`;

  // Check if we've already visited this position
  if (visited.has(key)) {
    return { clear: false, blockingBlocks: [] };
  }

  // Check if we've tested too many blocks
  if (visited.size >= maxBlocksToTest) {
    return { clear: false, blockingBlocks: [] };
  }

  // Mark this position as visited
  visited.add(key);

  // Base case: reached target
  const flooredFrom = fromPos.floored();
  const flooredTo = toPos.floored();
  if (flooredFrom.x === flooredTo.x && flooredFrom.y === flooredTo.y && flooredFrom.z === flooredTo.z) {
    return { clear: true, blockingBlocks: [] };
  }

  // Check if current position has a blocking block
  const currentBlock = bot.blockAt(flooredFrom);
  if (!isBlockEmpty(currentBlock)) {
    return { clear: false, blockingBlocks: currentBlock ? [currentBlock] : [] };
  }

  // Calculate which directions move us closer to target
  const dx = flooredTo.x - flooredFrom.x;
  const dy = flooredTo.y - flooredFrom.y;
  const dz = flooredTo.z - flooredFrom.z;

  // Try each direction that moves us closer
  const directions: Vec3[] = [];

  if (dx > 0) directions.push(new Vec3(1, 0, 0));
  if (dx < 0) directions.push(new Vec3(-1, 0, 0));
  if (dy > 0) directions.push(new Vec3(0, 1, 0));
  if (dy < 0) directions.push(new Vec3(0, -1, 0));
  if (dz > 0) directions.push(new Vec3(0, 0, 1));
  if (dz < 0) directions.push(new Vec3(0, 0, -1));

  // Try each direction - if ANY succeeds, path is clear
  // Collect all blocking blocks we find along the way
  const blockingBlocksFoundSoFar: Block[] = [];
  for (const dir of directions) {
    const nextPos = fromPos.plus(dir);
    const result = isPathClear(bot, nextPos, toPos, maxBlocksToTest, visited);
    if (result.clear) {
      return result;
    }
    // Collect blocking blocks from this failed path
    blockingBlocksFoundSoFar.push(...result.blockingBlocks);
  }

  // No direction worked - path is blocked, return all blocking blocks we found
  return { clear: false, blockingBlocks: blockingBlocksFoundSoFar };
}

/**
 * Get the blocks ahead of the bot's head and feet
 */
export function getBlocksAhead(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection
): { blockAheadOfHead: Block; blockAheadOfFeet: Block,  blockAheadOfFeetClear: boolean, blockAheadOfHeadClear: boolean} {
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor())!;
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor())!;
  const blockAheadOfFeetClear = isBlockEmpty(blockAheadOfFeet);
  const blockAheadOfHeadClear = isBlockEmpty(blockAheadOfHead);

  return { blockAheadOfHead, blockAheadOfFeet, blockAheadOfFeetClear, blockAheadOfHeadClear };
}

// ========== Basic Movement Helper Functions ==========

/**
 * Get the distance from the bot to the target
 */
export function getDistance(bot: Bot, target: Vec3): number {
  return bot.entity.position.distanceTo(target);
}

export function getBlockCenter(block: Block | null): Vec3 {
  const blockCorner = block!.position;
  return new Vec3(blockCorner.x + 0.5, blockCorner.y + 0.5, blockCorner.z + 0.5)
}

/**
 * Get the next axis-aligned direction to move toward target
 * Returns a vector where either x is 0 or z is 0 (never both non-zero)
 */
export function getNextXZAlignedDirection(bot: Bot, target: Vec3): AxisAlignedDirection {
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
  target: Vec3,
  thenStop: boolean = true,
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

  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 100));
  bot.setControlState('jump', true);
  
  await new Promise(r => setTimeout(r, 100));
  bot.setControlState('jump', false);
  if (thenStop) {
    await new Promise(r => setTimeout(r, 200));
    bot.setControlState('forward', false);
  }
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

// ========== Walking Functions ==========

export async function walkForwardsIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection,
  thenStop: boolean = true,
): Promise<boolean> {
  logger.debug("Running walkForwardsIfPossible")
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

  const feetClear = isBlockEmpty(blockAheadOfFeet);
  const headClear = isBlockEmpty(blockAheadOfHead);

  if (feetClear && headClear) {
    walkForwardsAtLeastOneBlock(bot, blockAheadOfFeet!.position, thenStop)
    return true;
  }

  return false;
}

/**
 * Walk forward for at least 500ms to ensure the bot moves at least one block
 */
export async function walkForwardsAtLeastOneBlockXZAligned(
  bot: Bot,
  direction: AxisAlignedDirection
): Promise<void> {
  // Look in the direction we're walking
  const currentPos = bot.entity.position;
  const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);

  return walkForwardsAtLeastOneBlock(bot, lookTarget)
}

export async function walkForwardsAtLeastOneBlock(
  bot: Bot,
  target: Vec3,
  thenStop: boolean = true
): Promise<void> {
  await bot.lookAt(target, false);

  // Walk forward for 500ms
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 500));
  if (thenStop) {
      bot.setControlState('forward', false);
  }
}

// ========== Strafe Functions ==========

/**
 * Get the axis-aligned direction the bot is currently facing
 * Throws if bot is not facing a cardinal direction
 */
export function getBotAxisAlignedDirection(bot: Bot): AxisAlignedDirection {
  const yaw = bot.entity.yaw;

  // Normalize yaw to 0-2π range
  const normalizedYaw = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);

  // Convert to degrees for easier reasoning
  const degrees = (normalizedYaw * 180) / Math.PI;

  // Check which cardinal direction (exact 90 degree increments)
  const rounded = Math.round(degrees / 90) * 90;

  if (Math.abs(degrees - rounded) > 1) {
    // Not aligned to cardinal direction
    throw new Error(
      `Bot is not axis-aligned. Yaw: ${yaw.toFixed(2)} rad (${degrees.toFixed(1)}°). ` +
      `Expected exactly: 0°, 90°, 180°, or 270°`
    );
  }

  // Return direction based on rounded degrees
  switch ((rounded + 360) % 360) {
    case 0:   // South (+Z)
      return { x: 0, y: 0, z: 1 };
    case 90:  // West (-X)
      return { x: -1, y: 0, z: 0 };
    case 180: // North (-Z)
      return { x: 0, y: 0, z: -1 };
    case 270: // East (+X)
      return { x: 1, y: 0, z: 0 };
    default:
      throw new Error(`Unexpected rounded degrees: ${rounded}`);
  }
}

/**
 * Calculate strafe direction and amount needed to center the bot
 * Uses bot's yaw to determine which axis to align on, and bot's position for the amount
 * Returns null if already centered enough
 */
export function getStrafeDirectionAndAmount(
  bot: Bot
): { direction: 'left' | 'right'; amount: number } | null {
  const currentPos = bot.entity.position;
  const facingDirection = getBotAxisAlignedDirection(bot);

  // Determine which coordinate to check based on facing direction
  // If facing along X-axis, need to center Z. If facing along Z-axis, need to center X.
  let perpCoord: number;
  if (facingDirection.x !== 0) {
    // Facing east or west (along X), check Z alignment
    perpCoord = currentPos.z;
  } else {
    // Facing north or south (along Z), check X alignment
    perpCoord = currentPos.x;
  }

  // Calculate offset from block center (0.5 is perfectly centered)
  // Use ((x % 1) + 1) % 1 to normalize to 0-1 range (handles negative coords)
  const normalizedCoord = ((perpCoord % 1.0) + 1.0) % 1.0; // Normalize to 0-1 range
  const offsetFromCenter = normalizedCoord - 0.5; // Range: -0.5 to +0.5

  // Threshold: if we're within 0.1 blocks of center, no strafe needed
  const ALIGNMENT_THRESHOLD = 0.1;
  if (Math.abs(offsetFromCenter) <= ALIGNMENT_THRESHOLD) {
    return null;
  }

  // Determine strafe direction based on facing direction and position offset
  let strafeDirection: 'left' | 'right';

  // offsetFromCenter < 0 means we need to increase the perpendicular coordinate
  // offsetFromCenter > 0 means we need to decrease the perpendicular coordinate
  if (facingDirection.x > 0) {      // Facing east (+X), perpCoord is Z
    // Increase Z (+Z) = strafe right, Decrease Z (-Z) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else if (facingDirection.x < 0) { // Facing west (-X), perpCoord is Z
    // Increase Z (+Z) = strafe left, Decrease Z (-Z) = strafe right
    strafeDirection = offsetFromCenter > 0 ? 'right' : 'left';
  } else if (facingDirection.z > 0) { // Facing south (+Z), perpCoord is X
    // Increase X (+X) = strafe right, Decrease X (-X) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else {                            // Facing north (-Z), perpCoord is X
    // Increase X (+X) = strafe left, Decrease X (-X) = strafe right
    strafeDirection = offsetFromCenter > 0 ? 'right' : 'left';
  }

  return {
    direction: strafeDirection,
    amount: Math.abs(offsetFromCenter)
  };
}

/**
 * Strafe the bot toward the center of the block perpendicular to facing direction
 * Strategy: Use 50ms strafes (moves 0.2 blocks) in a loop until centered within 0.2 blocks.
 * This avoids overshooting and hitting the opposite wall.
 */
export async function strafeToMiddle(bot: Bot): Promise<void> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const strafeInfo = getStrafeDirectionAndAmount(bot);

    if (!strafeInfo) {
      // Already centered enough
      return;
    }

    const { direction, amount } = strafeInfo;
    const posBefore = bot.entity.position.clone();

    // Use 50ms which moves ~0.2 blocks
    const strafeDuration = 50;

    bot.setControlState(direction, true);
    await new Promise(r => setTimeout(r, strafeDuration));
    bot.setControlState(direction, false);

    const posAfter = bot.entity.position.clone();
    const actualMovement = posBefore.distanceTo(posAfter);

    // Check final position
    const afterStrafe = getStrafeDirectionAndAmount(bot);
    const finalOffset = afterStrafe ? afterStrafe.amount : 0;

    const strafeDataMsg =
      `Strafe attempt ${attempt + 1}: dir=${direction}, before=${amount.toFixed(3)}b from center, ` +
      `duration=${strafeDuration}ms, actual_moved=${actualMovement.toFixed(3)}b, ` +
      `after=${Math.abs(finalOffset).toFixed(3)}b from center, ` +
      `pos_before=(${posBefore.x.toFixed(2)},${posBefore.z.toFixed(2)}), ` +
      `pos_after=(${posAfter.x.toFixed(2)},${posAfter.z.toFixed(2)})`;

    logger.debug(strafeDataMsg);

    // If we're now centered (within 0.2 blocks), we're done
    if (!afterStrafe || Math.abs(afterStrafe.amount) <= 0.2) {
      return;
    }
  }

  // After MAX_ATTEMPTS, check if we're close enough
  const finalCheck = getStrafeDirectionAndAmount(bot);
  if (finalCheck && Math.abs(finalCheck.amount) > 0.2) {
    const errorMsg = `Failed to center after ${MAX_ATTEMPTS} attempts: still ${finalCheck.amount.toFixed(2)}b from center`;
    appendFileSync('strafe_log.txt', errorMsg + '\n');
    throw new Error(errorMsg);
  }
}

/**
 * Center the bot in both X and Z axes by rotating to each axis and strafing
 */
export async function strafeToMiddleBothXZ(bot: Bot): Promise<void> {
  // Save original yaw
  const originalYaw = bot.entity.yaw;

  // Center in X direction (face north or south)
  await bot.look(0, 0, false); // Face south (0 yaw = south in Minecraft)
  await new Promise(resolve => setTimeout(resolve, 50));
  await strafeToMiddle(bot);

  // Center in Z direction (face east or west)
  await bot.look(Math.PI / 2, 0, false); // Face west (90 degrees)
  await new Promise(resolve => setTimeout(resolve, 50));
  await strafeToMiddle(bot);

  // Restore original yaw
  await bot.look(originalYaw, 0, false);
}// Helper functions for move-to horizontal movement
export async function mineForwardsIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  DIG_TIMEOUT_SECONDS: number,
  returnErrorIfNothingMined: boolean = true): Promise<MineForwardResult> {
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);
  let totalBlocksMined = 0;

  const botPos = bot.entity.position;
  const botBottomHalf = formatBotPosition(botPos);

  // Try mining head block first
  if (!isBlockEmpty(blockAheadOfHead)) {
    const result = await tryMiningOneBlock(bot, blockAheadOfHead!, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return { ...result, blocksMined: totalBlocksMined };
  }

  // Try mining feet block
  if (!isBlockEmpty(blockAheadOfFeet)) {
    const result = await tryMiningOneBlock(bot, blockAheadOfFeet!, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return { ...result, blocksMined: totalBlocksMined };
  }

  // Build detailed error message about what blocks we tried to mine
  const headInfo = blockAheadOfHead
    ? `${blockAheadOfHead.name} at ${formatBlockPosition(blockAheadOfHead.position)}`
    : 'air or null';
  const feetInfo = blockAheadOfFeet
    ? `${blockAheadOfFeet.name} at ${formatBlockPosition(blockAheadOfFeet.position)}`
    : 'air or null';

  // If we mined nothing and should return an error
  if (totalBlocksMined === 0 && returnErrorIfNothingMined) {
    return {
      success: false,
      blocksMined: 0,
      error: `No blocks mined. Bot bottom-half at ${botBottomHalf}. Block ahead of head: ${headInfo}. Block ahead of feet: ${feetInfo}. allowMiningOf is ${Object.keys(allowMiningOf).length === 0 ? 'empty (no mining allowed)' : `{${Object.keys(allowMiningOf).join(', ')}}`}`
    };
  }

  // If we mined some blocks, return success
  if (totalBlocksMined > 0) {
    return { success: true, blocksMined: totalBlocksMined };
  }

  // If we're here, totalBlocksMined is 0 and returnErrorIfNothingMined is false
  // This means we were told it's okay to return with no mining
  return { success: true, blocksMined: 0 };
}
/**
 * Dig directly down if possible, ensuring we won't fall into a hole
 * @param bot The minecraft bot
 * @param blocksToDigDown How many blocks down to dig (typically 1)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and blocks mined
 */
export async function digDirectlyDownIfPossible(
  bot: Bot,
  blocksToDigDown: number,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number): Promise<MineForwardResult> {
  // Center the bot so we're digging straight down from the middle of the block
  await strafeToMiddleBothXZ(bot);

  let totalBlocksMined = 0;

  // Dig down multiple blocks
  for (let i = 0; i < blocksToDigDown; i++) {
    const currentBotPos = bot.entity.position;
    const blockUnderUs = bot.blockAt(currentBotPos.offset(0, -1, 0));
    const blockUnderUnderUs = bot.blockAt(currentBotPos.offset(0, -2, 0));
    const blockUnderUnderUnderUs = bot.blockAt(currentBotPos.offset(0, -3, 0));

    // Safety check: make sure there's a solid block two blocks down
    // so we don't fall into a hole when we dig the block under us
    if (isBlockEmpty(blockUnderUnderUs)) {
      return {
        success: false,
        blocksMined: totalBlocksMined,
        error: `Not digging for caution: block at ${formatBlockPosition(currentBotPos.offset(0, -2, 0))} (below what we are digging) is ${blockUnderUnderUs?.name || 'null'}, would fall into hole if we dug one down. Use dig-adjacent-block at your own risk (you will probably die if you keep digging down)`
      };
    }

    if (isBlockEmpty(blockUnderUnderUnderUs)) {
      return {
        success: false,
        blocksMined: totalBlocksMined,
        error: `Not digging for caution: block at ${formatBlockPosition(currentBotPos.offset(0, -3, 0))} (below what we are digging) is ${blockUnderUnderUs?.name || 'null'}, would fall into hole if we dug one down. Use dig-adjacent-block at your own risk (you will probably die if you keep digging down)`
      };
    }

    // Dig the block under us
    const result = await tryMiningOneBlock(bot, blockUnderUs!, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        success: false,
        blocksMined: totalBlocksMined,
        error: `Failed to dig block under bot: ${result.error}`
      };
    }

    totalBlocksMined += result.blocksMined;

    // Wait for bot to fall and land on the block below
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return {
    success: true,
    blocksMined: totalBlocksMined
  };
}
/**
 * Try to pillar up one block, handling all validation and errors
 * Returns detailed error info if pillaring fails
 */
export async function tryPillaringUpIfSensible(
  bot: Bot,
  target: Vec3,
  allowPillarUpWith: string[],
  allowMiningOf: Record<string, string[]> = {},
  digTimeout: number = 3): Promise<PillarResult> {
  const currentPos = bot.entity.position;
  const startDist = currentPos.distanceTo(target);
  const verticalDist = Math.abs(currentPos.y - target.y);

  // Check if we should pillar (target is above)
  // Allow pillaring even for small vertical distances
  if (target.y <= currentPos.y) {
    return {
      success: false,
      error: `Target not above us (target.y=${target.y}, current.y=${currentPos.y})`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  // Check if blocks provided
  if (allowPillarUpWith.length === 0) {
    return {
      success: false,
      error: `Target is ${verticalDist.toFixed(1)} blocks above but no allowPillarUpWith blocks provided`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  // Find pillar block in inventory
  const pillarBlock = bot.inventory.items().find(item => allowPillarUpWith.includes(item.name));
  if (!pillarBlock) {
    return {
      success: false,
      error: `Need blocks ${allowPillarUpWith.join(', ')} but none found in inventory`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  const buildingBlockName = pillarBlock.name;

  // Check and clear blocks above (up to 3 blocks), sorted by closest first
  const blocksToCheck = [2, 3, 4]; // Y+2, Y+3, Y+4 (closest to farthest)
  for (const yOffset of blocksToCheck) {
    const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
    if (!isBlockEmpty(blockAbove)) {
      // Try to mine this block using the mining tools mapping
      const mineResult = await tryMiningOneBlock(bot, blockAbove!, allowMiningOf, digTimeout, true);
      if (!mineResult.success) {
        return {
          success: false,
          error: `Blocked at Y+${yOffset} by ${blockAbove!.name}, failed to clear: ${mineResult.error}`,
          pillaredUpBlocks: 0,
          movedBlocksCloser: 0
        };
      }
      // Successfully mined, continue checking other blocks above
    }
  }

  // Re-equip the building block (in case we switched to a tool for mining)
  const buildingBlock = bot.inventory.items().find(item => item.name === buildingBlockName);
  if (!buildingBlock) {
    return {
      success: false,
      error: `Lost ${buildingBlockName} from inventory while clearing blocks above`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }
  await bot.equip(buildingBlock, 'hand');

  // Attempt pillar
  const beforeY = currentPos.y.toFixed(1);
  const pillared = await pillarUpOneBlock(bot);
  const afterY = bot.entity.position.y.toFixed(1);

  const newPos = bot.entity.position;
  const newDist = newPos.distanceTo(target);
  const movedCloser = startDist - newDist;

  if (pillared && afterY > beforeY) {
    return {
      success: true,
      pillaredUpBlocks: 1,
      movedBlocksCloser: movedCloser
    };
  } else {
    // Check what went wrong
    const stillHaveBlocks = bot.heldItem && bot.heldItem.name === buildingBlockName;
    return {
      success: false,
      error: `Failed to pillar up (Y ${beforeY}→${afterY}). Still have ${buildingBlockName}: ${stillHaveBlocks}`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }
}
/**
 * Mine down one step by clearing blocks ahead and moving forward-and-down
 * @param bot The minecraft bot
 * @param direction The XZ-aligned direction to move (e.g., {x: 1, z: 0} for east)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and error details if failed
 */
export async function mineDownOneStep(
  bot: Bot,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number): Promise<MineDownOneStepResult> {
  const currentPos = bot.entity.position;

  // Get the three blocks we need to mine: ahead of head, ahead of feet, and ahead-and-down
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadAndDown = bot.blockAt(currentPos.offset(direction.x, -1, direction.z).floor());

  // Mine each block in order if not empty
  const blocksToMine = [
    { block: blockAheadOfHead, name: "ahead of head" },
    { block: blockAheadOfFeet, name: "ahead of feet" },
    { block: blockAheadAndDown, name: "ahead and down" }
  ];

  for (const { block, name } of blocksToMine) {
    if (block && !isBlockEmpty(block)) {
      const result = await tryMiningOneBlock(bot, block, allowMiningOf, digTimeout, true);
      if (!result.success) {
        return {
          success: false,
          error: `Failed to mine block ${name}: ${result.error}`
        };
      }
    }
  }

  // Calculate expected position after the step
  const expectedPos = currentPos.offset(direction.x, -1, direction.z);

  // Look at the middle of the expected position
  const targetLookPos = expectedPos.offset(0.5, 0.5, 0.5);
  await bot.lookAt(targetLookPos, false);

  // Walk forward
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 300));
  bot.setControlState('forward', false);

  // Wait a moment to settle
  await new Promise(r => setTimeout(r, 200));

  // Verify we ended up at the right position (on the lowest block)
  const finalPos = bot.entity.position;
  const targetY = expectedPos.y;
  const actualY = finalPos.y;

  // Check if we're within reasonable range of the target Y (bot is 2 blocks tall, feet at Y)
  if (Math.abs(actualY - targetY) > 0.5) {
    return {
      success: false,
      error: `Bot ended up at Y=${actualY.toFixed(2)} but expected Y=${targetY.toFixed(2)}. ` +
        `Position: ${formatBotPosition(finalPos)}, Expected: ${formatBlockPosition(expectedPos)}`
    };
  }

  return { success: true };
}



// ========== Position and Movement Tools ==========

// Helper functions for formatting positions
// Helper functions for pillar-up movement

// TODO: This should also return an error if it fails
export async function pillarUpOneBlock(bot: Bot): Promise<boolean> {
  const botFeetPos = bot.entity.position;
  const blockWeAreStandingOn = bot.blockAt(botFeetPos.offset(0, -1, 0).floor());

  await jumpAndWaitToBeInAir(bot);

  // Place block AT our feet location (where we were standing), using the block below as reference
  if (!isBlockEmpty(blockWeAreStandingOn)) {
    try {
      await bot.placeBlock(blockWeAreStandingOn!, new Vec3(0, 1, 0));
      await waitToLandFromAir(bot);
      return true;
    } catch (placeError) {
      logger.warn(`Failed to place pillar block: ${formatError(placeError)}`);
      await waitToLandFromAir(bot);
      return false;
    }
  }

  await waitToLandFromAir(bot);
  return false;
}

/**
 * Mine steps down by repeatedly calling mineDownOneStep
 * @param bot The minecraft bot
 * @param stepsToGoDown Number of steps to descend
 * @param nextStepPos The first step position (must be adjacent and one down)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Object with stepsCompleted and optional error
 */
export async function mineStepsDown(
  bot: Bot,
  stepsToGoDown: number,
  nextStepPos: Vec3,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<{ stepsCompleted: number; error?: string }> {
  const currentPos = bot.entity.position;
  const currentFloor = currentPos.floor();

  // Calculate the 4 valid next positions (adjacent and one down)
  const validNextPositions = [
    new Vec3(currentFloor.x + 1, currentFloor.y - 1, currentFloor.z),
    new Vec3(currentFloor.x - 1, currentFloor.y - 1, currentFloor.z),
    new Vec3(currentFloor.x, currentFloor.y - 1, currentFloor.z + 1),
    new Vec3(currentFloor.x, currentFloor.y - 1, currentFloor.z - 1)
  ];

  // Check if nextStepPos matches one of the valid positions
  const nextStepFloor = nextStepPos.floor();
  const isValid = validNextPositions.some(pos =>
    pos.x === nextStepFloor.x && pos.y === nextStepFloor.y && pos.z === nextStepFloor.z
  );

  if (!isValid) {
    const posStrings = validNextPositions.map(p => formatBlockPosition(p));
    return {
      stepsCompleted: 0,
      error: `nextStepPos must be adjacent and one down. Current: ${formatBotPosition(currentPos)}, ` +
        `nextStepPos: ${formatBlockPosition(nextStepPos)}. Valid positions: ${posStrings.join(', ')}`
    };
  }

  // Calculate the XZ-aligned direction vector (same for all steps)
  const dx = nextStepFloor.x - currentFloor.x;
  const dz = nextStepFloor.z - currentFloor.z;
  const direction: AxisAlignedDirection = dx !== 0
    ? (dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 })
    : (dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 });

  // Loop for the specified number of steps
  let stepsCompleted = 0;

  for (let i = 0; i < stepsToGoDown; i++) {
    const result = await mineDownOneStep(bot, direction, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        stepsCompleted,
        error: result.error
      };
    }

    stepsCompleted++;
  }

  return { stepsCompleted };
}

/**
 * Mine up one step by clearing blocks above and jumping forward-and-up
 * @param bot The minecraft bot
 * @param direction The XZ-aligned direction to move (e.g., {x: 1, z: 0} for east)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and error details if failed
 */
export async function mineUpOneStep(
  bot: Bot,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<MineUpOneStepResult> {
  const currentPos = bot.entity.position;

  // Get the blocks we need to check and potentially mine
  const blockAboveHead = bot.blockAt(currentPos.offset(0, 2, 0).floor());
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadAndUp = bot.blockAt(currentPos.offset(direction.x, 2, direction.z).floor());

  // Verify blockAheadOfFeet is NOT empty (we need a stair to land on)
  if (!blockAheadOfFeet || isBlockEmpty(blockAheadOfFeet)) {
    return {
      success: false,
      error: `Cannot step up: blockAheadOfFeet is empty (no stair to land on). ` +
        `Position: ${formatBotPosition(currentPos)}, direction: (${direction.x}, 0, ${direction.z})`
    };
  }

  // Mine the three blocks we need clear: blockAboveHead, blockAheadOfHead, blockAheadAndUp
  const blocksToMine = [
    { block: blockAboveHead, name: "above head" },
    { block: blockAheadOfHead, name: "ahead of head" },
    { block: blockAheadAndUp, name: "ahead and up" }
  ];

  for (const { block, name } of blocksToMine) {
    if (block && !isBlockEmpty(block)) {
      const result = await tryMiningOneBlock(bot, block, allowMiningOf, digTimeout, true);
      if (!result.success) {
        return {
          success: false,
          error: `Failed to mine block ${name}: ${result.error}`
        };
      }
    }
  }

  // Perform the jump up the stair
  const startPos = currentPos.clone();

  // Look at the target stair block
  await bot.lookAt(blockAheadOfFeet.position.offset(0.5, 0.5, 0.5), false);

  // Walk forward first to position properly at the edge of current stair
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 200));

  // Now jump while continuing to move forward
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 500));
  bot.setControlState('jump', false);
  // Keep moving forward for a bit after jump ends
  await new Promise(r => setTimeout(r, 150));
  bot.setControlState('forward', false);
  await new Promise(r => setTimeout(r, 100));

  // Verify we ended up approximately one block up and forward
  const finalPos = bot.entity.position;
  const expectedY = startPos.y + 1;
  const actualY = finalPos.y;

  // Check if we're within reasonable range of the expected Y
  if (Math.abs(actualY - expectedY) > 0.5) {
    return {
      success: false,
      error: `Bot ended up at Y=${actualY.toFixed(2)} but expected Y=${expectedY.toFixed(2)}. ` +
        `Start: ${formatBotPosition(startPos)}, Final: ${formatBotPosition(finalPos)}`
    };
  }

  return { success: true };
}

/**
 * Mine steps up by repeatedly calling mineUpOneStep
 * @param bot The minecraft bot
 * @param stepsToGoUp Number of steps to ascend
 * @param nextStepPos The first step position (must be adjacent and one up)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Object with stepsCompleted and optional error
 */
export async function mineStepsUp(
  bot: Bot,
  stepsToGoUp: number,
  nextStepPos: Vec3,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<{ stepsCompleted: number; error?: string }> {
  const currentPos = bot.entity.position;
  const currentFloor = currentPos.floor();

  // Calculate the 4 valid next positions (adjacent and one up)
  const validNextPositions = [
    new Vec3(currentFloor.x + 1, currentFloor.y + 1, currentFloor.z),
    new Vec3(currentFloor.x - 1, currentFloor.y + 1, currentFloor.z),
    new Vec3(currentFloor.x, currentFloor.y + 1, currentFloor.z + 1),
    new Vec3(currentFloor.x, currentFloor.y + 1, currentFloor.z - 1)
  ];

  // Check if nextStepPos matches one of the valid positions
  const nextStepFloor = nextStepPos.floor();
  const isValid = validNextPositions.some(pos =>
    pos.x === nextStepFloor.x && pos.y === nextStepFloor.y && pos.z === nextStepFloor.z
  );

  if (!isValid) {
    const posStrings = validNextPositions.map(p => formatBlockPosition(p));
    return {
      stepsCompleted: 0,
      error: `nextStepPos must be adjacent and one up. Current: ${formatBotPosition(currentPos)}, ` +
        `nextStepPos: ${formatBlockPosition(nextStepPos)}. Valid positions: ${posStrings.join(', ')}`
    };
  }

  // Calculate the XZ-aligned direction vector (same for all steps)
  const dx = nextStepFloor.x - currentFloor.x;
  const dz = nextStepFloor.z - currentFloor.z;
  const direction: AxisAlignedDirection = dx !== 0
    ? (dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 })
    : (dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 });

  // Loop for the specified number of steps
  let stepsCompleted = 0;

  for (let i = 0; i < stepsToGoUp; i++) {
    const result = await mineUpOneStep(bot, direction, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        stepsCompleted,
        error: result.error
      };
    }

    stepsCompleted++;
  }

  return { stepsCompleted };
}



/**
 * Get the bot's position information
 */
export function getBotPosition(bot: Bot): {
  botFeetPosition: { x: string; y: string; z: string };
  botHeadPosition: { x: string; y: string; z: string };
  blockUnderBotFeet: Block | null;
} {
  const position = bot.entity.position;

  const botFeetPosition = {
    x: position.x.toFixed(1),
    y: position.y.toFixed(1),
    z: position.z.toFixed(1),
  };

  const botHeadPosition = {
    x: position.x.toFixed(1),
    y: (position.y + 1).toFixed(1),
    z: position.z.toFixed(1),
  };

  const blockUnderBotFeet = bot.blockAt(position.offset(0, -1, 0).floor());

  return { botFeetPosition, botHeadPosition, blockUnderBotFeet };
}


/**
 * Get blocks adjacent to the bot in all horizontal directions and at all height levels
 * The bot is 2 blocks tall, so we check 4 height levels:
 * - above_head: y+2
 * - head_height: y+1
 * - feet_height: y+0
 * - below_feet: y-1
 */
export function getAdjacentBlocks(bot: Bot): string {
  const currentPos = bot.entity.position;
  const botX = Math.floor(currentPos.x);
  const botY = Math.floor(currentPos.y);
  const botZ = Math.floor(currentPos.z);

  let result = '';

  // Direction: higher x (x+1)
  const higherX = botX + 1;
  result += `direction higher x (x=${higherX}) :\n\n`;

  const higherXAboveHead = [
    bot.blockAt(new Vec3(higherX, botY + 2, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY + 2, botZ)),
    bot.blockAt(new Vec3(higherX, botY + 2, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXHeadHeight = [
    bot.blockAt(new Vec3(higherX, botY + 1, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY + 1, botZ)),
    bot.blockAt(new Vec3(higherX, botY + 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXFeetHeight = [
    bot.blockAt(new Vec3(higherX, botY, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY, botZ)),
    bot.blockAt(new Vec3(higherX, botY, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXBelowFeet = [
    bot.blockAt(new Vec3(higherX, botY - 1, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY - 1, botZ)),
    bot.blockAt(new Vec3(higherX, botY - 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  result += `above_head: ${higherXAboveHead}\n`;
  result += `head_height: ${higherXHeadHeight}\n`;
  result += `feet_height: ${higherXFeetHeight}\n`;
  result += `below_feet: ${higherXBelowFeet}\n\n`;

  // Direction: lower x (x-1)
  const lowerX = botX - 1;
  result += `direction lower x (x=${lowerX}) :\n\n`;

  const lowerXAboveHead = [
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ)),
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXHeadHeight = [
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ)),
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXFeetHeight = [
    bot.blockAt(new Vec3(lowerX, botY, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY, botZ)),
    bot.blockAt(new Vec3(lowerX, botY, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXBelowFeet = [
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ)),
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  result += `above_head: ${lowerXAboveHead}\n`;
  result += `head_height: ${lowerXHeadHeight}\n`;
  result += `feet_height: ${lowerXFeetHeight}\n`;
  result += `below_feet: ${lowerXBelowFeet}\n\n`;

  // Direction: higher z (z+1)
  const higherZ = botZ + 1;
  result += `direction higher z (z=${higherZ}) :\n\n`;

  const higherZAboveHead = bot.blockAt(new Vec3(botX, botY + 2, higherZ))?.name || 'null';
  const higherZHeadHeight = bot.blockAt(new Vec3(botX, botY + 1, higherZ))?.name || 'null';
  const higherZFeetHeight = bot.blockAt(new Vec3(botX, botY, higherZ))?.name || 'null';
  const higherZBelowFeet = bot.blockAt(new Vec3(botX, botY - 1, higherZ))?.name || 'null';

  result += `above_head: ${higherZAboveHead}\n`;
  result += `head_height: ${higherZHeadHeight}\n`;
  result += `feet_height: ${higherZFeetHeight}\n`;
  result += `below_feet: ${higherZBelowFeet}\n\n`;

  // Direction: lower z (z-1)
  const lowerZ = botZ - 1;
  result += `direction lower z (z=${lowerZ}) :\n\n`;

  const lowerZAboveHead = bot.blockAt(new Vec3(botX, botY + 2, lowerZ))?.name || 'null';
  const lowerZHeadHeight = bot.blockAt(new Vec3(botX, botY + 1, lowerZ))?.name || 'null';
  const lowerZFeetHeight = bot.blockAt(new Vec3(botX, botY, lowerZ))?.name || 'null';
  const lowerZBelowFeet = bot.blockAt(new Vec3(botX, botY - 1, lowerZ))?.name || 'null';

  result += `above_head: ${lowerZAboveHead}\n`;
  result += `head_height: ${lowerZHeadHeight}\n`;
  result += `feet_height: ${lowerZFeetHeight}\n`;
  result += `below_feet: ${lowerZBelowFeet}\n\n`;

  // Directly above head
  const aboveHead = bot.blockAt(new Vec3(botX, botY + 2, botZ))?.name || 'null';
  result += `above head: ${aboveHead}\n\n`;

  // At bot head (where the head actually is)
  const atHead = bot.blockAt(new Vec3(botX, botY + 1, botZ))?.name || 'null';
  result += `at head: ${atHead}\n\n`;

  // At bot feet (where the feet actually are)
  const atFeet = bot.blockAt(new Vec3(botX, botY, botZ))?.name || 'null';
  result += `at feet: ${atFeet} (x,y,z=${botX},${botY},${botZ}) \n\n`;

  // Directly below feet
  const belowFeet = bot.blockAt(new Vec3(botX, botY - 1, botZ))?.name || 'null';
  result += `below feet: ${belowFeet}`;

  return result;
}

export function didArriveAtTarget(bot: Bot, target: Vec3): {arrived: boolean, distance: number} {
  const DISTANCE_THRESHOLD = 1.5;
  const VERTICAL_THRESHOLD = 0;
  const currentPos = bot.entity.position;
  const distance = currentPos.distanceTo(target);
  const verticalDist = Math.abs(currentPos.y - target.y);
  const arrived = distance <= DISTANCE_THRESHOLD && verticalDist <= VERTICAL_THRESHOLD;

  return {
    arrived,
    distance
  };
}

export async function moveOneStep(
  bot: Bot,
  target: Vec3,
  allowPillarUpWith: string[],
  allowMiningOf: Record<string, string[]>,
  digTimeout: number,
  allowDigDown: boolean = true
): Promise<{
  blocksMined: number;
  movedBlocksCloser: number;
  pillaredUpBlocks: number;
  error?: string;
}> {
  logger.debug("Running moveOneStep")
  const currentPos = bot.entity.position;
  const initialDistance = getDistance(bot, target);

  // If we're close horizontally (≤1 block in XZ), skip horizontal movement and focus on vertical movement
  const horizontalDist = Math.sqrt(
    Math.pow(currentPos.x - target.x, 2) +
    Math.pow(currentPos.z - target.z, 2)
  );

  if (horizontalDist <= 1.0 && target.y > currentPos.y) {
    // We're close horizontally and need to go up - center in both axes and try pillaring directly
    await strafeToMiddleBothXZ(bot);

    const pillarResult = await tryPillaringUpIfSensible(bot, target, allowPillarUpWith, allowMiningOf, digTimeout);

    if (pillarResult.success) {
      return {
        blocksMined: 0,
        movedBlocksCloser: pillarResult.movedBlocksCloser,
        pillaredUpBlocks: pillarResult.pillaredUpBlocks
      };
    } else {
      // Pillaring failed - return the error so we know what went wrong
      return {
        blocksMined: 0,
        movedBlocksCloser: 0,
        pillaredUpBlocks: 0,
        error: `Close horizontally (${horizontalDist.toFixed(2)}b), tried pillar: ${pillarResult.error}`
      };
    }
  }

  if (horizontalDist <= 1.0 && target.y < currentPos.y && allowDigDown) {
    // We're close horizontally and need to go down - try digging down directly
    const digDownResult = await digDirectlyDownIfPossible(bot, 1, allowMiningOf, digTimeout);
    if (digDownResult.success) {
      return {
        blocksMined: digDownResult.blocksMined,
        movedBlocksCloser: initialDistance - getDistance(bot, target),
        pillaredUpBlocks: 0
      };
    } else {
      return {
        blocksMined: 0,
        movedBlocksCloser: 0,
        pillaredUpBlocks: 0,
        error: `Close horizontally (${horizontalDist.toFixed(2)}b), tried dig down: ${digDownResult.error}`
      };
    }
  }

  // 1. Get the next axis-aligned direction to move toward target
  const direction = getNextXZAlignedDirection(bot, target);

  // 2. Look in movement direction
  const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);
  await bot.lookAt(lookTarget, false);

  // 3. Strafe to center if needed (to avoid shoulder collisions)
  await strafeToMiddle(bot);

  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

  const log: string[] = [];

  // Path forwards empty?
  if (isBlockEmpty(blockAheadOfHead) && isBlockEmpty(blockAheadOfFeet)) {
    if (await walkForwardsIfPossible(bot, currentPos, direction)) {
      log.push("Walked")
      const movedCloser = initialDistance - getDistance(bot, target);
      return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
    }
    log.push("Walk: failed to walk forward even though path appears clear");
  }

  // Path forwards blocked?
  if (!isBlockEmpty(blockAheadOfHead) && !isBlockEmpty(blockAheadOfFeet)) {
    const mineResult = await mineForwardsIfPossible(
      bot, currentPos, direction, allowMiningOf, digTimeout
    );

    if (mineResult.success) {
      log.push("Mined.")
      return {
        blocksMined: mineResult.blocksMined,
        movedBlocksCloser: initialDistance - getDistance(bot, target),
        pillaredUpBlocks: 0,
        error: log.join("; ")
      }
    } else {
      log.push(`Mine error: ${mineResult.error}`);
    }
  }

  // Only the bottom blocked?
  if (isBlockEmpty(blockAheadOfHead) && !isBlockEmpty(blockAheadOfFeet)) {
    const jumpResult = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target);
    if (jumpResult.success) {
      log.push("Jumped over object")
      const movedCloser = initialDistance - getDistance(bot, target);
      return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
    } else {
      log.push(`Jump: ${jumpResult.error}`);
    }
  }

  const pillarResult = await tryPillaringUpIfSensible(bot, target, allowPillarUpWith, allowMiningOf, digTimeout);

  if (!pillarResult.success) {
    log.push(`Pillar: ${pillarResult.error}`);
  } else {
    log.push("Did pillar-up")
    return {
      blocksMined: 0,
      movedBlocksCloser: pillarResult.movedBlocksCloser,
      pillaredUpBlocks: pillarResult.pillaredUpBlocks
    };
  }

  // Try digging down if allowed
  if (allowDigDown) {
    const digDownResult = await digDirectlyDownIfPossible(bot, 1, allowMiningOf, digTimeout);
    if (digDownResult.success) {
      log.push("Dug down")
      return {
        blocksMined: digDownResult.blocksMined,
        movedBlocksCloser: initialDistance - getDistance(bot, target),
        pillaredUpBlocks: 0
      };
    } else {
      log.push(`Dig down: ${digDownResult.error}`);
    }
  }

  return {
    blocksMined: 0,
    movedBlocksCloser: initialDistance - getDistance(bot, target),
    pillaredUpBlocks: 0,
    error: log.join("; ")
  };
}


/**
 * Wraps bot.dig with progress monitoring
 * Checks every few seconds if we're still actively digging
 */
export async function digWithTimeout(
  bot: Bot,
  block: Block,
  timeoutSeconds: number = 3
): Promise<void> {
  const digPromise = bot.dig(block);
  const startTime = Date.now();
  let lastDigCheck = startTime;
  let wasDigging = false;
  let digError: Error | null = null;

  const monitorInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;

    // Check if we're currently digging
    const isDigging = bot.targetDigBlock !== null;

    // If we started digging, remember it
    if (isDigging) {
      wasDigging = true;
      lastDigCheck = now;
    }

    // If we haven't dug at all after 3 seconds, something is wrong
    if (!wasDigging && elapsed > 3) {
      clearInterval(monitorInterval);
      digError = new Error(`Dig failed to start after 3s. Bot may be stuck or block unreachable.`);
      return;
    }

    // If we're digging for more than timeoutSeconds, stop with error
    if (wasDigging && isDigging && elapsed > timeoutSeconds) {
      clearInterval(monitorInterval);
      const heldItem = bot.heldItem;
      const toolName = heldItem ? heldItem.name : "no tool";
      digError = new Error(
        `Digging is very slow (${elapsed.toFixed(1)}s). Block: ${block.name}. ` +
        `Using: ${toolName}. Wrong tool? Or maybe your character isn't reaching the block?`
      );
      return;
    }

    // If we were digging but stopped for more than 2 seconds, might be done or stuck
    if (wasDigging && !isDigging && (now - lastDigCheck) > 2000) {
      // Dig likely completed, let the promise resolve
      clearInterval(monitorInterval);
      return;
    }

    // Overall timeout
    if (elapsed > timeoutSeconds) {
      clearInterval(monitorInterval);
      const heldItem = bot.heldItem;
      const toolName = heldItem ? heldItem.name : "no tool";
      digError = new Error(
        `Dig timeout after ${timeoutSeconds}s. Block: ${block.name}. Using: ${toolName}. ` +
        `May need better tools or block is too hard.`
      );
    }
  }, 500);

  try {
    await digPromise;
    clearInterval(monitorInterval);
    if (digError) throw digError;
  } catch (error) {
    clearInterval(monitorInterval);
    if (digError) throw digError;
    throw error;
  }
}

