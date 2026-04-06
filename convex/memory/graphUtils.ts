import { internalQuery, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";

// ─── Types ───

export interface NeighborResult {
  node: Doc<"eventNodes">;
  edgeType: "temporal" | "causal" | "semantic";
  direction: "forward" | "backward"; // forward = this node is cause/before, backward = this node is effect/after
  edgeWeight: number; // 1.0 for temporal, confidence for causal, similarity for semantic
}

// ─── Queries ───

export const getNode = internalQuery({
  args: { id: v.id("eventNodes") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Get all direct neighbors of a node across temporal, causal, and semantic edges.
// Does NOT traverse entity edges (those link to entityNodes, not eventNodes).
export const getNeighbors = internalQuery({
  args: { nodeId: v.id("eventNodes") },
  handler: async (ctx, args): Promise<NeighborResult[]> => {
    const results: NeighborResult[] = [];

    // Temporal: forward (this node → next)
    const tempForward = await ctx.db
      .query("temporalEdges")
      .withIndex("by_from", (q) => q.eq("fromNode", args.nodeId))
      .collect();
    for (const edge of tempForward) {
      const node = await ctx.db.get(edge.toNode);
      if (node) results.push({ node, edgeType: "temporal", direction: "forward", edgeWeight: 1.0 });
    }

    // Temporal: backward (prev node → this node)
    const tempBackward = await ctx.db
      .query("temporalEdges")
      .withIndex("by_to", (q) => q.eq("toNode", args.nodeId))
      .collect();
    for (const edge of tempBackward) {
      const node = await ctx.db.get(edge.fromNode);
      if (node) results.push({ node, edgeType: "temporal", direction: "backward", edgeWeight: 1.0 });
    }

    // Causal: forward (this node caused something)
    const causalForward = await ctx.db
      .query("causalEdges")
      .withIndex("by_from", (q) => q.eq("fromNode", args.nodeId))
      .collect();
    for (const edge of causalForward) {
      const node = await ctx.db.get(edge.toNode);
      if (node) results.push({ node, edgeType: "causal", direction: "forward", edgeWeight: edge.confidence });
    }

    // Causal: backward (something caused this node)
    const causalBackward = await ctx.db
      .query("causalEdges")
      .withIndex("by_to", (q) => q.eq("toNode", args.nodeId))
      .collect();
    for (const edge of causalBackward) {
      const node = await ctx.db.get(edge.fromNode);
      if (node) results.push({ node, edgeType: "causal", direction: "backward", edgeWeight: edge.confidence });
    }

    // Semantic: nodeA direction
    const semA = await ctx.db
      .query("semanticEdges")
      .withIndex("by_nodeA", (q) => q.eq("nodeA", args.nodeId))
      .collect();
    for (const edge of semA) {
      const node = await ctx.db.get(edge.nodeB);
      if (node) results.push({ node, edgeType: "semantic", direction: "forward", edgeWeight: edge.similarity });
    }

    // Semantic: nodeB direction
    const semB = await ctx.db
      .query("semanticEdges")
      .withIndex("by_nodeB", (q) => q.eq("nodeB", args.nodeId))
      .collect();
    for (const edge of semB) {
      const node = await ctx.db.get(edge.nodeA);
      if (node) results.push({ node, edgeType: "semantic", direction: "forward", edgeWeight: edge.similarity });
    }

    return results;
  },
});

// N-hop neighborhood expansion. Returns unique event nodes within N hops.
// Cap at maxNodes to prevent runaway traversals.
export const getNeighborhood = internalQuery({
  args: {
    nodeId: v.id("eventNodes"),
    hops: v.number(),
    maxNodes: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Doc<"eventNodes">[]> => {
    const max = args.maxNodes ?? 20;
    const visited = new Set<string>([args.nodeId]);
    let frontier: Id<"eventNodes">[] = [args.nodeId];
    const allNodes: Doc<"eventNodes">[] = [];

    // Get the target node itself
    const targetNode = await ctx.db.get(args.nodeId);
    if (targetNode) allNodes.push(targetNode);

    for (let hop = 0; hop < args.hops; hop++) {
      const nextFrontier: Id<"eventNodes">[] = [];

      for (const nodeId of frontier) {
        if (allNodes.length >= max) break;

        // Inline neighbor fetching to stay within single query context
        // Temporal forward
        const tf = await ctx.db
          .query("temporalEdges")
          .withIndex("by_from", (q) => q.eq("fromNode", nodeId))
          .collect();
        for (const e of tf) {
          if (!visited.has(e.toNode) && allNodes.length < max) {
            visited.add(e.toNode);
            nextFrontier.push(e.toNode);
            const n = await ctx.db.get(e.toNode);
            if (n) allNodes.push(n);
          }
        }

        // Temporal backward
        const tb = await ctx.db
          .query("temporalEdges")
          .withIndex("by_to", (q) => q.eq("toNode", nodeId))
          .collect();
        for (const e of tb) {
          if (!visited.has(e.fromNode) && allNodes.length < max) {
            visited.add(e.fromNode);
            nextFrontier.push(e.fromNode);
            const n = await ctx.db.get(e.fromNode);
            if (n) allNodes.push(n);
          }
        }

        // Causal forward
        const cf = await ctx.db
          .query("causalEdges")
          .withIndex("by_from", (q) => q.eq("fromNode", nodeId))
          .collect();
        for (const e of cf) {
          if (!visited.has(e.toNode) && allNodes.length < max) {
            visited.add(e.toNode);
            nextFrontier.push(e.toNode);
            const n = await ctx.db.get(e.toNode);
            if (n) allNodes.push(n);
          }
        }

        // Causal backward
        const cb = await ctx.db
          .query("causalEdges")
          .withIndex("by_to", (q) => q.eq("toNode", nodeId))
          .collect();
        for (const e of cb) {
          if (!visited.has(e.fromNode) && allNodes.length < max) {
            visited.add(e.fromNode);
            nextFrontier.push(e.fromNode);
            const n = await ctx.db.get(e.fromNode);
            if (n) allNodes.push(n);
          }
        }

        // Semantic (both directions since undirected)
        const sa = await ctx.db
          .query("semanticEdges")
          .withIndex("by_nodeA", (q) => q.eq("nodeA", nodeId))
          .collect();
        for (const e of sa) {
          if (!visited.has(e.nodeB) && allNodes.length < max) {
            visited.add(e.nodeB);
            nextFrontier.push(e.nodeB);
            const n = await ctx.db.get(e.nodeB);
            if (n) allNodes.push(n);
          }
        }

        const sb = await ctx.db
          .query("semanticEdges")
          .withIndex("by_nodeB", (q) => q.eq("nodeB", nodeId))
          .collect();
        for (const e of sb) {
          if (!visited.has(e.nodeA) && allNodes.length < max) {
            visited.add(e.nodeA);
            nextFrontier.push(e.nodeA);
            const n = await ctx.db.get(e.nodeA);
            if (n) allNodes.push(n);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0 || allNodes.length >= max) break;
    }

    return allNodes;
  },
});

// Vector search for semantically similar nodes.
// Must be an action because ctx.vectorSearch is only available in actions.
export const findSimilarNodes = internalAction({
  args: {
    embedding: v.array(v.float64()),
    scope: v.string(),
    limit: v.number(),
    excludeId: v.optional(v.id("eventNodes")),
  },
  handler: async (ctx, args) => {
    const results = await ctx.vectorSearch("eventNodes", "by_embedding", {
      vector: args.embedding,
      limit: args.limit + 1,
      filter: (q: any) => q.eq("scope", args.scope),
    });

    // Exclude self if needed, fetch full docs via runQuery helper
    const nodes: Array<{ node: Doc<"eventNodes">; score: number }> = [];
    for (const r of results) {
      if (args.excludeId && r._id === args.excludeId) continue;
      if (nodes.length >= args.limit) break;
      const node = await ctx.runQuery(internal.memory.graphUtils.getNode, {
        id: r._id,
      });
      if (node) nodes.push({ node, score: r._score });
    }
    return nodes;
  },
});

// Get entity edges + entity nodes for a specific event node
export const getEntityInfo = internalQuery({
  args: { eventNodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    const edges = await ctx.db
      .query("entityEdges")
      .withIndex("by_event", (q) => q.eq("eventNode", args.eventNodeId))
      .collect();

    const results: Array<{
      edge: Doc<"entityEdges">;
      entity: Doc<"entityNodes">;
    }> = [];

    for (const edge of edges) {
      const entity = await ctx.db.get(edge.entityNode);
      if (entity) results.push({ edge, entity });
    }

    return results;
  },
});

// Get existing semantic edges for a node (both directions) — used for dedup
export const getSemanticEdgesForNode = internalQuery({
  args: { nodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    const asA = await ctx.db
      .query("semanticEdges")
      .withIndex("by_nodeA", (q) => q.eq("nodeA", args.nodeId))
      .collect();
    const asB = await ctx.db
      .query("semanticEdges")
      .withIndex("by_nodeB", (q) => q.eq("nodeB", args.nodeId))
      .collect();
    return [...asA, ...asB];
  },
});

// Get existing causal edges for a node (both directions) — used for dedup
export const getCausalEdgesForNode = internalQuery({
  args: { nodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    const asFrom = await ctx.db
      .query("causalEdges")
      .withIndex("by_from", (q) => q.eq("fromNode", args.nodeId))
      .collect();
    const asTo = await ctx.db
      .query("causalEdges")
      .withIndex("by_to", (q) => q.eq("toNode", args.nodeId))
      .collect();
    return [...asFrom, ...asTo];
  },
});

// ─── Query Pipeline Support ───

// Full-text search on event content (Stage 2, Signal B)
export const searchByContent = internalQuery({
  args: {
    searchText: v.string(),
    scope: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("eventNodes")
      .withSearchIndex("by_content", (q) =>
        q.search("content", args.searchText).eq("scope", args.scope)
      )
      .take(args.limit);
  },
});

// Temporal range query (Stage 2, Signal C)
export const getEventsByTimeRange = internalQuery({
  args: {
    scope: v.string(),
    start: v.number(),
    end: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("eventNodes")
      .withIndex("by_scope_eventTime", (q) =>
        q.eq("scope", args.scope).gte("eventTime", args.start).lte("eventTime", args.end)
      )
      .take(args.limit);
  },
});

// Entity-based event lookup (Stage 2, Signal D)
// Given an entity name, find all events linked to that entity.
export const getEventsByEntity = internalQuery({
  args: {
    entityName: v.string(),
    scope: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Find the entity node
    const entity = await ctx.db
      .query("entityNodes")
      .withIndex("by_name_scope", (q) =>
        q.eq("name", args.entityName.toLowerCase()).eq("scope", args.scope)
      )
      .first();

    if (!entity) return [];

    // Get all event edges for this entity, sorted by most recent
    const edges = await ctx.db
      .query("entityEdges")
      .withIndex("by_entity", (q) => q.eq("entityNode", entity._id))
      .collect();

    // Fetch event nodes
    const events: Doc<"eventNodes">[] = [];
    for (const edge of edges) {
      if (events.length >= args.limit) break;
      const node = await ctx.db.get(edge.eventNode);
      if (node) events.push(node);
    }

    // Sort by eventTime descending (most recent first)
    events.sort((a, b) => b.eventTime - a.eventTime);
    return events.slice(0, args.limit);
  },
});

// Entity graph traversal: find events linked to the same entities as the given event.
// This is a 2-hop traversal: eventNode → entityNode → other eventNodes.
// Used during beam search for entity-type edge scoring.
export const getEntityLinkedEvents = internalQuery({
  args: {
    eventNodeId: v.id("eventNodes"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const max = args.limit ?? 15;

    // Get entities linked to this event
    const entityEdges = await ctx.db
      .query("entityEdges")
      .withIndex("by_event", (q) => q.eq("eventNode", args.eventNodeId))
      .collect();

    const seen = new Set<string>([args.eventNodeId]);
    const results: Array<{ node: Doc<"eventNodes">; entityName: string }> = [];

    for (const edge of entityEdges) {
      if (results.length >= max) break;

      const entity = await ctx.db.get(edge.entityNode);
      if (!entity) continue;

      // Get other events linked to this entity
      const linkedEdges = await ctx.db
        .query("entityEdges")
        .withIndex("by_entity", (q) => q.eq("entityNode", edge.entityNode))
        .collect();

      for (const linked of linkedEdges) {
        if (results.length >= max) break;
        if (seen.has(linked.eventNode)) continue;
        seen.add(linked.eventNode);

        const node = await ctx.db.get(linked.eventNode);
        if (node) results.push({ node, entityName: entity.name });
      }
    }

    return results;
  },
});

// Get causal edges between a set of node IDs — used for topological sort in synthesis
export const getCausalEdgesBetween = internalQuery({
  args: { nodeIds: v.array(v.id("eventNodes")) },
  handler: async (ctx, args) => {
    const idSet = new Set(args.nodeIds.map((id) => id.toString()));
    const edges: Doc<"causalEdges">[] = [];

    for (const nodeId of args.nodeIds) {
      const fromEdges = await ctx.db
        .query("causalEdges")
        .withIndex("by_from", (q) => q.eq("fromNode", nodeId))
        .collect();

      for (const edge of fromEdges) {
        if (idSet.has(edge.toNode.toString())) {
          edges.push(edge);
        }
      }
    }

    return edges;
  },
});
