#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mineflayer from "mineflayer";
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

/**
 * Try to mine a single block using the provided tool-to-blocks mapping
 * Returns detailed error info if mining fails, and count of blocks mined
 */
async function tryMiningOneBlock(
  bot: mineflayer.Bot,
  block: any,
  allowedMiningToolsToMinedBlocks: Record<string, string[]>,
  digTimeout: number = 3
): Promise<{success: boolean, error?: string, blocksMined: number}> {
  const botPos = bot.entity.position;
  const blockPos = block.position;
  const distance = botPos.distanceTo(blockPos);

  // Find the right tool for this block
  let tool = null;
  for (const [toolName, blockNames] of Object.entries(allowedMiningToolsToMinedBlocks)) {
    if (blockNames.includes(block.name)) {
      tool = bot.inventory.items().find(item => item.name === toolName);
      if (!tool) {
        return {
          success: false,
          blocksMined: 0,
          error: `Tool ${toolName} needed to mine ${block.name} at (${Math.floor(blockPos.x)}, ${Math.floor(blockPos.y)}, ${Math.floor(blockPos.z)}) but not found in inventory`
        };
      }
      break;
    }
  }

  // If no tool configured for this block and we have a non-empty mapping, it's an error
  if (!tool && Object.keys(allowedMiningToolsToMinedBlocks).length > 0) {
    const heldItem = bot.heldItem;
    const toolInfo = heldItem ? heldItem.name : "nothing (empty hand)";
    return {
      success: false,
      blocksMined: 0,
      error: `Block ${block.name} at (${Math.floor(blockPos.x)}, ${Math.floor(blockPos.y)}, ${Math.floor(blockPos.z)}) is not in allowedMiningToolsToMinedBlocks. Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks`
    };
  }

  // Equip tool if found
  if (tool) {
    await bot.equip(tool, 'hand');
  }

  // Look at the block
  await bot.lookAt(blockPos.offset(0.5, 0.5, 0.5), true);

  // Check if we can dig it
  if (!bot.canDigBlock(block)) {
    const heldItem = bot.heldItem;
    const toolInfo = heldItem ? heldItem.name : "nothing (empty hand)";
    return {
      success: false,
      blocksMined: 0,
      error: `Cannot dig ${block.name} at (${Math.floor(blockPos.x)}, ${Math.floor(blockPos.y)}, ${Math.floor(blockPos.z)}). Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks. Block might be out of reach or require different tool`
    };
  }

  // Try to dig with timeout
  try {
    await digWithTimeout(bot, block, digTimeout);
    return {success: true, blocksMined: 1};
  } catch (digError) {
    bot.stopDigging();
    const heldItem = bot.heldItem;
    const toolInfo = heldItem ? heldItem.name : "nothing (empty hand)";
    return {
      success: false,
      blocksMined: 0,
      error: `Failed to mine ${block.name} at (${Math.floor(blockPos.x)}, ${Math.floor(blockPos.y)}, ${Math.floor(blockPos.z)}). Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks. Error: ${formatError(digError)}`
    };
  }
}

// ========== Bot Setup ==========

function setupBot(argv: any): mineflayer.Bot {
  // Configure bot options based on command line arguments
  const botOptions = {
    host: argv.host,
    port: argv.port,
    username: argv.username,
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

// ========== Position and Movement Tools ==========

// Helper functions for pillar-up movement
async function jumpAndWaitToBeInAir(bot: mineflayer.Bot): Promise<void> {
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 100)); // Initial jump delay
  await new Promise(r => setTimeout(r, 200)); // Wait to be airborne
}

async function waitToLandFromAir(bot: mineflayer.Bot): Promise<void> {
  bot.setControlState('jump', false);
  await new Promise(r => setTimeout(r, 300)); // Wait to land
}

