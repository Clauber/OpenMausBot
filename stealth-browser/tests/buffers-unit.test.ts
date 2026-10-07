import { describe, expect, it } from "vitest";
import { pushBounded } from "../src/buffers";

describe("pushBounded", () => {
  it("appends below cap", () => {
    const buf: number[] = [];
    pushBounded(buf, 1, 3);
    pushBounded(buf, 2, 3);
    expect(buf).toEqual([1, 2]);
  });
  it("evicts oldest at cap", () => {
    const buf: number[] = [1, 2, 3];
    pushBounded(buf, 4, 3);
    expect(buf).toEqual([2, 3, 4]);
  });
  it("handles single-item buffer", () => {
    const buf: number[] = [];
    pushBounded(buf, 1, 1);
    pushBounded(buf, 2, 1);
    expect(buf).toEqual([2]);
  });
});
