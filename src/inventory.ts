import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";

/**
 * Get summary of inventory contents
 */
export function getInventorySummary(bot: Bot): string {
  return bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
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
 * Validate item has sufficient count
 */
export function expectSufficientItems(item: Item, needed: number): void {
  if (item.count < needed) {
    throw new Error(`Cannot use ${needed}x ${item.name}: only have ${item.count}`);
  }
}
