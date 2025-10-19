#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import yargs from "yargs";
import type { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";

import type { Entity } from "prismarine-entity";
import {
  type AxisAlignedDirection,
  formatBotPosition,
  formatBlockPosition,
  getBlocksAhead,
  getNextXZAlignedDirection,
  jumpOverSmallObstacleIfPossible,
  walkForwardsIfPossible,
  getBotAxisAlignedDirection,
  getStrafeDirectionAndAmount,
  strafeToMiddle,
  strafeToMiddleBothXZ,
  walkForwardsAtLeastOneBlockXZAligned,
  mineForwardsIfPossible,
  digDirectlyDownIfPossible,
  getAdjacentBlocks,
  mineStepsUp,
  tryMiningOneBlock,
  pillarUpOneBlock,
  mineStepsDown,
  getBotPosition,
} from "./movement.js";
import { formatError, log } from "./bot_log.js";
import logger, { logToolCall, logBotState, logGameEvent } from "./logger.js";

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

interface StoredMessage {
  timestamp: number;
  username: string;
  content: string;
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


// ========== Message Storage ==========

const MAX_STORED_MESSAGES = 100;

class MessageStore {
  private messages: StoredMessage[] = [];
  private maxMessages = MAX_STORED_MESSAGES;

  addMessage(username: string, content: string) {
    const message: StoredMessage = {
      timestamp: Date.now(),
      username,
      content,
    };

    this.messages.push(message);

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  getRecentMessages(count: number = 10): StoredMessage[] {
    return this.messages.slice(-count);
  }
}

// Global message store instance
const messageStore = new MessageStore();

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
  registerBlockTools(server, bot);
  registerEntityTools(server, bot);
  registerChatTools(server, bot);
  // registerFlightTools(server, bot);
  registerGameStateTools(server, bot);

  return server;
}

// ========== Crafting Tools ==========

export function registerCraftingTools(server: McpServer, bot: Bot) {
  server.tool(
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
    withToolLogging("craft-item", async ({ itemName, count = 1, useCraftingTable }): Promise<McpResponse> => {
      try {
        const mcData = minecraftData(bot.version);
        const itemsByName = mcData.itemsByName;

        const item = itemsByName[itemName];
        if (!item) {
          return createResponse(
            `Unknown item: ${itemName}. Make sure to use the exact item name (e.g., 'oak_planks', 'crafting_table')`
          );
        }

        let craftingTable = null;

        // If crafting table is required, find it first
        if (useCraftingTable) {
          craftingTable = bot.findBlock({
            matching: mcData.blocksByName.crafting_table?.id,
            maxDistance: 32,
          });

          if (!craftingTable) {
            return createResponse(
              `Cannot craft ${itemName}: crafting table required but none found within 32 blocks. Place a crafting table nearby.`
            );
          }

          log("info", `Found crafting table at ${craftingTable.position}`);
        }

        // Try to get craftable recipes directly
        const craftableRecipes = bot.recipesFor(item.id, null, 1, craftingTable);
        log("info", `bot.recipesFor returned ${craftableRecipes.length} craftable recipes for ${itemName} (with table: ${!!craftingTable})`);

        if (craftableRecipes.length === 0) {
          const inventory = bot.inventory.items().map(i => `${i.name}(x${i.count})`).join(', ');
          return createResponse(
            `Cannot craft ${itemName}: missing required materials. ` +
            `Inventory: ${inventory}`
          );
        }

        const recipe = craftableRecipes[0];
        await bot.craft(recipe, count, craftingTable || undefined);
        return createResponse(`Successfully crafted ${count}x ${itemName}`);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    })
  );
}

// ========== Smelting Tools ==========

export function registerSmeltingTools(server: McpServer, bot: Bot) {
  server.tool(
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
    async ({ itemName, fuelName, count = 1 }): Promise<McpResponse> => {
      try {
        const mcData = minecraftData(bot.version);
        const itemsByName = mcData.itemsByName;

        // Validate input item exists
        const inputItem = itemsByName[itemName];
        if (!inputItem) {
          return createResponse(
            `Unknown item: ${itemName}. Make sure to use the exact item name (e.g., 'raw_iron', 'sand')`
          );
        }

        // Check if bot has the input item
        const botInputItem = bot.inventory.items().find(i => i.name === itemName);
        if (!botInputItem || botInputItem.count < count) {
          return createResponse(
            `Not enough ${itemName} in inventory. Have: ${botInputItem?.count || 0}, Need: ${count}`
          );
        }

        // Find a furnace
        const furnace = bot.findBlock({
          matching: mcData.blocksByName.furnace?.id,
          maxDistance: 32,
        });

        if (!furnace) {
          return createResponse(
            `No furnace found within 32 blocks. Place a furnace nearby.`
          );
        }

        log("info", `Found furnace at ${furnace.position}`);

        // Move to furnace if needed
        if (!bot.canSeeBlock(furnace)) {
          return createResponse(
            `Furnace found at (${furnace.position.x}, ${furnace.position.y}, ${furnace.position.z}) but it's not visible. Move closer manually using move-in-direction tool.`
          );
        }

        // Open the furnace
        const furnaceBlock = await bot.openFurnace(furnace);

        // Find fuel
        let fuel = null;
        if (fuelName) {
          fuel = bot.inventory.items().find(i => i.name === fuelName);
          if (!fuel) {
            furnaceBlock.close();
            return createResponse(
              `Specified fuel '${fuelName}' not found in inventory`
            );
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
          return createResponse(
            `No fuel found in inventory. Need coal, charcoal, planks, or sticks.`
          );
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
          return createResponse(`Successfully smelted ${count}x ${itemName} using ${fuel.name} as fuel`);
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

          return createResponse(errorMsg);
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}


export function registerPositionTools(server: McpServer, bot: Bot) {
  server.tool(
    "get-position",
    "Get the current position of the bot",
    {},
    async (): Promise<McpResponse> => {
      try {
        const { botFeetPosition, botHeadPosition, blockUnderBotFeet } = getBotPosition(bot);

        return createResponse(
          `Bot feet position: (${botFeetPosition.x}, ${botFeetPosition.y}, ${botFeetPosition.z})\n` +
          `Bot head position: (${botHeadPosition.x}, ${botHeadPosition.y}, ${botHeadPosition.z})\n` +
          `Block under bot feet: ${blockUnderBotFeet?.name || 'null'}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }): Promise<McpResponse> => {
      try {
        await bot.lookAt(new Vec3(x, y, z), true);

        return createResponse(`Looking at position (${x}, ${y}, ${z})`);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "jump-in-place",
    "Make the bot jump",
    {},
    async (): Promise<McpResponse> => {
      try {
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 250);

        return createResponse("Jumped in place");
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-horizontally",
    "Move the bot toward a target block that is more or less the same height (Y) as the bot. Doesn't dig down (for a low Y target), doesn't build up (for a high Y target), so bad for those",
    {
      targetX: z.number().describe("Target X coordinate"),
      targetY: z.number().describe("Target Y coordinate"),
      targetZ: z.number().describe("Target Z coordinate"),
    },
    async ({
      targetX,
      targetY,
      targetZ,
    }): Promise<McpResponse> => {
      const target = new Vec3(targetX, targetY, targetZ);
      const startPos = bot.entity.position.clone();
      const initialDistance = startPos.distanceTo(target);

      // Try to move toward target with obstacle handling
      const MAX_ATTEMPTS = 20;
      let attempts = 0;
      let previousDistance = initialDistance;

      while (attempts < MAX_ATTEMPTS) {
        // Look toward the target
        const currentPos = bot.entity.position;
        const direction = getNextXZAlignedDirection(bot, target);
        const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);
        await bot.lookAt(lookTarget, false);

        const currentDistance = currentPos.distanceTo(target);

        // Check if we overshot the target (moved 0.5+ blocks further away)
        if (currentDistance > previousDistance + 0.1) {
          const distanceTraveled = initialDistance - currentDistance;
          return createResponse(
            `Stopped: overshot target. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
            `Distance to target: ${currentDistance.toFixed(1)} blocks.${getOptionalNewsFyi(bot)}`
          );
        }
        previousDistance = currentDistance;
        const horizontalDistance = Math.sqrt(
          Math.pow(currentPos.x - target.x, 2) + Math.pow(currentPos.z - target.z, 2)
        );

        // Check if we've reached the target (within 1.5 blocks horizontally)
        if (horizontalDistance <= 1.5) {
          const distanceTraveled = initialDistance - currentDistance;
          return createResponse(
            `Done traveling horizontally. Traveled ${distanceTraveled.toFixed(1)} blocks in ${attempts} steps. ` +
            `Final distance to target: ${currentDistance.toFixed(1)} blocks. Final horizontal distance (ignoring Y): ${horizontalDistance}. To go up/down (Y), use another tool.${getOptionalNewsFyi(bot)}`
          );
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

        return createResponse(
          `Stuck after ${attempts} steps. ` +
          `Traveled: ${distanceTraveled.toFixed(1)} blocks. ` +
          `Remaining: ${distanceRemaining.toFixed(1)} blocks. ` +
          `Block ahead of bot's head: ${headInfo}, ahead of bot's feet: ${feetInfo}. ` +
          `Tried jumping and got: ${jumpResult.error}`
        );
      }

      // Reached MAX_ATTEMPTS
      const endPos = bot.entity.position;
      const distanceTraveled = startPos.distanceTo(endPos);
      const distanceRemaining = endPos.distanceTo(target);

      return createResponse(
        `Made progress (${distanceTraveled.toFixed(1)} blocks), call again to continue.` +
        `Remaining: ${distanceRemaining.toFixed(1)} blocks${getOptionalNewsFyi(bot)}`
      );
    }
  );

  server.tool(
    "move-up-by-pillaring",
    "Build a pillar by jumping and placing blocks below. Good for trying to go way up.",
    {
      height: z.number().describe("Number of blocks to pillar up"),
      allowMiningOf: z
        .record(z.array(z.string()))
        .optional()
        .describe("Optional tool-to-blocks mapping for auto-mining blocks above: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
    },
    async ({ height, allowMiningOf = {} }): Promise<McpResponse> => {
      try {
        // Check if bot has a placeable block equipped
        const heldItem = bot.heldItem;
        if (!heldItem) {
          return createResponse(
            "No item equipped. Please equip a block (e.g., cobblestone, dirt) in hand before pillaring up."
          );
        }

        const mcData = minecraftData(bot.version);

        // Check if the held item corresponds to a placeable block
        // Look up by name since item IDs and block IDs are different
        const blockData = mcData.blocksByName[heldItem.name];
        if (!blockData) {
          return createResponse(
            `Cannot pillar with ${heldItem.name}. Please equip a placeable block (e.g., cobblestone, dirt) in hand.`
          );
        }

        const buildingBlockName = heldItem.name;
        const startY = bot.entity.position.y.toFixed(1);
        let blocksPlaced = 0;
        let totalBlocksCleared = 0;

        for (let i = 0; i < height; i++) {
          // Before each pillar iteration, clear blocks within reachable range (Y+2, Y+3, Y+4)
          const currentPos = bot.entity.position;
          const blocksToCheck = [2, 3, 4]; // Y+2, Y+3, Y+4 (bot can reach ~3 blocks above head)

          for (const yOffset of blocksToCheck) {
            const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
            if (blockAbove && blockAbove.name !== 'air') {
              // Try to mine this block using tryMiningOneBlock
              const mineResult = await tryMiningOneBlock(bot, blockAbove, allowMiningOf, 3);
              if (!mineResult.success) {
                return createResponse(
                  `Failed to pillar up: blocked at Y+${yOffset} by ${blockAbove.name} after ${blocksPlaced} blocks placed. ${mineResult.error}`
                );
              }
              totalBlocksCleared++;
            }
          }

          // Re-equip the building block (in case we switched to a tool for mining)
          const buildingBlock = bot.inventory.items().find(item => item.name === buildingBlockName);
          if (!buildingBlock) {
            return createResponse(
              `Failed to pillar up: lost ${buildingBlockName} from inventory after ${blocksPlaced} blocks placed`
            );
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
              return createResponse(
                `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
                `Ran out of blocks to place.`
              );
            }

            // Check the 3 blocks above the player to see what's blocking
            // Player occupies 2 blocks (Y+0 feet, Y+1 head), so check Y+2, Y+3, Y+4
            const currentPos = bot.entity.position;
            const blocksAbove: string[] = [];
            for (let yOffset = 2; yOffset <= 4; yOffset++) {
              const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
              if (blockAbove) {
                blocksAbove.push(`Y+${yOffset}: ${blockAbove.name}`);
              }
            }

            const equippedInfo = currentItem ? `${currentItem.name} (x${currentItem.count})` : 'nothing';

            return createResponse(
              `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
              `Equipped: ${equippedInfo}. Blocks above: ${blocksAbove.join(', ')}`
            );
          }
        }

        const finalY = bot.entity.position.y.toFixed(1);
        const clearMessage = totalBlocksCleared > 0 ? ` (cleared ${totalBlocksCleared} blocks above)` : '';
        return createResponse(
          `Pillared up ${blocksPlaced} blocks (from Y=${startY} to Y=${finalY})${clearMessage}${getOptionalNewsFyi(bot)}`
        );
      } catch (error) {
        bot.setControlState("jump", false);
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "center-in-block",
    "Center the bot in both X and Z axes within the current block",
    {},
    async (): Promise<McpResponse> => {
      try {
        const posBefore = bot.entity.position.clone();
        await strafeToMiddleBothXZ(bot);
        const posAfter = bot.entity.position.clone();

        return createResponse(
          `Centered bot: (${posBefore.x.toFixed(2)}, ${posBefore.z.toFixed(2)}) → (${posAfter.x.toFixed(2)}, ${posAfter.z.toFixed(2)})${getOptionalNewsFyi(bot)}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-forwards-by-mining",
    "Mines blocks ahead and walks forward, repeating for the specified number of blocks to make progress underground",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
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
    async ({ targetX, targetY, targetZ, allowMiningOf, numBlocksForwards = 1, digTimeout = 3 }): Promise<McpResponse> => {
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
            return createResponse(
              `Mined ${totalBlocksMined} block(s) and traveled ${distTraveled.toFixed(1)} blocks before encountering error: ${result.error}`
            );
          }

          totalBlocksMined += result.blocksMined;

          // Walk forward
          await walkForwardsAtLeastOneBlockXZAligned(bot, direction);
        }

        const distTraveled = startPos.distanceTo(bot.entity.position);
        return createResponse(
          `Successfully mined ${totalBlocksMined} block(s) and traveled ${distTraveled.toFixed(1)} blocks forward${getOptionalNewsFyi(bot)}`
        );
      } catch (error) {
        const distTraveled = startPos.distanceTo(bot.entity.position);
        const errorMsg = `${formatError(error)}. Progress: mined ${totalBlocksMined} block(s), traveled ${distTraveled.toFixed(1)} blocks`;
        return createErrorResponse(errorMsg);
      }
    }
  );

  server.tool(
    "jump-over-obstacle",
    "Jump over a small obstacle ahead of the bot in the direction toward target. Good for obstacles of height 1 (blocking the bot's feet but not head)",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
    },
    async ({ targetX, targetY, targetZ }): Promise<McpResponse> => {
      try {
        const target = new Vec3(targetX, targetY, targetZ);
        const currentPos = bot.entity.position;
        const direction = getNextXZAlignedDirection(bot, target);

        const result = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target);

        if (result.success) {
          return createResponse(`Successfully jumped over obstacle${getOptionalNewsFyi(bot)}`);
        } else {
          return createResponse(result.error || "Failed to jump over obstacle");
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-horizontally-and-down-using-steps",
    "Mine down multiple steps. Good for going vertically and down at the same time wile mining.",
    {
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
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
    async ({ allowMiningOf, stepsToGoDown, nextStepPos, digTimeout = 3 }): Promise<McpResponse> => {
      try {
        const nextStepVec = new Vec3(nextStepPos.x, nextStepPos.y, nextStepPos.z);
        const result = await mineStepsDown(bot, stepsToGoDown, nextStepVec, allowMiningOf, digTimeout);

        if (result.error) {
          return createResponse(
            `Completed ${result.stepsCompleted} of ${stepsToGoDown} steps before encountering error: ${result.error}`
          );
        } else {
          const finalPos = bot.entity.position;
          return createResponse(
            `Successfully mined down ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}${getOptionalNewsFyi(bot)}`
          );
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
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
    async ({ allowMiningOf, stepsToGoUp, nextStepPos, digTimeout = 3 }): Promise<McpResponse> => {
      try {
        const nextStepVec = new Vec3(nextStepPos.x, nextStepPos.y, nextStepPos.z);
        const result = await mineStepsUp(bot, stepsToGoUp, nextStepVec, allowMiningOf, digTimeout);

        if (result.error) {
          return createResponse(
            `Completed ${result.stepsCompleted} of ${stepsToGoUp} steps before encountering error: ${result.error}`
          );
        } else {
          const finalPos = bot.entity.position;
          return createResponse(
            `Successfully mined up ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}${getOptionalNewsFyi(bot)}`
          );
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  // server.tool(
  //   "deprecated-pathfind-and-move-or-dig-to",
  //   "Move to a target position with auto-mining and optional pillar-up.",
  //   {
  //     x: z.number().describe("Target X coordinate"),
  //     y: z.number().describe("Target Y coordinate"),
  //     z: z.number().describe("Target Z coordinate"),
  //     allowPillarUpWith: z
  //       .array(z.string())
  //       .optional()
  //       .describe("Allow using these blocks to use for pillaring up (e.g., ['cobblestone', 'dirt']). Only used if target is above."),
  //     allowMiningOf: z
  //       .record(z.string(), z.array(z.string()))
  //       .optional()
  //       .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
  //     allowDigDown: z
  //       .boolean()
  //       .optional()
  //       .default(true)
  //       .describe("Allow digging down when stuck (ensures there's solid ground 2 blocks below before digging)"),
  //     maxIterations: z
  //       .number()
  //       .optional()
  //       .default(10)
  //       .describe("Maximum number of movement iterations"),
  //   },
  //   async ({ x, y, z, allowPillarUpWith = [], allowMiningOf = {}, allowDigDown = true, maxIterations = 10 }): Promise<McpResponse> => {
  //     const startPos = bot.entity.position.clone();
  //     const startTime = Date.now();
  //     const target = new Vec3(x, y, z);
  //     const DIG_TIMEOUT_SECONDS = 3;

  //     try {
  //       let totalBlocksMined = 0;
  //       let totalPillaredBlocks = 0;
  //       const visitedPositions = new Set<string>();
  //       const stepLog: string[] = [];

  //       for (let iteration = 0; iteration < maxIterations; iteration++) {
  //         // Check if we've reached the target
  //         const arrivalCheck = didArriveAtTarget(bot, target);
  //         if (arrivalCheck.arrived) {
  //           const totalDist = startPos.distanceTo(bot.entity.position);
  //           const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  //           return createResponse(
  //             `Reached target (${x}, ${y}, ${z}) from ${formatBotPosition(startPos)}. ` +
  //             `Traveled ${totalDist.toFixed(1)} blocks in ${timeElapsed}s. Mined ${totalBlocksMined} blocks.\n` +
  //             `Steps: ${stepLog.join('; ')}`
  //           );
  //         }

  //         const posBeforeStep = bot.entity.position.clone();
  //         const stepResult = await moveOneStep(
  //           bot, target,
  //           allowPillarUpWith, allowMiningOf, DIG_TIMEOUT_SECONDS, allowDigDown
  //         );
  //         const posAfterStep = bot.entity.position.clone();

  //         // Log what happened in this step
  //         const stepDesc = [];
  //         if (stepResult.blocksMined > 0) stepDesc.push(`mined ${stepResult.blocksMined}`);
  //         if (stepResult.pillaredUpBlocks > 0) stepDesc.push(`pillared ${stepResult.pillaredUpBlocks}`);
  //         if (stepResult.movedBlocksCloser !== 0) stepDesc.push(`moved ${stepResult.movedBlocksCloser.toFixed(1)}b`);
  //         if (stepResult.error) stepDesc.push(stepResult.error);
  //         stepLog.push(`[${iteration+1}] ${formatBotPosition(posAfterStep)}: ${stepDesc.join(', ') || 'no action'}`);

  //         totalBlocksMined += stepResult.blocksMined;
  //         totalPillaredBlocks += stepResult.pillaredUpBlocks;

  //         // Check for circular movement
  //         const currentPos = bot.entity.position;
  //         const posKey = `${Math.floor(currentPos.x)},${Math.floor(currentPos.y)},${Math.floor(currentPos.z)}`;
  //         if (visitedPositions.has(posKey)) {
  //           const distRemaining = currentPos.distanceTo(target);
  //           const distTraveled = startPos.distanceTo(currentPos);
  //           return createResponse(
  //             `Detected circular movement: returned to position ${formatBotPosition(currentPos)} after ${iteration + 1} iteration(s). ` +
  //             `Traveled ${distTraveled.toFixed(1)} blocks, mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ` +
  //             `${distRemaining.toFixed(1)} blocks remaining to target.\n` +
  //             `Steps: ${stepLog.join('; ')}\n` +
  //             `Perhaps the pathfinder isn't working well for this situation (is it a reproducible bug?) and you should try a lower level tool.`
  //           );
  //         }
  //         visitedPositions.add(posKey);

  //         // Check if we made progress this iteration
  //         const madeProgress = stepResult.blocksMined > 0 ||
  //                             stepResult.movedBlocksCloser != 0 || // We might temporarily get further away, but at least we don't stay in place
  //                             stepResult.pillaredUpBlocks > 0;

  //         if (!madeProgress && iteration > 0) {
  //           const distRemaining = bot.entity.position.distanceTo(target);
  //           const distTraveled = startPos.distanceTo(bot.entity.position);

  //           return createResponse(
  //             `${stepResult.error || "Stuck at this iteration with no info from moveOneStep (probably a bug: info should normally be available)"}. ` +
  //             `Progress after ${iteration} iteration(s): traveled ${distTraveled.toFixed(1)} blocks, ` +
  //             `mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ` +
  //             `${distRemaining.toFixed(1)} blocks remaining to target.\n` +
  //             `Steps: ${stepLog.join('; ')}`
  //           );
  //         }
  //       }

  //       // Max iterations reached - calculate progress stats (reusing same calculation as above)
  //       const distRemaining = bot.entity.position.distanceTo(target);
  //       const distTraveled = startPos.distanceTo(bot.entity.position);
  //       return createResponse(
  //         `Reached iteration limit (${maxIterations} iterations). Made progress: traveled ${distTraveled.toFixed(1)} blocks, ` +
  //         `mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ${distRemaining.toFixed(1)} blocks remaining to target. ` +
  //         `Call move-to again to continue.\n` +
  //         `Steps: ${stepLog.join('; ')}`
  //       );

  //     } catch (error) {
  //       return createErrorResponse(error as Error);
  //     } finally {
  //       // Always clean up control states
  //       bot.setControlState('forward', false);
  //       bot.setControlState('jump', false);
  //     }
  //   }
  // );
}

// ========== Inventory Management Tools ==========

export function registerInventoryTools(server: McpServer, bot: Bot) {
  server.tool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async (): Promise<McpResponse> => {
      try {
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
          return createResponse("Inventory is empty");
        }

        let inventoryText = `Found ${items.length} items in inventory:\n\n`;
        itemList.forEach((item) => {
          let itemText = `- ${item.name} (x${item.count}) in slot ${item.slot}`;
          if (item.durability) {
            itemText += ` [durability: ${item.durability.remaining}/${item.durability.max}]`;
          }
          inventoryText += itemText + '\n';
        });

        return createResponse(inventoryText);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find"),
    },
    async ({ nameOrType }): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const item = items.find((item) =>
          item.name.includes(nameOrType.toLowerCase())
        );

        if (item) {
          return createResponse(
            `Found ${item.count} ${item.name} in inventory (slot ${item.slot})`
          );
        } else {
          return createResponse(
            `Couldn't find any item matching '${nameOrType}' in inventory`
          );
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z
        .string()
        .optional()
        .describe("Where to equip the item (default: 'hand')"),
    },
    async ({ itemName, destination = "hand" }): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const item = items.find(
          (item) => item.name === itemName.toLowerCase()
        );

        if (!item) {
          return createResponse(
            `Couldn't find any item matching '${itemName}' in inventory`
          );
        }

        await bot.equip(item, destination as mineflayer.EquipmentDestination);
        return createResponse(`Equipped ${item.name} to ${destination}`);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
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
}

const botStateMap = new WeakMap<Bot, BotState>();

function getBotState(bot: Bot): BotState {
  let state = botStateMap.get(bot);
  if (!state) {
    state = {};
    botStateMap.set(bot, state);
  }
  return state;
}

export function getOptionalNewsFyi(bot: Bot): string {
  const state = getBotState(bot);
  const updates: string[] = [];

  const currentOxygen = bot.oxygenLevel;
  if (state.lastOxygen !== undefined && currentOxygen < state.lastOxygen) {
    updates.push(`Oxygen ${currentOxygen}/20`);
  }
  state.lastOxygen = currentOxygen;

  const currentHealth = bot.health;
  if (state.lastHealth !== undefined && currentHealth < state.lastHealth) {
    updates.push(`Health ${currentHealth.toFixed(1)}/20`);
  }
  state.lastHealth = currentHealth;

  const durability = getEquippedItemDurability(bot);
  if (durability) {
    if (state.lastDurability !== undefined && durability.remaining < state.lastDurability) {
      updates.push(`Equipped item durability ${durability.remaining}/${durability.max}`);
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
    const inventoryChanges: string[] = [];

    // Check for added or increased items
    for (const [itemName, currentCount] of currentInventory) {
      const previousCount = state.lastInventory.get(itemName) || 0;
      const diff = currentCount - previousCount;
      if (diff > 0) {
        inventoryChanges.push(`+${diff}x ${itemName}`);
      }
    }

    if (inventoryChanges.length > 0) {
      updates.push(`Inventory: ${inventoryChanges.join(', ')}`);
    }
  }
  state.lastInventory = currentInventory;

  if (updates.length === 0) {
    return '';
  }

  const updateStr = updates.join(', ');
  logBotState(updateStr);
  return ` (updates: ${updateStr})`;
}

export function registerBlockTools(server: McpServer, bot: Bot) {
  server.tool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }): Promise<McpResponse> => {
      try {
        const placePos = new Vec3(x, y, z);
        const blockAtPos = bot.blockAt(placePos);
        if (blockAtPos && blockAtPos.name !== "air") {
          return createResponse(
            `There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`
          );
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
          if (refBlock && refBlock.name !== "air" /* && bot.canSeeBlock(refBlock) */) {
            try {
              await bot.lookAt(placePos, true);
              await bot.placeBlock(refBlock, face.vec.scaled(-1));
              return createResponse(`Placed block at (${x}, ${y}, ${z}) using ${face.name} face`);
            } catch {
              // Try next face
              continue;
            }
          }
        }

        const dist = bot.entity.position.distanceTo(placePos);
        return createResponse(
          `Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found` +
          (dist < 1.5 ? `. Distance: ${dist.toFixed(2)} blocks - too close, move away` : '')
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "dig-adjacent-block",
    "Dig one block",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
      timeoutSeconds: z
        .union([z.number(), z.string().transform(val => parseFloat(val))])
        .optional()
        .describe("Timeout for digging in seconds (default: 3). Use longer timeout (e.g. 10) for hard blocks like iron ore with stone pickaxe"),
      allowedMiningToolsToMinedBlocks: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Optional tool-to-blocks mapping for auto-equipping tools: {wooden_pickaxe: ['dirt'], diamond_pickaxe: ['stone', 'iron_ore']}. If not provided, will use currently equipped tool."),
    },
    async ({ x, y, z, timeoutSeconds, allowedMiningToolsToMinedBlocks = {} }): Promise<McpResponse> => {
      const digTimeout = timeoutSeconds ?? 3;
      try {
        const blockPos = new Vec3(x, y, z);
        const block = bot.blockAt(blockPos);

        if (!block || block.name === "air") {
          return createResponse(
            `No block found at position (${x}, ${y}, ${z})`
          );
        }

        // Use tryMiningOneBlock if tools mapping provided, otherwise use current tool
        const result = await tryMiningOneBlock(bot, block, allowedMiningToolsToMinedBlocks, digTimeout, true);

        if (!result.success) {
          return createResponse(result.error || "Failed to mine block");
        }

        let response = `Dug ${block.name} at (${x}, ${y}, ${z}). To pick up block, you might have to walk to it (or maybe there's a block in the way)`;
        // Add light level warning if it's dark
        const lightInfo = getLightLevel(block);
        if (lightInfo && lightInfo.totalLight < 8) {
          response += ` (fyi: effective light was ${lightInfo.totalLight}/15)`;
        }
        response += getOptionalNewsFyi(bot);

        return createResponse(response);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
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
    async ({ blocksToDigDown = 1, allowMiningOf, digTimeout = 3 }): Promise<McpResponse> => {
      try {
        const startPos = bot.entity.position.clone();
        const result = await digDirectlyDownIfPossible(bot, blocksToDigDown, allowMiningOf, digTimeout);

        if (result.success) {
          const endPos = bot.entity.position;
          const verticalDist = startPos.y - endPos.y;
          return createResponse(
            `Successfully dug down ${result.blocksMined} block(s). ` +
            `Descended ${verticalDist.toFixed(1)} blocks. ` +
            `Now at position ${formatBotPosition(endPos)}`
          );
        } else {
          return createResponse(result.error || `Unknown error while digging down. Dug down ${result.blocksMined} blocks`);
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }): Promise<McpResponse> => {
      try {
        const blockPos = new Vec3(x, y, z);
        const block = bot.blockAt(blockPos);

        if (!block) {
          return createResponse(
            `No block information found at position (${x}, ${y}, ${z})`
          );
        }

        const lightInfo = getBlockLightLevelFormatted(block);

        return createResponse(
          `Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z}), ${lightInfo}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "get-blocks-info",
    "Get information about multiple blocks at specified positions",
    {
      positions: z.array(z.object({
        x: z.number(),
        y: z.number(),
        z: z.number()
      })).describe("Array of positions to check, e.g., [{x: 1, y: 2, z: 3}, {x: 4, y: 5, z: 6}]"),
    },
    async ({ positions }): Promise<McpResponse> => {
      try {
        let result = `Block information for ${positions.length} position(s):\n\n`;

        for (const pos of positions) {
          const blockPos = new Vec3(pos.x, pos.y, pos.z);
          const block = bot.blockAt(blockPos);

          if (!block) {
            result += `(${pos.x}, ${pos.y}, ${pos.z}): No block information found\n`;
          } else {
            const lightInfo = getBlockLightLevelFormatted(block);
            result += `(${pos.x}, ${pos.y}, ${pos.z}): ${block.name}, ${lightInfo}\n`;
          }
        }

        return createResponse(result.trim());
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
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
    }): Promise<McpResponse> => {
      try {
        const mcData = minecraftData(bot.version);
        const blocksByName = mcData.blocksByName;

        if (!blocksByName[blockType]) {
          return createResponse(`Unknown block type: ${blockType}`);
        }

        const blockId = blocksByName[blockType].id;

        const positions = bot.findBlocks({
          matching: blockId,
          maxDistance: maxDistance,
          count: maxResults,
        });

        if (positions.length === 0) {
          return createResponse(
            `No ${blockType} found within ${maxDistance} blocks`
          );
        }

        const positionStrings = positions.map(
          (pos) => `(${pos.x}, ${pos.y}, ${pos.z})`
        );

        return createResponse(
          `Found ${positions.length} ${blockType} block(s):\n${positionStrings.join("\n")}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "get-nearby-block-types",
    "Get all unique block types and entity types in the nearby area with counts and closest distance",
    {
      maxDistanceSideways: z
        .number()
        .optional()
        .describe("Maximum horizontal search distance (default: 16)"),
      maxDistanceUpDown: z
        .number()
        .optional()
        .describe("Maximum vertical search distance (default: 8)"),
      maxBlockTypes: z
        .number()
        .optional()
        .describe("Limit on number of unique block types to return (default: 20)"),
    },
    async ({ maxDistanceSideways = 16, maxDistanceUpDown = 8, maxBlockTypes = 20 }): Promise<McpResponse> => {
      try {
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
          return createResponse(
            `No interesting blocks or entities found within ${maxDistanceSideways} blocks horizontally and ${maxDistanceUpDown} blocks vertically.`
          );
        }

        let output = `Found ${limitedItems.length} nearby items (of ${allItems.length} total):\n\n`;
        output += `Entity/Block;Name;Count;Closest_Distance;Closest_location(x,y,z)\n`;

        limitedItems.forEach((item) => {
          const pos = item.position;
          const typeMarker = item.category === 'entity' ? 'E' : 'B';
          output += `${typeMarker};${item.type};${item.count};${item.distance.toFixed(1)};(${pos.x},${pos.y},${pos.z})\n`;
        });

        output += `\nIf you wanted the blocks adjacent to the bot (e.g if stuck), use show-adjacent-blocks instead. To reach one of these blocks, consider pathfind-and-move-to`

        return createResponse(output.trim());
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Entity Interaction Tools ==========

export function registerEntityTools(server: McpServer, bot: Bot) {
  server.tool(
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
    async ({ type = "", maxDistance = 16 }): Promise<McpResponse> => {
      try {
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
          return createResponse(
            `No ${type || "entity"} found within ${maxDistance} blocks`
          );
        }

        return createResponse(
          `Found ${
            entity.name || (entity as any).username || entity.type
          } at position ${formatBotPosition(entity.position)}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
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
    async ({ type = "", maxDistance = 4 }): Promise<McpResponse> => {
      try {
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
          return createResponse(
            `No ${type || "entity"} found within ${maxDistance} blocks to attack`
          );
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
            return createResponse(
              `${entityName} moved too far away after ${attackCount} attacks. Try moving closer.`
            );
          }
        }

        if (attackCount >= maxAttacks) {
          return createResponse(
            `Attacked ${entityName} ${attackCount} times but it's still alive. It may be too strong or invulnerable.`
          );
        }

        return createResponse(
          `Successfully killed ${entityName} with ${attackCount} attacks at position ${formatBotPosition(initialPos)}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Chat Tools ==========

export function registerChatTools(server: McpServer, bot: Bot) {
  server.tool(
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().describe("Message to send in chat"),
    },
    async ({ message }): Promise<McpResponse> => {
      try {
        bot.chat(message);
        return createResponse(`Sent message: "${message}"`);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "read-chat",
    "Get recent chat messages from players",
    {
      count: z
        .number()
        .optional()
        .describe(
          "Number of recent messages to retrieve (default: 10, max: 100)"
        ),
    },
    async ({ count = 10 }): Promise<McpResponse> => {
      try {
        const maxCount = Math.min(count, MAX_STORED_MESSAGES);
        const messages = messageStore.getRecentMessages(maxCount);

        if (messages.length === 0) {
          return createResponse("No chat messages found");
        }

        let output = `Found ${messages.length} chat message(s):\n\n`;
        messages.forEach((msg, index) => {
          const timestamp = new Date(msg.timestamp).toISOString();
          output += `${index + 1}. ${timestamp} - ${msg.username}: ${
            msg.content
          }\n`;
        });

        return createResponse(output);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Game State Tools ============

export function registerGameStateTools(server: McpServer, bot: Bot) {
  server.tool(
    "detect-gamemode",
    "Detect the gamemode on game",
    {},
    async (): Promise<McpResponse> => {
      try {
        return createResponse(`Bot gamemode: "${bot.game.gameMode}"`);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "get-status",
    "Get the bot's health, food, and other status information",
    {},
    async (): Promise<McpResponse> => {
      try {
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

        return createResponse(status);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "show-adjacent-blocks",
    "Show all blocks directly adjacent to the bot in all horizontal directions and at all height levels (above head, head height, feet height, below feet). The bot is 2 blocks tall.",
    {},
    async (): Promise<McpResponse> => {
      try {
        const result = getAdjacentBlocks(bot);
        return createResponse(result);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
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
