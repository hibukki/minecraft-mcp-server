import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import { appendFileSync } from "fs";

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

// ========== Walking Functions ==========

export async function walkForwardsIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection
): Promise<boolean> {
  console.log("Running walkForwardsIfPossible")
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

  const feetClear = isBlockEmpty(blockAheadOfFeet);
  const headClear = isBlockEmpty(blockAheadOfHead);

  if (feetClear && headClear) {
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 200));
    bot.setControlState('forward', false);
    return true;
  }

  return false;
}

/**
 * Walk forward for at least 500ms to ensure the bot moves at least one block
 */
export async function walkForwardsAtLeastOneBlock(
  bot: Bot,
  direction: AxisAlignedDirection
): Promise<void> {
  // Look in the direction we're walking
  const currentPos = bot.entity.position;
  const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);
  await bot.lookAt(lookTarget, false);

  // Walk forward for 500ms
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 500));
  bot.setControlState('forward', false);
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

    console.log(strafeDataMsg);

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
  await strafeToMiddle(bot);

  // Center in Z direction (face east or west)
  await bot.look(Math.PI / 2, 0, false); // Face west (90 degrees)
  await strafeToMiddle(bot);

  // Restore original yaw
  await bot.look(originalYaw, 0, false);
}
