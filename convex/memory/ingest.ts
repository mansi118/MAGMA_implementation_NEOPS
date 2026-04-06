import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { generateEmbedding, extractMetadata } from "./embedding";

export const ingest = action({
  args: {
    content: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(),
    sourceId: v.optional(v.string()),
    eventTime: v.optional(v.number()), // Unix ms — defaults to now
  },
  handler: async (ctx, args) => {
    const eventTime = args.eventTime ?? Date.now();

    // Parallelize: embedding + metadata extraction are independent
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(args.content),
      extractMetadata(args.content),
    ]);

    // Write to DB via internal mutation
    const nodeId = await ctx.runMutation(internal.memory.fastPath.ingestEvent, {
      content: args.content,
      eventTime,
      embedding,
      scope: args.scope,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      entities: metadata.entities,
      keywords: metadata.keywords,
      temporalCue: metadata.temporalCue ?? undefined,
    });

    return nodeId;
  },
});
