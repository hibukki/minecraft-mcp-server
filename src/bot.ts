#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mineflayer from "mineflayer";
import type { Bot, Furnace } from "mineflayer";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import yargs from "yargs";
import type { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";
import { appendFileSync } from "fs";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { Entity } from "prismarine-entity";

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

// ========== Movement Result Types (Type-Safe) ==========

/** Result type that requires error message when success is false */
type MiningResult =
  | { success: true; blocksMined: number }
  | { success: false; blocksMined: number; error: string };

type JumpResult =
  | { success: true }
  | { success: false; error: string };

type PillarResult =
  | { success: true; pillaredUpBlocks: number; movedBlocksCloser: number }
  | { success: false; pillaredUpBlocks: number; movedBlocksCloser: number; error: string };

type MineForwardResult =
  | { success: true; blocksMined: number }
  | { success: false; blocksMined: number; error: string };

type MineDownOneStepResult =
  | { success: true }
  | { success: false; error: string };

type MineUpOneStepResult =
  | { success: true }
  | { success: false; error: string };

/** Axis-aligned direction vector (either x is 0 or z is 0, never both non-zero) */
type AxisAlignedDirection =
  | { x: 1; y: 0; z: 0 }
  | { x: -1; y: 0; z: 0 }
  | { x: 0; y: 0; z: 1 }
  | { x: 0; y: 0; z: -1 };

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
  bot: Bot,
  block: Block,
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
  bot: Bot,
  block: Block,
  allowedMiningToolsToMinedBlocks: Record<string, string[]>,
  digTimeout: number = 3,
  allowMiningDiagonalBlocks: boolean = false
): Promise<MiningResult> {
  const botPos = bot.entity.position;
  const blockPos = block.position;
  const distance = botPos.distanceTo(blockPos);

  // Check if block is diagonal in XZ plane (unless explicitly allowed)
  // Diagonal in Y (up/down) is OK, but diagonal in XZ (horizontal) is NOT OK
  if (!allowMiningDiagonalBlocks) {
    const dx = Math.abs(Math.floor(botPos.x) - Math.floor(blockPos.x));
    const dz = Math.abs(Math.floor(botPos.z) - Math.floor(blockPos.z));

    // Block is diagonal in XZ plane if both X and Z differ
    if (dx > 0 && dz > 0) {
      return {
        success: false,
        blocksMined: 0,
        error: `Block ${block.name} at ${formatBlockPosition(blockPos)} is diagonal in XZ plane from bot at ${formatBotPosition(botPos)}. Only mining blocks that are axis-aligned in XZ (forward/back/left/right, up/down is OK).`
      };
    }
  }

  // Find the right tool for this block
  let tool = null;
  for (const [toolName, blockNames] of Object.entries(allowedMiningToolsToMinedBlocks)) {
    if (blockNames.includes(block.name)) {
      tool = bot.inventory.items().find(item => item.name === toolName);
      if (!tool) {
        return {
          success: false,
          blocksMined: 0,
          error: `Tool ${toolName} needed to mine ${block.name} at ${formatBlockPosition(blockPos)} but not found in inventory`
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
      error: `Block ${block.name} at ${formatBlockPosition(blockPos)} is not in allowedMiningToolsToMinedBlocks. Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks`
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
      error: `Cannot dig ${block.name} at ${formatBlockPosition(blockPos)}. Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks. Block might be out of reach or require different tool`
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
      error: `Failed to mine ${block.name} at ${formatBlockPosition(blockPos)}. Holding: ${toolInfo}. Distance: ${distance.toFixed(1)} blocks. Error: ${formatError(digError)}`
    };
  }
}

// ========== Bot Setup ==========

function setupBot(argv: Arguments): Bot {
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

function createMcpServer(bot: Bot) {
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

function registerCraftingTools(server: McpServer, bot: Bot) {
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

function registerSmeltingTools(server: McpServer, bot: Bot) {
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

// Helper functions for formatting positions
function formatBotPosition(pos: Vec3): string {
  return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

function formatBlockPosition(pos: Vec3): string {
  // Blocks are always at integer coordinates, but we show the center at .5
  return `(${Math.floor(pos.x) + 0.5}, ${Math.floor(pos.y) + 0.5}, ${Math.floor(pos.z) + 0.5})`;
}

// Helper functions for pillar-up movement
async function jumpAndWaitToBeInAir(bot: Bot): Promise<void> {
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 100)); // Initial jump delay
  await new Promise(r => setTimeout(r, 200)); // Wait to be airborne
}

async function waitToLandFromAir(bot: Bot): Promise<void> {
  bot.setControlState('jump', false);
  await new Promise(r => setTimeout(r, 300)); // Wait to land
}

// TODO: This should also return an error if it fails
async function pillarUpOneBlock(bot: Bot): Promise<boolean> {
  const botFeetPos = bot.entity.position;
  const blockWeAreStandingOn = bot.blockAt(botFeetPos.offset(0, -1, 0).floor());

  await jumpAndWaitToBeInAir(bot);

  // Place block AT our feet location (where we were standing), using the block below as reference
  if (!isBlockEmpty(blockWeAreStandingOn)) {
    try {
      await bot.placeBlock(blockWeAreStandingOn!, new Vec3(0, 1, 0));
      await waitToLandFromAir(bot);
      return true;
    } catch (placeError) {
      log('warn', `Failed to place pillar block: ${formatError(placeError)}`);
      await waitToLandFromAir(bot);
      return false;
    }
  }

  await waitToLandFromAir(bot);
  return false;
}

/**
 * Try to pillar up one block, handling all validation and errors
 * Returns detailed error info if pillaring fails
 */
async function tryPillaringUpIfSensible(
  bot: Bot,
  target: Vec3,
  allowPillarUpWith: string[],
  allowMiningOf: Record<string, string[]> = {},
  digTimeout: number = 3
): Promise<PillarResult> {
  const currentPos = bot.entity.position;
  const startDist = currentPos.distanceTo(target);
  const verticalDist = Math.abs(currentPos.y - target.y);

  // Check if we should pillar (target is above)
  // Allow pillaring even for small vertical distances
  if (target.y <= currentPos.y) {
    return {
      success: false,
      error: `Target not above us (target.y=${target.y}, current.y=${currentPos.y})`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  // Check if blocks provided
  if (allowPillarUpWith.length === 0) {
    return {
      success: false,
      error: `Target is ${verticalDist.toFixed(1)} blocks above but no allowPillarUpWith blocks provided`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  // Find pillar block in inventory
  const pillarBlock = bot.inventory.items().find(item => allowPillarUpWith.includes(item.name));
  if (!pillarBlock) {
    return {
      success: false,
      error: `Need blocks ${allowPillarUpWith.join(', ')} but none found in inventory`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }

  const buildingBlockName = pillarBlock.name;

  // Check and clear blocks above (up to 3 blocks), sorted by closest first
  const blocksToCheck = [2, 3, 4]; // Y+2, Y+3, Y+4 (closest to farthest)
  for (const yOffset of blocksToCheck) {
    const blockAbove = bot.blockAt(currentPos.offset(0, yOffset, 0).floor());
    if (!isBlockEmpty(blockAbove)) {
      // Try to mine this block using the mining tools mapping
      const mineResult = await tryMiningOneBlock(bot, blockAbove!, allowMiningOf, digTimeout, true);
      if (!mineResult.success) {
        return {
          success: false,
          error: `Blocked at Y+${yOffset} by ${blockAbove!.name}, failed to clear: ${mineResult.error}`,
          pillaredUpBlocks: 0,
          movedBlocksCloser: 0
        };
      }
      // Successfully mined, continue checking other blocks above
    }
  }

  // Re-equip the building block (in case we switched to a tool for mining)
  const buildingBlock = bot.inventory.items().find(item => item.name === buildingBlockName);
  if (!buildingBlock) {
    return {
      success: false,
      error: `Lost ${buildingBlockName} from inventory while clearing blocks above`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }
  await bot.equip(buildingBlock, 'hand');

  // Attempt pillar
  const beforeY = currentPos.y.toFixed(1);
  const pillared = await pillarUpOneBlock(bot);
  const afterY = bot.entity.position.y.toFixed(1);

  const newPos = bot.entity.position;
  const newDist = newPos.distanceTo(target);
  const movedCloser = startDist - newDist;

  if (pillared && afterY > beforeY) {
    return {
      success: true,
      pillaredUpBlocks: 1,
      movedBlocksCloser: movedCloser
    };
  } else {
    // Check what went wrong
    const stillHaveBlocks = bot.heldItem && bot.heldItem.name === buildingBlockName;
    return {
      success: false,
      error: `Failed to pillar up (Y ${beforeY}→${afterY}). Still have ${buildingBlockName}: ${stillHaveBlocks}`,
      pillaredUpBlocks: 0,
      movedBlocksCloser: 0
    };
  }
}

// Helper functions for move-to horizontal movement
async function walkForwardsIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection
): Promise<boolean> {
  console.log("Running walkForwardsIfPossible")
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

  const feetClear = isBlockEmpty(blockAheadOfFeet);
  const headClear = isBlockEmpty(blockAheadOfHead);

  if (feetClear && headClear) {
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 200));
    bot.setControlState('forward', false);
    return true;
  }

  return false;
}

async function jumpOverSmallObstacleIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection,
  target: Vec3
): Promise<JumpResult> {
  // Check all relevant blocks
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);
  const blockAboveHead = bot.blockAt(currentPos.offset(0, 2, 0).floor());
  const blockAheadHeadPlusOne = bot.blockAt(currentPos.offset(direction.x, 2, direction.z).floor());

  // Build block situation string (used in all error messages)
  const blockSituation = `Block ahead of feet: ${blockAheadOfFeet?.name || 'null'}, ` +
    `ahead of head: ${blockAheadOfHead?.name || 'null'}, ` +
    `above head: ${blockAboveHead?.name || 'null'}, ` +
    `planned head dest (ahead+up): ${blockAheadHeadPlusOne?.name || 'null'}`;

  const feetClear = isBlockEmpty(blockAheadOfFeet);
  const headClear = isBlockEmpty(blockAheadOfHead);
  const aboveHeadClear = !blockAboveHead || blockAboveHead.name === 'air';
  const plannedHeadDestClear = !blockAheadHeadPlusOne || blockAheadHeadPlusOne.name === 'air';

  // Early returns for conditions that prevent jumping
  if (feetClear) {
    return {
      success: false,
      error: `Jump not attempted: feet ahead are clear (no obstacle to jump over). ${blockSituation}`
    };
  }

  if (!headClear) {
    return {
      success: false,
      error: `Jump not attempted: block ahead of head is not clear. ${blockSituation}`
    };
  }

  if (!aboveHeadClear) {
    return {
      success: false,
      error: `Jump not attempted: block above head is not clear (no room to jump). ${blockSituation}`
    };
  }

  if (!plannedHeadDestClear) {
    return {
      success: false,
      error: `Jump not attempted: planned head destination (ahead+up) is not clear. ${blockSituation}`
    };
  }

  // All conditions met - attempt the jump
  const startPos = currentPos.clone();
  const startDist = startPos.distanceTo(target);

  bot.setControlState('jump', true);
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 100));
  bot.setControlState('jump', false);
  bot.setControlState('forward', false);
  await new Promise(r => setTimeout(r, 50));

  const endPos = bot.entity.position;
  const endDist = endPos.distanceTo(target);
  const progress = startDist - endDist;

  // If we didn't make progress, the jump failed
  if (progress < 0.3) {
    const currentBlockAboveHead = bot.blockAt(endPos.offset(0, 1, 0).floor());
    return {
      success: false,
      error: `Jump failed - made only ${progress.toFixed(2)} blocks progress. ` +
        `Before: ${formatBotPosition(startPos)}, ` +
        `After: ${formatBotPosition(endPos)}. ` +
        `Block above bot head now: ${currentBlockAboveHead?.name || 'null'}. ${blockSituation}`
    };
  }

  return {success: true};
}

async function mineForwardsIfPossible(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  DIG_TIMEOUT_SECONDS: number,
  returnErrorIfNothingMined: boolean = true
): Promise<MineForwardResult> {
  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);
  let totalBlocksMined = 0;

  const botPos = bot.entity.position;
  const botBottomHalf = formatBotPosition(botPos);

  // Try mining head block first
  if (!isBlockEmpty(blockAheadOfHead)) {
    const result = await tryMiningOneBlock(bot, blockAheadOfHead!, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return {...result, blocksMined: totalBlocksMined};
  }

  // Try mining feet block
  if (!isBlockEmpty(blockAheadOfFeet)) {
    const result = await tryMiningOneBlock(bot, blockAheadOfFeet!, allowMiningOf, DIG_TIMEOUT_SECONDS);
    totalBlocksMined += result.blocksMined;
    if (!result.success) return {...result, blocksMined: totalBlocksMined};
  }

  // Build detailed error message about what blocks we tried to mine
  const headInfo = blockAheadOfHead
    ? `${blockAheadOfHead.name} at ${formatBlockPosition(blockAheadOfHead.position)}`
    : 'air or null';
  const feetInfo = blockAheadOfFeet
    ? `${blockAheadOfFeet.name} at ${formatBlockPosition(blockAheadOfFeet.position)}`
    : 'air or null';

  // If we mined nothing and should return an error
  if (totalBlocksMined === 0 && returnErrorIfNothingMined) {
    return {
      success: false,
      blocksMined: 0,
      error: `No blocks mined. Bot bottom-half at ${botBottomHalf}. Block ahead of head: ${headInfo}. Block ahead of feet: ${feetInfo}. allowMiningOf is ${Object.keys(allowMiningOf).length === 0 ? 'empty (no mining allowed)' : `{${Object.keys(allowMiningOf).join(', ')}}`}`
    };
  }

  // If we mined some blocks, return success
  if (totalBlocksMined > 0) {
    return {success: true, blocksMined: totalBlocksMined};
  }

  // If we're here, totalBlocksMined is 0 and returnErrorIfNothingMined is false
  // This means we were told it's okay to return with no mining
  return {success: true, blocksMined: 0};
}

/**
 * Dig directly down if possible, ensuring we won't fall into a hole
 * @param bot The minecraft bot
 * @param blocksToDigDown How many blocks down to dig (typically 1)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and blocks mined
 */
async function digDirectlyDownIfPossible(
  bot: Bot,
  blocksToDigDown: number,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<MineForwardResult> {
  let totalBlocksMined = 0;

  // Dig down multiple blocks
  for (let i = 0; i < blocksToDigDown; i++) {
    const currentBotPos = bot.entity.position;
    const blockUnderUs = bot.blockAt(currentBotPos.offset(0, -1, 0));
    const blockUnderUnderUs = bot.blockAt(currentBotPos.offset(0, -2, 0));

    // Safety check: make sure there's a solid block two blocks down
    // so we don't fall into a hole when we dig the block under us
    if (isBlockEmpty(blockUnderUnderUs)) {
      return {
        success: false,
        blocksMined: totalBlocksMined,
        error: `Cannot dig down: block at ${formatBlockPosition(currentBotPos.offset(0, -2, 0))} is ${blockUnderUnderUs?.name || 'null'}, would fall into hole`
      };
    }

    // Dig the block under us
    const result = await tryMiningOneBlock(bot, blockUnderUs!, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        success: false,
        blocksMined: totalBlocksMined,
        error: `Failed to dig block under bot: ${result.error}`
      };
    }

    totalBlocksMined += result.blocksMined;
  }

  return {
    success: true,
    blocksMined: totalBlocksMined
  };
}

/**
 * Mine down one step by clearing blocks ahead and moving forward-and-down
 * @param bot The minecraft bot
 * @param direction The XZ-aligned direction to move (e.g., {x: 1, z: 0} for east)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and error details if failed
 */
async function mineDownOneStep(
  bot: Bot,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<MineDownOneStepResult> {
  const currentPos = bot.entity.position;

  // Get the three blocks we need to mine: ahead of head, ahead of feet, and ahead-and-down
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadAndDown = bot.blockAt(currentPos.offset(direction.x, -1, direction.z).floor());

  // Mine each block in order if not empty
  const blocksToMine = [
    { block: blockAheadOfHead, name: "ahead of head" },
    { block: blockAheadOfFeet, name: "ahead of feet" },
    { block: blockAheadAndDown, name: "ahead and down" }
  ];

  for (const { block, name } of blocksToMine) {
    if (block && !isBlockEmpty(block)) {
      const result = await tryMiningOneBlock(bot, block, allowMiningOf, digTimeout, true);
      if (!result.success) {
        return {
          success: false,
          error: `Failed to mine block ${name}: ${result.error}`
        };
      }
    }
  }

  // Calculate expected position after the step
  const expectedPos = currentPos.offset(direction.x, -1, direction.z);

  // Look at the middle of the expected position
  const targetLookPos = expectedPos.offset(0.5, 0.5, 0.5);
  await bot.lookAt(targetLookPos, false);

  // Walk forward
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 300));
  bot.setControlState('forward', false);

  // Wait a moment to settle
  await new Promise(r => setTimeout(r, 200));

  // Verify we ended up at the right position (on the lowest block)
  const finalPos = bot.entity.position;
  const targetY = expectedPos.y;
  const actualY = finalPos.y;

  // Check if we're within reasonable range of the target Y (bot is 2 blocks tall, feet at Y)
  if (Math.abs(actualY - targetY) > 0.5) {
    return {
      success: false,
      error: `Bot ended up at Y=${actualY.toFixed(2)} but expected Y=${targetY.toFixed(2)}. ` +
        `Position: ${formatBotPosition(finalPos)}, Expected: ${formatBlockPosition(expectedPos)}`
    };
  }

  return { success: true };
}

/**
 * Mine steps down by repeatedly calling mineDownOneStep
 * @param bot The minecraft bot
 * @param stepsToGoDown Number of steps to descend
 * @param nextStepPos The first step position (must be adjacent and one down)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Object with stepsCompleted and optional error
 */
async function mineStepsDown(
  bot: Bot,
  stepsToGoDown: number,
  nextStepPos: Vec3,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<{ stepsCompleted: number; error?: string }> {
  const currentPos = bot.entity.position;
  const currentFloor = currentPos.floor();

  // Calculate the 4 valid next positions (adjacent and one down)
  const validNextPositions = [
    new Vec3(currentFloor.x + 1, currentFloor.y - 1, currentFloor.z),
    new Vec3(currentFloor.x - 1, currentFloor.y - 1, currentFloor.z),
    new Vec3(currentFloor.x, currentFloor.y - 1, currentFloor.z + 1),
    new Vec3(currentFloor.x, currentFloor.y - 1, currentFloor.z - 1)
  ];

  // Check if nextStepPos matches one of the valid positions
  const nextStepFloor = nextStepPos.floor();
  const isValid = validNextPositions.some(pos =>
    pos.x === nextStepFloor.x && pos.y === nextStepFloor.y && pos.z === nextStepFloor.z
  );

  if (!isValid) {
    const posStrings = validNextPositions.map(p => formatBlockPosition(p));
    return {
      stepsCompleted: 0,
      error: `nextStepPos must be adjacent and one down. Current: ${formatBotPosition(currentPos)}, ` +
        `nextStepPos: ${formatBlockPosition(nextStepPos)}. Valid positions: ${posStrings.join(', ')}`
    };
  }

  // Calculate the XZ-aligned direction vector (same for all steps)
  const dx = nextStepFloor.x - currentFloor.x;
  const dz = nextStepFloor.z - currentFloor.z;
  const direction: AxisAlignedDirection = dx !== 0
    ? (dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 })
    : (dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 });

  // Loop for the specified number of steps
  let stepsCompleted = 0;

  for (let i = 0; i < stepsToGoDown; i++) {
    const result = await mineDownOneStep(bot, direction, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        stepsCompleted,
        error: result.error
      };
    }

    stepsCompleted++;
  }

  return { stepsCompleted };
}

/**
 * Mine up one step by clearing blocks above and jumping forward-and-up
 * @param bot The minecraft bot
 * @param direction The XZ-aligned direction to move (e.g., {x: 1, z: 0} for east)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Result with success status and error details if failed
 */
async function mineUpOneStep(
  bot: Bot,
  direction: AxisAlignedDirection,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<MineUpOneStepResult> {
  const currentPos = bot.entity.position;

  // Get the blocks we need to check and potentially mine
  const blockAboveHead = bot.blockAt(currentPos.offset(0, 2, 0).floor());
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadAndUp = bot.blockAt(currentPos.offset(direction.x, 2, direction.z).floor());

  // Verify blockAheadOfFeet is NOT empty (we need a stair to land on)
  if (!blockAheadOfFeet || isBlockEmpty(blockAheadOfFeet)) {
    return {
      success: false,
      error: `Cannot step up: blockAheadOfFeet is empty (no stair to land on). ` +
        `Position: ${formatBotPosition(currentPos)}, direction: (${direction.x}, 0, ${direction.z})`
    };
  }

  // Mine the three blocks we need clear: blockAboveHead, blockAheadOfHead, blockAheadAndUp
  const blocksToMine = [
    { block: blockAboveHead, name: "above head" },
    { block: blockAheadOfHead, name: "ahead of head" },
    { block: blockAheadAndUp, name: "ahead and up" }
  ];

  for (const { block, name } of blocksToMine) {
    if (block && !isBlockEmpty(block)) {
      const result = await tryMiningOneBlock(bot, block, allowMiningOf, digTimeout, true);
      if (!result.success) {
        return {
          success: false,
          error: `Failed to mine block ${name}: ${result.error}`
        };
      }
    }
  }

  // Perform the jump up the stair
  const startPos = currentPos.clone();

  // Look at the target stair block
  await bot.lookAt(blockAheadOfFeet.position.offset(0.5, 0.5, 0.5), false);

  // Walk forward first to position properly at the edge of current stair
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 200));

  // Now jump while continuing to move forward
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 500));
  bot.setControlState('jump', false);
  // Keep moving forward for a bit after jump ends
  await new Promise(r => setTimeout(r, 150));
  bot.setControlState('forward', false);
  await new Promise(r => setTimeout(r, 100));

  // Verify we ended up approximately one block up and forward
  const finalPos = bot.entity.position;
  const expectedY = startPos.y + 1;
  const actualY = finalPos.y;

  // Check if we're within reasonable range of the expected Y
  if (Math.abs(actualY - expectedY) > 0.5) {
    return {
      success: false,
      error: `Bot ended up at Y=${actualY.toFixed(2)} but expected Y=${expectedY.toFixed(2)}. ` +
        `Start: ${formatBotPosition(startPos)}, Final: ${formatBotPosition(finalPos)}`
    };
  }

  return { success: true };
}

