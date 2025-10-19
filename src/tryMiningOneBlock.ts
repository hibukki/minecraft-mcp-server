import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { formatError } from "./bot_log.js";
import { MiningResult, formatBlockPosition, formatBotPosition, isPathClear, digWithTimeout } from "./movement.js";

/**
 * Try to mine a single block using the provided tool-to-blocks mapping
 * Returns detailed error info if mining fails, and count of blocks mined
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
  let tool = null;
  for (const [toolName, blockNames] of Object.entries(allowedMiningToolsToMinedBlocks)) {
    if (blockNames.includes(block.name)) {
      // "hand" means use empty hand (no tool), so skip inventory search
      if (toolName === "hand") {
        tool = "hand" as any; // Sentinel value to indicate we found a match but don't need to equip
        break;
      }
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
    return {
      success: false,
      blocksMined: 0,
      error: `Block ${block.name} at ${formatBlockPosition(blockPos)} missing from allowedMiningToolsToMinedBlocks input parameter, add it if you want to mine it.`
    };
  }

  // Equip tool if found (unless it's "hand" which means use empty hand)
  if (tool && tool !== "hand") {
    await bot.equip(tool, 'hand');
  } else if (tool === "hand") {
    // Unequip to use empty hand
    await bot.unequip('hand');
  }

  // Look at the block
  await bot.lookAt(blockPos.offset(0.5, 0.5, 0.5), true);

  // Check if there's a clear path to the block
  const pathCheck = isPathClear(bot, botPos, blockPos.offset(0.5, 0.5, 0.5));
  if (!pathCheck.clear) {
    const blockingInfo = pathCheck.blockingBlocks.length > 0
      ? ` Blocking block(s): ${pathCheck.blockingBlocks.map(b => `${b.name} at ${formatBlockPosition(b.position)}`).join(', ')}`
      : ' Path is obstructed';
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
