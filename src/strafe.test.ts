import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { getStrafeDirectionAndAmount } from "./strafe.js";

function mockBot(x: number, z: number, yaw: number): Bot {
  return { entity: { position: new Vec3(x, 64, z), yaw } } as unknown as Bot;
}

const FACING_SOUTH = 0; // +Z, perpendicular axis is X
const FACING_EAST = (3 * Math.PI) / 2; // +X, perpendicular axis is Z

describe("getStrafeDirectionAndAmount", () => {
  it("returns null when centered", () => {
    expect(getStrafeDirectionAndAmount(mockBot(10.5, 20.5, FACING_SOUTH))).toBeNull();
  });

  it("returns null within the 0.1 threshold", () => {
    expect(getStrafeDirectionAndAmount(mockBot(10.58, 20.5, FACING_SOUTH))).toBeNull();
  });

  it("strafes toward center when facing south and offset in X", () => {
    const result = getStrafeDirectionAndAmount(mockBot(10.8, 20.5, FACING_SOUTH));
    expect(result).toEqual({ direction: "left", amount: expect.closeTo(0.3, 5) });
  });

  it("strafes toward center when facing east and offset in Z", () => {
    const result = getStrafeDirectionAndAmount(mockBot(10.5, 20.2, FACING_EAST));
    expect(result).toEqual({ direction: "right", amount: expect.closeTo(0.3, 5) });
  });

  it("handles negative coordinates", () => {
    const result = getStrafeDirectionAndAmount(mockBot(-10.2, 20.5, FACING_SOUTH));
    expect(result).not.toBeNull();
    expect(result!.amount).toBeCloseTo(0.3, 5);
  });

  it("throws when bot is not axis-aligned", () => {
    expect(() => getStrafeDirectionAndAmount(mockBot(10.5, 20.5, Math.PI / 4))).toThrow(
      /not axis-aligned/
    );
  });
});
