#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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

type Direction = 'forward' | 'back' | 'left' | 'right';
type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

interface StoredMessage {
  timestamp: number;
  username: string;
  content: string;
}


// ========== Command Line Argument Parsing ==========

function parseCommandLineArgs() {
  return yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}

// ========== Logging and Responding ==========

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string) {
  const timestamp = new Date().toISOString();
  process.stderr.write(`${timestamp} [minecraft] [${level}] ${message}\n`);
}

function createResponse(text: string): McpResponse {
  return {
    content: [{ type: "text", text }]
  };
}

function createErrorResponse(error: Error | string): McpResponse {
  const errorMessage = formatError(error);
  log('error', errorMessage);
  return {
    content: [{ type: "text", text: `Failed: ${errorMessage}` }],
    isError: true
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
      content
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
  bot.once('spawn', async () => {

    // Set up pathfinder movements
    const mcData = minecraftData(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    bot.chat('LLM-powered bot ready to receive instructions!');
    log('info', `Server started and connected successfully. Bot: ${argv.username} on ${argv.host}:${argv.port}`);
  });

  // Register common event handlers
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    messageStore.addMessage(username, message);
  });

  bot.on('kicked', (reason) => {
    log('error', `Bot was kicked: ${formatError(reason)}`);
    bot.quit();
  });

  bot.on('error', (err) => {
    log('error', `Bot error: ${formatError(err)}`);
  });

  return bot;
}

// ========== MCP Server Configuration ==========

