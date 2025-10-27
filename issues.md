# MCP Server Issues Found During Diamond Gear Quest

## Issue 3: craft-item reports error but successfully crafts items

**Steps to reproduce:**
1. Had 4 birch_log in inventory
2. Called `craft-item` with itemName="birch_planks", count=4, useCraftingTable=false
3. Received error in response

**Expected behavior:**
Either succeed silently or fail with error - not both

**Actual behavior:**
Response text: "Cannot craft birch_planks: missing required materials. Inventory: birch_planks(x16)"
But updates showed: `"inventory": [{"item": "birch_planks", "gained": 16}]`
The craft succeeded and created 16 planks (4 logs × 4 planks each) but reported failure

---

## Issue 4: place-block fails with "No suitable reference block found"

**Steps to reproduce:**
1. Bot position: (20, 64, 1)
2. Called `place-block` with blockName="crafting_table", position (20, 64, 2)
3. Checked surrounding blocks - mix of air, grass_block, leaf_litter

**Expected behavior:**
Place crafting table at the specified position

**Actual behavior:**
Error: "Failed to place block at (20, 64, 2): No suitable reference block found"

**Additional observations:**
- Later attempts at other positions succeeded without issue
- Unclear what makes a reference block "suitable"
- Same block type (crafting_table) worked at (29, 64, 26) and (18, 65, 44)

**Suggestion:**
- Missing what the surrounding blocks are and where, we can check if this bug is obvious but might ignore this issue because not enough info exists

---

## Issue 5: dig-directly-down doesn't auto-equip tools from allowMiningOf

**Steps to reproduce:**
1. Had wooden_shovel in inventory (optimal for dirt)
2. Called `dig-directly-down` with blocksToDigDown=4, allowMiningOf={"hand": ["dirt", "grass_block", "leaf_litter"]}
3. Bot started digging dirt

**Expected behavior:**
Bot should use wooden_shovel for dirt (or at minimum, use hand as specified)

**Actual behavior:**
Error: "Digging is very slow (3.0s). Block: dirt. Using: dirt. Wrong tool?"
Bot equipped dirt block instead of proper tool, causing timeout

**Additional observations:**
- The allowMiningOf parameter appears to be ignored for tool selection
- Bot held the last mined item (dirt) instead of selecting from allowMiningOf

**Suggestion:**
- Check if this is an obvious bug, otherwise ignore

---

## Issue 6: craft-item fails claiming missing materials when materials exist

**Steps to reproduce:**
1. Inventory contained: stick(x16), birch_sapling(x2), and had placed crafting table nearby
2. Called `craft-item` with itemName="wooden_pickaxe", useCraftingTable=true
3. Recipe requires: 3 planks + 2 sticks

**Expected behavior:**
Craft the pickaxe or provide clear error about which material is missing

**Actual behavior:**
Error: "Cannot craft wooden_pickaxe: missing required materials. Inventory: stick(x16), birch_sapling(x2)"
Inventory showed 16 sticks but didn't show planks (though 4 planks were confirmed present earlier)

**Note:**
Later, with similar inventory contents including cobblestone and sticks, was able to craft stone_pickaxe successfully. Inconsistent behavior.

---

## Issue 7: dig-adjacent-blocks errors on air blocks in allowedMiningToolsToMinedBlocks

**Steps to reproduce:**
1. Bot position: (17, 65, 42)
2. Called `dig-adjacent-blocks` with positions: [(30, 62, 44), (30, 61, 44)]
3. allowedMiningToolsToMinedBlocks: {"stone_pickaxe": ["grass_block", "dirt"]}
4. Position (30, 61, 44) was air

**Expected behavior:**
Skip air blocks or handle them gracefully

**Actual behavior:**
Error: "Block air at (30, 61, 44) missing from allowedMiningToolsToMinedBlocks input parameter, add it if you want to mine it."
Dug 1/2 blocks

**Note:**
Requiring users to explicitly allow "air" in mining tool parameters is unintuitive

---

## Issue 8: move-up-by-pillaring doesn't support clearing blocks above

**Steps to reproduce:**
1. Bot position: (11, 46, 42) underground
2. Stone blocks above bot
3. Called `move-up-by-pillaring` with height=5
4. Had cobblestone equipped

**Expected behavior:**
Either:
- Accept allowMiningOf parameter to clear blocks above, or
- Automatically clear mineable blocks when pillaring

