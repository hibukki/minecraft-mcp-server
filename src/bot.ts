#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, Movements, goals } = pathfinderPkg;
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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
}

interface FaceOption {
  direction: string;
  vector: Vec3;
}

type Direction = "forward" | "back" | "left" | "right";
type FaceDirection = "up" | "down" | "north" | "south" | "east" | "west";

interface StoredMessage {
  timestamp: number;
  username: string;
  content: string;
}

// ========== Command Line Argument Parsing ==========

function parseCommandLineArgs() {
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

// ========== Logging and Responding ==========

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, message: string) {
  const timestamp = new Date().toISOString();
  process.stderr.write(`${timestamp} [minecraft] [${level}] ${message}\n`);
}

function createResponse(text: string): McpResponse {
  return {
    content: [{ type: "text", text }],
  };
}

function createErrorResponse(error: Error | string): McpResponse {
  const errorMessage = formatError(error);
  log("error", errorMessage);
  return {
    content: [{ type: "text", text: `Failed: ${errorMessage}` }],
    isError: true,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

// ========== Progress Monitoring Helpers ==========

/**
 * Wraps pathfinding with progress monitoring
 * Fails fast if bot gets stuck
 */
async function gotoAndVerifyProgress(
  bot: mineflayer.Bot,
  goal: any,
  options: {
    checkIntervalSeconds?: number;
    minBlocksPerCheck?: number;
    graceChecks?: number;
    timeoutSeconds?: number;
  } = {}
): Promise<void> {
  const {
    checkIntervalSeconds = 1,
    minBlocksPerCheck = 1,
    graceChecks = 1,
    timeoutSeconds = 10,
  } = options;

  const startPos = bot.entity.position.clone();
  const startTime = Date.now();
  let lastCheckPos = startPos.clone();
  let checksCount = 0;
  let stuckError: Error | null = null;

  const pathfinderPromise = bot.pathfinder.goto(goal);

  const progressCheck = setInterval(() => {
    checksCount++;

    // Grace period
    if (checksCount <= graceChecks) {
      lastCheckPos = bot.entity.position.clone();
      return;
    }

    const currentPos = bot.entity.position;
    const movedSinceLastCheck = lastCheckPos.distanceTo(currentPos);
    const elapsedSeconds = (Date.now() - startTime) / 1000;

    // Check timeout
    if (elapsedSeconds > timeoutSeconds) {
      const totalMoved = startPos.distanceTo(currentPos);
      clearInterval(progressCheck);
      bot.pathfinder.stop();
      stuckError = new Error(
        `Pathfinding timeout after ${timeoutSeconds}s. ` +
        `Moved ${totalMoved.toFixed(1)} blocks total. ` +
        `Current position: (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)}). ` +
        `Progress made - consider calling again if making progress.`
      );
      return;
    }

    // Check if stuck
    if (movedSinceLastCheck < minBlocksPerCheck) {
      const totalMoved = startPos.distanceTo(currentPos);
      clearInterval(progressCheck);
      bot.pathfinder.stop();
      stuckError = new Error(
        `Pathfinding stuck: moved ${movedSinceLastCheck.toFixed(1)} blocks in last ${checkIntervalSeconds}s. ` +
        `Total progress: ${totalMoved.toFixed(1)} blocks. ` +
        `Current position: (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)})`
      );
    }

    lastCheckPos = currentPos.clone();
  }, checkIntervalSeconds * 1000);

  try {
    await pathfinderPromise;
    clearInterval(progressCheck);
    if (stuckError) throw stuckError;
  } catch (error) {
    clearInterval(progressCheck);
    if (stuckError) throw stuckError;
    throw error;
  }
}

/**
 * Wraps bot.dig with progress monitoring
 * Checks every few seconds if we're still actively digging
 */
async function digWithTimeout(
  bot: mineflayer.Bot,
  block: any,
  timeoutSeconds: number = 3
): Promise<void> {
  const digPromise = bot.dig(block);
  const startTime = Date.now();
  let lastDigCheck = startTime;
  let wasDigging = false;
  let digError: Error | null = null;

  const monitorInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;

    // Check if we're currently digging
    const isDigging = bot.targetDigBlock !== null;

    // If we started digging, remember it
    if (isDigging) {
      wasDigging = true;
      lastDigCheck = now;
    }

    // If we haven't dug at all after 3 seconds, something is wrong
    if (!wasDigging && elapsed > 3) {
      clearInterval(monitorInterval);
      digError = new Error(`Dig failed to start after 3s. Bot may be stuck or block unreachable.`);
      return;
    }

    // If we're digging for more than timeoutSeconds, stop with error
    if (wasDigging && isDigging && elapsed > timeoutSeconds) {
      clearInterval(monitorInterval);
      const heldItem = bot.heldItem;
      const toolName = heldItem ? heldItem.name : "no tool";
      digError = new Error(
        `Digging is very slow (${elapsed.toFixed(1)}s). Block: ${block.name}. ` +
        `Using: ${toolName}. Wrong tool? Or maybe your character isn't reaching the block?`
      );
      return;
    }

    // If we were digging but stopped for more than 2 seconds, might be done or stuck
    if (wasDigging && !isDigging && (now - lastDigCheck) > 2000) {
      // Dig likely completed, let the promise resolve
      clearInterval(monitorInterval);
      return;
    }

    // Overall timeout
    if (elapsed > timeoutSeconds) {
      clearInterval(monitorInterval);
      const heldItem = bot.heldItem;
      const toolName = heldItem ? heldItem.name : "no tool";
      digError = new Error(
        `Dig timeout after ${timeoutSeconds}s. Block: ${block.name}. Using: ${toolName}. ` +
        `May need better tools or block is too hard.`
      );
    }
  }, 500);

  try {
    await digPromise;
    clearInterval(monitorInterval);
    if (digError) throw digError;
  } catch (error) {
    clearInterval(monitorInterval);
    if (digError) throw digError;
    throw error;
  }
}

