import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { describeWhyUncraftable } from "./craftingDiagnostics.js";

const VERSION = "1.21.1";
const mcData = minecraftData(VERSION);

type RecipeDelta = { id: number; metadata: number | null; count: number };

function mockBot(
  inventory: Array<{ name: string; count: number }>,
  recipeDeltas: RecipeDelta[][]
): Bot {
  return {
    version: VERSION,
    inventory: {
      items: () =>
        inventory.map(({ name, count }) => ({
          name,
          count,
          type: mcData.itemsByName[name].id,
        })),
    },
    recipesAll: () => recipeDeltas.map((delta) => ({ delta })),
  } as unknown as Bot;
}

function planksRecipe(planksName: string): RecipeDelta[] {
  // 3 planks + 2 sticks -> 1 wooden_pickaxe
  return [
    { id: mcData.itemsByName[planksName].id, metadata: null, count: -3 },
    { id: mcData.itemsByName.stick.id, metadata: null, count: -2 },
    { id: mcData.itemsByName.wooden_pickaxe.id, metadata: null, count: 1 },
  ];
}

describe("describeWhyUncraftable", () => {
  it("says when no recipe exists at all", () => {
    const bot = mockBot([], []);
    expect(describeWhyUncraftable(bot, mcData.itemsByName.wooden_pickaxe.id, null)).toContain(
      "no recipe craftable without a crafting table"
    );
  });

  it("lists missing materials with needed and available counts", () => {
    const bot = mockBot([{ name: "stick", count: 16 }], [planksRecipe("oak_planks")]);
    const message = describeWhyUncraftable(bot, mcData.itemsByName.wooden_pickaxe.id, null);
    expect(message).toContain("oak_planks (need 3, have 0)");
    expect(message).not.toContain("stick (need");
  });

  it("picks the closest recipe variant (birch planks in inventory)", () => {
    const bot = mockBot(
      [
        { name: "stick", count: 16 },
        { name: "birch_planks", count: 3 },
      ],
      [planksRecipe("oak_planks"), planksRecipe("birch_planks")]
    );
    const message = describeWhyUncraftable(bot, mcData.itemsByName.wooden_pickaxe.id, null);
    expect(message).toContain("materials look sufficient");
  });
});
