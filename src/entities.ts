import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

/**
 * Get entity name, falling back to type or unknown_entity
 */
export function getEntityName(entity: Entity): string {
  return entity.name || (entity as any).username || entity.type || 'unknown_entity';
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
