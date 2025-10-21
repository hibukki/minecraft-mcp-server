import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/**
 * Format position as (x, y, z)
 */
export function formatPosition(pos: Vec3): string {
  return `(${pos.x}, ${pos.y}, ${pos.z})`;
}

/**
 * Get summary of inventory contents
 */
export function getInventorySummary(bot: Bot): string {
  return bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
}

/**
 * Get entity name, falling back to type or unknown_entity
 */
export function getEntityName(entity: Entity): string {
  return entity.name || (entity as any).username || entity.type || 'unknown_entity';
}

/**
 * Check if block is empty (air, cave_air, void_air)
 */
export function isBlockEmpty(block: Block): boolean {
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}
