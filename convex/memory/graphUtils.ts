import { internalQuery } from "../_generated/server";
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

// Vector search for semantically similar nodes
export const findSimilarNodes = internalQuery({
  args: {
    embedding: v.array(v.float64()),
    scope: v.string(),
    limit: v.number(),
    excludeId: v.optional(v.id("eventNodes")),
  },
  handler: async (ctx, args) => {
    const results = await ctx.vectorSearch("eventNodes", "by_embedding", {
      vector: args.embedding,
      limit: args.limit + 1, // +1 in case we need to exclude self
      filter: (q) => q.eq("scope", args.scope),
    });

    // Exclude self if needed, fetch full docs
    const nodes: Array<{ node: Doc<"eventNodes">; score: number }> = [];
    for (const r of results) {
      if (args.excludeId && r._id === args.excludeId) continue;
      if (nodes.length >= args.limit) break;
      const node = await ctx.db.get(r._id);
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
