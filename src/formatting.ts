import { Vec3 } from "vec3";

/**
 * Format position as (x, y, z)
 */
export function formatPosition(pos: Vec3): string {
  return `(${pos.x}, ${pos.y}, ${pos.z})`;
}
