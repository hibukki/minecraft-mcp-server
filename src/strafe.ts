import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { appendFileSync } from "fs";
import {
  getBotAxisAlignedDirection,
  type MineForwardResult,
  formatBotPosition,
  formatBlockPosition
} from "./movement.js";
import { type AxisAlignedDirection, getBlocksAhead, isBlockEmpty } from "./botLocation.js";
import { tryMiningOneBlock } from "./tryMiningOneBlock.js";
import logger from "./logger.js";

/**
 * Calculate strafe direction and amount needed to center the bot
 * Uses bot's yaw to determine which axis to align on, and bot's position for the amount
 * Returns null if already centered enough
 */

export function getStrafeDirectionAndAmount(
  bot: Bot
): { direction: 'left' | 'right'; amount: number; } | null {
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
  if (facingDirection.x > 0) { // Facing east (+X), perpCoord is Z
    // Increase Z (+Z) = strafe right, Decrease Z (-Z) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else if (facingDirection.x < 0) { // Facing west (-X), perpCoord is Z
    // Increase Z (+Z) = strafe left, Decrease Z (-Z) = strafe right
    strafeDirection = offsetFromCenter > 0 ? 'right' : 'left';
  } else if (facingDirection.z > 0) { // Facing south (+Z), perpCoord is X
    // Increase X (+X) = strafe right, Decrease X (-X) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else { // Facing north (-Z), perpCoord is X
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