/**
 * Mine steps up by repeatedly calling mineUpOneStep
 * @param bot The minecraft bot
 * @param stepsToGoUp Number of steps to ascend
 * @param nextStepPos The first step position (must be adjacent and one up)
 * @param allowMiningOf Tool-to-blocks mapping for mining
 * @param digTimeout Timeout for digging operations
 * @returns Object with stepsCompleted and optional error
 */
async function mineStepsUp(
  bot: Bot,
  stepsToGoUp: number,
  nextStepPos: Vec3,
  allowMiningOf: Record<string, string[]>,
  digTimeout: number
): Promise<{ stepsCompleted: number; error?: string }> {
  const currentPos = bot.entity.position;
  const currentFloor = currentPos.floor();

  // Calculate the 4 valid next positions (adjacent and one up)
  const validNextPositions = [
    new Vec3(currentFloor.x + 1, currentFloor.y + 1, currentFloor.z),
    new Vec3(currentFloor.x - 1, currentFloor.y + 1, currentFloor.z),
    new Vec3(currentFloor.x, currentFloor.y + 1, currentFloor.z + 1),
    new Vec3(currentFloor.x, currentFloor.y + 1, currentFloor.z - 1)
  ];

  // Check if nextStepPos matches one of the valid positions
  const nextStepFloor = nextStepPos.floor();
  const isValid = validNextPositions.some(pos =>
    pos.x === nextStepFloor.x && pos.y === nextStepFloor.y && pos.z === nextStepFloor.z
  );

  if (!isValid) {
    const posStrings = validNextPositions.map(p => formatBlockPosition(p));
    return {
      stepsCompleted: 0,
      error: `nextStepPos must be adjacent and one up. Current: ${formatBotPosition(currentPos)}, ` +
        `nextStepPos: ${formatBlockPosition(nextStepPos)}. Valid positions: ${posStrings.join(', ')}`
    };
  }

  // Calculate the XZ-aligned direction vector (same for all steps)
  const dx = nextStepFloor.x - currentFloor.x;
  const dz = nextStepFloor.z - currentFloor.z;
  const direction: AxisAlignedDirection = dx !== 0
    ? (dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 })
    : (dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 });

  // Loop for the specified number of steps
  let stepsCompleted = 0;

  for (let i = 0; i < stepsToGoUp; i++) {
    const result = await mineUpOneStep(bot, direction, allowMiningOf, digTimeout);

    if (!result.success) {
      return {
        stepsCompleted,
        error: result.error
      };
    }

    stepsCompleted++;
  }

  return { stepsCompleted };
}

