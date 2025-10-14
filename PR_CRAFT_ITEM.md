# PR: Add craft-item tool

## Description

Adds a `craft-item` MCP tool that allows the bot to craft items using available materials in their inventory.

## Features

- Looks up recipes for requested items using minecraft-data
- Automatically finds nearby crafting tables when needed (within 32 blocks)
- Supports crafting multiple items at once with the `count` parameter
- Provides helpful error messages:
  - Unknown item names
  - Missing materials
  - Missing crafting table when required
  - Recipe not found

## Usage Example

```typescript
// In Claude Desktop chat:
"Craft 4 oak planks from the oak logs in your inventory"
// Bot calls: craft-item with itemName="oak_planks", count=4

"Make a wooden pickaxe"
// Bot calls: craft-item with itemName="wooden_pickaxe", count=1
```

## Implementation Details

- Uses `bot.recipesFor()` to find available recipes
- Uses `bot.craft()` to perform the crafting
- Searches for crafting tables using `bot.findBlock()` with 32 block radius
- Handles both 2x2 inventory crafting and 3x3 crafting table recipes

## Testing

Tested successfully crafting:
- Oak planks (no crafting table needed)
- Crafting table (no crafting table needed)
- Wooden tools (crafting table required)
- Multiple items in a single craft operation

## Files Changed

- `src/bot.ts`: Added `registerCraftingTools()` function and `craft-item` tool
- Tool registered in `createMcpServer()`

---

## Clean Diff (without .mcp.json)

The actual PR should only include the `src/bot.ts` changes, not the `.mcp.json` file which contains personal server configuration.

### src/bot.ts changes:

1. Add to `createMcpServer()` (around line 200):
```typescript
registerCraftingTools(server, bot);
```

2. Add new section before Game State Tools (around line 708):
```typescript
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

        // Find a crafting table if needed (for recipes that require it)
        const craftingTable = bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 32,
        });

        // Find the recipe for this item
        const recipes = bot.recipesFor(item.id, null, 1, craftingTable);
        if (recipes.length === 0) {
          return createResponse(
            `No recipe found for ${itemName}. Make sure you have the required materials${
              craftingTable ? "." : " or place a crafting table nearby."
            }`
          );
        }

        // Use the first available recipe
        const recipe = recipes[0];

        // Craft the item
        try {
          await bot.craft(recipe, count, craftingTable || undefined);
          return createResponse(`Successfully crafted ${count}x ${itemName}`);
        } catch (craftError) {
          const errorMsg =
            craftError instanceof Error
              ? craftError.message
              : String(craftError);
          // Provide helpful error messages
          if (errorMsg.includes("recipe")) {
            return createResponse(
              `Cannot craft ${itemName}: Recipe not found or missing required materials. You may need a crafting table nearby.`
            );
          }
          if (errorMsg.includes("material")) {
            return createResponse(
              `Cannot craft ${itemName}: Missing required materials.`
            );
          }
          return createErrorResponse(craftError as Error);
        }
      } catch (error) {
        return createErrorResponse(error as Error);
      }
    }
  );
}
```

## Notes for Upstream PR

- This is a clean feature addition with no breaking changes
- Integrates well with existing MCP tool pattern
- Uses existing mineflayer crafting API
- Should we add this to the README's "Available Commands" section?
