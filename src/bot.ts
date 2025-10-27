#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import yargs from "yargs";
import type { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";

import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import {
  formatBotPosition,
  formatBlockPosition,
  getNextXZAlignedDirection,
  jumpOverSmallObstacleIfPossible,
  walkForwardsIfPossible,
  walkForwardsAtLeastOneBlockXZAligned,
  digDirectlyDownIfPossible,
  getAdjacentBlocks,
  mineStepsUp,
  pillarUpOneBlock,
  mineStepsDown,
  getBotPosition,
} from "./movement.js";
import {
  strafeToMiddleBothXZ,
  mineForwardsIfPossible
} from "./strafe.js";
import { getBlocksAhead, isBlockEmpty } from "./botLocation.js";
import { tryMiningOneBlock } from "./tryMiningOneBlock.js";
import { formatError, log } from "./bot_log.js";
import logger, { logToolCall, logGameEvent } from "./logger.js";
import { getOptionalNewsFyi } from "./news.js";
import { getDistanceToBlock } from "./getDistance.js";
import { messageStore, MAX_STORED_MESSAGES } from "./chatMessages.js";

// ========== Type Definitions ==========

type TextContent = {
  type: "text";
  text: string;
};

type ContentItem = TextContent;

type McpResponse = {
  content: ContentItem[];
  _meta?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
};

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
  durability?: {
    remaining: number;
    max: number;
  };
}

// ========== Movement Result Types (Type-Safe) ==========

/** Result type that requires error message when success is false */



// ========== Command Line Argument Parsing ==========

export function parseCommandLineArgs() {
  return yargs(hideBin(process.argv))
    .option("host", {
      type: "string",
      description: "Minecraft server host",
      default: "localhost",
    })
    .option("port", {
      type: "number",
      description: "Minecraft server port",
      default: 25565,
    })
    .option("username", {
      type: "string",
      description: "Bot username",
      default: "LLMBot",
    })
    .help()
    .alias("help", "h")
    .parseSync();
}


export function createResponse(text: string): McpResponse {
  return {
    content: [{ type: "text", text }],
  };
}

export function createErrorResponse(error: Error | string): McpResponse {
  const errorMessage = formatError(error);
  log("error", errorMessage);
  return {
    content: [{ type: "text", text: `Failed: ${errorMessage}` }],
    isError: true,
  };
}

// Type helper to infer params from schema object
type InferSchemaParams<T extends Record<string, z.ZodTypeAny>> = {
  [K in keyof T]: z.infer<T[K]>
};

// Wrapper function to add tools with automatic error handling, logging, and news updates
function addServerTool<TSchema extends Record<string, z.ZodTypeAny>>(
  server: McpServer,
  bot: Bot,
  name: string,
  description: string,
  schema: TSchema,
  handler: (params: InferSchemaParams<TSchema>) => Promise<string>
) {
  // TypeScript can't match our generic TSchema to server.tool's overloads
  // But params are still fully type-safe for the handler
  (server.tool as any)(
    name,
    description,
    schema,
    async (params: InferSchemaParams<TSchema>): Promise<CallToolResult> => {
      logToolCall(name, params);
      try {
        const result = await handler(params);
        const response = createResponse(result + getOptionalNewsFyi(bot));
        logToolCall(name, params, response);
        return response;
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Helper Functions for Tools ==========

/**
 * Get block at position or throw error
 */
function expectBlock(bot: Bot, pos: Vec3): Block {
  const block = bot.blockAt(pos);
  if (!block) {
    throw new Error(`No block found at ${formatPosition(pos)}`);
  }
  return block;
}

/**
 * Get block at position and verify it matches expected type
 */
function expectBlockOfType(bot: Bot, pos: Vec3, expectedType: string | ((name: string) => boolean)): Block {
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
function expectItemInInventory(bot: Bot, itemName: string): Item {
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
async function equipItem(bot: Bot, itemName: string, destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' = 'hand'): Promise<Item> {
  const item = expectItemInInventory(bot, itemName);
  await bot.equip(item, destination);
  return item;
}

/**
 * Find entity matching criteria or throw error
 */
function expectEntity(bot: Bot, entityType: string | undefined, maxDistance: number, filter?: (entity: Entity) => boolean): Entity {
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
function expectSufficientItems(item: Item, needed: number): void {
  if (item.count < needed) {
    throw new Error(`Cannot use ${needed}x ${item.name}: only have ${item.count}`);
  }
}

/**
 * Format position as (x, y, z)
 */
function formatPosition(pos: Vec3): string {
  return `(${pos.x}, ${pos.y}, ${pos.z})`;
}

/**
 * Get summary of inventory contents
 */
function getInventorySummary(bot: Bot): string {
  return bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
}

/**
 * Get entity name, falling back to type or unknown_entity
 */
function getEntityName(entity: Entity): string {
  return entity.name || (entity as any).username || entity.type || 'unknown_entity';
}

// Wrapper to log tool calls
export function withToolLogging<T extends Record<string, unknown>>(
  toolName: string,
  handler: (params: T) => Promise<McpResponse>
): (params: T) => Promise<McpResponse> {
  return async (params: T): Promise<McpResponse> => {
    logToolCall(toolName, params);
    const result = await handler(params);
    if (!result.isError) {
      logToolCall(toolName, params, result);
    }
    return result;
  };
}



export function setupBot(argv: Arguments): Bot {
  // Configure bot options based on command line arguments
  const botOptions = {
    host: argv.host as string,
    port: argv.port as number,
    username: argv.username as string,
  };

  // Create a bot instance
  const bot = mineflayer.createBot(botOptions);

  // Set up the bot when it spawns
  bot.once("spawn", async () => {
    bot.chat("LLM-powered bot ready to receive instructions!");
    log(
      "info",
      `Server started and connected successfully. Bot: ${argv.username} on ${argv.host}:${argv.port}`
    );
    logGameEvent("spawn", { username: argv.username, host: argv.host, port: argv.port });
  });

  // Register common event handlers
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    messageStore.addMessage(username, message);
    logGameEvent("chat", { username, message });
  });

  bot.on("kicked", (reason) => {
    log("error", `Bot was kicked: ${formatError(reason)}`);
    logGameEvent("kicked", { reason: formatError(reason) });
    bot.quit();
  });

  bot.on("error", (err) => {
    log("error", `Bot error: ${formatError(err)}`);
  });

  bot.on("death", () => {
    const pos = bot.entity.position;
    logGameEvent("death", { position: { x: pos.x, y: pos.y, z: pos.z } });
  });

  bot.on("respawn", () => {
    const pos = bot.entity.position;
    logGameEvent("respawn", { position: { x: pos.x, y: pos.y, z: pos.z } });
  });

  return bot;
}

// ========== MCP Server Configuration ==========

export function createMcpServer(bot: Bot) {
  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "1.2.0",
  });

  // Register all tool categories
  registerCraftingTools(server, bot);
  registerSmeltingTools(server, bot);
  registerPositionTools(server, bot);
  registerInventoryTools(server, bot);
  registerItemActionTools(server, bot);
  registerContainerTools(server, bot);
  registerBlockTools(server, bot);
  registerEntityTools(server, bot);
  registerChatTools(server, bot);
  registerSurvivalTools(server, bot);
  // registerFlightTools(server, bot);
  registerGameStateTools(server, bot);

  return server;
}

// ========== Crafting Tools ==========

export function registerCraftingTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "craft-item",
    "Craft an item using available materials",
    {
      itemName: z
        .string()
        .describe(
          "Name of the item to craft (e.g., 'oak_planks', 'crafting_table', 'wooden_pickaxe')"
        ),
      count: z
        .number()
        .optional()
        .describe("Number of items to craft (default: 1)"),
      useCraftingTable: z
        .union([z.boolean(), z.string().transform(val => val === 'true')])
        .describe("Whether to use a crafting table for this recipe (required for most tools and complex items)"),
    },
    async ({ itemName, count = 1, useCraftingTable }) => {
      const mcData = minecraftData(bot.version);
      const itemsByName = mcData.itemsByName;

      const item = itemsByName[itemName];
      if (!item) {
        return `Unknown item: ${itemName}. Make sure to use the exact item name (e.g., 'oak_planks', 'crafting_table')`;
      }

      let craftingTable = null;

      // If crafting table is required, find it first
      if (useCraftingTable) {
        craftingTable = bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 32,
        });

        if (!craftingTable) {
          return `Cannot craft ${itemName}: crafting table required but none found within 32 blocks. Place a crafting table nearby.`;
        }

        log("info", `Found crafting table at ${craftingTable.position}`);

        const distanceToCraftingTable = getDistanceToBlock(bot, craftingTable);

        if (distanceToCraftingTable > 3) {
          return `Crafting table too far (distance: ${distanceToCraftingTable.toFixed(1)}, location: ${craftingTable?.position}). Move closer (within ~3 blocks).`;
        }
      }

      // Try to get craftable recipes directly with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Crafting didn't start after 1 second. CraftingTable location: ${craftingTable?.position}`)), 1000);
      });

      const recipesPromise = Promise.resolve(bot.recipesFor(item.id, null, 1, craftingTable));

      const craftableRecipes = await Promise.race([recipesPromise, timeoutPromise]);
      log("info", `bot.recipesFor returned ${craftableRecipes.length} craftable recipes for ${itemName} (with table: ${!!craftingTable})`);

      if (craftableRecipes.length === 0) {
        const inventory = bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
        return `Cannot craft ${itemName}: missing required materials. Inventory: ${inventory}`;
      }

      const recipe = craftableRecipes[0];
      await bot.craft(recipe, count, craftingTable || undefined);
      return `Successfully crafted ${count}x ${itemName}`;
    }
  );
}