/**
 * Get the next axis-aligned direction to move toward target
 * Returns a vector where either x is 0 or z is 0 (never both non-zero)
 */
function getNextDirection(bot: Bot, target: Vec3): AxisAlignedDirection {
  const currentPos = bot.entity.position;
  const dx = target.x - currentPos.x;
  const dz = target.z - currentPos.z;

  // Choose the axis with larger absolute difference
  if (Math.abs(dx) > Math.abs(dz)) {
    // Move along X axis
    return dx > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
  } else {
    // Move along Z axis
    return dz > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
  }
}

/**
 * Check if a block is empty (air, water, or lava - things we can move through)
 */
function isBlockEmpty(block: Block | null): boolean {
  if (!block) return true;
  return block.name === 'air' || block.name === 'water' || block.name === 'lava';
}

/**
 * Get the distance from the bot to the target
 */
function getDistance(bot: Bot, target: Vec3): number {
  return bot.entity.position.distanceTo(target);
}

/**
 * Get the axis-aligned direction the bot is currently facing
 * Throws if bot is not facing a cardinal direction
 */
function getBotAxisAlignedDirection(bot: Bot): AxisAlignedDirection {
  const yaw = bot.entity.yaw;

  // Normalize yaw to 0-2π range
  const normalizedYaw = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);

  // Convert to degrees for easier reasoning
  const degrees = (normalizedYaw * 180) / Math.PI;

  // Check which cardinal direction (exact 90 degree increments)
  const rounded = Math.round(degrees / 90) * 90;

  if (Math.abs(degrees - rounded) > 1) {
    // Not aligned to cardinal direction
    throw new Error(
      `Bot is not axis-aligned. Yaw: ${yaw.toFixed(2)} rad (${degrees.toFixed(1)}°). ` +
      `Expected exactly: 0°, 90°, 180°, or 270°`
    );
  }

  // Return direction based on rounded degrees
  switch ((rounded + 360) % 360) {
    case 0:   // South (+Z)
      return { x: 0, y: 0, z: 1 };
    case 90:  // West (-X)
      return { x: -1, y: 0, z: 0 };
    case 180: // North (-Z)
      return { x: 0, y: 0, z: -1 };
    case 270: // East (+X)
      return { x: 1, y: 0, z: 0 };
    default:
      throw new Error(`Unexpected rounded degrees: ${rounded}`);
  }
}

