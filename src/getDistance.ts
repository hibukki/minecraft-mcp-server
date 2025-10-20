import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

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