// ========== Smelting Tools ==========

export function registerSmeltingTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "smelt-item",
    "Smelt an item using a furnace",
    {
      itemName: z
        .string()
        .describe(
          "Name of the item to smelt (e.g., 'raw_iron', 'raw_gold', 'sand')"
        ),
      fuelName: z
        .string()
        .optional()
        .describe("Name of fuel to use (e.g., 'coal', 'planks'). If not provided, will use available fuel."),
      count: z
        .number()
        .optional()
        .describe("Number of items to smelt (default: 1)"),
    },
    async ({ itemName, fuelName, count = 1 }) => {
      const mcData = minecraftData(bot.version);
      const itemsByName = mcData.itemsByName;

      // Validate input item exists
      const inputItem = itemsByName[itemName];
      if (!inputItem) {
        return `Unknown item: ${itemName}. Make sure to use the exact item name (e.g., 'raw_iron', 'sand')`;
      }

      // Check if bot has the input item
      const botInputItem = bot.inventory.items().find(i => i.name === itemName);
      if (!botInputItem || botInputItem.count < count) {
        return `Not enough ${itemName} in inventory. Have: ${botInputItem?.count || 0}, Need: ${count}`;
      }

      // Find a furnace
      const furnace = bot.findBlock({
        matching: mcData.blocksByName.furnace?.id,
        maxDistance: 32,
      });

      if (!furnace) {
        return `No furnace found within 32 blocks. Place a furnace nearby.`;
      }

      log("info", `Found furnace at ${furnace.position}`);

      // Move to furnace if needed
      if (!bot.canSeeBlock(furnace)) {
        return `Furnace found at (${furnace.position.x}, ${furnace.position.y}, ${furnace.position.z}) but it's not visible. Move closer manually using move-in-direction tool.`;
      }

      // Open the furnace
      const furnaceBlock = await bot.openFurnace(furnace);

      // Find fuel
      let fuel = null;
      if (fuelName) {
        fuel = bot.inventory.items().find(i => i.name === fuelName);
        if (!fuel) {
          furnaceBlock.close();
          return `Specified fuel '${fuelName}' not found in inventory`;
        }
      } else {
        // Try common fuels: coal, charcoal, planks, sticks
        const fuelTypes = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'stick'];
        for (const fuelType of fuelTypes) {
          fuel = bot.inventory.items().find(i => i.name === fuelType);
          if (fuel) break;
        }
      }

      if (!fuel) {
        furnaceBlock.close();
        return `No fuel found in inventory. Need coal, charcoal, planks, or sticks.`;
      }

      // Calculate how much fuel we need (rough estimate: planks smelt ~1.5 items each, coal ~8 items)
      let fuelNeeded = 1;
      if (count > 1) {
        if (fuel.name.includes('plank')) {
          fuelNeeded = Math.ceil(count / 1.5);
        } else if (fuel.name === 'coal' || fuel.name === 'charcoal') {
          fuelNeeded = Math.ceil(count / 8);
        } else if (fuel.name === 'stick') {
          fuelNeeded = count; // sticks only smelt 0.5 items each
        } else {
          fuelNeeded = count; // conservative default
        }
      }

      log("info", `Using ${fuelNeeded}x ${fuel.name} as fuel for ${count} items`);

      // Put items in furnace
      await furnaceBlock.putInput(botInputItem.type, null, count);
      await furnaceBlock.putFuel(fuel.type, null, fuelNeeded);

      // Wait for smelting to complete
      // Each item takes about 10 seconds to smelt
      const smeltTime = count * 10 * 1000;
      log("info", `Waiting ${smeltTime / 1000}s for smelting to complete...`);
      await new Promise(resolve => setTimeout(resolve, smeltTime));

      // Take output if available
      const output = furnaceBlock.outputItem();
      if (output) {
        await furnaceBlock.takeOutput();
        furnaceBlock.close();
        return `Successfully smelted ${count}x ${itemName} using ${fuel.name} as fuel`;
      } else {
        // Check full furnace state to give detailed error
        const inputStillThere = furnaceBlock.inputItem();
        const fuelStillThere = furnaceBlock.fuelItem();
        const progress = (furnaceBlock as any).progress;
        const progressSeconds = (furnaceBlock as any).progressSeconds;
        const fuelRemaining = (furnaceBlock as any).fuel;
        const fuelSeconds = (furnaceBlock as any).fuelSeconds;
        furnaceBlock.close();

        let errorMsg = `Smelting failed: No output found after waiting ${smeltTime / 1000}s.\n`;
        errorMsg += `Furnace state:\n`;
        errorMsg += `  Input: ${inputStillThere ? `${inputStillThere.count}x ${inputStillThere.name}` : 'empty'}\n`;
        errorMsg += `  Fuel: ${fuelStillThere ? `${fuelStillThere.count}x ${fuelStillThere.name}` : 'empty'}\n`;
        errorMsg += `  Output: empty\n`;
        errorMsg += `  Progress: ${progress !== null ? (progress * 100).toFixed(1) : 'unknown'}%`;
        if (progressSeconds !== null) {
          errorMsg += ` (${progressSeconds.toFixed(1)}s remaining)`;
        }
        errorMsg += `\n`;
        errorMsg += `  Fuel: ${fuelRemaining !== null ? (fuelRemaining * 100).toFixed(1) : 'unknown'}%`;
        if (fuelSeconds !== null) {
          errorMsg += ` (${fuelSeconds.toFixed(1)}s remaining)`;
        }
        errorMsg += `\n`;
        errorMsg += `Likely causes: (1) Fuel ran out mid-smelt, (2) Need to wait longer, (3) Items already taken.`;

        return errorMsg;
      }
    }
  );
}


