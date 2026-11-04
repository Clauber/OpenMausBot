import { describe, expect, it } from "vitest";
import { zoomAt } from "./pan-zoom";

describe("pan and zoom geometry", () => {
  it("keeps the world point under the cursor anchored while zooming", () => {
    const view = { x: -50, y: 80, scale: 0.5 };
    const point = { x: 310, y: 270 };
    const world = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
    const next = zoomAt(view, 1.4, point);
    expect(world.x * next.scale + next.x).toBeCloseTo(point.x);
    expect(world.y * next.scale + next.y).toBeCloseTo(point.y);
    expect(zoomAt(view, view.scale, point)).toEqual(view);
  });
});
