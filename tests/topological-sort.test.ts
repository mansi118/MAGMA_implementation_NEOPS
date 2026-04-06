import { describe, it, expect } from "vitest";
import { topologicalSortByCausalEdges } from "../convex/memory/traversal";
import { makeNode, mockEmbedding } from "./helpers";

// Helper to make ScoredNode from MockEventNode
function scored(node: any, cumScore: number = 1.0) {
  return { node, cumScore, depth: 0 };
}

describe("topologicalSortByCausalEdges", () => {
  it("sorts a simple causal chain correctly", () => {
    const nodes = [
      scored(makeNode("e4", "privacy concern", 4, mockEmbedding(0))),
      scored(makeNode("e5", "addendum prepared", 5, mockEmbedding(1))),
      scored(makeNode("e8", "GDPR flagged", 8, mockEmbedding(2))),
      scored(makeNode("e10", "architecture updated", 10, mockEmbedding(3))),
    ];

    const causalEdges = [
      { fromNode: "e4", toNode: "e5" },   // concern → addendum
      { fromNode: "e5", toNode: "e8" },   // addendum → GDPR
      { fromNode: "e8", toNode: "e10" },  // GDPR → update
    ];

    const sorted = topologicalSortByCausalEdges(nodes, causalEdges);
    const ids = sorted.map((s) => s.node._id);

    expect(ids).toEqual(["e4", "e5", "e8", "e10"]);
  });

  it("handles diamond-shaped causal graph", () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const nodes = [
      scored(makeNode("D", "effect D", 4, mockEmbedding(0))),
      scored(makeNode("A", "cause A", 1, mockEmbedding(1))),
      scored(makeNode("C", "middle C", 3, mockEmbedding(2))),
      scored(makeNode("B", "middle B", 2, mockEmbedding(3))),
    ];

    const causalEdges = [
      { fromNode: "A", toNode: "B" },
      { fromNode: "A", toNode: "C" },
      { fromNode: "B", toNode: "D" },
      { fromNode: "C", toNode: "D" },
    ];

    const sorted = topologicalSortByCausalEdges(nodes, causalEdges);
    const ids = sorted.map((s) => s.node._id);

    // A must come first, D must come last
    expect(ids[0]).toBe("A");
    expect(ids[ids.length - 1]).toBe("D");
    // B and C can be in either order, but both before D
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("D"));
    expect(ids.indexOf("C")).toBeLessThan(ids.indexOf("D"));
  });

  it("handles nodes with no causal edges (falls back to eventTime)", () => {
    const nodes = [
      scored(makeNode("e3", "event 3", 30, mockEmbedding(0))),
      scored(makeNode("e1", "event 1", 10, mockEmbedding(1))),
      scored(makeNode("e2", "event 2", 20, mockEmbedding(2))),
    ];

    const sorted = topologicalSortByCausalEdges(nodes, []);
    const ids = sorted.map((s) => s.node._id);

    // No causal edges → sort by eventTime
    expect(ids).toEqual(["e1", "e2", "e3"]);
  });

  it("handles mixed: some nodes in causal chain, some disconnected", () => {
    const nodes = [
      scored(makeNode("e1", "cause", 1, mockEmbedding(0))),
      scored(makeNode("e2", "effect", 2, mockEmbedding(1))),
      scored(makeNode("e3", "unrelated", 3, mockEmbedding(2))),
    ];

    const causalEdges = [{ fromNode: "e1", toNode: "e2" }];

    const sorted = topologicalSortByCausalEdges(nodes, causalEdges);
    const ids = sorted.map((s) => s.node._id);

    // e1 before e2 (causal), e3 at end (disconnected, sorted by eventTime)
    expect(ids.indexOf("e1")).toBeLessThan(ids.indexOf("e2"));
  });

  it("ignores causal edges referencing nodes not in the set", () => {
    const nodes = [
      scored(makeNode("e1", "node 1", 1, mockEmbedding(0))),
      scored(makeNode("e2", "node 2", 2, mockEmbedding(1))),
    ];

    const causalEdges = [
      { fromNode: "e1", toNode: "e2" },
      { fromNode: "e999", toNode: "e1" }, // e999 not in nodes
      { fromNode: "e2", toNode: "e888" }, // e888 not in nodes
    ];

    const sorted = topologicalSortByCausalEdges(nodes, causalEdges);
    const ids = sorted.map((s) => s.node._id);

    expect(ids).toEqual(["e1", "e2"]);
  });

  it("preserves all nodes even with cycles (cycle nodes appended)", () => {
    const nodes = [
      scored(makeNode("a", "node a", 1, mockEmbedding(0))),
      scored(makeNode("b", "node b", 2, mockEmbedding(1))),
      scored(makeNode("c", "node c", 3, mockEmbedding(2))),
    ];

    // Cycle: a→b→c→a (shouldn't happen with temporal ordering, but test robustness)
    const causalEdges = [
      { fromNode: "a", toNode: "b" },
      { fromNode: "b", toNode: "c" },
      { fromNode: "c", toNode: "a" },
    ];

    const sorted = topologicalSortByCausalEdges(nodes, causalEdges);

    // All nodes should still appear
    expect(sorted.length).toBe(3);
  });
});