// ========== Bot Setup ==========

function setupBot(argv: any): mineflayer.Bot {
  // Configure bot options based on command line arguments
  const botOptions = {
    host: argv.host,
    port: argv.port,
    username: argv.username,
    plugins: { pathfinder },
  };

  // Create a bot instance
  const bot = mineflayer.createBot(botOptions);

  // Set up the bot when it spawns
  bot.once("spawn", async () => {
    // Set up pathfinder movements
    const mcData = minecraftData(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    bot.chat("LLM-powered bot ready to receive instructions!");
    log(
      "info",
      `Server started and connected successfully. Bot: ${argv.username} on ${argv.host}:${argv.port}`
    );
  });

  // Register common event handlers
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    messageStore.addMessage(username, message);
  });

  bot.on("kicked", (reason) => {
    log("error", `Bot was kicked: ${formatError(reason)}`);
    bot.quit();
  });

  bot.on("error", (err) => {
    log("error", `Bot error: ${formatError(err)}`);
  });

  return bot;
}

// ========== MCP Server Configuration ==========

function createMcpServer(bot: mineflayer.Bot) {
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
  registerFlightTools(server, bot);
  registerGameStateTools(server, bot);

  return server;
}

// ========== Crafting Tools ==========

function registerCraftingTools(server: McpServer, bot: mineflayer.Bot) {
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
    async ({ itemName, count = 1, useCraftingTable }): Promise<McpResponse> => {
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
    }
  );
}

// ========== Smelting Tools ==========

