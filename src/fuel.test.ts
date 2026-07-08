import { describe, expect, it } from "vitest";
import { calculateFuelNeeded, getItemsSmeltedPerFuel, isKnownFuel } from "./fuel.js";

describe("calculateFuelNeeded", () => {
  it("coal smelts 8 items each", () => {
    expect(calculateFuelNeeded("coal", 1)).toBe(1);
    expect(calculateFuelNeeded("coal", 8)).toBe(1);
    expect(calculateFuelNeeded("coal", 9)).toBe(2);
  });

  it("planks smelt 1.5 items each", () => {
    expect(calculateFuelNeeded("oak_planks", 3)).toBe(2);
    expect(calculateFuelNeeded("birch_planks", 4)).toBe(3);
  });

  it("sticks smelt 0.5 items each (2 sticks per item)", () => {
    expect(calculateFuelNeeded("stick", 3)).toBe(6);
  });

  it("unknown fuel assumes 1 item per fuel", () => {
    expect(calculateFuelNeeded("weird_item", 5)).toBe(5);
  });
});

describe("getItemsSmeltedPerFuel / isKnownFuel", () => {
  it("recognizes any wood planks and logs", () => {
    expect(getItemsSmeltedPerFuel("cherry_planks")).toBe(1.5);
    expect(getItemsSmeltedPerFuel("dark_oak_log")).toBe(1.5);
  });

  it("rejects non-fuels", () => {
    expect(isKnownFuel("cobblestone")).toBe(false);
    expect(isKnownFuel("coal")).toBe(true);
  });
});