async function pillarUpOneBlock(bot: mineflayer.Bot): Promise<boolean> {
  await jumpAndWaitToBeInAir(bot);

  const currentPos = bot.entity.position;
  const belowPos = currentPos.offset(0, -1, 0).floor();
  const blockBelow = bot.blockAt(belowPos);

  if (blockBelow && blockBelow.name === 'air') {
    const refBlock = bot.blockAt(belowPos.offset(0, -1, 0));
    if (refBlock && refBlock.name !== 'air') {
      try {
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        await waitToLandFromAir(bot);
        return true;
      } catch (placeError) {
        log('warn', `Failed to place pillar block: ${formatError(placeError)}`);
        await waitToLandFromAir(bot);
        return false;
      }
    }
  }

  await waitToLandFromAir(bot);
  return false;
}

// Helper functions for move-to horizontal movement
async function walkForwardsIfPossible(
  bot: mineflayer.Bot,
  currentPos: Vec3,
  forwardVec: Vec3
): Promise<boolean> {
  const blockAheadFeet = bot.blockAt(currentPos.offset(forwardVec.x, 0, forwardVec.z).floor());
  const blockAheadHead = bot.blockAt(currentPos.offset(forwardVec.x, 1, forwardVec.z).floor());

  const feetClear = !blockAheadFeet || blockAheadFeet.name === 'air' || blockAheadFeet.name === 'water' || blockAheadFeet.name === 'lava';
  const headClear = !blockAheadHead || blockAheadHead.name === 'air' || blockAheadHead.name === 'water' || blockAheadHead.name === 'lava';

  if (feetClear && headClear) {
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 100));
    bot.setControlState('forward', false);
    await new Promise(r => setTimeout(r, 50));
    return true;
  }

  return false;
}

async function jumpOverSmallObstacleIfPossible(
  bot: mineflayer.Bot,
  currentPos: Vec3,
  forwardVec: Vec3
): Promise<boolean> {
  const blockAheadFeet = bot.blockAt(currentPos.offset(forwardVec.x, 0, forwardVec.z).floor());
  const blockAheadHead = bot.blockAt(currentPos.offset(forwardVec.x, 1, forwardVec.z).floor());

  const feetClear = !blockAheadFeet || blockAheadFeet.name === 'air' || blockAheadFeet.name === 'water' || blockAheadFeet.name === 'lava';
  const headClear = !blockAheadHead || blockAheadHead.name === 'air' || blockAheadHead.name === 'water' || blockAheadHead.name === 'lava';

  // Check if we can jump over: feet blocked, head clear, room above
  if (!feetClear && headClear) {
    const blockAboveHead = bot.blockAt(currentPos.offset(0, 2, 0).floor());
    const aboveHeadClear = !blockAboveHead || blockAboveHead.name === 'air';

    if (aboveHeadClear) {
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 100));
      bot.setControlState('jump', false);
      bot.setControlState('forward', false);
      await new Promise(r => setTimeout(r, 50));
      return true;
    }
  }

  return false;
}