function registerSmeltingTools(server: McpServer, bot: mineflayer.Bot) {
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
          const goal = new goals.GoalNear(
            furnace.position.x,
            furnace.position.y,
            furnace.position.z,
            2
          );
          await gotoAndVerifyProgress(bot, goal, { timeoutSeconds: 10 });
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

// ========== Position and Movement Tools ==========

function registerPositionTools(server: McpServer, bot: mineflayer.Bot) {
  server.tool(
    "get-position",
    "Get the current position of the bot",
    {},
    async (): Promise<McpResponse> => {
      try {
        const position = bot.entity.position;
        const pos = {
          x: Math.floor(position.x),
          y: Math.floor(position.y),
          z: Math.floor(position.z),
        };

        return createResponse(
          `Current position: (${pos.x}, ${pos.y}, ${pos.z})`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
      range: z
        .number()
        .optional()
        .describe("How close to get to the target (default: 1)"),
    },
    async ({ x, y, z, range = 1 }): Promise<McpResponse> => {
      try {
        const targetPos = new Vec3(x, y, z);
        let lastCheckPos = bot.entity.position.clone();
        let stuckError: Error | null = null;

        const goal = new goals.GoalNear(x, y, z, range);
        const pathfinderPromise = bot.pathfinder.goto(goal);

        // Check progress every second (after initial 1 second grace period)
        let checksCount = 0;
        const progressCheckInterval = setInterval(() => {
          checksCount++;
          if (checksCount === 1) {
            // Skip first check to give pathfinding time to start
            lastCheckPos = bot.entity.position.clone();
            return;
          }

          const currentPos = bot.entity.position;
          const currentDistance = currentPos.distanceTo(targetPos);
          const progressInLastSecond = lastCheckPos.distanceTo(currentPos);

          if (progressInLastSecond < 1) {
            clearInterval(progressCheckInterval);
            bot.pathfinder.stop();

            // Gather diagnostic info about surrounding blocks
            const dirX = Math.sign(x - currentPos.x);
            const dirZ = Math.sign(z - currentPos.z);
            const blocksAhead: string[] = [];
            const blocksAbove: string[] = [];

            // Check blocks at head level in direction of target (these block horizontal movement)
            for (let offset = 0; offset <= 1; offset++) {
              const checkPos = currentPos.offset(dirX * offset, 0, dirZ * offset).floor();
              const block = bot.blockAt(checkPos);
              if (block && block.name !== 'air') {
                blocksAhead.push(`${block.name} at (${checkPos.x}, ${checkPos.y}, ${checkPos.z})`);
              }
            }

            // Check blocks above head (Y+1 and Y+2)
            for (let yOffset = 1; yOffset <= 2; yOffset++) {
              const headBlock = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
              if (headBlock && headBlock.name !== 'air') {
                blocksAbove.push(`${headBlock.name} at Y+${yOffset}`);
              }
            }

            const footBlock = bot.blockAt(currentPos.offset(0, -1, 0).floor());
            const yDiff = y - Math.floor(currentPos.y);

            let errorMsg = `Movement stuck: Only moved ${progressInLastSecond.toFixed(1)} blocks in 1 second. ` +
              `Current position: (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)}), ` +
              `distance remaining: ${currentDistance.toFixed(1)} blocks.\n`;

            // Add specific diagnostics
            if (blocksAhead.length > 0) {
              errorMsg += `Blocks blocking path ahead: ${blocksAhead.join(', ')}. Consider digging or avoiding these.\n`;
            }
            if (blocksAbove.length > 0) {
              errorMsg += `Blocks above head: ${blocksAbove.join(', ')}. This prevents movement - consider digging these.\n`;
            }
            if (footBlock?.name === 'air') {
              errorMsg += `Standing over air - may be stuck on edge of hole or cliff.\n`;
            }

            // Suggest actions based on vertical difference
            if (yDiff >= 3) {
              errorMsg += `Need to go up ${yDiff} blocks. Consider using pillar-up tool.`;
            } else if (yDiff <= -3) {
              errorMsg += `Need to go down ${-yDiff} blocks. Consider digging down carefully.`;
            } else if (blocksAhead.length === 0 && blocksAbove.length === 0) {
              errorMsg += `No obvious obstacles detected. Pathfinding may be confused by terrain.`;
            }

            stuckError = new Error(errorMsg);
          }

          lastCheckPos = currentPos.clone();
        }, 1000);

        try {
          await pathfinderPromise;
          clearInterval(progressCheckInterval);

          if (stuckError) {
            throw stuckError;
          }
        } catch (error) {
          clearInterval(progressCheckInterval);
          if (stuckError) {
            throw stuckError;
          }
          throw error;
        }

        return createResponse(
          `Successfully moved to position near (${x}, ${y}, ${z})`
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
    "jump",
    "Make the bot jump",
    {},
    async (): Promise<McpResponse> => {
      try {
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 250);

        return createResponse("Successfully jumped");
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z
        .enum(["forward", "back", "left", "right"])
        .describe("Direction to move"),
      duration: z
        .number()
        .optional()
        .describe("Duration in milliseconds (default: 1000)"),
    },
    async ({
      direction,
      duration = 1000,
    }: {
      direction: Direction;
      duration?: number;
    }): Promise<McpResponse> => {
      return new Promise((resolve) => {
        try {
          bot.setControlState(direction, true);

          setTimeout(() => {
            bot.setControlState(direction, false);
            resolve(createResponse(`Moved ${direction} for ${duration}ms`));
          }, duration);
        } catch (error) {
          bot.setControlState(direction, false);
          resolve(createErrorResponse(error as Error));
        }
      });
    }
  );

  server.tool(
    "pillar-up",
    "Build a pillar by jumping and placing blocks below",
    {
      height: z.number().describe("Number of blocks to pillar up"),
    },
    async ({ height }): Promise<McpResponse> => {
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

        const startY = Math.floor(bot.entity.position.y);
        let blocksPlaced = 0;

        for (let i = 0; i < height; i++) {
          const beforeY = Math.floor(bot.entity.position.y);

          // Jump
          bot.setControlState("jump", true);
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Wait to be in the air
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Place block below
          const belowPos = bot.entity.position.offset(0, -1, 0).floor();
          const blockBelow = bot.blockAt(belowPos);

          if (blockBelow && blockBelow.name === "air") {
            try {
              const referenceBlock = bot.blockAt(belowPos.offset(0, -1, 0));
              if (referenceBlock && referenceBlock.name !== "air") {
                await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
                blocksPlaced++;
              }
            } catch (placeError) {
              log("warn", `Failed to place block: ${formatError(placeError)}`);
            }
          }

          bot.setControlState("jump", false);

          // Wait to land
          await new Promise((resolve) => setTimeout(resolve, 300));

          // Check if we actually moved up
          const afterY = Math.floor(bot.entity.position.y);
          if (afterY <= beforeY && i < height - 1) {
            // Check if we still have blocks equipped
            const currentItem = bot.heldItem;
            if (!currentItem) {
              return createResponse(
                `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
                `Ran out of blocks to place.`
              );
            }
            return createResponse(
              `Failed to pillar up: stuck at Y=${afterY} after ${blocksPlaced} blocks placed. ` +
              `There may be blocks above preventing upward movement.`
            );
          }
        }

        const finalY = Math.floor(bot.entity.position.y);
        return createResponse(
          `Pillared up ${blocksPlaced} blocks (from Y=${startY} to Y=${finalY})`
        );
      } catch (error) {
        bot.setControlState("jump", false);
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Inventory Management Tools ==========

function registerInventoryTools(server: McpServer, bot: mineflayer.Bot) {
  server.tool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async (): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const itemList: InventoryItem[] = items.map((item: any) => ({
          name: item.name,
          count: item.count,
          slot: item.slot,
        }));

        if (items.length === 0) {
          return createResponse("Inventory is empty");
        }

        let inventoryText = `Found ${items.length} items in inventory:\n\n`;
        itemList.forEach((item) => {
          inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
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
        const item = items.find((item: any) =>
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
          (item: any) => item.name === itemName.toLowerCase()
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

function registerBlockTools(server: McpServer, bot: mineflayer.Bot) {
  server.tool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
      faceDirection: z
        .enum(["up", "down", "north", "south", "east", "west"])
        .optional()
        .describe("Direction to place against (default: 'down')"),
    },
    async ({
      x,
      y,
      z,
      faceDirection = "down",
    }: {
      x: number;
      y: number;
      z: number;
      faceDirection?: FaceDirection;
    }): Promise<McpResponse> => {
      try {
        const placePos = new Vec3(x, y, z);
        const blockAtPos = bot.blockAt(placePos);
        if (blockAtPos && blockAtPos.name !== "air") {
          return createResponse(
            `There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`
          );
        }

        const possibleFaces: FaceOption[] = [
          { direction: "down", vector: new Vec3(0, -1, 0) },
          { direction: "north", vector: new Vec3(0, 0, -1) },
          { direction: "south", vector: new Vec3(0, 0, 1) },
          { direction: "east", vector: new Vec3(1, 0, 0) },
          { direction: "west", vector: new Vec3(-1, 0, 0) },
          { direction: "up", vector: new Vec3(0, 1, 0) },
        ];

        // Prioritize the requested face direction
        if (faceDirection !== "down") {
          const specificFace = possibleFaces.find(
            (face) => face.direction === faceDirection
          );
          if (specificFace) {
            possibleFaces.unshift(
              possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]
            );
          }
        }

        // Try each potential face for placing
        for (const face of possibleFaces) {
          const referencePos = placePos.plus(face.vector);
          const referenceBlock = bot.blockAt(referencePos);

          if (referenceBlock && referenceBlock.name !== "air") {
            if (!bot.canSeeBlock(referenceBlock)) {
              // Try to move closer to see the block - with timeout & progress monitoring
              const goal = new goals.GoalNear(
                referencePos.x,
                referencePos.y,
                referencePos.z,
                2
              );
              await gotoAndVerifyProgress(bot, goal, { timeoutSeconds: 10 });
            }

            await bot.lookAt(placePos, true);

            try {
              await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
              return createResponse(
                `Placed block at (${x}, ${y}, ${z}) using ${face.direction} face`
              );
            } catch (placeError) {
              log(
                "warn",
                `Failed to place using ${face.direction} face: ${formatError(
                  placeError
                )}`
              );
              continue;
            }
          }
        }

        return createResponse(
          `Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "dig-block",
    "Dig a block at the specified position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
      timeoutSeconds: z
        .union([z.number(), z.string().transform(val => parseFloat(val))])
        .optional()
        .describe("Timeout for digging in seconds (default: 3). Use longer timeout (e.g. 10) for hard blocks like iron ore with stone pickaxe"),
    },
    async ({ x, y, z, timeoutSeconds }): Promise<McpResponse> => {
      const digTimeout = timeoutSeconds ?? 3;
      try {
        const blockPos = new Vec3(x, y, z);
        const block = bot.blockAt(blockPos);

        if (!block || block.name === "air") {
          return createResponse(
            `No block found at position (${x}, ${y}, ${z})`
          );
        }

        // Remember the currently held item before pathfinding
        const heldItem = bot.heldItem;

        if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
          // Try to move closer to dig the block - with timeout & progress monitoring
          const goal = new goals.GoalNear(x, y, z, 2);
          await gotoAndVerifyProgress(bot, goal, { timeoutSeconds: 10 });

          // Re-equip the tool after pathfinding (pathfinder may change held item)
          if (heldItem) {
            await bot.equip(heldItem, "hand");
          }
        }

        // Dig with timeout (use provided timeout or default 3s)
        await digWithTimeout(bot, block, digTimeout);

        // Move to block location to pick up drops (need to be within ~1.5 blocks for auto-collection)
        try {
          const goal = new goals.GoalNear(x, y, z, 0.5);
          await gotoAndVerifyProgress(bot, goal, { timeoutSeconds: 2 });
        } catch (pickupError) {
          log("warn", `Failed to move to collect drops: ${formatError(pickupError)}`);
          // Continue anyway - drops may be collected passively
        }

        // Re-equip the tool after everything (pathfinding for drops may change held item)
        if (heldItem) {
          try {
            await bot.equip(heldItem, "hand");
          } catch (equipError) {
            log("warn", `Failed to re-equip tool: ${formatError(equipError)}`);
          }
        }

        return createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
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

        return createResponse(
          `Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`
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
            result += `(${pos.x}, ${pos.y}, ${pos.z}): ${block.name}\n`;
          }
        }

        return createResponse(result.trim());
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "find-block",
    "Find the nearest block of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z
        .number()
        .optional()
        .describe("Maximum search distance (default: 16)"),
    },
    async ({ blockType, maxDistance = 16 }): Promise<McpResponse> => {
      try {
        const mcData = minecraftData(bot.version);
        const blocksByName = mcData.blocksByName;

        if (!blocksByName[blockType]) {
          return createResponse(`Unknown block type: ${blockType}`);
        }

        const blockId = blocksByName[blockType].id;

        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance,
        });

        if (!block) {
          return createResponse(
            `No ${blockType} found within ${maxDistance} blocks`
          );
        }

        return createResponse(
          `Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Entity Interaction Tools ==========

function registerEntityTools(server: McpServer, bot: mineflayer.Bot) {
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
        const entityFilter = (entity: any) => {
          if (!type) return true;
          if (type === "player") return entity.type === "player";
          if (type === "mob") return entity.type === "mob";
          return entity.name && entity.name.includes(type.toLowerCase());
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
          } at position (${Math.floor(entity.position.x)}, ${Math.floor(
            entity.position.y
          )}, ${Math.floor(entity.position.z)})`
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
        const entityFilter = (entity: any) => {
          // Don't attack players or ourselves
          if (entity.type === "player" || entity === bot.entity) return false;
          if (!type) return true;
          return entity.name && entity.name.includes(type.toLowerCase());
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

        log("info", `Attacking ${entityName} at (${Math.floor(initialPos.x)}, ${Math.floor(initialPos.y)}, ${Math.floor(initialPos.z)})`);

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
          `Successfully killed ${entityName} with ${attackCount} attacks at position (${Math.floor(initialPos.x)}, ${Math.floor(initialPos.y)}, ${Math.floor(initialPos.z)})`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Chat Tools ==========

function registerChatTools(server: McpServer, bot: mineflayer.Bot) {
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

// ========== Flight Tools ==========

function registerFlightTools(server: McpServer, bot: mineflayer.Bot) {
  server.tool(
    "fly-to",
    "Make the bot fly to a specific position",
    {
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      z: z.number().describe("Z coordinate"),
    },
    async ({ x, y, z }): Promise<McpResponse> => {
      if (!bot.creative) {
        return createResponse("Creative mode is not available. Cannot fly.");
      }

      const controller = new AbortController();
      const FLIGHT_TIMEOUT_MS = 20000;

      const timeoutId = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, FLIGHT_TIMEOUT_MS);

      try {
        const destination = new Vec3(x, y, z);

        await createCancellableFlightOperation(bot, destination, controller);

        return createResponse(
          `Successfully flew to position (${x}, ${y}, ${z}).`
        );
      } catch (error) {
        if (controller.signal.aborted) {
          const currentPosAfterTimeout = bot.entity.position;
          return createErrorResponse(
            `Flight timed out after ${
              FLIGHT_TIMEOUT_MS / 1000
            } seconds. The destination may be unreachable. ` +
              `Current position: (${Math.floor(
                currentPosAfterTimeout.x
              )}, ${Math.floor(currentPosAfterTimeout.y)}, ${Math.floor(
                currentPosAfterTimeout.z
              )})`
          );
        }

        log("error", `Flight error: ${formatError(error)}`);
        return createErrorResponse(error as Error);
      } finally {
        clearTimeout(timeoutId);
        bot.creative.stopFlying();
      }
    }
  );
}

function createCancellableFlightOperation(
  bot: mineflayer.Bot,
  destination: Vec3,
  controller: AbortController
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let aborted = false;

    controller.signal.addEventListener("abort", () => {
      aborted = true;
      bot.creative.stopFlying();
      reject(new Error("Flight operation cancelled"));
    });

    bot.creative
      .flyTo(destination)
      .then(() => {
        if (!aborted) {
          resolve(true);
        }
      })
      .catch((err: any) => {
        if (!aborted) {
          reject(err);
        }
      });
  });
}

// ========== Game State Tools ============

function registerGameStateTools(server: McpServer, bot: mineflayer.Bot) {
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
}

// ========== Main Application ==========

async function main() {
  let bot: mineflayer.Bot | undefined;

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
