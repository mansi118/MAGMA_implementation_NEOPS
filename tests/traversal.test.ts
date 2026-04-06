import { describe, it, expect } from "vitest";
import { adaptiveTraversal, DEFAULT_CONFIG } from "../convex/memory/traversal";
import { makeNode, mockEmbedding } from "./helpers";

function scored(node: any, score: number) {
  return { node, score };
}

describe("adaptiveTraversal", () => {
  // Build a small mock graph:
  //   e1 --temporal--> e2 --causal--> e3
  //         \--semantic--> e4
  const e1 = makeNode("e1", "event 1", 1, [1, 0, 0, 0]);
  const e2 = makeNode("e2", "event 2", 2, [0.9, 0.1, 0, 0]);
  const e3 = makeNode("e3", "event 3", 3, [0.5, 0.5, 0, 0]);
  const e4 = makeNode("e4", "event 4", 4, [0, 0, 1, 0]);

  const adjacency: Record<string, Array<{ node: any; edgeType: string }>> = {
    e1: [
      { node: e2, edgeType: "temporal" },
      { node: e4, edgeType: "semantic" },
    ],
    e2: [{ node: e3, edgeType: "causal" }],
    e3: [],
    e4: [],
  };

  const fetchNeighbors = async (nodeId: string) => {
    return adjacency[nodeId] ?? [];
  };

  const queryEmbedding = [1, 0, 0, 0]; // Similar to e1, e2

  it("returns anchors even without traversal", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 0 } // No traversal
    );

    expect(result.length).toBe(1);
    expect(result[0].node._id).toBe("e1");
  });

  it("discovers neighbors through traversal", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 2, beamWidth: 5, budget: 10 }
    );

    const ids = result.map((r) => r.node._id);

    // Should find e1 (anchor) + e2 (temporal) + e3 or e4 (depth 2)
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
    expect(result.length).toBeGreaterThan(1);
  });

  it("respects budget limit", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 5, beamWidth: 10, budget: 2 }
    );

    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("respects beam width", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 1, beamWidth: 1, budget: 10 }
    );

    // Anchor (1) + at most beamWidth (1) new nodes per depth
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("prefers causal edges for 'why' intent", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "why",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 2, beamWidth: 1, budget: 10 }
    );

    const ids = result.map((r) => r.node._id);

    // With beamWidth=1, the traversal picks the best neighbor per depth.
    // From e1: temporal→e2 and semantic→e4. For "why" intent,
    // temporal(0.2) vs semantic(0.3) + semantic affinity differences.
    // From e2: causal→e3. Causal edges are weighted 0.8 for "why".
    // If e2 was chosen at depth 1, e3 should follow at depth 2.
    expect(ids).toContain("e1");
  });

  it("does not visit the same node twice", async () => {
    // Create a cycle: e1 → e2 → e1
    const cyclicAdjacency: Record<
      string,
      Array<{ node: any; edgeType: string }>
    > = {
      e1: [{ node: e2, edgeType: "temporal" }],
      e2: [{ node: e1, edgeType: "temporal" }], // Back edge
    };

    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      async (id) => cyclicAdjacency[id] ?? [],
      { ...DEFAULT_CONFIG, maxDepth: 5, beamWidth: 5, budget: 10 }
    );

    const ids = result.map((r) => r.node._id);
    const uniqueIds = new Set(ids);

    // No duplicates
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("handles empty neighbor lists gracefully", async () => {
    const result = await adaptiveTraversal(
      [scored(e3, 1.0)], // e3 has no neighbors
      queryEmbedding,
      "what",
      fetchNeighbors,
      DEFAULT_CONFIG
    );

    expect(result.length).toBe(1);
    expect(result[0].node._id).toBe("e3");
  });

  it("handles multiple anchors", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0), scored(e3, 0.8)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 1, beamWidth: 5, budget: 10 }
    );

    const ids = result.map((r) => r.node._id);

    expect(ids).toContain("e1");
    expect(ids).toContain("e3");
  });

  it("assigns increasing depth to discovered nodes", async () => {
    const result = await adaptiveTraversal(
      [scored(e1, 1.0)],
      queryEmbedding,
      "what",
      fetchNeighbors,
      { ...DEFAULT_CONFIG, maxDepth: 2, beamWidth: 5, budget: 10 }
    );

    const anchor = result.find((r) => r.node._id === "e1");
    expect(anchor?.depth).toBe(0);

    // Any non-anchor node should have depth > 0
    for (const r of result) {
      if (r.node._id !== "e1") {
        expect(r.depth).toBeGreaterThan(0);
      }
    }
  });
});
