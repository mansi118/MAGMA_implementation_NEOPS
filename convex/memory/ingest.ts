import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { generateEmbedding, extractMetadata } from "./embedding";

// Internal action — called by segmentAndIngest, ingestBatch, and the public
// ingestEvent wrapper in api.ts. Not directly exposed to clients.
export const ingest = internalAction({
  args: {
    content: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(),
    sourceId: v.optional(v.string()),
    eventTime: v.optional(v.number()),
    // Pre-extracted metadata — if provided, skips the extractMetadata LLM call.
    // Used by segmentAndIngest to avoid redundant extraction.
    entities: v.optional(v.array(v.string())),
    keywords: v.optional(v.array(v.string())),
    temporalCue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Cap content at 8K chars to stay within embedding model token limits
    const content = args.content.slice(0, 8000);
    const eventTime = args.eventTime ?? Date.now();

    let embedding: number[];
    let entities: string[];
    let keywords: string[];
    let temporalCue: string | undefined = args.temporalCue;

    if (args.entities && args.keywords) {
      // Pre-extracted: only need embedding
      embedding = await generateEmbedding(content);
      entities = args.entities;
      keywords = args.keywords;
    } else {
      // No pre-extraction: parallelize embedding + metadata extraction
      const [emb, metadata] = await Promise.all([
        generateEmbedding(content),
        extractMetadata(content),
      ]);
      embedding = emb;
      entities = metadata.entities;
      keywords = metadata.keywords;
      temporalCue = temporalCue ?? metadata.temporalCue ?? undefined;
    }

    const nodeId = await ctx.runMutation(internal.memory.fastPath.ingestEvent, {
      content,
      eventTime,
      embedding,
      scope: args.scope,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      entities,
      keywords,
      temporalCue,
    });

    return nodeId;
  },
});