/**
 * Calculate strafe direction and amount needed to center the bot
 * Uses bot's yaw to determine which axis to align on, and bot's position for the amount
 * Returns null if already centered enough
 */
function getStrafeDirectionAndAmount(
  bot: Bot
): { direction: 'left' | 'right'; amount: number } | null {
  const currentPos = bot.entity.position;
  const facingDirection = getBotAxisAlignedDirection(bot);

  // Determine which coordinate to check based on facing direction
  // If facing along X-axis, need to center Z. If facing along Z-axis, need to center X.
  let perpCoord: number;
  if (facingDirection.x !== 0) {
    // Facing east or west (along X), check Z alignment
    perpCoord = currentPos.z;
  } else {
    // Facing north or south (along Z), check X alignment
    perpCoord = currentPos.x;
  }

  // Calculate offset from block center (0.5 is perfectly centered)
  // Use ((x % 1) + 1) % 1 to normalize to 0-1 range (handles negative coords)
  // e.g., if perpCoord is 10.9, then ((10.9 % 1) + 1) % 1 = 0.9, and 0.9 - 0.5 = 0.4 (too far positive)
  // e.g., if perpCoord is 10.1, then ((10.1 % 1) + 1) % 1 = 0.1, and 0.1 - 0.5 = -0.4 (too far negative)
  // e.g., if perpCoord is -11.7, then ((-11.7 % 1) + 1) % 1 = (-0.7 + 1) % 1 = 0.3, and 0.3 - 0.5 = -0.2
  const normalizedCoord = ((perpCoord % 1.0) + 1.0) % 1.0; // Normalize to 0-1 range
  const offsetFromCenter = normalizedCoord - 0.5; // Range: -0.5 to +0.5

  // Threshold: if we're within 0.1 blocks of center, no strafe needed
  const ALIGNMENT_THRESHOLD = 0.1;
  if (Math.abs(offsetFromCenter) <= ALIGNMENT_THRESHOLD) {
    return null;
  }

  // Determine strafe direction based on facing direction and position offset
  let strafeDirection: 'left' | 'right';

  // offsetFromCenter < 0 means we need to increase the perpendicular coordinate
  // offsetFromCenter > 0 means we need to decrease the perpendicular coordinate
  if (facingDirection.x > 0) {      // Facing east (+X), perpCoord is Z
    // Increase Z (+Z) = strafe right, Decrease Z (-Z) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else if (facingDirection.x < 0) { // Facing west (-X), perpCoord is Z
    // Increase Z (+Z) = strafe left, Decrease Z (-Z) = strafe right
    strafeDirection = offsetFromCenter > 0 ? 'right' : 'left';
  } else if (facingDirection.z > 0) { // Facing south (+Z), perpCoord is X
    // Increase X (+X) = strafe right, Decrease X (-X) = strafe left
    strafeDirection = offsetFromCenter > 0 ? 'left' : 'right';
  } else {                            // Facing north (-Z), perpCoord is X
    // Increase X (+X) = strafe left, Decrease X (-X) = strafe right
    strafeDirection = offsetFromCenter > 0 ? 'right' : 'left';
  }

  return {
    direction: strafeDirection,
    amount: Math.abs(offsetFromCenter)
  };
}