async function mineForwardsIfPossible(
  bot: mineflayer.Bot,
  currentPos: Vec3,
  forwardVec: Vec3,
  allowMiningOf: Record<string, string[]>,
  DIG_TIMEOUT_SECONDS: number
): Promise<{success: boolean, error?: string, blocksMined: number}> {
  const blockAheadHead = bot.blockAt(currentPos.offset(forwardVec.x, 1, forwardVec.z).floor());
  const blockAheadFeet = bot.blockAt(currentPos.offset(forwardVec.x, 0, forwardVec.z).floor());
  let totalBlocksMined = 0;

  // Try mining head block first
  if (blockAheadHead && blockAheadHead.name !== 'air' && blockAheadHead.name !== 'water' && blockAheadHead.name !== 'lava') {
    const result = await tryMiningOneBlock(bot, blockAheadHead, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return {...result, blocksMined: totalBlocksMined};
  }

  // Try mining feet block
  if (blockAheadFeet && blockAheadFeet.name !== 'air' && blockAheadFeet.name !== 'water' && blockAheadFeet.name !== 'lava') {
    const result = await tryMiningOneBlock(bot, blockAheadFeet, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return {...result, blocksMined: totalBlocksMined};
  }

  return {success: true, blocksMined: totalBlocksMined};
}

function didArriveAtTarget(bot: mineflayer.Bot, target: Vec3): boolean {
  const HORIZONTAL_THRESHOLD = 1.5;
  const VERTICAL_THRESHOLD = 1.0;
  const currentPos = bot.entity.position;
  const horizontalDist = Math.sqrt(
    Math.pow(currentPos.x - target.x, 2) + Math.pow(currentPos.z - target.z, 2)
  );
  const verticalDist = Math.abs(currentPos.y - target.y);
  return horizontalDist <= HORIZONTAL_THRESHOLD && verticalDist <= VERTICAL_THRESHOLD;
}

async function moveOneStep(
  bot: mineflayer.Bot,
  target: Vec3,
  forwardVec: Vec3,
  allowPillarUpWith: string[],
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<{
  blocksMined: number;
  movedBlocksCloser: number;
  pillaredUpBlocks: number;
  error?: string;
}> {
  const currentPos = bot.entity.position;
  const startDist = currentPos.distanceTo(target);

  // Try walking forward
  if (await walkForwardsIfPossible(bot, currentPos, forwardVec)) {
    const newPos = bot.entity.position;
    const newDist = newPos.distanceTo(target);
    const movedCloser = Math.max(0, startDist - newDist);
    return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
  }

  // Try jumping over obstacle
  if (await jumpOverSmallObstacleIfPossible(bot, currentPos, forwardVec)) {
    const newPos = bot.entity.position;
    const newDist = newPos.distanceTo(target);
    const movedCloser = Math.max(0, startDist - newDist);
    return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
  }

  // Try mining forward
  const mineResult = await mineForwardsIfPossible(
    bot, currentPos, forwardVec, allowMiningOf, digTimeout
  );

  if (mineResult.error) {
    return { blocksMined: mineResult.blocksMined, movedBlocksCloser: 0, pillaredUpBlocks: 0, error: mineResult.error };
  }

  if (mineResult.success && mineResult.blocksMined > 0) {
    // Try walking after mining
    const newCurrentPos = bot.entity.position;
    await walkForwardsIfPossible(bot, newCurrentPos, forwardVec);
    const newPos = bot.entity.position;
    const newDist = newPos.distanceTo(target);
    const movedCloser = Math.max(0, startDist - newDist);
    return { blocksMined: mineResult.blocksMined, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
  }

  // Try pillaring up if target is above
  const VERTICAL_THRESHOLD = 1.0;
  const verticalDist = Math.abs(currentPos.y - target.y);
  if (target.y > currentPos.y + 1 && verticalDist > VERTICAL_THRESHOLD) {
    if (allowPillarUpWith.length === 0) {
      return {
        blocksMined: 0,
        movedBlocksCloser: 0,
        pillaredUpBlocks: 0,
        error: `Target is ${verticalDist.toFixed(1)} blocks above at (${Math.floor(target.x)}, ${Math.floor(target.y)}, ${Math.floor(target.z)}). ` +
          `Current: (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)}). ` +
          `Need blocks for pillaring. Provide allowPillarUpWith parameter (e.g., ['cobblestone', 'dirt']).`
      };
    }

    const pillarBlock = bot.inventory.items().find(item => allowPillarUpWith.includes(item.name));
    if (!pillarBlock) {
      return {
        blocksMined: 0,
        movedBlocksCloser: 0,
        pillaredUpBlocks: 0,
        error: `Need blocks for pillaring: ${allowPillarUpWith.join(', ')}. None found in inventory.`
      };
    }

    await bot.equip(pillarBlock, 'hand');
    const pillared = await pillarUpOneBlock(bot);
    const newPos = bot.entity.position;
    const newDist = newPos.distanceTo(target);
    const movedCloser = Math.max(0, startDist - newDist);
    return {
      blocksMined: 0,
      movedBlocksCloser: movedCloser,
      pillaredUpBlocks: pillared ? 1 : 0
    };
  }

  // Nothing worked - stuck
  return {
    blocksMined: 0,
    movedBlocksCloser: 0,
    pillaredUpBlocks: 0,
    error: "Stuck: Cannot walk, jump, mine, or pillar. Path may be blocked."
  };
}

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

  // DISABLED: move-to-position tool (pathfinder removed)
  // Use move-in-direction, jump, and pillar-up instead

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

        // Check and clear blocks above if they exist (player is 2 blocks tall, check Y+2 through Y+height+1)
        const buildingBlockName = heldItem.name;
        const currentPos = bot.entity.position;
        let blocksDug = 0;
        for (let yOffset = 2; yOffset <= height + 1; yOffset++) {
          const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
          if (blockAbove && blockAbove.name !== 'air') {
            // Need to dig this block - temporarily equip a tool
            const pickaxe = bot.inventory.items().find(item =>
              item.name.includes('pickaxe') || item.name.includes('shovel') || item.name.includes('axe')
            );
            if (pickaxe) {
              await bot.equip(pickaxe, 'hand');
              await bot.dig(blockAbove);
              blocksDug++;
              // Re-equip the building block by name
              const buildingBlock = bot.inventory.items().find(item => item.name === buildingBlockName);
              if (buildingBlock) {
                await bot.equip(buildingBlock, 'hand');
              }
            } else {
              // No tool, try to dig anyway
              await bot.dig(blockAbove);
              blocksDug++;
            }
          }
        }

        const startY = Math.floor(bot.entity.position.y);
        let blocksPlaced = 0;
        let digMessage = blocksDug > 0 ? ` (cleared ${blocksDug} blocks above first)` : '';

        for (let i = 0; i < height; i++) {
          const beforeY = Math.floor(bot.entity.position.y);

          // Use the pillarUpOneBlock helper
          const placed = await pillarUpOneBlock(bot);
          if (placed) {
            blocksPlaced++;
          }

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

        const finalY = Math.floor(bot.entity.position.y);
        return createResponse(
          `Pillared up ${blocksPlaced} blocks (from Y=${startY} to Y=${finalY})${digMessage}`
        );
      } catch (error) {
        bot.setControlState("jump", false);
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "move-to",
    "Move to a target position using yaw-based movement with auto-mining and optional pillar-up",
    {
      x: z.number().describe("Target X coordinate"),
      y: z.number().describe("Target Y coordinate"),
      z: z.number().describe("Target Z coordinate"),
      allowPillarUpWith: z
        .array(z.string())
        .optional()
        .describe("Allow using these blocks to use for pillaring up (e.g., ['cobblestone', 'dirt']). Only used if target is above."),
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
      maxIterations: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of movement iterations"),
    },
    async ({ x, y, z, allowPillarUpWith = [], allowMiningOf = {}, maxIterations = 10 }): Promise<McpResponse> => {
      const startPos = bot.entity.position.clone();
      const startTime = Date.now();
      const target = new Vec3(x, y, z);
      const DIG_TIMEOUT_SECONDS = 3;

      try {
        let totalBlocksMined = 0;
        let totalPillaredBlocks = 0;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
          // Check if we've reached the target
          if (didArriveAtTarget(bot, target)) {
            const totalDist = startPos.distanceTo(bot.entity.position);
            const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            return createResponse(
              `Reached target (${x}, ${y}, ${z}) from (${Math.floor(startPos.x)}, ${Math.floor(startPos.y)}, ${Math.floor(startPos.z)}). ` +
              `Traveled ${totalDist.toFixed(1)} blocks in ${timeElapsed}s. Mined ${totalBlocksMined} blocks.`
            );
          }

          // Look at target (so bot will look realistic)
          await bot.lookAt(target, false);

          // TODO: Remove this. moveOneStep already gets `target` so it can calculate the `forwardVec` if it needs to.
          // Calculate forward vector
          const yaw = bot.entity.yaw;
          const forwardVec = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));

          const stepResult = await moveOneStep(
            bot, target, forwardVec,
            allowPillarUpWith, allowMiningOf, DIG_TIMEOUT_SECONDS
          );

          totalBlocksMined += stepResult.blocksMined;
          totalPillaredBlocks += stepResult.pillaredUpBlocks;

          // Check if we made progress this iteration
          const madeProgress = stepResult.blocksMined > 0 ||
                              stepResult.movedBlocksCloser >= 0.3 ||
                              stepResult.pillaredUpBlocks > 0;

          if (!madeProgress) {
            // TODO: When move-to exists, also return how many iterations were run, what total progress was made so far (blocksMined, movedBlocksCloser, ..).
            // No progress - return error from step
            return createResponse(stepResult.error || "Stuck at this iteration with no info from moveOneStep");
          }
        }

        // Max iterations reached
        // TODO: Only calculate these things once, and reuse them for the other errors, like in !madeProgress
        const distRemaining = bot.entity.position.distanceTo(target);
        const distTraveled = startPos.distanceTo(bot.entity.position);
        return createResponse(
          `Reached iteration limit (${maxIterations} iterations). Made progress: traveled ${distTraveled.toFixed(1)} blocks, ` +
          `mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ${distRemaining.toFixed(1)} blocks remaining to target. ` +
          `Call move-to again to continue.`
        );

      } catch (error) {
        return createErrorResponse(error as Error);
      } finally {
        // Always clean up control states
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
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

function getLightLevel(light: number | undefined): string {
  if (light === undefined || light === null) {
    return "light: ?/15";
  }
  return `light: ${light}/15`;
}

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
              // Block not visible - try next face
              continue;
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

        // Check light level before digging
        const lightLevel = block.light;

        // Use tryMiningOneBlock if tools mapping provided, otherwise use current tool
        const result = await tryMiningOneBlock(bot, block, allowedMiningToolsToMinedBlocks, digTimeout);

        if (!result.success) {
          return createResponse(result.error || "Failed to mine block");
        }

        let response = `Dug ${block.name} at (${x}, ${y}, ${z})`;
        // Add light level warning if it's dark
        if (lightLevel !== undefined && lightLevel < 8) {
          response += ` (fyi: block lighting was ${lightLevel}/15)`;
        }
        return createResponse(response);
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

        const lightInfo = getLightLevel(block.light);

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
            const lightInfo = getLightLevel(block.light);
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

  server.tool(
    "get-nearby-blocks",
    "Get all unique blocks and entities in the nearby area, sorted by distance",
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

        // Map to track closest instance of each block type
        const blockTypes = new Map<string, { distance: number; position: Vec3 }>();

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

              if (!existing || distance < existing.distance) {
                blockTypes.set(block.name, { distance, position: blockPos });
              }
            }
          }
        }

        // Search for entities
        const entityTypes = new Map<string, { distance: number; position: Vec3 }>();

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

          if (!existing || distance < existing.distance) {
            entityTypes.set(entityName, { distance, position: entity.position });
          }
        }

        // Combine blocks and entities
        const allItems: Array<{ type: string; distance: number; position: Vec3; category: 'block' | 'entity' }> = [];

        blockTypes.forEach((data, name) => {
          allItems.push({ type: name, distance: data.distance, position: data.position, category: 'block' });
        });

        entityTypes.forEach((data, name) => {
          allItems.push({ type: name, distance: data.distance, position: data.position, category: 'entity' });
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

        limitedItems.forEach((item, index) => {
          const pos = item.position;
          const marker = item.category === 'entity' ? '[ENTITY]' : '[BLOCK]';
          output += `${index + 1}. ${marker} ${item.type} - ${item.distance.toFixed(1)} blocks away at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})\n`;
        });

        return createResponse(output.trim());
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