export function registerPositionTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const { botFeetPosition, botHeadPosition, blockUnderBotFeet } = getBotPosition(bot);
      return `Bot feet position: (${botFeetPosition.x}, ${botFeetPosition.y}, ${botFeetPosition.z})\n` +
        `Bot head position: (${botHeadPosition.x}, ${botHeadPosition.y}, ${botHeadPosition.z})\n` +
        `Block under bot feet: ${blockUnderBotFeet?.name || 'null'}`;
    }
  );

  addServerTool(
    server,
    bot,
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      await bot.lookAt(new Vec3(x, y, z), true);
      return `Looking at position (${x}, ${y}, ${z})`;
    }
  );

  addServerTool(
    server,
    bot,
    "jump-in-place",
    "Make the bot jump",
    {},
    async () => {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 250);
      return "Jumped in place";
    }
  );

  addServerTool(
    server,
    bot,
    "toggle-swim-up-jump-up",
    "Toggle the bot's jump state on or off. When underwater, holding jump makes the bot swim upward. Use this to control swimming or jumping state.",
    {
      enabled: z.boolean().describe("true to start jumping/swimming up, false to stop"),
    },
    async ({ enabled }) => {
      bot.setControlState("jump", enabled);
      if (enabled) {
        return "Jump/swim-up enabled (bot will continuously jump or swim upward)";
      } else {
        return "Jump/swim-up disabled";
      }
    }
  );

  addServerTool(
    server,
    bot,
    "move-horizontally",
    "Move the bot toward a target block that is more or less the same height (Y) as the bot. Doesn't dig down (for a low Y target), doesn't build up (for a high Y target), so bad for those",
    {
      targetX: z.number().describe("Target X coordinate"),
      targetY: z.number().describe("Target Y coordinate"),
      targetZ: z.number().describe("Target Z coordinate"),
    },
    async ({ targetX, targetY, targetZ }) => {
      const target = new Vec3(targetX, targetY, targetZ);
      const startPos = bot.entity.position.clone();
      const initialDistance = startPos.distanceTo(target);

      // Try to move toward target with obstacle handling
      const MAX_ATTEMPTS = 20;
      let attempts = 0;
      let closestDistance = initialDistance;

      while (attempts < MAX_ATTEMPTS) {
        // Look toward the target
        const currentPos = bot.entity.position;
        const direction = getNextXZAlignedDirection(bot, target);
        const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);
        await bot.lookAt(lookTarget, false);

        const currentDistance = currentPos.distanceTo(target);

        // Check if we overshot (moved 1+ blocks further from closest we've been)
        if (currentDistance > closestDistance + 1.0) {
          const distanceTraveled = initialDistance - currentDistance;
          bot.setControlState('forward', false);
          return `Stopped: overshot target. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
            `Distance to target: ${currentDistance.toFixed(1)} blocks. Closest was: ${closestDistance.toFixed(1)} blocks.`;
        }
        closestDistance = Math.min(closestDistance, currentDistance);
        const horizontalDistance = Math.sqrt(
          Math.pow(currentPos.x - target.x, 2) + Math.pow(currentPos.z - target.z, 2)
        );

        // Check if we've reached the target (within 1.5 blocks horizontally)
        if (horizontalDistance <= 1.5) {
          bot.setControlState('forward', false);
          const distanceTraveled = initialDistance - currentDistance;
          return `Done traveling horizontally. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
            `Final distance to target: ${currentDistance.toFixed(1)} blocks. Final horizontal distance (ignoring Y): ${horizontalDistance}. To go up/down (Y), use another tool.`;
        }

        const walked = await walkForwardsIfPossible(bot, currentPos, direction, false);

        const jumpResult = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target, false);

        if (jumpResult.success || walked) {
          attempts++;
          await new Promise(r => setTimeout(r, 50));
          continue;
        }

        // Failed to make progress
        const endPos = bot.entity.position;
        const distanceTraveled = startPos.distanceTo(endPos);
        const distanceRemaining = endPos.distanceTo(target);
        const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

        const headInfo = blockAheadOfHead
          ? `${blockAheadOfHead.name} at ${formatBlockPosition(blockAheadOfHead.position)}`
          : 'air or null';
        const feetInfo = blockAheadOfFeet
          ? `${blockAheadOfFeet.name} at ${formatBlockPosition(blockAheadOfFeet.position)}`
          : 'air or null';

        bot.setControlState('forward', false);
        return `Stuck after ${attempts} steps. ` +
          `Traveled: ${distanceTraveled.toFixed(1)} blocks. ` +
          `Remaining: ${distanceRemaining.toFixed(1)} blocks. ` +
          `Block ahead of bot's head: ${headInfo}, ahead of bot's feet: ${feetInfo}. ` +
          `Tried jumping and got: ${jumpResult.error}`;
      }

      bot.setControlState('forward', false);

      // Reached MAX_ATTEMPTS
      const endPos = bot.entity.position;
      const distanceTraveled = startPos.distanceTo(endPos);
      const distanceRemaining = endPos.distanceTo(target);

      return `Made progress (${distanceTraveled.toFixed(1)} blocks), call again to continue.` +
        `Remaining: ${distanceRemaining.toFixed(1)} blocks`;
    }
  );

  addServerTool(
    server,
    bot,
    "swim-horizontally",
    "Swim horizontally toward a target position. Enables jump/swim-up and moves forward in a loop, stopping forward movement when target is reached or overshot. Keeps jump enabled at the end in case still in water.",
    {
      targetX: z.number().describe("Target X coordinate"),
      targetY: z.number().describe("Target Y coordinate"),
      targetZ: z.number().describe("Target Z coordinate"),
    },
    async ({ targetX, targetY, targetZ }) => {
      const target = new Vec3(targetX, targetY, targetZ);
      const startPos = bot.entity.position.clone();
      const initialDistance = startPos.distanceTo(target);

      // Enable jump/swim-up at the start
      bot.setControlState("jump", true);

      // Enable forward movement
      bot.setControlState("forward", true);

      const MAX_ATTEMPTS = 50;
      let attempts = 0;
      let closestDistance = initialDistance;

      try {
        while (attempts < MAX_ATTEMPTS) {
          // Look toward the target
          const currentPos = bot.entity.position;
          await bot.lookAt(target, false);

          const currentDistance = currentPos.distanceTo(target);

          // Check if we overshot (moved 0.5+ blocks further from closest we've been)
          if (currentDistance > closestDistance + 0.5) {
            const distanceTraveled = initialDistance - currentDistance;
            bot.setControlState('forward', false);
            return `Stopped forward movement: overshot target. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
              `Distance to target: ${currentDistance.toFixed(1)} blocks. Closest was: ${closestDistance.toFixed(1)} blocks. ` +
              `Jump/swim-up still enabled.`;
          }

          closestDistance = Math.min(closestDistance, currentDistance);

          const horizontalDistance = Math.sqrt(
            Math.pow(currentPos.x - target.x, 2) + Math.pow(currentPos.z - target.z, 2)
          );

          // Check if we've reached the target
          if (horizontalDistance <= 0.5) {
            const distanceTraveled = initialDistance - currentDistance;
            bot.setControlState('forward', false);
            return `Reached target. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
              `Final distance to target: ${currentDistance.toFixed(1)} blocks. ` +
              `Jump/swim-up still enabled.`;
          }

          attempts++;
          await new Promise(r => setTimeout(r, 50));
        }

        // Reached MAX_ATTEMPTS
        const endPos = bot.entity.position;
        const distanceTraveled = startPos.distanceTo(endPos);
        const distanceRemaining = endPos.distanceTo(target);
        bot.setControlState('forward', false);

        return `Reached iteration limit (${MAX_ATTEMPTS} attempts). Traveled ${distanceTraveled.toFixed(1)} blocks. ` +
          `Remaining: ${distanceRemaining.toFixed(1)} blocks. Call again to continue. ` +
          `Jump/swim-up still enabled.`;
      } catch (error) {
        bot.setControlState('forward', false);
        // Keep jump enabled even on error
        throw error;
      }
    }
  );

  addServerTool(
    server,
    bot,
    "move-up-by-pillaring",
    "Build a pillar by jumping and placing blocks below. Good for trying to go way up.",
    {
      height: z.number().describe("Number of blocks to pillar up"),
      allowMiningOf: z
        .record(z.array(z.string()))
        .optional()
        .describe("Optional tool-to-blocks mapping for auto-mining blocks above: {wooden_pickaxe: ['stone', 'cobblestone'], ...}. Use 'hand' to indicate no-tool"),
    },
    async ({ height, allowMiningOf = {} }) => {
      try {
        // Check if bot has a placeable block equipped
        const heldItem = bot.heldItem;
        if (!heldItem) {
          return "No item equipped. Please equip a block (e.g., cobblestone, dirt) in hand before pillaring up.";
        }

        const mcData = minecraftData(bot.version);

        // Check if the held item corresponds to a placeable block
        const blockData = mcData.blocksByName[heldItem.name];
        if (!blockData) {
          return `Cannot pillar with ${heldItem.name}. Please equip a placeable block (e.g., cobblestone, dirt) in hand.`;
        }

        const buildingBlockName = heldItem.name;
        const startY = bot.entity.position.y.toFixed(1);
        let blocksPlaced = 0;
        let totalBlocksCleared = 0;

        for (let i = 0; i < height; i++) {
          // Before each pillar iteration, clear blocks within reachable range (Y+2, Y+3, Y+4)
          const currentPos = bot.entity.position;
          const blocksToCheck = [2, 3, 4];

          for (const yOffset of blocksToCheck) {
            const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
            if (blockAbove && blockAbove.name !== 'air') {
              // Try to mine this block using tryMiningOneBlock
              const mineResult = await tryMiningOneBlock(bot, blockAbove, allowMiningOf, 3);
              if (!mineResult.success) {
                return `Failed to pillar up: blocked at Y+${yOffset} by ${blockAbove.name} after ${blocksPlaced} blocks placed. Mining next block up got error: ${mineResult.error}`;
              }
              totalBlocksCleared++;
            }
          }

          // Re-equip the building block (in case we switched to a tool for mining)
          const buildingBlock = bot.inventory.items().find(item => item.name === buildingBlockName);
          if (!buildingBlock) {
            return `Failed to pillar up: lost ${buildingBlockName} from inventory after ${blocksPlaced} blocks placed, because didn't find ${buildingBlockName} in inventory.`;
          }
          await bot.equip(buildingBlock, 'hand');
          const beforeY = bot.entity.position.y.toFixed(1);

          // Use the pillarUpOneBlock helper
          const placed = await pillarUpOneBlock(bot);
          if (placed) {
            blocksPlaced++;
          }

          // Check if we actually moved up
          const afterY = bot.entity.position.y.toFixed(1);
          if (afterY <= beforeY && i < height - 1) {
            // Check if we still have blocks equipped
            const currentItem = bot.heldItem;
            if (!currentItem) {
              return `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
                `Ran out of blocks to place.`;
            }

            // Check the 3 blocks above the player to see what's blocking
            const currentPos = bot.entity.position;
            const blocksAbove: string[] = [];
            for (let yOffset = 2; yOffset <= 4; yOffset++) {
              const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
              if (blockAbove) {
                blocksAbove.push(`Y+${yOffset}: ${blockAbove.name}`);
              }
            }

            const equippedInfo = currentItem ? `${currentItem.name} (x${currentItem.count})` : 'nothing';

            return `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
              `Equipped: ${equippedInfo}. Blocks above: ${blocksAbove.join(', ')}`;
          }
        }

        const finalY = bot.entity.position.y.toFixed(1);
        const clearMessage = totalBlocksCleared > 0 ? ` (cleared ${totalBlocksCleared} blocks above)` : '';
        return `Pillared up ${blocksPlaced} blocks (from Y=${startY} to Y=${finalY})${clearMessage}`;
      } finally {
        bot.setControlState("jump", false);
      }
    }
  );

  addServerTool(
    server,
    bot,
    "center-in-block",
    "Center the bot in both X and Z axes within the current block",
    {},
    async () => {
      const posBefore = bot.entity.position.clone();
      await strafeToMiddleBothXZ(bot);
      const posAfter = bot.entity.position.clone();
      return `Centered bot: (${posBefore.x.toFixed(2)}, ${posBefore.z.toFixed(2)}) → (${posAfter.x.toFixed(2)}, ${posAfter.z.toFixed(2)})`;
    }
  );

  addServerTool(
    server,
    bot,
    "move-horizontally-by-mining",
    "Mines blocks ahead and walks forward, repeating for the specified number of blocks to make progress underground",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}. Use 'hand' to indicate no-tool"),
      numBlocksForwards: z
        .number()
        .optional()
        .default(1)
        .describe("Number of blocks to mine and walk forward (default: 1)"),
      digTimeout: z
        .number()
        .optional()
        .describe("Timeout for digging in seconds (default: 3)"),
    },
    async ({ targetX, targetY, targetZ, allowMiningOf, numBlocksForwards = 1, digTimeout = 3 }) => {
      const target = new Vec3(targetX, targetY, targetZ);
      const startPos = bot.entity.position.clone();
      let totalBlocksMined = 0;

      await strafeToMiddleBothXZ(bot);

      try {
        for (let i = 0; i < numBlocksForwards; i++) {
          const currentPos = bot.entity.position;
          const direction = getNextXZAlignedDirection(bot, target);

          // Mine blocks ahead
          const result = await mineForwardsIfPossible(
            bot, currentPos, direction, allowMiningOf, digTimeout, true
          );

          if (!result.success) {
            const distTraveled = startPos.distanceTo(bot.entity.position);
            return `Mined ${totalBlocksMined} block(s) and traveled ${distTraveled.toFixed(1)} blocks before encountering error: ${result.error}`;
          }

          totalBlocksMined += result.blocksMined;

          // Walk forward
          await walkForwardsAtLeastOneBlockXZAligned(bot, direction);
        }

        const distTraveled = startPos.distanceTo(bot.entity.position);
        return `Successfully mined ${totalBlocksMined} block(s) and traveled ${distTraveled.toFixed(1)} blocks forward`;
      } catch (error) {
        const distTraveled = startPos.distanceTo(bot.entity.position);
        throw new Error(`${formatError(error)}. Progress: mined ${totalBlocksMined} block(s), traveled ${distTraveled.toFixed(1)} blocks`);
      }
    }
  );

  addServerTool(
    server,
    bot,
    "jump-over-obstacle",
    "Jump over a small obstacle ahead of the bot in the direction toward target. Good for obstacles of height 1 (blocking the bot's feet but not head)",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
    },
    async ({ targetX, targetY, targetZ }) => {
      const target = new Vec3(targetX, targetY, targetZ);
      const currentPos = bot.entity.position;
      const direction = getNextXZAlignedDirection(bot, target);

      const result = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target);

      if (result.success) {
        return `Successfully jumped over obstacle`;
      } else {
        return result.error || "Failed to jump over obstacle";
      }
    }
  );

  addServerTool(
    server,
    bot,
    "move-horizontally-and-down-using-steps",
    "Mine down multiple steps. Good for going vertically and down at the same time wile mining.",
    {
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}. Use 'hand' to indicate no-tool"),
      stepsToGoDown: z
        .number()
        .describe("Number of steps to descend"),
      nextStepPos: z.object({
        x: z.number(),
        y: z.number(),
        z: z.number()
      }).describe("Position of the first step (must be adjacent and one block down from current position)"),
      digTimeout: z
        .number()
        .optional()
        .describe("Timeout for digging in seconds (default: 3)"),
    },
    async ({ allowMiningOf, stepsToGoDown, nextStepPos, digTimeout = 3 }) => {
      const nextStepVec = new Vec3(nextStepPos.x, nextStepPos.y, nextStepPos.z);
      const result = await mineStepsDown(bot, stepsToGoDown, nextStepVec, allowMiningOf, digTimeout);

      if (result.error) {
        return `Completed ${result.stepsCompleted} of ${stepsToGoDown} steps before encountering error: ${result.error}`;
      } else {
        const finalPos = bot.entity.position;
        return `Successfully mined down ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}`;
      }
    }
  );

  addServerTool(
    server,
    bot,
    "move-horizontally-and-up-using-steps",
    "Mine up multiple steps. Good for going forwards-and-up.",
    {
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
      stepsToGoUp: z
        .number()
        .describe("Number of steps to ascend"),
      nextStepPos: z.object({
        x: z.number(),
        y: z.number(),
        z: z.number()
      }).describe("Position of the first step (must be adjacent and one block up from current position)"),
      digTimeout: z
        .number()
        .optional()
        .describe("Timeout for digging in seconds (default: 3)"),
    },
    async ({ allowMiningOf, stepsToGoUp, nextStepPos, digTimeout = 3 }) => {
      const nextStepVec = new Vec3(nextStepPos.x, nextStepPos.y, nextStepPos.z);
      const result = await mineStepsUp(bot, stepsToGoUp, nextStepVec, allowMiningOf, digTimeout);

      if (result.error) {
        return `Completed ${result.stepsCompleted} of ${stepsToGoUp} steps before encountering error: ${result.error}`;
      } else {
        const finalPos = bot.entity.position;
        return `Successfully mined up ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}`;
      }
    }
  );
}


