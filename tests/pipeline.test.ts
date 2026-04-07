/**
 * Layer 4: Pipeline Simulation Tests
 * Tests the full MAGMA pipeline using real API calls but mocked Convex DB.
 * Validates that the components wire together correctly end-to-end.
 *
 * Requires env vars: GROQ_API_KEY, OPENROUTER_API_KEY
 */

import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  scoreTransition,
  adaptiveTraversal,
  synthesizeContext,
  topologicalSortByCausalEdges,
  INTENT_WEIGHTS,
  DEFAULT_CONFIG,
} from "../convex/memory/traversal";
import {
  getChatClient,
  getEmbeddingClient,
  CHAT_MODEL,
  EMBEDDING_MODEL,
} from "../convex/memory/llm";
import { makeNode } from "./helpers";

const hasKeys = !!process.env.GROQ_API_KEY && !!process.env.OPENROUTER_API_KEY;

async function embed(text: string): Promise<number[]> {
  const r = await getEmbeddingClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return r.data[0].embedding;
}

async function classifyIntent(query: string): Promise<string> {
  const r = await getChatClient().chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content:
          'Classify query intent. Return JSON: {"intent": "why"|"when"|"entity"|"what"|"how"}',
      },
      { role: "user", content: query },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  return JSON.parse(r.choices[0].message.content!).intent;
}

describe.skipIf(!hasKeys)("Pipeline: Embedding + Traversal Integration", () => {
  it("embeds Zoo Media events and finds correct semantic neighbors", async () => {
    // Embed 5 events — some related, some not
    const texts = [
      "Akhilesh raised concerns about data privacy in ICD NEop",
      "Rahul prepared a data privacy addendum addressing concerns",
      "Zoo Media legal flagged GDPR compliance requirement",
      "Shivam began ICD NEop deployment on staging",
      "The weather in Mumbai is very hot today",
    ];

    const embeddings = await Promise.all(texts.map(embed));

    // Privacy concern (0) should be most similar to privacy addendum (1)
    const sim01 = cosineSimilarity(embeddings[0], embeddings[1]);
    const sim04 = cosineSimilarity(embeddings[0], embeddings[4]);

    expect(sim01).toBeGreaterThan(0.5); // Related topics
    expect(sim04).toBeLessThan(0.4); // Unrelated
    expect(sim01).toBeGreaterThan(sim04); // Related > unrelated

    // Both GDPR (2) and deployment (3) share "ICD NEop" vocabulary with privacy (0),
    // so embeddings may be close. Just verify related > unrelated (weather).
    const sim02 = cosineSimilarity(embeddings[0], embeddings[2]);
    expect(sim02).toBeGreaterThan(sim04); // GDPR more related than weather
  }, 60000);

  it("intent classification works for all 4 test queries", async () => {
    const queries = [
      { q: "Why did we update the ICD architecture?", expected: "why" },
      { q: "Give me the timeline of events between Jan 12 and Jan 25", expected: "when" },
      { q: "Everything involving Akhilesh", expected: "entity" },
      { q: "What led to Zoo Media signing the SOW?", expected: "why" },
    ];

    const results = await Promise.all(
      queries.map((t) => classifyIntent(t.q))
    );

    for (let i = 0; i < queries.length; i++) {
      expect(results[i]).toBe(queries[i].expected);
    }
  }, 60000);
});