function createMcpServer(bot: mineflayer.Bot) {
  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "1.2.0"
  });

  // Register all tool categories
  registerCraftingTools(server, bot);
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
    },
    async ({ itemName, count = 1 }): Promise<McpResponse> => {
      try {
        const mcData = minecraftData(bot.version);
        const itemsByName = mcData.itemsByName;

        // Find the item to craft
        const item = itemsByName[itemName];
        if (!item) {
          return createResponse(
            `Unknown item: ${itemName}. Make sure to use the exact item name (e.g., 'oak_planks', 'crafting_table')`
          );
        }

        const allRecipes = bot.recipesAll(item.id, null, null);
        if (allRecipes.length === 0) {
          return createResponse(
            `No recipe found for ${itemName}.`
          );
        }

        const requiresCraftingTable = allRecipes.every((r: any) => r.requiresTable);

        let maybeCraftingTable = null;

        if (requiresCraftingTable) {
          maybeCraftingTable = bot.findBlock({
            matching: mcData.blocksByName.crafting_table?.id,
            maxDistance: 32,
          });

          if (!maybeCraftingTable) {
            return createResponse(
              `Cannot craft ${itemName}: requires a crafting table, but none found within 32 blocks.`
            );
          }
        }

        const craftableRecipes = bot.recipesFor(item.id, null, 1, maybeCraftingTable);
        if (craftableRecipes.length === 0) {
          return createResponse(
            `Cannot craft ${itemName}: missing required materials.`
          );
        }

        const recipe = craftableRecipes[0];
        await bot.craft(recipe, count, maybeCraftingTable || undefined);
        return createResponse(`Successfully crafted ${count}x ${itemName}`);
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
          z: Math.floor(position.z)
        };

        return createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
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
      range: z.number().optional().describe("How close to get to the target (default: 1)")
    },
    async ({ x, y, z, range = 1 }): Promise<McpResponse> => {
      try {
        const goal = new goals.GoalNear(x, y, z, range);
        await bot.pathfinder.goto(goal);

        return createResponse(`Successfully moved to position near (${x}, ${y}, ${z})`);
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
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 250);

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
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().optional().describe("Duration in milliseconds (default: 1000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }): Promise<McpResponse> => {
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
          slot: item.slot
        }));

        if (items.length === 0) {
          return createResponse("Inventory is empty");
        }

        let inventoryText = `Found ${items.length} items in inventory:\n\n`;
        itemList.forEach(item => {
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
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const item = items.find((item: any) =>
          item.name.includes(nameOrType.toLowerCase())
        );

        if (item) {
          return createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
        } else {
          return createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
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
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }): Promise<McpResponse> => {
      try {
        const items = bot.inventory.items();
        const item = items.find((item: any) =>
          item.name.includes(itemName.toLowerCase())
        );

        if (!item) {
          return createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
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
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async ({ x, y, z, faceDirection = 'down' }: { x: number, y: number, z: number, faceDirection?: FaceDirection }): Promise<McpResponse> => {
      try {
        const placePos = new Vec3(x, y, z);
        const blockAtPos = bot.blockAt(placePos);
        if (blockAtPos && blockAtPos.name !== 'air') {
          return createResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
        }

        const possibleFaces: FaceOption[] = [
          { direction: 'down', vector: new Vec3(0, -1, 0) },
          { direction: 'north', vector: new Vec3(0, 0, -1) },
          { direction: 'south', vector: new Vec3(0, 0, 1) },
          { direction: 'east', vector: new Vec3(1, 0, 0) },
          { direction: 'west', vector: new Vec3(-1, 0, 0) },
          { direction: 'up', vector: new Vec3(0, 1, 0) }
        ];

        // Prioritize the requested face direction
        if (faceDirection !== 'down') {
          const specificFace = possibleFaces.find(face => face.direction === faceDirection);
          if (specificFace) {
            possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
          }
        }

        // Try each potential face for placing
        for (const face of possibleFaces) {
          const referencePos = placePos.plus(face.vector);
          const referenceBlock = bot.blockAt(referencePos);

          if (referenceBlock && referenceBlock.name !== 'air') {
            if (!bot.canSeeBlock(referenceBlock)) {
              // Try to move closer to see the block
              const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
              await bot.pathfinder.goto(goal);
            }

            await bot.lookAt(placePos, true);

            try {
              await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
              return createResponse(`Placed block at (${x}, ${y}, ${z}) using ${face.direction} face`);
            } catch (placeError) {
              log('warn', `Failed to place using ${face.direction} face: ${formatError(placeError)}`);
              continue;
            }
          }
        }

        return createResponse(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
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
    },
    async ({ x, y, z }): Promise<McpResponse> => {
      try {
        const blockPos = new Vec3(x, y, z);
        const block = bot.blockAt(blockPos);

        if (!block || block.name === 'air') {
          return createResponse(`No block found at position (${x}, ${y}, ${z})`);
        }

        if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
          // Try to move closer to dig the block
          const goal = new goals.GoalNear(x, y, z, 2);
          await bot.pathfinder.goto(goal);
        }

        await bot.dig(block);

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
          return createResponse(`No block information found at position (${x}, ${y}, ${z})`);
        }

        return createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
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
      maxDistance: z.number().optional().describe("Maximum search distance (default: 16)")
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
          maxDistance: maxDistance
        });

        if (!block) {
          return createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
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
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.number().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type = '', maxDistance = 16 }): Promise<McpResponse> => {
      try {
        const entityFilter = (entity: any) => {
          if (!type) return true;
          if (type === 'player') return entity.type === 'player';
          if (type === 'mob') return entity.type === 'mob';
          return entity.name && entity.name.includes(type.toLowerCase());
        };

        const entity = bot.nearestEntity(entityFilter);

        if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
          return createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
        }

        return createResponse(`Found ${entity.name || (entity as any).username || entity.type} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
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
      message: z.string().describe("Message to send in chat")
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
      count: z.number().optional().describe("Number of recent messages to retrieve (default: 10, max: 100)")
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
          output += `${index + 1}. ${timestamp} - ${msg.username}: ${msg.content}\n`;
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
      z: z.number().describe("Z coordinate")
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

        return createResponse(`Successfully flew to position (${x}, ${y}, ${z}).`);
      } catch (error) {
        if (controller.signal.aborted) {
          const currentPosAfterTimeout = bot.entity.position;
          return createErrorResponse(
            `Flight timed out after ${FLIGHT_TIMEOUT_MS / 1000} seconds. The destination may be unreachable. ` +
            `Current position: (${Math.floor(currentPosAfterTimeout.x)}, ${Math.floor(currentPosAfterTimeout.y)}, ${Math.floor(currentPosAfterTimeout.z)})`
          );
        }

        log('error', `Flight error: ${formatError(error)}`);
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

    controller.signal.addEventListener('abort', () => {
      aborted = true;
      bot.creative.stopFlying();
      reject(new Error("Flight operation cancelled"));
    });

    bot.creative.flyTo(destination)
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
    process.stdin.on('end', () => {
      if (bot) bot.quit();
      log('info', 'MCP Client has disconnected. Shutting down...');
      process.exit(0);
    });

    // Connect to the transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    if (bot) bot.quit();
    log('error', `Failed to start server: ${formatError(error)}`);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  log('error', `Fatal error in main(): ${formatError(error)}`);
  process.exit(1);
});