// ========== Inventory Management Tools ==========

export function registerInventoryTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const items = bot.inventory.items();
      const itemList: InventoryItem[] = items.map((item) => {
        const inventoryItem: InventoryItem = {
          name: item.name,
          count: item.count,
          slot: item.slot,
        };

        if (item.maxDurability != null && item.durabilityUsed != null) {
          inventoryItem.durability = {
            remaining: item.maxDurability - item.durabilityUsed,
            max: item.maxDurability,
          };
        }

        return inventoryItem;
      });

      if (items.length === 0) {
        return "Inventory is empty";
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach((item) => {
        let itemText = `- ${item.name} (x${item.count}) in slot ${item.slot}`;
        if (item.durability) {
          itemText += ` [durability: ${item.durability.remaining}/${item.durability.max}]`;
        }
        inventoryText += itemText + '\n';
      });

      return inventoryText;
    }
  );

  addServerTool(
    server,
    bot,
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find"),
    },
    async ({ nameOrType }) => {
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(nameOrType.toLowerCase())
      );

      if (item) {
        return `Found ${item.count} ${item.name} in inventory (slot ${item.slot})`;
      } else {
        return `Couldn't find any item matching '${nameOrType}' in inventory`;
      }
    }
  );

  addServerTool(
    server,
    bot,
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z
        .string()
        .optional()
        .describe("Where to equip the item (default: 'hand')"),
    },
    async ({ itemName, destination = "hand" }) => {
      const items = bot.inventory.items();
      const item = items.find(
        (item) => item.name === itemName.toLowerCase()
      );

      if (!item) {
        return `Couldn't find any item matching '${itemName}' in inventory`;
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return `Equipped ${item.name} to ${destination}`;
    }
  );
}

