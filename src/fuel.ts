// Vanilla burn rates: how many items one unit of this fuel smelts
const ITEMS_SMELTED_PER_FUEL: Record<string, number> = {
  coal: 8,
  charcoal: 8,
  coal_block: 80,
  lava_bucket: 100,
  blaze_rod: 12,
  stick: 0.5,
};

export function getItemsSmeltedPerFuel(fuelName: string): number | null {
  if (fuelName.endsWith("_planks") || fuelName.endsWith("_log")) return 1.5;
  return ITEMS_SMELTED_PER_FUEL[fuelName] ?? null;
}

export function isKnownFuel(fuelName: string): boolean {
  return getItemsSmeltedPerFuel(fuelName) !== null;
}

export function calculateFuelNeeded(fuelName: string, count: number): number {
  // Unknown fuel: assume 1 item smelted per fuel (conservative)
  const perFuel = getItemsSmeltedPerFuel(fuelName) ?? 1;
  return Math.ceil(count / perFuel);
}

export function estimatedSmeltSeconds(count: number): number {
  return count * 10;
}
