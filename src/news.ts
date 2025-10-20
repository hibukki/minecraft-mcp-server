import type { Bot } from "mineflayer";
import { getBotState, getEquippedItemDurability } from "./bot.js";
import { logBotState } from "./logger.js";
import { messageStore } from "./chatMessages.js";


export function getOptionalNewsFyi(bot: Bot): string {
  const state = getBotState(bot);
  const news: Record<string, any> = {};

  // Track bot location (feet position)
  const botPos = bot.entity.position;
  const currentFeetPos = { x: Math.floor(botPos.x), y: Math.floor(botPos.y), z: Math.floor(botPos.z) };

  if (state.lastFeetPos !== undefined &&
      (currentFeetPos.x !== state.lastFeetPos.x ||
       currentFeetPos.y !== state.lastFeetPos.y ||
       currentFeetPos.z !== state.lastFeetPos.z)) {
    news.botFeet = currentFeetPos;
  }
  state.lastFeetPos = currentFeetPos;

  const currentOxygen = bot.oxygenLevel;
  if (state.lastOxygen !== undefined && currentOxygen < state.lastOxygen) {
    news.oxygen = { current: currentOxygen, max: 20 };
  }
  state.lastOxygen = currentOxygen;

  const currentHealth = bot.health;
  if (state.lastHealth !== undefined && currentHealth < state.lastHealth) {
    news.health = { current: parseFloat(currentHealth.toFixed(1)), max: 20 };
  }
  state.lastHealth = currentHealth;

  const durability = getEquippedItemDurability(bot);
  if (durability) {
    if (state.lastDurability !== undefined && durability.remaining < state.lastDurability) {
      news.equippedItemDurability = { remaining: durability.remaining, max: durability.max };
    }
    state.lastDurability = durability.remaining;
  } else {
    state.lastDurability = undefined;
  }

  // Track inventory changes
  const currentInventory = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    const itemName = item.name;
    const currentCount = currentInventory.get(itemName) || 0;
    currentInventory.set(itemName, currentCount + item.count);
  }

  if (state.lastInventory) {
    const inventoryChanges: Array<{ item: string; gained: number }> = [];

    // Check for added or increased items
    for (const [itemName, currentCount] of currentInventory) {
      const previousCount = state.lastInventory.get(itemName) || 0;
      const diff = currentCount - previousCount;
      if (diff > 0) {
        inventoryChanges.push({ item: itemName, gained: diff });
      }
    }

    if (inventoryChanges.length > 0) {
      news.inventory = inventoryChanges;
    }
  }
  state.lastInventory = currentInventory;

  // Track nearby entities (within 16 blocks)
  const maxEntityDistance = 16;
  const currentEntities: Array<{ type: string; location: { x: number; y: number; z: number; }; }> = [];

  for (const entityId in bot.entities) {
    const entity = bot.entities[entityId];
    if (entity === bot.entity) continue; // Skip self

    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance <= maxEntityDistance) {
      const entityType = entity.name || (entity as any).username || entity.type || 'unknown';
      currentEntities.push({
        type: entityType,
        location: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      });
    }
  }

  // Check if entities changed
  if (state.lastEntities) {
    const entitiesChanged = currentEntities.length !== state.lastEntities.length ||
      !currentEntities.every((current, i) => {
        const last = state.lastEntities![i];
        return last &&
          current.type === last.type &&
          current.location.x === last.location.x &&
          current.location.y === last.location.y &&
          current.location.z === last.location.z;
      });

    if (entitiesChanged) {
      news.nearbyEntities = currentEntities;
    }
  }
  state.lastEntities = currentEntities;

  // Track new chat messages
  const recentMessages = messageStore.getRecentMessages(10);
  const lastCheckedTimestamp = state.lastChatTimestamp || 0;

  const newMessages = recentMessages.filter(msg => msg.timestamp > lastCheckedTimestamp);

  if (newMessages.length > 0) {
    news.chat = newMessages.map(msg => ({ username: msg.username, message: msg.content }));
    state.lastChatTimestamp = Math.max(...newMessages.map(msg => msg.timestamp));
  }

  if (updates.length === 0) {
    return '';
  }

  const updateStr = updates.join(', ');
  logBotState(updateStr);
  return ` (updates: ${updateStr})`;
}
