import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const ingestEvent = internalMutation({
  args: {
    content: v.string(),
    eventTime: v.number(),
    embedding: v.array(v.float64()),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(),
    sourceId: v.optional(v.string()),
    entities: v.array(v.string()), // Already lowercased by extractMetadata
    keywords: v.array(v.string()),
    temporalCue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Insert Event Node
    const nodeId = await ctx.db.insert("eventNodes", {
      content: args.content,
      eventTime: args.eventTime,
      createdAt: now,
      embedding: args.embedding,
      scope: args.scope,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      metadata: {
        entities: args.entities,
        temporalCues: args.temporalCue,
        keywords: args.keywords,
      },
      consolidated: false,
    });

    // 2. Temporal Edge — splice into the chain at the correct position.
    //    Find prev (latest event before this) and next (earliest event after this).
    //    If prev→next edge exists, delete it and create prev→new + new→next.
    const prevNode = await ctx.db
      .query("eventNodes")
      .withIndex("by_scope_eventTime", (q) =>
        q.eq("scope", args.scope).lt("eventTime", args.eventTime)
      )
      .order("desc")
      .first();

    const nextNode = await ctx.db
      .query("eventNodes")
      .withIndex("by_scope_eventTime", (q) =>
        q.eq("scope", args.scope).gt("eventTime", args.eventTime)
      )
      .order("asc")
      .first();

    // If both prev and next exist, check for an existing prev→next edge to splice
    if (prevNode && nextNode) {
      const existingEdge = await ctx.db
        .query("temporalEdges")
        .withIndex("by_from", (q) => q.eq("fromNode", prevNode._id))
        .first();
      if (existingEdge && existingEdge.toNode === nextNode._id) {
        await ctx.db.delete(existingEdge._id);
      }
    }

    if (prevNode) {
      await ctx.db.insert("temporalEdges", {
        fromNode: prevNode._id,
        toNode: nodeId,
        scope: args.scope,
      });
    }
    if (nextNode) {
      await ctx.db.insert("temporalEdges", {
        fromNode: nodeId,
        toNode: nextNode._id,
        scope: args.scope,
      });
    }

    // 3. Entity Resolution — upsert entity nodes + create entity edges
    for (const entityName of args.entities) {
      // Look up existing entity by normalized name + scope
      const existing = await ctx.db
        .query("entityNodes")
        .withIndex("by_name_scope", (q) =>
          q.eq("name", entityName).eq("scope", args.scope)
        )
        .first();

      let entityId;

      if (existing) {
        // Update lastSeen if this event is newer
        if (args.eventTime > existing.lastSeen) {
          await ctx.db.patch(existing._id, { lastSeen: args.eventTime });
        }
        // Update firstSeen if this event is older (backfill case)
        if (args.eventTime < existing.firstSeen) {
          await ctx.db.patch(existing._id, { firstSeen: args.eventTime });
        }
        entityId = existing._id;
      } else {
        // Create new entity — slow path will classify type and merge duplicates
        entityId = await ctx.db.insert("entityNodes", {
          name: entityName,
          type: "unknown",
          aliases: [entityName],
          scope: args.scope,
          firstSeen: args.eventTime,
          lastSeen: args.eventTime,
        });
      }

      // Create entity edge
      await ctx.db.insert("entityEdges", {
        eventNode: nodeId,
        entityNode: entityId,
        role: "participant", // Slow path refines to subject/object/owner
        scope: args.scope,
      });
    }

    // 4. Enqueue for slow-path consolidation
    await ctx.db.insert("consolidationQueue", {
      eventNodeId: nodeId,
      priority: 1,
      createdAt: now,
      status: "pending",
    });

    return nodeId;
  },
});