**Actual behavior:**
Error: "Failed to pillar up: blocked at Y+4 by stone after 1 blocks placed. Mining next block up got error: Failed to mine stone at (11, 50, 42). Holding: cobblestone. Distance: 4.1 blocks. Error: Digging is very slow (3.0s). Block: stone. Using: cobblestone. Wrong tool?"

**Note:**
- Function tried to mine with cobblestone instead of using proper tool
- No parameter to specify which tool to use for clearing
- Other movement functions (move-horizontally-by-mining, move-horizontally-and-down-using-steps) do accept allowMiningOf

---

## Issue 9: move-horizontally-and-down-using-steps reports false Y position error

**Steps to reproduce:**
1. Bot position: (20, 64, 44)
2. Called `move-horizontally-and-down-using-steps` with stepsToGoDown=4, nextStepPos={"x": 21, "y": 63, "z": 44}
3. allowMiningOf specified with stone_pickaxe for various blocks

**Expected behavior:**
Descend 4 steps or provide actionable error

**Actual behavior:**
Error: "Bot ended up at Y=63.54 but expected Y=63.00. Position: (21.4, 63.5, 44.5), Expected: (21, 63, 44)"
Completed 0 of 4 steps

**However:**
Next response from get-position showed: "Bot feet position: (21, 63, 44)" (exactly the expected position)

**Note:**
The error appears to be a false positive - bot was actually at the correct position but function reported failure due to floating point precision difference (63.54 vs 63.00)

---

## Issue 10: smelt-item cannot find items in valid inventory slots

**Steps to reproduce:**
1. Inventory contents (from list-inventory):
   - oak_planks (x1) in slot 10
   - raw_iron (x5) in slot 43
   - stick (x8) in slot 9
2. Placed furnace at (20, 64, 45)
3. Called `smelt-item` with itemName="raw_iron", count=3, fuelName="oak_planks"

**Expected behavior:**
Begin smelting 3 raw iron using oak_planks as fuel

**Actual behavior:**
Error: "Can't find oak_planks in slots [3 - 39], (item id: 36)"

**Additional observation:**
Error message says searching "slots [3 - 39]" but oak_planks was in slot 10, which is within that range

---

## Issue 11: smelt-item cannot find items in slots beyond 39

**Steps to reproduce:**
1. Inventory contents: raw_iron (x5) in slot 43
2. Called `smelt-item` with itemName="raw_iron", count=3, fuelName="stick"

**Expected behavior:**
Find raw_iron and begin smelting

**Actual behavior:**
Error: "Can't find raw_iron in slots [3 - 39], (item id: 867)"

**Note:**
Error explicitly states searching "slots [3 - 39]" but raw_iron was in slot 43. Appears to be a hardcoded slot range that's too restrictive.

---

## Issue 12: transfer-items cannot access inventory at all

**Steps to reproduce:**
1. Opened furnace with `furnace-open` at (20, 64, 45) - succeeded
2. Inventory confirmed to contain: raw_iron (x5) in slot 43, stick (x8) in slot 9
3. Called `transfer-items` with itemName="raw_iron", count=3, toSlot=0
4. Called `transfer-items` with itemName="stick", count=4, toSlot=1

**Expected behavior:**
Transfer items to furnace slots

**Actual behavior:**
Both calls failed with:
- "Can't find raw_iron in slots [undefined - undefined], (item id: 867)"
- "Can't find stick in slots [undefined - undefined], (item id: 905)"

**Note:**
Slot range shows as "[undefined - undefined]" suggesting the function isn't correctly determining which slots to search. This is a critical bug blocking all furnace/container operations.

---

## Summary

**Critical issues blocking progression:**
- Issue 10, 11, 12: Inventory slot access broken for smelting/container operations
- Issue 2: Unpredictable bot teleportation makes navigation unreliable

**High priority issues:**
- Issue 5: dig-directly-down doesn't use allowMiningOf for tool selection
- Issue 8: move-up-by-pillaring cannot clear blocks above
- Issue 9: False Y position errors in stair movement

**Medium priority issues:**
- Issue 1: Path finding doesn't handle obstructing leaves
- Issue 3: Confusing error messages when crafting succeeds
- Issue 6: Inconsistent craft-item material detection
- Issue 7: Air blocks require explicit allowlist

**Low priority issues:**
- Issue 4: Inconsistent place-block reference block detection
