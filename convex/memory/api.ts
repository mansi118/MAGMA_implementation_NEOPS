import { action, query as convexQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";

// ─── Write API ───

// Ingest a batch of events in parallel.
// Each item can optionally include pre-extracted metadata.
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

    // Already sorted by eventTime desc from the query
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
    direction: v.optional(v.union(v.literal("forward"), v.literal("backward"))),
    maxDepth: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const direction = args.direction ?? "backward"; // default: trace causes
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

        // Follow causal edges in the specified direction
        const causalEdges = await ctx.runQuery(
          internal.memory.graphUtils.getCausalEdgesForNode,
          { nodeId }
        );

        for (const edge of causalEdges) {
          if (direction === "backward" && edge.toNode === nodeId) {
            // This node is the effect — follow to the cause
            if (!visited.has(edge.fromNode)) {
              nextFrontier.push(edge.fromNode);
            }
          } else if (direction === "forward" && edge.fromNode === nodeId) {
            // This node is the cause — follow to the effect
            if (!visited.has(edge.toNode)) {
              nextFrontier.push(edge.toNode);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    // Sort by eventTime
    chain.sort((a, b) => a.eventTime - b.eventTime);
    return chain;
  },
});

// ─── Admin API ───

// Graph statistics: node and edge counts by type and scope.
export const getGraphStats = convexQuery({
  args: {
    scope: v.optional(v.union(v.literal("company"), v.literal("private"))),
  },
  handler: async (ctx, args) => {
    // Count event nodes
    let eventNodesQuery = ctx.db.query("eventNodes");
    if (args.scope) {
      eventNodesQuery = eventNodesQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const eventNodes = await eventNodesQuery.collect();

    // Count entity nodes
    let entityNodesQuery = ctx.db.query("entityNodes");
    if (args.scope) {
      entityNodesQuery = entityNodesQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const entityNodes = await entityNodesQuery.collect();

    // Count edges by type
    let temporalQuery = ctx.db.query("temporalEdges");
    if (args.scope) {
      temporalQuery = temporalQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const temporalEdges = await temporalQuery.collect();

    let causalQuery = ctx.db.query("causalEdges");
    if (args.scope) {
      causalQuery = causalQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const causalEdges = await causalQuery.collect();

    let semanticQuery = ctx.db.query("semanticEdges");
    if (args.scope) {
      semanticQuery = semanticQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const semanticEdges = await semanticQuery.collect();

    let entityEdgesQuery = ctx.db.query("entityEdges");
    if (args.scope) {
      entityEdgesQuery = entityEdgesQuery.withIndex("by_scope", (q) =>
        q.eq("scope", args.scope!)
      );
    }
    const entityEdges = await entityEdgesQuery.collect();

    const consolidated = eventNodes.filter((n) => n.consolidated).length;

    return {
      scope: args.scope ?? "all",
      nodes: {
        events: eventNodes.length,
        entities: entityNodes.length,
        consolidated,
        unconsolidated: eventNodes.length - consolidated,
      },
      edges: {
        temporal: temporalEdges.length,
        causal: causalEdges.length,
        semantic: semanticEdges.length,
        entity: entityEdges.length,
        total:
          temporalEdges.length +
          causalEdges.length +
          semanticEdges.length +
          entityEdges.length,
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

    return {
      total: all.length,
      pending,
      processing,
      done,
    };
  },
});
