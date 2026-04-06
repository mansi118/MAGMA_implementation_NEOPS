import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../convex/memory/traversal";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("handles zero vector gracefully", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("is symmetric", () => {
    const a = [1, 3, -5, 2];
    const b = [4, -2, 1, 7];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("ignores magnitude (unit vs non-unit)", () => {
    const a = [3, 4];
    const b = [6, 8]; // Same direction, double magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("works with high-dimensional vectors", () => {
    // Simulate 1536d (text-embedding-3-small dimension)
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    // Slightly shifted sine waves should be very similar
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});