// ========== Item Action Tools ==========

export function registerItemActionTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "drop-item",
    "Drop items from inventory",
    {
      itemName: z.string().describe("Name of the item to drop"),
      count: z.number().optional().default(1).describe("Number of items to drop (default: 1)"),
    },
    async ({ itemName, count }) => {
      const item = expectItemInInventory(bot, itemName);
      expectSufficientItems(item, count);
      await bot.toss(item.type, null, count);
      return `Dropped ${count}x ${itemName}`;
    }
  );

  addServerTool(
    server,
    bot,
    "eat-food",
    "Consume food to restore hunger",
    {
      itemName: z.string().optional().describe("Name of the food item to eat (auto-select if not provided)"),
    },
    async ({ itemName }) => {
      const items = bot.inventory.items();
      let foodItem;

      if (itemName) {
        foodItem = items.find(i => i.name === itemName);
        if (!foodItem) {
          const inventory = items.map(i => `${i.name}(x${i.count})`).join(', ');
          return `Cannot eat ${itemName}: not found in inventory. Inventory: ${inventory}`;
        }
        if (!(foodItem as any).foodPoints) {
          return `Cannot eat ${itemName}: not a food item`;
        }
      } else {
        foodItem = items.find(i => (i as any).foodPoints);
        if (!foodItem) {
          return `Cannot eat: no food items in inventory`;
        }
      }

      await bot.equip(foodItem, 'hand');
      await bot.consume();
      return `Ate ${foodItem.name}`;
    }
  );

  addServerTool(
    server,
    bot,
    "activate-item",
    "Use currently held item (e.g., shoot bow, raise shield, throw snowball, drink potion)",
    {
      offhand: z.boolean().optional().default(false).describe("Use offhand item instead of main hand"),
    },
    async ({ offhand }) => {
      const heldItem = bot.heldItem;
      if (!heldItem) {
        const hand = offhand ? 'offhand' : 'main hand';
        return `No item held in ${hand}`;
      }

      bot.activateItem(offhand);
      return `Activated ${heldItem.name}`;
    }
  );

  addServerTool(
    server,
    bot,
    "write-book",
    "Write content to a book and quill",
    {
      slot: z.number().describe("Inventory slot containing the book"),
      pages: z.array(z.string()).describe("Array of page contents"),
    },
    async ({ slot, pages }) => {
      await bot.writeBook(slot, pages);
      return `Wrote ${pages.length} pages to book in slot ${slot}`;
    }
  );
}

// ========== Container Tools ==========

