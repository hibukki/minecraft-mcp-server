import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
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

/**
 * Find item in inventory or throw error
 */
export function expectItemInInventory(bot: Bot, itemName: string): Item {
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) {
    const inventory = getInventorySummary(bot);
    throw new Error(`Cannot find ${itemName}: not found in inventory. Inventory: ${inventory}`);
  }
  return item;
}

/**
 * Find and equip item or throw error
 */
export async function equipItem(bot: Bot, itemName: string, destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' = 'hand'): Promise<Item> {
  const item = expectItemInInventory(bot, itemName);
  await bot.equip(item, destination);
  return item;
}

/**
 * Find entity matching criteria or throw error
 */
export function expectEntity(bot: Bot, entityType: string | undefined, maxDistance: number, filter?: (entity: Entity) => boolean): Entity {
  const entityFilter = filter || ((e: Entity) => !entityType || e.name === entityType);
  const entity = bot.nearestEntity(e => entityFilter(e) && bot.entity.position.distanceTo(e.position) <= maxDistance);

  if (!entity) {
    throw new Error(`No ${entityType || 'entity'} found within ${maxDistance} blocks`);
  }
  return entity;
}

/**
 * Validate item has sufficient count
 */
export function expectSufficientItems(item: Item, needed: number): void {
  if (item.count < needed) {
    throw new Error(`Cannot use ${needed}x ${item.name}: only have ${item.count}`);
  }
}
