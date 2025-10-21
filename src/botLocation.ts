import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";

export type AxisAlignedDirection =
  | { x: 1; y: 0; z: 0 }
  | { x: -1; y: 0; z: 0 }
  | { x: 0; y: 0; z: 1 }
  | { x: 0; y: 0; z: -1 };

export function isBlockEmpty(block: Block | null): boolean {
  if (!block) return true;
  // Check for air variants, water, lava
  if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air' ||
      block.name === 'water' || block.name === 'lava') return true;
  // Check for passable blocks (flowers, tall grass, etc.) which have no collision
  if (block.boundingBox === 'empty') return true;
  return false;
}

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

export function getBotLocation(bot: Bot): { botFeetBlock: Block | null; botHeadBlock: Block | null } {
  const botPos = bot.entity.position;
  const botFeetBlock = bot.blockAt(botPos.floor());
  const botHeadBlock = bot.blockAt(botPos.offset(0, 1, 0).floor());

  return { botFeetBlock, botHeadBlock };
}