/**
 * Strafe the bot toward the center of the block perpendicular to facing direction
 *
 * Movement observations (tested while facing south, axis-aligned):
 * - 10ms: 0 blocks
 * - 20ms: 0 blocks
 * - 25ms: 0 blocks
 * - 30ms: 0.2 blocks
 * - 40ms: 0.4 blocks
 * - 50ms: 0.2 blocks (2 attempts)
 * - 60ms: 0.2 blocks
 * - 75ms: 0.4 blocks
 * - 100ms: 0.4 blocks
 * - 1000ms: 0.4 blocks (movement caps at 0.4 blocks per control state)
 *
 * Strategy: Use 50ms strafes (moves 0.2 blocks) in a loop until centered within 0.2 blocks.
 * This avoids overshooting and hitting the opposite wall.
 */
async function strafeToMiddle(bot: Bot): Promise<void> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const strafeInfo = getStrafeDirectionAndAmount(bot);

    if (!strafeInfo) {
      // Already centered enough
      return;
    }

    const { direction, amount } = strafeInfo;
    const posBefore = bot.entity.position.clone();

    // Use 50ms which moves ~0.2 blocks
    const strafeDuration = 50;

    bot.setControlState(direction, true);
    await new Promise(r => setTimeout(r, strafeDuration));
    bot.setControlState(direction, false);

    const posAfter = bot.entity.position.clone();
    const actualMovement = posBefore.distanceTo(posAfter);

    // Check final position
    const afterStrafe = getStrafeDirectionAndAmount(bot);
    const finalOffset = afterStrafe ? afterStrafe.amount : 0;

    const strafeDataMsg =
      `Strafe attempt ${attempt + 1}: dir=${direction}, before=${amount.toFixed(3)}b from center, ` +
      `duration=${strafeDuration}ms, actual_moved=${actualMovement.toFixed(3)}b, ` +
      `after=${Math.abs(finalOffset).toFixed(3)}b from center, ` +
      `pos_before=(${posBefore.x.toFixed(2)},${posBefore.z.toFixed(2)}), ` +
      `pos_after=(${posAfter.x.toFixed(2)},${posAfter.z.toFixed(2)})`;

    console.log(strafeDataMsg);

    // If we're now centered (within 0.2 blocks), we're done
    if (!afterStrafe || Math.abs(afterStrafe.amount) <= 0.2) {
      return;
    }
  }

  // After MAX_ATTEMPTS, check if we're close enough
  const finalCheck = getStrafeDirectionAndAmount(bot);
  if (finalCheck && Math.abs(finalCheck.amount) > 0.2) {
    const errorMsg = `Failed to center after ${MAX_ATTEMPTS} attempts: still ${finalCheck.amount.toFixed(2)}b from center`;
    appendFileSync('strafe_log.txt', errorMsg + '\n');
    throw new Error(errorMsg);
  }
}

/**
 * Center the bot in both X and Z axes by rotating to each axis and strafing
 */
async function strafeToMiddleBothXZ(bot: Bot): Promise<void> {
  // Save original yaw
  const originalYaw = bot.entity.yaw;

  // Center in X direction (face north or south)
  await bot.look(0, 0, false); // Face south (0 yaw = south in Minecraft)
  await strafeToMiddle(bot);

  // Center in Z direction (face east or west)
  await bot.look(Math.PI / 2, 0, false); // Face west (90 degrees)
  await strafeToMiddle(bot);

  // Restore original yaw
  await bot.look(originalYaw, 0, false);
}

/**
 * Get the bot's position information
 */
function getBotPosition(bot: Bot): {
  botFeetPosition: { x: string; y: string; z: string };
  botHeadPosition: { x: string; y: string; z: string };
  blockUnderBotFeet: Block | null;
} {
  const position = bot.entity.position;

  const botFeetPosition = {
    x: position.x.toFixed(1),
    y: position.y.toFixed(1),
    z: position.z.toFixed(1),
  };

  const botHeadPosition = {
    x: position.x.toFixed(1),
    y: (position.y + 1).toFixed(1),
    z: position.z.toFixed(1),
  };

  const blockUnderBotFeet = bot.blockAt(position.offset(0, -1, 0).floor());

  return { botFeetPosition, botHeadPosition, blockUnderBotFeet };
}

/**
 * Get the blocks ahead of the bot's head and feet
 */
function getBlocksAhead(
  bot: Bot,
  currentPos: Vec3,
  direction: AxisAlignedDirection
): { blockAheadOfHead: Block | null; blockAheadOfFeet: Block | null } {
  const blockAheadOfFeet = bot.blockAt(currentPos.offset(direction.x, 0, direction.z).floor());
  const blockAheadOfHead = bot.blockAt(currentPos.offset(direction.x, 1, direction.z).floor());

  return { blockAheadOfHead, blockAheadOfFeet };
}

/**
 * Get blocks adjacent to the bot in all horizontal directions and at all height levels
 * The bot is 2 blocks tall, so we check 4 height levels:
 * - above_head: y+2
 * - head_height: y+1
 * - feet_height: y+0
 * - below_feet: y-1
 */
