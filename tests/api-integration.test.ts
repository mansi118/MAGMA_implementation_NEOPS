/**
 * Layer 2: API Integration Tests
 * Tests real API calls to Groq (chat) and OpenRouter (embeddings).
 * Verifies response shapes match what our pipeline expects.
 *
 * Requires env vars: GROQ_API_KEY, OPENROUTER_API_KEY
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getChatClient,
  getEmbeddingClient,
  CHAT_MODEL,
  EMBEDDING_MODEL,
} from "../convex/memory/llm";

const hasKeys = !!process.env.GROQ_API_KEY && !!process.env.OPENROUTER_API_KEY;

describe.skipIf(!hasKeys)("Groq Chat API", () => {
  it("returns valid JSON with response_format", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: 'Return JSON: {"status": "ok", "count": 42}',
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 50,
    });

    const content = response.choices[0].message.content;
    expect(content).toBeTruthy();
    const parsed = JSON.parse(content!);
    expect(parsed).toHaveProperty("status");
  }, 15000);

  it("handles intent classification prompt", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `Analyze this query. Return JSON: {"intent": "why"|"when"|"entity"|"what"|"how", "entities": [], "keywords": []}`,
        },
        {
          role: "user",
          content: "Why did we update the ICD architecture?",
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(parsed.intent).toBe("why");
    expect(Array.isArray(parsed.entities)).toBe(true);
    expect(Array.isArray(parsed.keywords)).toBe(true);
  }, 15000);

  it("handles entity extraction prompt", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `Extract metadata. Return JSON: {"entities": ["lowercase names"], "keywords": ["lowercase terms"], "temporal_cue": "time ref or null"}`,
        },
        {
          role: "user",
          content:
            "Akhilesh raised concerns about data privacy in ICD NEop on Jan 12",
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(Array.isArray(parsed.entities)).toBe(true);
    expect(parsed.entities.length).toBeGreaterThan(0);

    // Should extract "akhilesh" as an entity
    const lowerEntities = parsed.entities.map((e: string) => e.toLowerCase());
    expect(lowerEntities).toContain("akhilesh");
  }, 15000);

  it("handles causal inference prompt", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: `You are a memory consolidation agent. Infer causal relationships.

TARGET EVENT:
[n0] [2025-01-14] Rahul prepared a data privacy addendum addressing Akhilesh's concerns

NEIGHBORHOOD:
[n1] [2025-01-12] Akhilesh raised concerns about data privacy in ICD NEop
[n2] [2025-01-15] Sent revised proposal with privacy addendum to Zoo Media

Return JSON:
{"causal_edges": [{"from_label": "...", "to_label": "...", "confidence": 0.0-1.0, "reasoning": "..."}]}

Rules: cause must be earlier than effect, confidence > 0.6, at least one endpoint must be n0.`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(parsed).toHaveProperty("causal_edges");
    expect(Array.isArray(parsed.causal_edges)).toBe(true);

    // Should find at least: n1 → n0 (concern caused addendum)
    if (parsed.causal_edges.length > 0) {
      const edge = parsed.causal_edges[0];
      expect(edge).toHaveProperty("from_label");
      expect(edge).toHaveProperty("to_label");
      expect(edge).toHaveProperty("confidence");
      expect(edge).toHaveProperty("reasoning");
      expect(edge.confidence).toBeGreaterThan(0.5);
    }
  }, 15000);

  it("handles event segmentation prompt", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `Break text into atomic events. Return JSON: {"events": [{"content": "...", "entities": [], "keywords": [], "temporal_cue": null, "event_type": "observation"|"action"|"decision"|"state_change"}]}`,
        },
        {
          role: "user",
          content:
            "Met with Akhilesh from Zoo Media. He raised concerns about data privacy. Rahul prepared an addendum in response.",
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(parsed).toHaveProperty("events");
    expect(Array.isArray(parsed.events)).toBe(true);
    // Should segment into 2-3 events
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.events.length).toBeLessThanOrEqual(5);

    for (const event of parsed.events) {
      expect(event).toHaveProperty("content");
      expect(typeof event.content).toBe("string");
    }
  }, 15000);

  it("handles entity classification prompt", async () => {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: `Given this event and entities, classify each.

EVENT: Akhilesh raised concerns about data privacy in ICD NEop

ENTITIES: akhilesh, icd neop

Return JSON: {"entities": [{"name": "...", "type": "person"|"company"|"project"|"concept"|"tool", "role": "subject"|"object"|"participant"|"owner"}]}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content!);
    expect(Array.isArray(parsed.entities)).toBe(true);
    expect(parsed.entities.length).toBe(2);

    const akhilesh = parsed.entities.find(
      (e: any) => e.name.toLowerCase() === "akhilesh"
    );
    expect(akhilesh).toBeTruthy();
    expect(akhilesh.type).toBe("person");
  }, 15000);
});

describe.skipIf(!hasKeys)("OpenRouter Embeddings API", () => {
  it("returns 1536-dimensional embedding", async () => {
    const response = await getEmbeddingClient().embeddings.create({
      model: EMBEDDING_MODEL,
      input: "Met with Akhilesh from Zoo Media",
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0].embedding).toHaveLength(1536);
    // Embeddings should be numbers, not NaN/Infinity
    for (const val of response.data[0].embedding.slice(0, 10)) {
      expect(Number.isFinite(val)).toBe(true);
    }
  }, 15000);

  it("similar texts produce similar embeddings", async () => {
    const [r1, r2, r3] = await Promise.all([
      getEmbeddingClient().embeddings.create({
        model: EMBEDDING_MODEL,
        input: "data privacy concerns in the project",
      }),
      getEmbeddingClient().embeddings.create({
        model: EMBEDDING_MODEL,
        input: "privacy issues raised about the project",
      }),
      getEmbeddingClient().embeddings.create({
        model: EMBEDDING_MODEL,
        input: "the weather is sunny today in Mumbai",
      }),
    ]);

    const { cosineSimilarity } = await import("../convex/memory/traversal");

    const simSimilar = cosineSimilarity(
      r1.data[0].embedding,
      r2.data[0].embedding
    );
    const simDifferent = cosineSimilarity(
      r1.data[0].embedding,
      r3.data[0].embedding
    );

    // Similar texts should have higher cosine similarity
    expect(simSimilar).toBeGreaterThan(simDifferent);
    expect(simSimilar).toBeGreaterThan(0.7);
    expect(simDifferent).toBeLessThan(0.5);
  }, 20000);
});
