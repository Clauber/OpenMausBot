import { describe, expect, it } from "vitest";
import { actualSizeScale, clampPan, clampScale, FIT_VIEW, pinchScale, ZOOM_MAX, ZOOM_MIN, zoomAt } from "./pan-zoom";

describe("pan and zoom geometry", () => {
  it.each([
    [0, ZOOM_MIN], [1, ZOOM_MIN], [2.5, 2.5], [8, ZOOM_MAX], [20, ZOOM_MAX],
    [NaN, ZOOM_MIN], [Infinity, ZOOM_MAX], [-Infinity, ZOOM_MIN],
  ])("clamps scale %s to %s", (scale, expected) => {
    expect(clampScale(scale)).toBe(expected);
  });

  it("pins content smaller than the viewport to the centre on each axis", () => {
    const viewport = { width: 1000, height: 800 };
    expect(clampPan({ x: 70, y: -90, scale: 1 }, { width: 500, height: 400 }, viewport)).toEqual(FIT_VIEW);
    expect(clampPan({ x: 70, y: -900, scale: 2 }, { width: 400, height: 600 }, viewport))
      .toEqual({ x: 0, y: -200, scale: 2 });
    expect(clampPan({ x: -900, y: 90, scale: 2 }, { width: 800, height: 300 }, viewport))
      .toEqual({ x: -300, y: 0, scale: 2 });
  });

  it("clamps both pan directions without changing valid offsets or scale", () => {
    const content = { width: 800, height: 600 };
    const viewport = { width: 1000, height: 800 };
    expect(clampPan({ x: 900, y: -900, scale: 2 }, content, viewport)).toEqual({ x: 300, y: -200, scale: 2 });
    expect(clampPan({ x: -900, y: 900, scale: 2 }, content, viewport)).toEqual({ x: -300, y: 200, scale: 2 });
    expect(clampPan({ x: 50, y: -60, scale: 2 }, content, viewport)).toEqual({ x: 50, y: -60, scale: 2 });
  });

  it.each([
    [2400, 800, 3], [10000, 800, ZOOM_MAX], [800, 800, 2.5], [400, 800, 2.5],
    [800, 0, 2.5], [800, -1, 2.5], [NaN, 800, 2.5], [800, NaN, 2.5],
    [Infinity, 800, 2.5], [800, Infinity, 2.5],
  ])("zooms natural width %s and fitted width %s to %s", (natural, fitted, expected) => {
    expect(actualSizeScale(natural, fitted)).toBe(expected);
  });

  it.each([
    [1, 100, 200, 2], [2, 100, 150, 3], [2, 100, 25, ZOOM_MIN], [1, 100, 1e6, ZOOM_MAX],
    [2, 0, 200, 2], [2, -10, 200, 2], [2, 100, NaN, 2], [2, 100, Infinity, 2],
  ])("pinches scale %s from distance %s to %s, giving %s", (scale, startDistance, distance, expected) => {
    expect(pinchScale(scale, startDistance, distance)).toBe(expected);
  });

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