function getAdjacentBlocks(bot: Bot): string {
  const currentPos = bot.entity.position;
  const botX = Math.floor(currentPos.x);
  const botY = Math.floor(currentPos.y);
  const botZ = Math.floor(currentPos.z);

  let result = '';

  // Direction: higher x (x+1)
  const higherX = botX + 1;
  result += `direction higher x (x=${higherX}) :\n\n`;

  const higherXAboveHead = [
    bot.blockAt(new Vec3(higherX, botY + 2, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY + 2, botZ)),
    bot.blockAt(new Vec3(higherX, botY + 2, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXHeadHeight = [
    bot.blockAt(new Vec3(higherX, botY + 1, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY + 1, botZ)),
    bot.blockAt(new Vec3(higherX, botY + 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXFeetHeight = [
    bot.blockAt(new Vec3(higherX, botY, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY, botZ)),
    bot.blockAt(new Vec3(higherX, botY, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const higherXBelowFeet = [
    bot.blockAt(new Vec3(higherX, botY - 1, botZ - 1)),
    bot.blockAt(new Vec3(higherX, botY - 1, botZ)),
    bot.blockAt(new Vec3(higherX, botY - 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  result += `above_head: ${higherXAboveHead}\n`;
  result += `head_height: ${higherXHeadHeight}\n`;
  result += `feet_height: ${higherXFeetHeight}\n`;
  result += `below_feet: ${higherXBelowFeet}\n\n`;

  // Direction: lower x (x-1)
  const lowerX = botX - 1;
  result += `direction lower x (x=${lowerX}) :\n\n`;

  const lowerXAboveHead = [
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ)),
    bot.blockAt(new Vec3(lowerX, botY + 2, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXHeadHeight = [
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ)),
    bot.blockAt(new Vec3(lowerX, botY + 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXFeetHeight = [
    bot.blockAt(new Vec3(lowerX, botY, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY, botZ)),
    bot.blockAt(new Vec3(lowerX, botY, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  const lowerXBelowFeet = [
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ - 1)),
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ)),
    bot.blockAt(new Vec3(lowerX, botY - 1, botZ + 1))
  ].map(b => b?.name || 'null').join(', ');

  result += `above_head: ${lowerXAboveHead}\n`;
  result += `head_height: ${lowerXHeadHeight}\n`;
  result += `feet_height: ${lowerXFeetHeight}\n`;
  result += `below_feet: ${lowerXBelowFeet}\n\n`;

  // Direction: higher z (z+1)
  const higherZ = botZ + 1;
  result += `direction higher z (z=${higherZ}) :\n\n`;

  const higherZAboveHead = bot.blockAt(new Vec3(botX, botY + 2, higherZ))?.name || 'null';
  const higherZHeadHeight = bot.blockAt(new Vec3(botX, botY + 1, higherZ))?.name || 'null';
  const higherZFeetHeight = bot.blockAt(new Vec3(botX, botY, higherZ))?.name || 'null';
  const higherZBelowFeet = bot.blockAt(new Vec3(botX, botY - 1, higherZ))?.name || 'null';

  result += `above_head: ${higherZAboveHead}\n`;
  result += `head_height: ${higherZHeadHeight}\n`;
  result += `feet_height: ${higherZFeetHeight}\n`;
  result += `below_feet: ${higherZBelowFeet}\n\n`;

  // Direction: lower z (z-1)
  const lowerZ = botZ - 1;
  result += `direction lower z (z=${lowerZ}) :\n\n`;

  const lowerZAboveHead = bot.blockAt(new Vec3(botX, botY + 2, lowerZ))?.name || 'null';
  const lowerZHeadHeight = bot.blockAt(new Vec3(botX, botY + 1, lowerZ))?.name || 'null';
  const lowerZFeetHeight = bot.blockAt(new Vec3(botX, botY, lowerZ))?.name || 'null';
  const lowerZBelowFeet = bot.blockAt(new Vec3(botX, botY - 1, lowerZ))?.name || 'null';

  result += `above_head: ${lowerZAboveHead}\n`;
  result += `head_height: ${lowerZHeadHeight}\n`;
  result += `feet_height: ${lowerZFeetHeight}\n`;
  result += `below_feet: ${lowerZBelowFeet}\n\n`;

  // Directly above head
  const aboveHead = bot.blockAt(new Vec3(botX, botY + 2, botZ))?.name || 'null';
  result += `above head: ${aboveHead}\n\n`;

  // At bot head (where the head actually is)
  const atHead = bot.blockAt(new Vec3(botX, botY + 1, botZ))?.name || 'null';
  result += `at head: ${atHead}\n\n`;

  // At bot feet (where the feet actually are)
  const atFeet = bot.blockAt(new Vec3(botX, botY, botZ))?.name || 'null';
  result += `at feet: ${atFeet} (x,y,z=${botX},${botY},${botZ}) \n\n`;

  // Directly below feet
  const belowFeet = bot.blockAt(new Vec3(botX, botY - 1, botZ))?.name || 'null';
  result += `below feet: ${belowFeet}`;

  return result;
}

function didArriveAtTarget(bot: Bot, target: Vec3): {arrived: boolean, distance: number} {
  const DISTANCE_THRESHOLD = 1.5;
  const VERTICAL_THRESHOLD = 0;
  const currentPos = bot.entity.position;
  const distance = currentPos.distanceTo(target);
  const verticalDist = Math.abs(currentPos.y - target.y);
  const arrived = distance <= DISTANCE_THRESHOLD && verticalDist <= VERTICAL_THRESHOLD;

  return {
    arrived,
    distance
  };
}

async function moveOneStep(
  bot: Bot,
  target: Vec3,
  allowPillarUpWith: string[],
  allowMiningOf: Record<string, string[]>,
  digTimeout: number,
  allowDigDown: boolean = true
): Promise<{
  blocksMined: number;
  movedBlocksCloser: number;
  pillaredUpBlocks: number;
  error?: string;
}> {
  console.log("Running moveOneStep")
  const currentPos = bot.entity.position;
  const initialDistance = getDistance(bot, target);

  // If we're close horizontally (≤1 block in XZ), skip horizontal movement and try pillaring
  const horizontalDist = Math.sqrt(
    Math.pow(currentPos.x - target.x, 2) +
    Math.pow(currentPos.z - target.z, 2)
  );

  if (horizontalDist <= 1.0 && target.y > currentPos.y) {
    // We're close horizontally and need to go up - center in both axes and try pillaring directly
    await strafeToMiddleBothXZ(bot);

    const pillarResult = await tryPillaringUpIfSensible(bot, target, allowPillarUpWith, allowMiningOf, digTimeout);

    if (pillarResult.success) {
      return {
        blocksMined: 0,
        movedBlocksCloser: pillarResult.movedBlocksCloser,
        pillaredUpBlocks: pillarResult.pillaredUpBlocks
      };
    } else {
      // Pillaring failed - return the error so we know what went wrong
      return {
        blocksMined: 0,
        movedBlocksCloser: 0,
        pillaredUpBlocks: 0,
        error: `Close horizontally (${horizontalDist.toFixed(2)}b), tried pillar: ${pillarResult.error}`
      };
    }
  }

  // 1. Get the next axis-aligned direction to move toward target
  const direction = getNextDirection(bot, target);

  // 2. Look in movement direction
  const lookTarget = currentPos.offset(direction.x * 5, 0, direction.z * 5);
  await bot.lookAt(lookTarget, false);

  // 3. Strafe to center if needed (to avoid shoulder collisions)
  await strafeToMiddle(bot);

  const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

  const log: string[] = [];

  // Path forwards empty?
  if (isBlockEmpty(blockAheadOfHead) && isBlockEmpty(blockAheadOfFeet)) {
    if (await walkForwardsIfPossible(bot, currentPos, direction)) {
      log.push("Walked")
      const movedCloser = initialDistance - getDistance(bot, target);
      return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
    }
    log.push("Walk: failed to walk forward even though path appears clear");
  }

  // Path forwards blocked?
  if (!isBlockEmpty(blockAheadOfHead) && !isBlockEmpty(blockAheadOfFeet)) {
    const mineResult = await mineForwardsIfPossible(
      bot, currentPos, direction, allowMiningOf, digTimeout
    );

    if (mineResult.success) {
      log.push("Mined.")
      return {
        blocksMined: mineResult.blocksMined,
        movedBlocksCloser: initialDistance - getDistance(bot, target),
        pillaredUpBlocks: 0,
        error: log.join("; ")
      }
    } else {
      log.push(`Mine error: ${mineResult.error}`);
    }
  }

  // Only the bottom blocked?
  if (isBlockEmpty(blockAheadOfHead) && !isBlockEmpty(blockAheadOfFeet)) {
    const jumpResult = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target);
    if (jumpResult.success) {
      log.push("Jumped over object")
      const movedCloser = initialDistance - getDistance(bot, target);
      return { blocksMined: 0, movedBlocksCloser: movedCloser, pillaredUpBlocks: 0 };
    } else {
      log.push(`Jump: ${jumpResult.error}`);
    }
  }

  const pillarResult = await tryPillaringUpIfSensible(bot, target, allowPillarUpWith, allowMiningOf, digTimeout);

  if (!pillarResult.success) {
    log.push(`Pillar: ${pillarResult.error}`);
  } else {
    log.push("Did pillar-up")
    return {
      blocksMined: 0,
      movedBlocksCloser: pillarResult.movedBlocksCloser,
      pillaredUpBlocks: pillarResult.pillaredUpBlocks
    };
  }

  // Try digging down if allowed
  if (allowDigDown) {
    const digDownResult = await digDirectlyDownIfPossible(bot, 1, allowMiningOf, digTimeout);
    if (digDownResult.success) {
      log.push("Dug down")
      return {
        blocksMined: digDownResult.blocksMined,
        movedBlocksCloser: initialDistance - getDistance(bot, target),
        pillaredUpBlocks: 0
      };
    } else {
      log.push(`Dig down: ${digDownResult.error}`);
    }
  }

  return {
    blocksMined: 0,
    movedBlocksCloser: initialDistance - getDistance(bot, target),
    pillaredUpBlocks: 0,
    error: log.join("; ")
  };
}

function registerPositionTools(server: McpServer, bot: Bot) {
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

        return createResponse("Successfully jumped in place");
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
          const startPos = bot.entity.position.clone();
          bot.setControlState(direction, true);

          setTimeout(() => {
            bot.setControlState(direction, false);
            const endPos = bot.entity.position.clone();
            const distance = startPos.distanceTo(endPos);
            resolve(createResponse(`Moved ${direction} for ${duration}ms. Distance: ${distance.toFixed(2)} blocks. If stuck, consider show-adjacent-blocks, or a higher level tool like the pathfinder / stairs`));
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
          `Pillared up ${blocksPlaced} blocks (from Y=${startY} to Y=${finalY})${clearMessage}`
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
          `Centered bot: (${posBefore.x.toFixed(2)}, ${posBefore.z.toFixed(2)}) → (${posAfter.x.toFixed(2)}, ${posAfter.z.toFixed(2)})`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "center-bot-in-current-block",
    "If the bot is stuck even though it is trying to move in a direction that should be available: the bot might be at the edge of its block, and so centering might help",
    {
      executeStrafe: z
        .boolean()
        .optional()
        .describe("Whether to actually execute the strafe (default: true)"),
    },
    async ({ executeStrafe = true }): Promise<McpResponse> => {
      try {
        const currentPos = bot.entity.position;
        const yaw = bot.entity.yaw;

        // Get facing direction
        let facingDirection: AxisAlignedDirection;
        let facingName: string;
        try {
          facingDirection = getBotAxisAlignedDirection(bot);
          const normalizedYaw = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
          const degrees = (normalizedYaw * 180) / Math.PI;
          const rounded = Math.round(degrees / 90) * 90;
          switch ((rounded + 360) % 360) {
            case 0:   facingName = "South (+Z)"; break;
            case 90:  facingName = "West (-X)"; break;
            case 180: facingName = "North (-Z)"; break;
            case 270: facingName = "East (+X)"; break;
            default:  facingName = "Unknown"; break;
          }
        } catch (error) {
          return createResponse(
            `Bot is not axis-aligned.\n` +
            `Position: ${formatBotPosition(currentPos)}\n` +
            `Yaw: ${yaw.toFixed(2)} rad (${((yaw * 180) / Math.PI).toFixed(1)}°)\n` +
            `Error: ${formatError(error)}`
          );
        }

        // Determine which coordinate to check
        let perpCoord: number;
        let perpAxis: string;
        if (facingDirection.x !== 0) {
          perpCoord = currentPos.z;
          perpAxis = "Z";
        } else {
          perpCoord = currentPos.x;
          perpAxis = "X";
        }

        // Calculate alignment info
        const normalizedCoord = ((perpCoord % 1.0) + 1.0) % 1.0;
        const offsetFromCenter = normalizedCoord - 0.5;
        const ALIGNMENT_THRESHOLD = 0.1;
        const isAligned = Math.abs(offsetFromCenter) <= ALIGNMENT_THRESHOLD;

        // Get strafe direction info
        const strafeInfo = getStrafeDirectionAndAmount(bot);

        let result = `Bot Alignment Debug Info:\n\n`;
        result += `Position: ${formatBotPosition(currentPos)}\n`;
        result += `Yaw: ${yaw.toFixed(2)} rad (${((yaw * 180) / Math.PI).toFixed(1)}°)\n`;
        result += `Facing: ${facingName}\n\n`;
        result += `Perpendicular axis to check: ${perpAxis}\n`;
        result += `${perpAxis} coordinate: ${perpCoord.toFixed(3)}\n`;
        result += `Normalized (0-1 range): ${normalizedCoord.toFixed(3)}\n`;
        result += `Offset from center: ${offsetFromCenter.toFixed(3)} blocks\n`;
        result += `Threshold: ±${ALIGNMENT_THRESHOLD} blocks\n\n`;

        if (isAligned) {
          result += `✓ Bot is already centered (within threshold)\n`;
          result += `No strafe needed.`;
        } else {
          result += `✗ Bot needs centering\n`;
          if (strafeInfo) {
            result += `Strafe direction: ${strafeInfo.direction}\n`;
            result += `Strafe amount: ${strafeInfo.amount.toFixed(3)} blocks\n`;
            result += `Strafe duration: ${Math.round((strafeInfo.amount / 0.1) * 10)}ms\n\n`;

            if (executeStrafe) {
              const beforePos = bot.entity.position.clone();
              await strafeToMiddle(bot);
              const afterPos = bot.entity.position;

              // Calculate actual movement
              const moved = afterPos.distanceTo(beforePos);
              const newOffset = facingDirection.x !== 0
                ? (((afterPos.z % 1.0) + 1.0) % 1.0) - 0.5
                : (((afterPos.x % 1.0) + 1.0) % 1.0) - 0.5;

              result += `Strafe executed!\n`;
              result += `Before: ${formatBotPosition(beforePos)}\n`;
              result += `After: ${formatBotPosition(afterPos)}\n`;
              result += `Moved: ${moved.toFixed(3)} blocks\n`;
              result += `New offset from center: ${newOffset.toFixed(3)} blocks`;
            } else {
              result += `Strafe NOT executed (executeStrafe=false)`;
            }
          } else {
            result += `Warning: getStrafeDirectionAndAmount returned null even though bot is not aligned!\n`;
            result += `This might indicate a bug in the strafe logic.`;
          }
        }

        return createResponse(result);
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "look-ahead-not-diagonally",
    "Debug tool",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
    },
    async ({ targetX, targetY, targetZ }): Promise<McpResponse> => {
      try {
        const target = new Vec3(targetX, targetY, targetZ);
        const currentPos = bot.entity.position;
        const direction = getNextDirection(bot, target);
        const { blockAheadOfHead, blockAheadOfFeet } = getBlocksAhead(bot, currentPos, direction);

        const headInfo = blockAheadOfHead
          ? `${blockAheadOfHead.name} at ${formatBlockPosition(blockAheadOfHead.position)}`
          : 'air or null';
        const feetInfo = blockAheadOfFeet
          ? `${blockAheadOfFeet.name} at ${formatBlockPosition(blockAheadOfFeet.position)}`
          : 'air or null';

        return createResponse(
          `Looking ahead toward target (${targetX}, ${targetY}, ${targetZ}):\n` +
          `Block ahead of head: ${headInfo}\n` +
          `Block ahead of feet: ${feetInfo}`
        );
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "mine-forwards",
    "Mines the block ahead of the bot's head and ahead of the bot's feet, used to make progress underground",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
      allowMiningOf: z
        .record(z.string(), z.array(z.string()))
        .describe("Tool-to-blocks mapping for auto-mining: {wooden_pickaxe: ['stone', 'cobblestone'], ...}"),
      digTimeout: z
        .number()
        .optional()
        .describe("Timeout for digging in seconds (default: 3)"),
    },
    async ({ targetX, targetY, targetZ, allowMiningOf, digTimeout = 3 }): Promise<McpResponse> => {
      try {
        const target = new Vec3(targetX, targetY, targetZ);
        const currentPos = bot.entity.position;
        const direction = getNextDirection(bot, target);

        const result = await mineForwardsIfPossible(
          bot, currentPos, direction, allowMiningOf, digTimeout, true
        );

        if (result.success) {
          return createResponse(
            `Successfully mined ${result.blocksMined} block(s) ahead`
          );
        } else {
          return createResponse(result.error || "Failed to mine blocks");
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "jump-over-obstacle",
    "Jump over a small obstacle ahead of the bot in the direction toward target",
    {
      targetX: z.number().describe("Target X coordinate to determine direction"),
      targetY: z.number().describe("Target Y coordinate to determine direction"),
      targetZ: z.number().describe("Target Z coordinate to determine direction"),
    },
    async ({ targetX, targetY, targetZ }): Promise<McpResponse> => {
      try {
        const target = new Vec3(targetX, targetY, targetZ);
        const currentPos = bot.entity.position;
        const direction = getNextDirection(bot, target);

        const result = await jumpOverSmallObstacleIfPossible(bot, currentPos, direction, target);

        if (result.success) {
          return createResponse("Successfully jumped over obstacle");
        } else {
          return createResponse(result.error || "Failed to jump over obstacle");
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "mine-steps-down",
    "Mine down multiple steps in a staircase pattern by repeatedly clearing blocks and descending",
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
            `Successfully mined down ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}`
          );
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "mine-steps-up",
    "Mine up multiple steps in a staircase pattern by clearing blocks above and jumping up",
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
            `Successfully mined up ${result.stepsCompleted} step(s). Final position: ${formatBotPosition(finalPos)}`
          );
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );

  server.tool(
    "pathfind-and-move-or-dig-to",
    "Move to a target position with auto-mining and optional pillar-up",
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
      allowDigDown: z
        .boolean()
        .optional()
        .default(true)
        .describe("Allow digging down when stuck (ensures there's solid ground 2 blocks below before digging)"),
      maxIterations: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of movement iterations"),
    },
    async ({ x, y, z, allowPillarUpWith = [], allowMiningOf = {}, allowDigDown = true, maxIterations = 10 }): Promise<McpResponse> => {
      const startPos = bot.entity.position.clone();
      const startTime = Date.now();
      const target = new Vec3(x, y, z);
      const DIG_TIMEOUT_SECONDS = 3;

      try {
        let totalBlocksMined = 0;
        let totalPillaredBlocks = 0;
        const visitedPositions = new Set<string>();
        const stepLog: string[] = [];

        for (let iteration = 0; iteration < maxIterations; iteration++) {
          // Check if we've reached the target
          const arrivalCheck = didArriveAtTarget(bot, target);
          if (arrivalCheck.arrived) {
            const totalDist = startPos.distanceTo(bot.entity.position);
            const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            return createResponse(
              `Reached target (${x}, ${y}, ${z}) from ${formatBotPosition(startPos)}. ` +
              `Traveled ${totalDist.toFixed(1)} blocks in ${timeElapsed}s. Mined ${totalBlocksMined} blocks.\n` +
              `Steps: ${stepLog.join('; ')}`
            );
          }

          const posBeforeStep = bot.entity.position.clone();
          const stepResult = await moveOneStep(
            bot, target,
            allowPillarUpWith, allowMiningOf, DIG_TIMEOUT_SECONDS, allowDigDown
          );
          const posAfterStep = bot.entity.position.clone();

          // Log what happened in this step
          const stepDesc = [];
          if (stepResult.blocksMined > 0) stepDesc.push(`mined ${stepResult.blocksMined}`);
          if (stepResult.pillaredUpBlocks > 0) stepDesc.push(`pillared ${stepResult.pillaredUpBlocks}`);
          if (stepResult.movedBlocksCloser !== 0) stepDesc.push(`moved ${stepResult.movedBlocksCloser.toFixed(1)}b`);
          if (stepResult.error) stepDesc.push(stepResult.error);
          stepLog.push(`[${iteration+1}] ${formatBotPosition(posAfterStep)}: ${stepDesc.join(', ') || 'no action'}`);

          totalBlocksMined += stepResult.blocksMined;
          totalPillaredBlocks += stepResult.pillaredUpBlocks;

          // Check for circular movement
          const currentPos = bot.entity.position;
          const posKey = `${Math.floor(currentPos.x)},${Math.floor(currentPos.y)},${Math.floor(currentPos.z)}`;
          if (visitedPositions.has(posKey)) {
            const distRemaining = currentPos.distanceTo(target);
            const distTraveled = startPos.distanceTo(currentPos);
            return createResponse(
              `Detected circular movement: returned to position ${formatBotPosition(currentPos)} after ${iteration + 1} iteration(s). ` +
              `Traveled ${distTraveled.toFixed(1)} blocks, mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ` +
              `${distRemaining.toFixed(1)} blocks remaining to target.\n` +
              `Steps: ${stepLog.join('; ')}`
            );
          }
          visitedPositions.add(posKey);

          // Check if we made progress this iteration
          const madeProgress = stepResult.blocksMined > 0 ||
                              stepResult.movedBlocksCloser != 0 || // We might temporarily get further away, but at least we don't stay in place
                              stepResult.pillaredUpBlocks > 0;

          if (!madeProgress && iteration > 0) {
            const distRemaining = bot.entity.position.distanceTo(target);
            const distTraveled = startPos.distanceTo(bot.entity.position);

            return createResponse(
              `${stepResult.error || "Stuck at this iteration with no info from moveOneStep (probably a bug: info should normally be available)"}. ` +
              `Progress after ${iteration} iteration(s): traveled ${distTraveled.toFixed(1)} blocks, ` +
              `mined ${totalBlocksMined} blocks, pillared ${totalPillaredBlocks} blocks, ` +
              `${distRemaining.toFixed(1)} blocks remaining to target.\n` +
              `Steps: ${stepLog.join('; ')}`
            );
          }
        }

        // Max iterations reached - calculate progress stats (reusing same calculation as above)
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

function registerInventoryTools(server: McpServer, bot: Bot) {
  server.tool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async (): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const itemList: InventoryItem[] = items.map((item) => ({
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

function getLightLevel(light: number | undefined): string {
  if (light === undefined || light === null) {
    return "light: ?/15";
  }
  return `light: ${light}/15`;
}

function registerBlockTools(server: McpServer, bot: Bot) {
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

        // Check light level before digging
        const lightLevel = block.light;

        // Use tryMiningOneBlock if tools mapping provided, otherwise use current tool
        const result = await tryMiningOneBlock(bot, block, allowedMiningToolsToMinedBlocks, digTimeout, true);

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
    "find-block-by-type",
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

        limitedItems.forEach((item, index) => {
          const pos = item.position;
          const marker = item.category === 'entity' ? '[ENTITY]' : '[BLOCK]';
          output += `${index + 1}. ${marker} ${item.type} | count=${item.count} | closest_distance=${item.distance.toFixed(1)} | closest_xyz=${formatBlockPosition(pos)}\n`;
        });

        output += `If you wanted the blocks adjacent to the bot (e.g if stuck), use show-adjacent-blocks instead. To reach one of these blocks, consider pathfind-and-move-to`

        return createResponse(output.trim());
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}

// ========== Entity Interaction Tools ==========

function registerEntityTools(server: McpServer, bot: Bot) {
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

function registerChatTools(server: McpServer, bot: Bot) {
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

function registerGameStateTools(server: McpServer, bot: Bot) {
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

async function main() {
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
