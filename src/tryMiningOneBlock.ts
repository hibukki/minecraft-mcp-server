import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { formatError } from "./bot_log.js";
import { MiningResult, formatBlockPosition, formatBotPosition, isPathClear, digWithTimeout } from "./movement.js";

// Block categories and their optimal tool types
const SHOVEL_BLOCKS = new Set([
  'dirt', 'grass_block', 'sand', 'gravel', 'clay', 'soul_sand', 'soul_soil',
  'snow', 'snow_block', 'podzol', 'mycelium', 'coarse_dirt', 'rooted_dirt',
  'farmland', 'grass_path', 'mud', 'muddy_mangrove_roots'
]);

const PICKAXE_BLOCKS = new Set([
  'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate',
  'netherrack', 'end_stone', 'sandstone', 'red_sandstone', 'basalt', 'blackstone',
  'obsidian', 'crying_obsidian', 'ancient_debris', 'nether_bricks', 'red_nether_bricks',
  'prismarine', 'prismarine_bricks', 'dark_prismarine', 'terracotta', 'coal_ore',
  'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'copper_ore', 'deepslate_coal_ore',
  'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
  'deepslate_lapis_ore', 'deepslate_redstone_ore', 'deepslate_copper_ore',
  'bricks', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks',
  'ice', 'packed_ice', 'blue_ice', 'frosted_ice'
]);

const AXE_BLOCKS = new Set([
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood',
  'acacia_wood', 'dark_oak_wood', 'mangrove_wood', 'cherry_wood',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crafting_table', 'bookshelf',
  'chest', 'barrel', 'fence', 'fence_gate', 'ladder', 'sign', 'door'
]);

// Tool tier ordering (higher index = better tool)
const TOOL_TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];

/**
 * Find the best tool in inventory for mining a specific block
 * Returns the best tool item, or null if no appropriate tool found
 */
function findBestToolForBlock(bot: Bot, blockName: string): Item | null {
  const inventory = bot.inventory.items();

  // Determine which tool type is best for this block
  let toolType: string | null = null;
  if (SHOVEL_BLOCKS.has(blockName)) {
    toolType = 'shovel';
  } else if (PICKAXE_BLOCKS.has(blockName)) {
    toolType = 'pickaxe';
  } else if (AXE_BLOCKS.has(blockName)) {
    toolType = 'axe';
  }

  if (!toolType) {
    // No specific tool needed for this block, can use hand
    return null;
  }

  // Find all tools of the appropriate type in inventory
  const matchingTools = inventory.filter(item =>
    item.name.includes(toolType)
  );

  if (matchingTools.length === 0) {
    return null;
  }

  // Sort by tier (best first)
  matchingTools.sort((a, b) => {
    const aTier = TOOL_TIERS.findIndex(tier => a.name.startsWith(tier));
    const bTier = TOOL_TIERS.findIndex(tier => b.name.startsWith(tier));
    return bTier - aTier; // Higher tier first
  });

  return matchingTools[0];
}

/**
 * Try to mine a single block using the provided tool-to-blocks mapping
 * Returns detailed error info if mining fails, and count of blocks mined
 *
 * Enhanced with auto-tool-selection: if no tool is specified in allowedMiningToolsToMinedBlocks
 * for a block, the function will automatically find and use the best available tool in inventory
 */

export async function tryMiningOneBlock(
  bot: Bot,
  block: Block,
  allowedMiningToolsToMinedBlocks: Record<string, string[]>,
  digTimeout: number = 3,
  allowMiningDiagonalBlocks: boolean = false
): Promise<MiningResult> {
  const botPos = bot.entity.position;
  const blockPos = block.position;
  const distance = botPos.distanceTo(blockPos);

  // Don't walk
  bot.setControlState('forward', false);

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
  let tool: Item | "hand" | null = null;
  let toolSource: "explicit" | "auto" = "auto";

  // First, check if a tool is explicitly specified in allowedMiningToolsToMinedBlocks
  for (const [toolName, blockNames] of Object.entries(allowedMiningToolsToMinedBlocks)) {
    if (blockNames.includes(block.name)) {
      toolSource = "explicit";
      // "hand" means use empty hand (no tool), so skip inventory search
      if (toolName === "hand") {
        tool = "hand" as any; // Sentinel value to indicate we found a match but don't need to equip
        break;
      }
      const foundTool = bot.inventory.items().find(item => item.name === toolName);
      if (!foundTool) {
        return {
          success: false,
          blocksMined: 0,
          error: `Tool ${toolName} needed to mine ${block.name} at ${formatBlockPosition(blockPos)} but not found in inventory`
        };
      }
      tool = foundTool;
      break;
    }
  }

  // If no explicit tool found, try auto-tool-selection
  if (!tool) {
    const autoTool = findBestToolForBlock(bot, block.name);
    if (autoTool) {
      tool = autoTool;
      toolSource = "auto";
    } else {
      // No appropriate tool found in inventory, will use hand
      // Only error if allowedMiningToolsToMinedBlocks is non-empty and this block wasn't listed
      if (Object.keys(allowedMiningToolsToMinedBlocks).length > 0) {
        return {
          success: false,
          blocksMined: 0,
          error: `Block ${block.name} at ${formatBlockPosition(blockPos)} missing from allowedMiningToolsToMinedBlocks input parameter, add it if you want to mine it.`
        };
      }
      // If allowedMiningToolsToMinedBlocks is empty, we're in full auto mode - use hand for unknown blocks
      tool = "hand";
    }
  }

  // Equip tool if found (unless it's "hand" which means use empty hand)
  if (tool && tool !== "hand") {
    await bot.equip(tool, 'hand');
  } else if (tool === "hand") {
    // Unequip to use empty hand
    // Try to unequip current item if any
    if (bot.heldItem) {
      try {
        await bot.unequip('hand');
      } catch (error) {
        // If unequip fails, try to find an empty hotbar slot and switch to it
        const emptySlot = bot.inventory.slots.findIndex((slot, idx) =>
          idx >= bot.inventory.hotbarStart && idx < bot.inventory.hotbarStart + 9 && slot === null
        );
        if (emptySlot !== -1) {
          await bot.setQuickBarSlot(emptySlot - bot.inventory.hotbarStart);
        }
      }
    }
    // Verify hand is now empty
    if (bot.heldItem) {
      // Still holding something - this shouldn't happen but log it
      const heldItemName = bot.heldItem.name;
      // Continue anyway - bot.canDigBlock will catch if it's actually a problem
    }
  }

  // Look at the block
  await bot.lookAt(blockPos.offset(0.5, 0.5, 0.5), true);

  // Check if there's a clear path to the block
  const pathCheck = isPathClear(bot, botPos, blockPos.offset(0.5, 0.5, 0.5));
  if (!pathCheck.clear) {
    const blockingInfo = pathCheck.blockingBlocks.length > 0
      ? ` Blocking block(s): ${pathCheck.blockingBlocks.map(b => `${b.name} at ${formatBlockPosition(b.position)}`).join(', ')}`
      : ' Maybe dig those blocks first.';
    return {
      success: false,
      blocksMined: 0,
      error: `No clear path to ${block.name} at ${formatBlockPosition(blockPos)}.${blockingInfo}`
    };
  }

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
    return { success: true, blocksMined: 1 };
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