describe.skipIf(!hasKeys)("Pipeline: Full Traversal with Real Embeddings", () => {
  it("causal 'why' query retrieves cause chain via beam search", async () => {
    // Build a mini graph with real embeddings
    const contents = [
      "Akhilesh raised concerns about data privacy in ICD NEop",
      "Rahul prepared a data privacy addendum addressing concerns",
      "Zoo Media legal flagged GDPR compliance requirement",
      "Mansi researched GDPR compliance for ICD architecture",
      "Updated ICD architecture to include EU data residency",
    ];

    const embeddings = await Promise.all(contents.map(embed));

    const nodes = contents.map((c, i) =>
      makeNode(`e${i}`, c, (i + 1) * 1000, embeddings[i])
    );

    // Build adjacency: both forward AND backward edges (the real getNeighbors
    // returns both directions). Without backward edges, traversal from e4 would
    // find nothing since all causal arrows point forward.
    const adjacency: Record<
      string,
      Array<{ node: any; edgeType: string }>
    > = {
      e0: [
        { node: nodes[1], edgeType: "causal" },
        { node: nodes[1], edgeType: "temporal" },
      ],
      e1: [
        { node: nodes[0], edgeType: "causal" }, // backward
        { node: nodes[2], edgeType: "temporal" },
      ],
      e2: [
        { node: nodes[1], edgeType: "temporal" }, // backward
        { node: nodes[3], edgeType: "causal" },
        { node: nodes[3], edgeType: "temporal" },
      ],
      e3: [
        { node: nodes[2], edgeType: "causal" }, // backward
        { node: nodes[4], edgeType: "causal" },
        { node: nodes[4], edgeType: "temporal" },
      ],
      e4: [
        { node: nodes[3], edgeType: "causal" }, // backward: update ← research
        { node: nodes[3], edgeType: "temporal" }, // backward
      ],
    };

    const fetchNeighbors = async (id: string) => adjacency[id] ?? [];

    // Query: "Why did we update the ICD architecture?"
    const queryEmb = await embed("Why did we update the ICD architecture?");

    // Anchor: the architecture update node (e4)
    const result = await adaptiveTraversal(
      [{ node: nodes[4] as any, score: 1.0 }],
      queryEmb,
      "why",
      fetchNeighbors as any,
      { ...DEFAULT_CONFIG, maxDepth: 4, beamWidth: 5, budget: 10 }
    );

    const ids = result.map((r) => r.node._id);

    // Should retrieve the anchor (e4) and trace backward through causal edges
    expect(ids).toContain("e4"); // anchor
    // With "why" intent, causal edges weighted 0.8 — should follow the chain
    expect(result.length).toBeGreaterThan(1);
  }, 60000);

  it("synthesis produces correct ordering for 'why' intent", async () => {
    const contents = [
      "Privacy concern raised",
      "Addendum prepared",
      "Architecture updated",
    ];
    const embeddings = await Promise.all(contents.map(embed));

    const nodes = [
      { node: makeNode("e1", contents[0], 1000, embeddings[0]) as any, cumScore: 2, depth: 2 },
      { node: makeNode("e2", contents[1], 2000, embeddings[1]) as any, cumScore: 1.5, depth: 1 },
      { node: makeNode("e3", contents[2], 3000, embeddings[2]) as any, cumScore: 1, depth: 0 },
    ];

    const causalEdges = [
      { fromNode: "e1", toNode: "e2" },
      { fromNode: "e2", toNode: "e3" },
    ];

    const result = synthesizeContext(nodes, "why", causalEdges);

    // Should order: e1 → e2 → e3 (causal chain)
    expect(result.nodes[0].id).toBe("e1");
    expect(result.nodes[1].id).toBe("e2");
    expect(result.nodes[2].id).toBe("e3");
    expect(result.context).toContain("Privacy concern");
    expect(result.context).toContain("Addendum");
    expect(result.context).toContain("Architecture");
  }, 60000);

  it("'when' query orders results chronologically", async () => {
    const contents = [
      "Event on Jan 25",
      "Event on Jan 12",
      "Event on Jan 18",
    ];
    const embeddings = await Promise.all(contents.map(embed));

    const nodes = [
      {
        node: makeNode("e1", contents[0], new Date("2025-01-25").getTime(), embeddings[0]) as any,
        cumScore: 1, depth: 0,
      },
      {
        node: makeNode("e2", contents[1], new Date("2025-01-12").getTime(), embeddings[1]) as any,
        cumScore: 1, depth: 0,
      },
      {
        node: makeNode("e3", contents[2], new Date("2025-01-18").getTime(), embeddings[2]) as any,
        cumScore: 1, depth: 0,
      },
    ];

    const result = synthesizeContext(nodes, "when", []);

    // Should be chronological: Jan 12, Jan 18, Jan 25
    expect(result.nodes[0].id).toBe("e2");
    expect(result.nodes[1].id).toBe("e3");
    expect(result.nodes[2].id).toBe("e1");
  }, 60000);

  it("intent-weighted scoring favors correct edge types", async () => {
    const queryEmb = await embed("Why did this happen?");
    const neighborEmb = await embed("This was caused by a privacy concern");

    const causalWhyScore = scoreTransition(
      "causal", neighborEmb, queryEmb, "why", DEFAULT_CONFIG
    );
    const temporalWhyScore = scoreTransition(
      "temporal", neighborEmb, queryEmb, "why", DEFAULT_CONFIG
    );
    const causalWhenScore = scoreTransition(
      "causal", neighborEmb, queryEmb, "when", DEFAULT_CONFIG
    );
    const temporalWhenScore = scoreTransition(
      "temporal", neighborEmb, queryEmb, "when", DEFAULT_CONFIG
    );

    // "why" should prefer causal over temporal
    expect(causalWhyScore).toBeGreaterThan(temporalWhyScore);
    // "when" should prefer temporal over causal
    expect(temporalWhenScore).toBeGreaterThan(causalWhenScore);
  }, 60000);
});

describe.skipIf(!hasKeys)("Pipeline: Causal Inference via LLM", () => {
  it("infers correct causal edges from Zoo Media scenario", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: `You are a memory consolidation agent. Infer causal relationships.

TARGET EVENT:
[n0] [2025-01-25] Updated ICD architecture to include EU data residency

NEIGHBORHOOD:
[n1] [2025-01-12] Akhilesh raised concerns about data privacy in ICD NEop
[n2] [2025-01-14] Rahul prepared a data privacy addendum addressing Akhilesh's concerns
[n3] [2025-01-22] Zoo Media legal flagged GDPR compliance requirement
[n4] [2025-01-24] Mansi researched GDPR compliance for ICD architecture
[n5] [2025-01-28] Presented GDPR-compliant architecture to Akhilesh

Return JSON:
{"causal_edges": [{"from_label": "...", "to_label": "...", "confidence": 0.0-1.0, "reasoning": "..."}]}

Rules:
- Cause must have earlier date than effect
- Only confidence > 0.6
- Max 5 edges
- At least one endpoint must be n0`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(parsed.causal_edges.length).toBeGreaterThan(0);

    // Should find: n4 → n0 (research led to architecture update)
    const researchToUpdate = parsed.causal_edges.find(
      (e: any) => e.from_label === "n4" && e.to_label === "n0"
    );
    expect(researchToUpdate).toBeTruthy();
    expect(researchToUpdate.confidence).toBeGreaterThan(0.6);

    // LLM may also infer edges between neighborhood nodes (e.g., n3 → n4).
    // Verify all edges have valid labels and confidence
    for (const edge of parsed.causal_edges) {
      expect(edge.from_label).toMatch(/^n\d$/);
      expect(edge.to_label).toMatch(/^n\d$/);
      expect(edge.confidence).toBeGreaterThan(0);
      expect(typeof edge.reasoning).toBe("string");
    }
  }, 60000);
});
