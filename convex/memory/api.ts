import { action, query as convexQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { generateEmbedding } from "./embedding";

// ─── Write API ───

// Public wrapper around the internal ingest action.
// This is the entry point for external callers (scripts, NEops via HTTP).
export const ingestEvent = action({
  args: {
    content: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(),
    sourceId: v.optional(v.string()),
    eventTime: v.optional(v.number()),
    entities: v.optional(v.array(v.string())),
    keywords: v.optional(v.array(v.string())),
    temporalCue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runAction(internal.memory.ingest.ingest, {
      content: args.content,
      scope: args.scope,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      eventTime: args.eventTime,
      entities: args.entities,
      keywords: args.keywords,
      temporalCue: args.temporalCue,
    });
  },
});

// Ingest a batch of events in parallel.
export const ingestBatch = action({
  args: {
    events: v.array(
      v.object({
        content: v.string(),
        scope: v.union(v.literal("company"), v.literal("private")),
        sourceType: v.string(),
        sourceId: v.optional(v.string()),
        eventTime: v.optional(v.number()),
        entities: v.optional(v.array(v.string())),
        keywords: v.optional(v.array(v.string())),
        temporalCue: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const nodeIds = await Promise.all(
      args.events.map((event) =>
        ctx.runAction(internal.memory.ingest.ingest, {
          content: event.content,
          scope: event.scope,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          eventTime: event.eventTime,
          entities: event.entities,
          keywords: event.keywords,
          temporalCue: event.temporalCue,
        })
      )
    );
    return { ingested: nodeIds.length, nodeIds };
  },
});

// ─── Read API ───

// Get the full timeline of events involving a specific entity.
export const getEntityHistory = action({
  args: {
    entityName: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const events = await ctx.runQuery(
      internal.memory.graphUtils.getEventsByEntity,
      {
        entityName: args.entityName,
        scope: args.scope,
        limit: args.limit ?? 50,
      }
    );

    return events.map((e: Doc<"eventNodes">) => ({
      id: e._id,
      content: e.content,
      eventTime: e.eventTime,
      date: new Date(e.eventTime).toISOString().slice(0, 10),
      entities: e.metadata.entities,
    }));
  },
});

// Get chronological events within a time range.
export const getTimeline = action({
  args: {
    scope: v.union(v.literal("company"), v.literal("private")),
    start: v.number(),
    end: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const events = await ctx.runQuery(
      internal.memory.graphUtils.getEventsByTimeRange,
      {
        scope: args.scope,
        start: args.start,
        end: args.end,
        limit: args.limit ?? 50,
      }
    );

    return events.map((e: Doc<"eventNodes">) => ({
      id: e._id,
      content: e.content,
      eventTime: e.eventTime,
      date: new Date(e.eventTime).toISOString().slice(0, 10),
      entities: e.metadata.entities,
    }));
  },
});

// Trace cause→effect chain forward or backward from an event node.
export const getCausalChain = action({
  args: {
    eventNodeId: v.id("eventNodes"),
    direction: v.optional(
      v.union(v.literal("forward"), v.literal("backward"))
    ),
    maxDepth: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const direction = args.direction ?? "backward";
    const maxDepth = args.maxDepth ?? 5;
    const chain: Array<{
      id: string;
      content: string;
      eventTime: number;
      date: string;
      depth: number;
    }> = [];
    const visited = new Set<string>();

    let frontier: Id<"eventNodes">[] = [args.eventNodeId];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextFrontier: Id<"eventNodes">[] = [];

      for (const nodeId of frontier) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = await ctx.runQuery(internal.memory.graphUtils.getNode, {
          id: nodeId,
        });
        if (!node) continue;

        chain.push({
          id: node._id,
          content: node.content,
          eventTime: node.eventTime,
          date: new Date(node.eventTime).toISOString().slice(0, 10),
          depth,
        });

        const causalEdges = await ctx.runQuery(
          internal.memory.graphUtils.getCausalEdgesForNode,
          { nodeId }
        );

        for (const edge of causalEdges) {
          if (direction === "backward" && edge.toNode === nodeId) {
            if (!visited.has(edge.fromNode)) {
              nextFrontier.push(edge.fromNode);
            }
          } else if (direction === "forward" && edge.fromNode === nodeId) {
            if (!visited.has(edge.toNode)) {
              nextFrontier.push(edge.toNode);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    chain.sort((a, b) => a.eventTime - b.eventTime);
    return chain;
  },
});

// ─── Baseline Query (for eval comparison) ───

// Pure vector similarity search — no graph traversal, no intent classification.
// This is what a flat embedding store (pre-MAGMA Context Vault) would return.
export const baselineQuery = action({
  args: {
    queryText: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    maxNodes: v.optional(v.number()),
    tokenBudget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const limit = args.maxNodes ?? 10;
    const tokenBudget = args.tokenBudget ?? 4000;

    // Just embed the query and do vector search — nothing else
    const embedding = await generateEmbedding(args.queryText);

    const results = await ctx.runAction(
      internal.memory.graphUtils.findSimilarNodes,
      { embedding, scope: args.scope, limit }
    );

    // Linearize by similarity score (highest first)
    let context = "";
    let tokenCount = 0;
    const nodes: Array<{
      id: string;
      content: string;
      eventTime: number;
      score: number;
    }> = [];

    for (const r of results) {
      const date = new Date(r.node.eventTime).toISOString().slice(0, 10);
      const line = `[${date}] ${r.node.content} [ref:${r.node._id}]\n`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenCount + lineTokens > tokenBudget) break;

      context += line;
      tokenCount += lineTokens;
      nodes.push({
        id: r.node._id,
        content: r.node.content,
        eventTime: r.node.eventTime,
        score: r.score,
      });
    }

    return {
      context,
      nodes,
      nodesRetrieved: nodes.length,
      latencyMs: Date.now() - startTime,
    };
  },
});

// ─── Admin API ───

// Graph statistics: node and edge counts by type and scope.
// Bounded: counts up to COUNT_LIMIT to prevent OOM at scale.
export const getGraphStats = convexQuery({
  args: {
    scope: v.optional(v.union(v.literal("company"), v.literal("private"))),
  },
  handler: async (ctx, args) => {
    const COUNT_LIMIT = 10000;

    // Helper to count docs in a query (bounded)
    async function countQuery(query: any): Promise<number> {
      const docs = await query.take(COUNT_LIMIT);
      return docs.length;
    }

    let eventQ = ctx.db.query("eventNodes");
    if (args.scope) eventQ = eventQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const eventCount = await countQuery(eventQ);

    // For consolidated count, we need to filter — take events and count
    let eventForConsolidated = ctx.db.query("eventNodes");
    if (args.scope) eventForConsolidated = eventForConsolidated.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const events = await eventForConsolidated.take(COUNT_LIMIT);
    const consolidated = events.filter((n: any) => n.consolidated).length;

    let entityQ = ctx.db.query("entityNodes");
    if (args.scope) entityQ = entityQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const entityCount = await countQuery(entityQ);

    let tempQ = ctx.db.query("temporalEdges");
    if (args.scope) tempQ = tempQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const temporalCount = await countQuery(tempQ);

    let causalQ = ctx.db.query("causalEdges");
    if (args.scope) causalQ = causalQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const causalCount = await countQuery(causalQ);

    let semQ = ctx.db.query("semanticEdges");
    if (args.scope) semQ = semQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const semanticCount = await countQuery(semQ);

    let entEdgeQ = ctx.db.query("entityEdges");
    if (args.scope) entEdgeQ = entEdgeQ.withIndex("by_scope", (q) => q.eq("scope", args.scope!));
    const entityEdgeCount = await countQuery(entEdgeQ);

    return {
      scope: args.scope ?? "all",
      nodes: {
        events: eventCount,
        entities: entityCount,
        consolidated,
        unconsolidated: eventCount - consolidated,
      },
      edges: {
        temporal: temporalCount,
        causal: causalCount,
        semantic: semanticCount,
        entity: entityEdgeCount,
        total: temporalCount + causalCount + semanticCount + entityEdgeCount,
      },
    };
  },
});

// Consolidation queue status.
export const getConsolidationStatus = convexQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("consolidationQueue").collect();

    const pending = all.filter((i) => i.status === "pending").length;
    const processing = all.filter((i) => i.status === "processing").length;
    const done = all.filter((i) => i.status === "done").length;

    return { total: all.length, pending, processing, done };
  },
});

// Reset all stuck "processing" items back to pending.
// Use when consolidation workers have crashed and left items in limbo.
export const resetStuck = action({
  args: {},
  handler: async (ctx) => {
    return await ctx.runMutation(internal.memory.slowPath.resetAllStuck);
  },
});

// Force-consolidate a specific event node (skips queue, processes immediately).
// Useful during development to avoid waiting for cron.
export const forceConsolidate = action({
  args: { eventNodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    return await ctx.runAction(
      internal.memory.slowPath.forceConsolidate,
      { eventNodeId: args.eventNodeId }
    );
  },
});
