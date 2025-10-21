import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { formatPosition } from "./formatting.js";

/**
 * Check if block is empty (air, cave_air, void_air)
 */
export function isBlockEmpty(block: Block): boolean {
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

/**
 * Get block at position or throw error
 */
export function expectBlock(bot: Bot, pos: Vec3): Block {
  const block = bot.blockAt(pos);
  if (!block) {
    throw new Error(`No block found at ${formatPosition(pos)}`);
  }
  return block;
}

/**
 * Get block at position and verify it matches expected type
 */
export function expectBlockOfType(bot: Bot, pos: Vec3, expectedType: string | ((name: string) => boolean)): Block {
  const block = expectBlock(bot, pos);
  const matches = typeof expectedType === 'string'
    ? block.name.includes(expectedType)
    : expectedType(block.name);

  if (!matches) {
    const expected = typeof expectedType === 'string' ? expectedType : 'expected type';
    throw new Error(`Block at ${formatPosition(pos)} is ${block.name}, not ${expected}`);
  }
  return block;
}
