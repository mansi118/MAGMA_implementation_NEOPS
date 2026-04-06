import { describe, it, expect } from "vitest";
import { synthesizeContext } from "../convex/memory/traversal";
import { makeNode, mockEmbedding } from "./helpers";

function scored(node: any, cumScore: number = 1.0) {
  return { node, cumScore, depth: 0 };
}

describe("synthesizeContext", () => {
  const nodes = [
    scored(makeNode("e4", "Akhilesh raised concerns about data privacy", new Date("2025-01-12").getTime(), mockEmbedding(0)), 3.0),
    scored(makeNode("e5", "Rahul prepared a privacy addendum", new Date("2025-01-14").getTime(), mockEmbedding(1)), 2.0),
    scored(makeNode("e10", "Updated ICD architecture", new Date("2025-01-25").getTime(), mockEmbedding(2)), 1.0),
  ];

  describe("when intent", () => {
    it("orders by eventTime (chronological)", () => {
      const result = synthesizeContext(nodes, "when", []);

      expect(result.nodes[0].content).toContain("data privacy");
      expect(result.nodes[1].content).toContain("addendum");
      expect(result.nodes[2].content).toContain("ICD architecture");
    });

    it("includes ISO date prefixes", () => {
      const result = synthesizeContext(nodes, "when", []);
      expect(result.context).toContain("[2025-01-12]");
      expect(result.context).toContain("[2025-01-14]");
      expect(result.context).toContain("[2025-01-25]");
    });
  });

  describe("why intent", () => {
    it("uses topological sort when causal edges exist", () => {
      const causalEdges = [
        { fromNode: "e4", toNode: "e5" },
        { fromNode: "e5", toNode: "e10" },
      ];

      const result = synthesizeContext(nodes, "why", causalEdges);

      // Should follow causal order: e4 → e5 → e10
      expect(result.nodes[0].id).toBe("e4");
      expect(result.nodes[1].id).toBe("e5");
      expect(result.nodes[2].id).toBe("e10");
    });
  });

  describe("what intent", () => {
    it("orders by cumulative score (highest first)", () => {
      const result = synthesizeContext(nodes, "what", []);

      // e4 has score 3.0, e5 has 2.0, e10 has 1.0
      expect(result.nodes[0].id).toBe("e4");
      expect(result.nodes[1].id).toBe("e5");
      expect(result.nodes[2].id).toBe("e10");
    });
  });

  describe("entity intent", () => {
    it("orders by eventTime (chronological)", () => {
      const result = synthesizeContext(nodes, "entity", []);

      expect(result.nodes[0].eventTime).toBeLessThan(result.nodes[1].eventTime);
      expect(result.nodes[1].eventTime).toBeLessThan(result.nodes[2].eventTime);
    });
  });

  describe("token budget", () => {
    it("truncates when budget is exceeded", () => {
      // Very small budget — should only fit 1-2 events
      const result = synthesizeContext(nodes, "what", [], 30);

      expect(result.truncated).toBe(true);
      expect(result.nodes.length).toBeLessThan(nodes.length);
      expect(result.context).toContain("additional events omitted");
    });

    it("does not truncate when budget is sufficient", () => {
      const result = synthesizeContext(nodes, "what", [], 4000);

      expect(result.truncated).toBe(false);
      expect(result.nodes.length).toBe(nodes.length);
    });
  });

  describe("output format", () => {
    it("includes ref tags for provenance", () => {
      const result = synthesizeContext(nodes, "what", []);

      expect(result.context).toContain("[ref:e4]");
      expect(result.context).toContain("[ref:e5]");
      expect(result.context).toContain("[ref:e10]");
    });

    it("returns both context string and structured nodes", () => {
      const result = synthesizeContext(nodes, "what", []);

      expect(typeof result.context).toBe("string");
      expect(result.context.length).toBeGreaterThan(0);
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(result.nodes[0]).toHaveProperty("id");
      expect(result.nodes[0]).toHaveProperty("content");
      expect(result.nodes[0]).toHaveProperty("eventTime");
      expect(result.nodes[0]).toHaveProperty("score");
    });
  });
});
