import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import minecraftData from "minecraft-data";

export function getInventorySummary(bot: Bot): string {
  return bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
}

export function describeWhyUncraftable(bot: Bot, itemId: number, craftingTable: Block | null): string {
  const recipes = bot.recipesAll(itemId, null, craftingTable);
  if (recipes.length === 0) {
    return craftingTable
      ? `no recipe exists for this item`
      : `no recipe craftable without a crafting table. Try useCraftingTable: true`;
  }

  const inventoryCountById = new Map<number, number>();
  for (const invItem of bot.inventory.items()) {
    inventoryCountById.set(invItem.type, (inventoryCountById.get(invItem.type) || 0) + invItem.count);
  }

  // Recipes come in variants (e.g. one per plank type); report the closest one
  const mcData = minecraftData(bot.version);
  let fewestMissing: string[] | null = null;
  for (const recipe of recipes) {
    const neededById = new Map<number, number>();
    for (const delta of recipe.delta) {
      if (delta.count < 0) {
        neededById.set(delta.id, (neededById.get(delta.id) || 0) - delta.count);
      }
    }

    const missing: string[] = [];
    for (const [id, needed] of neededById) {
      const have = inventoryCountById.get(id) || 0;
      if (have < needed) {
        missing.push(`${mcData.items[id]?.name || `item#${id}`} (need ${needed}, have ${have})`);
      }
    }
    if (fewestMissing === null || missing.length < fewestMissing.length) {
      fewestMissing = missing;
    }
  }

  if (fewestMissing !== null && fewestMissing.length === 0) {
    return `materials look sufficient but mineflayer reports no craftable recipe - possible inventory desync, try again. Inventory: ${getInventorySummary(bot)}`;
  }

  return `missing materials: ${fewestMissing!.join(', ')}. Inventory: ${getInventorySummary(bot)}`;
}
