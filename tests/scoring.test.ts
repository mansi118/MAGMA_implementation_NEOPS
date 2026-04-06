import { describe, it, expect } from "vitest";
import {
  scoreTransition,
  INTENT_WEIGHTS,
  DEFAULT_CONFIG,
} from "../convex/memory/traversal";

describe("INTENT_WEIGHTS", () => {
  it("has weights for all 5 intents", () => {
    expect(Object.keys(INTENT_WEIGHTS)).toEqual(
      expect.arrayContaining(["why", "when", "entity", "what", "how"])
    );
  });

  it("each intent has all 4 edge types", () => {
    for (const [intent, weights] of Object.entries(INTENT_WEIGHTS)) {
      expect(weights).toHaveProperty("temporal");
      expect(weights).toHaveProperty("causal");
      expect(weights).toHaveProperty("semantic");
      expect(weights).toHaveProperty("entity");
      // All weights should be in [0, 1]
      for (const [, w] of Object.entries(weights)) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it("why intent heavily weights causal edges", () => {
    expect(INTENT_WEIGHTS.why.causal).toBeGreaterThan(
      INTENT_WEIGHTS.why.temporal
    );
    expect(INTENT_WEIGHTS.why.causal).toBeGreaterThan(
      INTENT_WEIGHTS.why.semantic
    );
    expect(INTENT_WEIGHTS.why.causal).toBeGreaterThan(
      INTENT_WEIGHTS.why.entity
    );
  });

  it("when intent heavily weights temporal edges", () => {
    expect(INTENT_WEIGHTS.when.temporal).toBeGreaterThan(
      INTENT_WEIGHTS.when.causal
    );
    expect(INTENT_WEIGHTS.when.temporal).toBeGreaterThan(
      INTENT_WEIGHTS.when.semantic
    );
  });

  it("entity intent heavily weights entity edges", () => {
    expect(INTENT_WEIGHTS.entity.entity).toBeGreaterThan(
      INTENT_WEIGHTS.entity.causal
    );
    expect(INTENT_WEIGHTS.entity.entity).toBeGreaterThan(
      INTENT_WEIGHTS.entity.temporal
    );
  });
});

describe("scoreTransition", () => {
  const queryEmb = [1, 0, 0, 0, 0, 0, 0, 0];

  it("returns higher score for matching edge type and intent", () => {
    const neighborEmb = [1, 0, 0, 0, 0, 0, 0, 0]; // identical to query

    const causalWhyScore = scoreTransition(
      "causal",
      neighborEmb,
      queryEmb,
      "why",
      DEFAULT_CONFIG
    );
    const temporalWhyScore = scoreTransition(
      "temporal",
      neighborEmb,
      queryEmb,
      "why",
      DEFAULT_CONFIG
    );

    // For "why" intent, causal should score higher than temporal
    expect(causalWhyScore).toBeGreaterThan(temporalWhyScore);
  });

  it("returns higher score for semantically similar neighbors", () => {
    const similarEmb = [0.9, 0.1, 0, 0, 0, 0, 0, 0];
    const dissimilarEmb = [0, 0, 0, 0, 0, 0, 0, 1];

    const similarScore = scoreTransition(
      "semantic",
      similarEmb,
      queryEmb,
      "what",
      DEFAULT_CONFIG
    );
    const dissimilarScore = scoreTransition(
      "semantic",
      dissimilarEmb,
      queryEmb,
      "what",
      DEFAULT_CONFIG
    );

    expect(similarScore).toBeGreaterThan(dissimilarScore);
  });

  it("returns positive values (exp is always > 0)", () => {
    const emb = [0, 0, 0, 0, 0, 0, 0, 1];
    for (const intent of ["why", "when", "entity", "what", "how"]) {
      for (const edgeType of ["temporal", "causal", "semantic", "entity"]) {
        const score = scoreTransition(
          edgeType,
          emb,
          queryEmb,
          intent,
          DEFAULT_CONFIG
        );
        expect(score).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to 'what' weights for unknown intent", () => {
    const emb = [1, 0, 0, 0, 0, 0, 0, 0];
    const unknownScore = scoreTransition(
      "semantic",
      emb,
      queryEmb,
      "unknown_intent",
      DEFAULT_CONFIG
    );
    const whatScore = scoreTransition(
      "semantic",
      emb,
      queryEmb,
      "what",
      DEFAULT_CONFIG
    );
    expect(unknownScore).toBeCloseTo(whatScore, 5);
  });

  it("uses 0.1 weight for unknown edge type", () => {
    const emb = [1, 0, 0, 0, 0, 0, 0, 0];
    const unknownEdge = scoreTransition(
      "unknown_edge",
      emb,
      queryEmb,
      "why",
      DEFAULT_CONFIG
    );
    // Should still be positive
    expect(unknownEdge).toBeGreaterThan(0);
    // Should be less than known edge types
    const causalEdge = scoreTransition(
      "causal",
      emb,
      queryEmb,
      "why",
      DEFAULT_CONFIG
    );
    expect(unknownEdge).toBeLessThan(causalEdge);
  });
});