export function registerContainerTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "chest-open",
    "Open a chest at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlockOfType(bot, pos, 'chest');

      const chest = await bot.openChest(block);
      const items = chest.containerItems();
      const itemsSummary = items.length > 0
        ? items.map(i => `${i.name}(x${i.count})`).join(', ')
        : 'empty';

      return `Opened chest at ${formatPosition(pos)}. Contents: ${itemsSummary}`;
    }
  );

  addServerTool(
    server,
    bot,
    "furnace-open",
    "Open furnace interface for direct interaction",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlockOfType(bot, pos, 'furnace');
      await bot.openFurnace(block);
      return `Opened furnace at ${formatPosition(pos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "enchantment-table-open",
    "Open enchantment table interface",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlockOfType(bot, pos, 'enchanting_table');
      await bot.openEnchantmentTable(block);
      return `Opened enchantment table at ${formatPosition(pos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "anvil-open",
    "Open anvil for repairs and renaming",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlockOfType(bot, pos, 'anvil');
      await bot.openAnvil(block);
      return `Opened anvil at ${formatPosition(pos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "transfer-items",
    "Transfer items between inventory slots or containers",
    {
      itemName: z.string().describe("Name of the item to transfer"),
      count: z.number().describe("Number of items to transfer"),
      fromSlot: z.number().optional().describe("Source slot number"),
      toSlot: z.number().optional().describe("Destination slot number"),
    },
    async ({ itemName, count, fromSlot, toSlot }) => {
      const items = bot.inventory.items();
      const item = items.find(i => i.name === itemName);

      if (!item) {
        const inventory = items.map(i => `${i.name}(x${i.count})`).join(', ');
        return `Cannot transfer ${itemName}: not found in inventory. Inventory: ${inventory}`;
      }

      if (item.count < count) {
        return `Cannot transfer ${count}x ${itemName}: only have ${item.count}`;
      }

      await bot.transfer({
        window: bot.currentWindow || bot.inventory,
        itemType: item.type,
        metadata: null,
        sourceStart: fromSlot,
        sourceEnd: fromSlot,
        destStart: toSlot,
      } as any);

      return `Transferred ${count}x ${itemName}`;
    }
  );
}

// ========== Survival Tools ==========

export function registerSurvivalTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "bed-sleep",
    "Sleep in a bed to skip night and set spawn point",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlock(bot, pos);
      if (!bot.isABed(block)) {
        throw new Error(`Block at ${formatPosition(pos)} is not a bed`);
      }
      await bot.sleep(block);
      return `Sleeping in bed at ${formatPosition(pos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "bed-wake",
    "Wake up from bed",
    {},
    async () => {
      if (!bot.isSleeping) {
        return `Not currently sleeping`;
      }

      await bot.wake();
      return `Woke up from bed`;
    }
  );

  addServerTool(
    server,
    bot,
    "fish",
    "Start fishing (requires fishing rod equipped)",
    {},
    async () => {
      const heldItem = bot.heldItem;
      if (!heldItem || !heldItem.name.includes('fishing_rod')) {
        return `No fishing rod equipped in main hand`;
      }

      await bot.fish();
      return `Caught a fish`;
    }
  );

  addServerTool(
    server,
    bot,
    "elytra-fly",
    "Activate elytra flight",
    {},
    async () => {
      await bot.elytraFly();
      return `Activated elytra flight`;
    }
  );
}

// ========== Block Interaction Tools ==========

export interface LightLevelInfo {
  lightFromSun: number;
  lightFromBlocks: number;
  totalLight: number;
}

export function getLightLevel(block: { light?: number; skyLight?: number } | null | undefined): LightLevelInfo | null {
  if (!block || ((block.light === undefined || block.light === null) && (block.skyLight === undefined || block.skyLight === null))) {
    return null;
  }

  const lightFromBlocks = block.light ?? 0;
  const lightFromSun = block.skyLight ?? 0;
  const totalLight = Math.max(lightFromBlocks, lightFromSun);

  return {
    lightFromSun,
    lightFromBlocks,
    totalLight
  };
}

export function getBlockLightLevelFormatted(block: { light?: number; skyLight?: number } | null | undefined): string {
  const lightInfo = getLightLevel(block);

  if (!lightInfo) {
    return "light: ?/15";
  }

  // Debug log the raw values
  logger.debug(`Light levels - sun: ${lightInfo.lightFromSun}, blocks: ${lightInfo.lightFromBlocks}, total: ${lightInfo.totalLight}`);

  // Return formatted string with total light level
  return `light: ${lightInfo.totalLight}/15`;
}

export function getEquippedItemDurability(bot: Bot): { remaining: number; max: number } | null {
  const heldItem = bot.heldItem;
  if (!heldItem || heldItem.maxDurability == null || heldItem.durabilityUsed == null) {
    return null;
  }
  return {
    remaining: heldItem.maxDurability - heldItem.durabilityUsed,
    max: heldItem.maxDurability,
  };
}

// Track previous state for each bot to detect changes
interface BotState {
  lastOxygen?: number;
  lastHealth?: number;
  lastDurability?: number;
  lastInventory?: Map<string, number>;
  lastEntities?: Array<{type: string, location: {x: number, y: number, z: number}}>;
  lastChatTimestamp?: number;
  lastFeetPos?: {x: number, y: number, z: number};
}

const botStateMap = new WeakMap<Bot, BotState>();

export function getBotState(bot: Bot): BotState {
  let state = botStateMap.get(bot);
  if (!state) {
    state = {};
    botStateMap.set(bot, state);
  }
  return state;
}

export function registerBlockTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "place-block",
    "Place a block at the specified position",
    {
      blockName: z.string().describe("Name of the block to place (e.g., 'dirt')"),
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ blockName, x, y, z }) => {
      // Find and equip the block
      await equipItem(bot, blockName, 'hand');

      const placePos = new Vec3(x, y, z);
      const blockAtPos = bot.blockAt(placePos);
      if (blockAtPos && !isBlockEmpty(blockAtPos)) {
        throw new Error(`There's already a block (${blockAtPos.name}) at ${formatPosition(placePos)}`);
      }

      // Try all 6 faces
      const faces: Array<{ name: string; vec: Vec3 }> = [
        { name: "down", vec: new Vec3(0, -1, 0) },
        { name: "up", vec: new Vec3(0, 1, 0) },
        { name: "north", vec: new Vec3(0, 0, -1) },
        { name: "south", vec: new Vec3(0, 0, 1) },
        { name: "west", vec: new Vec3(-1, 0, 0) },
        { name: "east", vec: new Vec3(1, 0, 0) },
      ];

      for (const face of faces) {
        const refBlock = bot.blockAt(placePos.plus(face.vec));
        if (refBlock && !isBlockEmpty(refBlock) /* && bot.canSeeBlock(refBlock) */) {
          try {
            await bot.lookAt(placePos, true);
            await bot.placeBlock(refBlock, face.vec.scaled(-1));
            return `Placed block at ${formatPosition(placePos)} using ${face.name} face`;
          } catch {
            // Try next face
            continue;
          }
        }
      }

      const dist = bot.entity.position.distanceTo(placePos);
      throw new Error(`Failed to place block at ${formatPosition(placePos)}: No suitable reference block found` +
        (dist < 1.5 ? `. Distance: ${dist.toFixed(2)} blocks - too close, move away` : ''));
    }
  );

  addServerTool(
    server,
    bot,
    "dig-adjacent-blocks",
    "Dig multiple blocks sequentially",
    {
      positions: z.array(z.object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
      })).describe("Array of positions to dig, e.g., [{x: 1, y: 2, z: 3}, {x: 4, y: 5, z: 6}]"),
      timeoutSeconds: z
        .union([z.number(), z.string().transform(val => parseFloat(val))])
        .optional()
        .describe("Timeout for digging each block in seconds (default: 3). Use longer timeout (e.g. 10) for hard blocks like iron ore with stone pickaxe"),
      allowedMiningToolsToMinedBlocks: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Optional tool-to-blocks mapping for auto-equipping tools: {wooden_pickaxe: ['dirt'], diamond_pickaxe: ['stone', 'iron_ore']}. If not provided, will use currently equipped tool."),
    },
    async ({ positions, timeoutSeconds, allowedMiningToolsToMinedBlocks = {} }) => {
      const digTimeout = timeoutSeconds ?? 3;
      let dugCount = 0;
      let lastError: string | undefined;

      for (let i = 0; i < positions.length; i++) {
        const { x, y, z } = positions[i];
        const blockPos = new Vec3(x, y, z);
        const block = bot.blockAt(blockPos)!;

        const result = await tryMiningOneBlock(bot, block, allowedMiningToolsToMinedBlocks, digTimeout, true);

        if (!result.success) {
          lastError = result.error || `Failed to mine block ${block.name} at (${x}, ${y}, ${z}) for unknown reason`;
          break;
        }

        dugCount++;
      }

      const totalBlocks = positions.length;
      if (dugCount === totalBlocks) {
        return `Dug ${dugCount} block${dugCount === 1 ? '' : 's'}`;
      } else {
        return `Dug ${dugCount}/${totalBlocks} blocks. Error on block ${dugCount + 1}: ${lastError}`;
      }
    }
  );

  addServerTool(
    server,
    bot,
    "dig-directly-down",
    "Dig straight down by mining blocks directly below the bot. Good if the target is far down.",
    {
      blocksToDigDown: z
        .number()
        .optional()
        .default(1)
        .describe("Number of blocks to dig down (default: 1)"),
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {iron_pickaxe: ['stone', 'cobblestone'], ...}"),
      digTimeout: z
        .number()
        .optional()
        .default(3)
        .describe("Timeout for digging each block in seconds (default: 3)"),
    },
    async ({ blocksToDigDown = 1, allowMiningOf, digTimeout = 3 }) => {
      const startPos = bot.entity.position.clone();
      const result = await digDirectlyDownIfPossible(bot, blocksToDigDown, allowMiningOf, digTimeout);

      if (result.success) {
        const endPos = bot.entity.position;
        const verticalDist = startPos.y - endPos.y;
        return `Successfully dug down ${result.blocksMined} block(s). ` +
          `Descended ${verticalDist.toFixed(1)} blocks. ` +
          `Now at position ${formatBotPosition(endPos)}.`;
      } else {
        return result.error || `Unknown error while digging down. Dug down ${result.blocksMined} blocks.`;
      }
    }
  );

  addServerTool(
    server,
    bot,
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return `No block information found at position (${x}, ${y}, ${z})`;
      }

      const lightInfo = getBlockLightLevelFormatted(block);

      return `Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z}), ${lightInfo}`;
    }
  );

  addServerTool(
    server,
    bot,
    "get-blocks-info",
    "Get information about multiple blocks at specified positions",
    {
      positions: z.array(z.object({
        x: z.number(),
        y: z.number(),
        z: z.number()
      })).describe("Array of positions to check, e.g., [{x: 1, y: 2, z: 3}, {x: 4, y: 5, z: 6}]"),
    },
    async ({ positions }) => {
      let result = `Blocks:\n\n`;

      for (const pos of positions) {
        const blockPos = new Vec3(pos.x, pos.y, pos.z);
        const block = bot.blockAt(blockPos);

        if (!block) {
          result += `(${pos.x}, ${pos.y}, ${pos.z}): (unkonwn, maybe bug?)\n`;
        } else {
          const lightInfo = getBlockLightLevelFormatted(block);
          result += `(${pos.x}, ${pos.y}, ${pos.z}): ${block.name}, ${lightInfo}\n`;
        }
      }

      return result.trim();
    }
  );

  addServerTool(
    server,
    bot,
    "find-blocks-by-type",
    "Find blocks of a specific type (sorted by distance, closest first)",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z
        .number()
        .optional()
        .describe("Maximum search distance (default: 16)"),
      maxResults: z
        .number()
        .optional()
        .describe("Maximum number of blocks to return (default: 5)"),
    },
    async ({
      blockType,
      maxDistance = 16,
      maxResults = 5,
    }) => {
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;

      if (!blocksByName[blockType]) {
        return `Unknown block type: ${blockType}`;
      }

      const blockId = blocksByName[blockType].id;

      const positions = bot.findBlocks({
        matching: blockId,
        maxDistance: maxDistance,
        count: maxResults,
      });

      if (positions.length === 0) {
        return `No ${blockType} found within ${maxDistance} blocks`;
      }

      const positionStrings = positions.map(
        (pos) => `(${pos.x}, ${pos.y}, ${pos.z})`
      );

      return `Found ${positions.length} ${blockType} block(s):\n${positionStrings.join("\n")}`;
    }
  );

  addServerTool(
    server,
    bot,
    "get-nearby-block-types",
    "Get all unique block types and entity types in the nearby area with counts and closest distance",
    {
      maxDistanceSideways: z
        .number()
        .optional()
        .default(16)
        .describe("Maximum horizontal search distance"),
      maxDistanceUpDown: z
        .number()
        .optional()
        .default(8),
      maxBlockTypes: z
        .number()
        .optional()
        .default(20)
        .describe("Limit on number of unique block types to return"),

    },
    async ({ maxDistanceSideways, maxDistanceUpDown, maxBlockTypes }) => {
      const botPos = bot.entity.position;

      // Define blocks to ignore (common/boring blocks)
      const boringBlocks = new Set([
        'air', 'stone', 'dirt', 'grass_block', 'water', 'lava',
        'bedrock', 'cave_air', 'void_air'
      ]);

      // Map to track closest instance and count of each block type
      const blockTypes = new Map<string, { distance: number; position: Vec3; count: number }>();

      // Search for interesting blocks
      const minPos = botPos.offset(-maxDistanceSideways, -maxDistanceUpDown, -maxDistanceSideways);
      const maxPos = botPos.offset(maxDistanceSideways, maxDistanceUpDown, maxDistanceSideways);

      for (let x = Math.floor(minPos.x); x <= Math.floor(maxPos.x); x++) {
        for (let y = Math.floor(minPos.y); y <= Math.floor(maxPos.y); y++) {
          for (let z = Math.floor(minPos.z); z <= Math.floor(maxPos.z); z++) {
            const blockPos = new Vec3(x, y, z);
            const block = bot.blockAt(blockPos);

            if (!block || boringBlocks.has(block.name)) continue;

            const distance = botPos.distanceTo(blockPos);
            const existing = blockTypes.get(block.name);

            if (!existing) {
              blockTypes.set(block.name, { distance, position: blockPos, count: 1 });
            } else {
              existing.count++;
              if (distance < existing.distance) {
                existing.distance = distance;
                existing.position = blockPos;
              }
            }
          }
        }
      }

      // Search for entities
      const entityTypes = new Map<string, { distance: number; position: Vec3; count: number }>();

      for (const entityId in bot.entities) {
        const entity = bot.entities[entityId];

        // Skip the bot itself
        if (entity === bot.entity) continue;

        const distance = botPos.distanceTo(entity.position);

        // Check if within search radius
        const horizontalDist = Math.sqrt(
          Math.pow(entity.position.x - botPos.x, 2) +
          Math.pow(entity.position.z - botPos.z, 2)
        );
        const verticalDist = Math.abs(entity.position.y - botPos.y);

        if (horizontalDist > maxDistanceSideways || verticalDist > maxDistanceUpDown) continue;

        const entityName = entity.name || (entity as any).username || entity.type || 'unknown';
        const existing = entityTypes.get(entityName);

        if (!existing) {
          entityTypes.set(entityName, { distance, position: entity.position, count: 1 });
        } else {
          existing.count++;
          if (distance < existing.distance) {
            existing.distance = distance;
            existing.position = entity.position;
          }
        }
      }

      // Combine blocks and entities
      const allItems: Array<{ type: string; distance: number; position: Vec3; count: number; category: 'block' | 'entity' }> = [];

      blockTypes.forEach((data, name) => {
        allItems.push({ type: name, distance: data.distance, position: data.position, count: data.count, category: 'block' });
      });

      entityTypes.forEach((data, name) => {
        allItems.push({ type: name, distance: data.distance, position: data.position, count: data.count, category: 'entity' });
      });

      // Sort by distance (closest first) and limit results
      allItems.sort((a, b) => a.distance - b.distance);
      const limitedItems = allItems.slice(0, maxBlockTypes);

      if (limitedItems.length === 0) {
        return `No interesting blocks or entities found within ${maxDistanceSideways} blocks horizontally and ${maxDistanceUpDown} blocks vertically.`;
      }

      let output = `Found ${limitedItems.length} nearby items (of ${allItems.length} total):\n\n`;
      output += `Entity/Block;Name;Count;Closest_Distance;Closest_location(x,y,z)\n`;

      limitedItems.forEach((item) => {
        const pos = item.position;
        const typeMarker = item.category === 'entity' ? 'E' : 'B';
        output += `${typeMarker};${item.type};${item.count};${item.distance.toFixed(1)};(${pos.x},${pos.y},${pos.z})\n`;
      });

      output += `\nIf you wanted the blocks adjacent to the bot (e.g if stuck), use show-adjacent-blocks instead. To reach one of these blocks, consider pathfind-and-move-to`

      return output.trim();
    }
  );

  addServerTool(
    server,
    bot,
    "block-activate",
    "Activate a block (button, lever, door, trapdoor, etc.)",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlock(bot, pos);
      if (isBlockEmpty(block)) {
        throw new Error(`Cannot activate air block at ${formatPosition(pos)}`);
      }
      await bot.activateBlock(block);
      return `Activated ${block.name} at ${formatPosition(pos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "sign-update",
    "Update text on a sign",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
      text: z.string().describe("Text to write on the sign"),
      back: z.boolean().optional().default(false).describe("Write on back of sign (default: false)"),
    },
    async ({ x, y, z, text, back }) => {
      const pos = new Vec3(x, y, z);
      const block = expectBlockOfType(bot, pos, 'sign');
      bot.updateSign(block, text, back);
      return `Updated sign at ${formatPosition(pos)}`;
    }
  );
}

// ========== Entity Interaction Tools ==========

export function registerEntityTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z
        .string()
        .optional()
        .describe("Type of entity to find (empty for any entity)"),
      maxDistance: z
        .number()
        .optional()
        .describe("Maximum search distance (default: 16)"),
    },
    async ({ type = "", maxDistance = 16 }) => {
      const entityFilter = (entity: Entity) => {
        if (!type) return true;
        if (type === "player") return entity.type === "player";
        if (type === "mob") return entity.type === "mob";
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (
        !entity ||
        bot.entity.position.distanceTo(entity.position) > maxDistance
      ) {
        return `No ${type || "entity"} found within ${maxDistance} blocks`;
      }

      return `Found ${
        entity.name || (entity as any).username || entity.type
      } at position ${formatBotPosition(entity.position)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "attack-entity",
    "Attack a nearby entity repeatedly until it dies",
    {
      type: z
        .string()
        .optional()
        .describe("Type of entity to attack (e.g., 'sheep', 'zombie', 'cow'). If not provided, attacks nearest entity."),
      maxDistance: z
        .number()
        .optional()
        .describe("Maximum search distance (default: 4)"),
    },
    async ({ type = "", maxDistance = 4 }) => {
      const entityFilter = (entity: Entity) => {
        // Don't attack players or ourselves
        if (entity.type === "player" || entity === bot.entity) return false;
        if (!type) return true;
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (
        !entity ||
        bot.entity.position.distanceTo(entity.position) > maxDistance
      ) {
        return `No ${type || "entity"} found within ${maxDistance} blocks to attack`;
      }

      const entityName = entity.name || entity.type || "entity";
      const initialPos = entity.position.clone();

      log("info", `Attacking ${entityName} at ${formatBotPosition(initialPos)}`);

      // Attack until entity is dead
      let attackCount = 0;
      const maxAttacks = 20; // Safety limit

      while (entity.isValid && attackCount < maxAttacks) {
        // Look at the entity
        await bot.lookAt(entity.position, true);

        // Attack (synchronous)
        bot.attack(entity);
        attackCount++;

        // Wait a bit between attacks (attack cooldown)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check if entity is still close enough
        if (bot.entity.position.distanceTo(entity.position) > maxDistance + 2) {
          return `${entityName} moved too far away after ${attackCount} attacks. Try moving closer.`;
        }
      }

      if (attackCount >= maxAttacks) {
        return `Attacked ${entityName} ${attackCount} times but it's still alive. It may be too strong or invulnerable.`;
      }

      return `Successfully killed ${entityName} with ${attackCount} attacks at position ${formatBotPosition(initialPos)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "entity-interact",
    "Right-click/interact with nearest entity",
    {
      entityType: z.string().optional().describe("Type of entity to interact with (e.g., 'villager', 'sheep')"),
      maxDistance: z.number().optional().default(4).describe("Maximum search distance (default: 4)"),
    },
    async ({ entityType, maxDistance }) => {
      const entity = entityType
        ? bot.nearestEntity(e => e.name === entityType && bot.entity.position.distanceTo(e.position) <= maxDistance)
        : bot.nearestEntity(e => bot.entity.position.distanceTo(e.position) <= maxDistance);

      if (!entity) {
        return `No ${entityType || 'entity'} found within ${maxDistance} blocks`;
      }

      await bot.activateEntity(entity);
      return `Interacted with ${getEntityName(entity)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "entity-use-item-on",
    "Use held item on entity (shears on sheep, dye on wolf, etc.)",
    {
      entityType: z.string().describe("Type of entity (e.g., 'sheep', 'wolf')"),
      maxDistance: z.number().optional().default(4).describe("Maximum search distance (default: 4)"),
    },
    async ({ entityType, maxDistance }) => {
      const heldItem = bot.heldItem;
      if (!heldItem) {
        return `No item held in main hand`;
      }

      const entity = bot.nearestEntity(e => e.name === entityType && bot.entity.position.distanceTo(e.position) <= maxDistance);

      if (!entity) {
        return `No ${entityType} found within ${maxDistance} blocks`;
      }

      bot.useOn(entity);
      return `Used ${heldItem.name} on ${getEntityName(entity)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "entity-mount",
    "Mount a horse, boat, minecart, etc.",
    {
      entityType: z.string().describe("Type of entity to mount (e.g., 'horse', 'boat', 'minecart')"),
      maxDistance: z.number().optional().default(4).describe("Maximum search distance (default: 4)"),
    },
    async ({ entityType, maxDistance }) => {
      const entity = bot.nearestEntity(e => e.name === entityType && bot.entity.position.distanceTo(e.position) <= maxDistance);

      if (!entity) {
        return `No ${entityType} found within ${maxDistance} blocks`;
      }

      if (bot.entity.vehicle) {
        return `Already mounted on ${getEntityName(bot.entity.vehicle)}`;
      }

      bot.mount(entity);
      return `Mounted ${getEntityName(entity)}`;
    }
  );

  addServerTool(
    server,
    bot,
    "entity-dismount",
    "Dismount from current mount",
    {},
    async () => {
      if (!bot.entity.vehicle) {
        return `Not currently mounted on anything`;
      }

      const vehicleName = bot.entity.vehicle.name || bot.entity.vehicle.type;
      bot.dismount();
      return `Dismounted from ${vehicleName}`;
    }
  );

  addServerTool(
    server,
    bot,
    "villager-open",
    "Open trade window with nearest villager",
    {
      maxDistance: z.number().optional().default(4).describe("Maximum search distance (default: 4)"),
    },
    async ({ maxDistance }) => {
      const entity = bot.nearestEntity(e => e.name === 'villager' && bot.entity.position.distanceTo(e.position) <= maxDistance);

      if (!entity) {
        return `No villager found within ${maxDistance} blocks`;
      }

      const villager = await bot.openVillager(entity);
      const trades = villager.trades;

      if (!trades || trades.length === 0) {
        return `Opened villager but no trades available`;
      }

      let tradesText = `Opened villager with ${trades.length} trades:\n`;
      trades.forEach((trade: any, index: number) => {
        const inputItems = trade.inputItem1 ? `${trade.inputItem1.count}x ${trade.inputItem1.name}` : '';
        const inputItems2 = trade.inputItem2 ? ` + ${trade.inputItem2.count}x ${trade.inputItem2.name}` : '';
        const outputItem = trade.outputItem ? `${trade.outputItem.count}x ${trade.outputItem.name}` : '';
        tradesText += `  ${index}: ${inputItems}${inputItems2} -> ${outputItem}\n`;
      });

      return tradesText.trim();
    }
  );

  addServerTool(
    server,
    bot,
    "villager-trade",
    "Execute a trade with an open villager",
    {
      tradeIndex: z.number().describe("Index of the trade to execute (0-based)"),
      times: z.number().optional().default(1).describe("Number of times to repeat the trade (default: 1)"),
    },
    async ({ tradeIndex, times }) => {
      if (!bot.currentWindow) {
        return `No villager window open. Use villager-open first`;
      }

      await bot.trade(bot.currentWindow as any, tradeIndex, times);
      return `Executed trade ${tradeIndex} ${times} time(s)`;
    }
  );
}

// ========== Chat Tools ==========

export function registerChatTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().describe("Message to send in chat"),
    },
    async ({ message }) => {
      bot.chat(message);
      return `Sent message: "${message}"`;
    }
  );

  addServerTool(
    server,
    bot,
    "read-chat",
    "Get recent chat messages from players",
    {
      count: z
        .number()
        .optional()
        .default(10)
        .describe(
          "Max recent messages to retrieve"
        ),
    },
    async ({ count }) => {
      const maxCount = Math.min(count, MAX_STORED_MESSAGES);
      const messages = messageStore.getRecentMessages(maxCount);

      if (messages.length === 0) {
        return "No chat messages found";
      }

      let output = `Found ${messages.length} chat message(s):\n\n`;
      messages.forEach((msg, index) => {
        const timestamp = new Date(msg.timestamp).toISOString();
        output += `${index + 1}. ${timestamp} - ${msg.username}: ${
          msg.content
        }\n`;
      });

      return output;
    }
  );

  addServerTool(
    server,
    bot,
    "player-whisper",
    "Send a private message to a player",
    {
      username: z.string().describe("Username of the player to whisper"),
      message: z.string().describe("Message to send"),
    },
    async ({ username, message }) => {
      bot.whisper(username, message);
      return `Whispered to ${username}: "${message}"`;
    }
  );
}

// ========== Game State Tools ============

export function registerGameStateTools(server: McpServer, bot: Bot) {
  addServerTool(
    server,
    bot,
    "detect-gamemode",
    "Detect the gamemode on game",
    {},
    async () => {
      return `Bot gamemode: "${bot.game.gameMode}"`;
    }
  );

  addServerTool(
    server,
    bot,
    "get-status",
    "Get the bot's health, food, and other status information",
    {},
    async () => {
      const health = bot.health;
      const food = bot.food;
      const saturation = bot.foodSaturation;
      const oxygen = bot.oxygenLevel;

      let status = `Bot Status:\n`;
      status += `  Health: ${health}/20 (${(health/20*100).toFixed(0)}%)\n`;
      status += `  Food: ${food}/20 (${(food/20*100).toFixed(0)}%)\n`;
      status += `  Saturation: ${saturation.toFixed(1)}\n`;
      status += `  Oxygen: ${oxygen}/20\n`;
      status += `  Game Mode: ${bot.game.gameMode}`;

      return status;
    }
  );

  // addServerTool(
  //   server,
  //   bot,
  //   "show-adjacent-blocks",
  //   "Show all blocks directly adjacent to the bot in all horizontal directions and at all height levels (above head, head height, feet height, below feet). The bot is 2 blocks tall.",
  //   {},
  //   async () => {
  //     const result = getAdjacentBlocks(bot);
  //     return result;
  //   }
  // );
}

// ========== Main Application ==========

export async function main() {
  let bot: Bot | undefined;

  try {
    // Parse command line arguments
    const argv = parseCommandLineArgs();

    // Set up the Minecraft bot
    bot = setupBot(argv);

    // Create and configure MCP server
    const server = createMcpServer(bot);

    // Handle stdin end - this will detect when MCP Client is closed
    process.stdin.on("end", () => {
      if (bot) bot.quit();
      log("info", "MCP Client has disconnected. Shutting down...");
      process.exit(0);
    });

    // Connect to the transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    if (bot) bot.quit();
    log("error", `Failed to start server: ${formatError(error)}`);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  log("error", `Fatal error in main(): ${formatError(error)}`);
  process.exit(1);
});
