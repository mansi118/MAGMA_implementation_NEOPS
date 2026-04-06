import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ─── CORE EVENT NODES ───
  // Every memory item is an Event Node — the fundamental unit of the MAGMA graph.
  // An event is an atomic observation, action, decision, or state change.
  eventNodes: defineTable({
    content: v.string(),
    eventTime: v.number(), // Unix ms — when the event HAPPENED in the real world
    createdAt: v.number(), // Unix ms — when this node was ingested into the system
    embedding: v.array(v.float64()),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(), // "conversation", "document", "tool_output", "observation"
    sourceId: v.optional(v.string()),
    metadata: v.object({
      entities: v.array(v.string()),
      temporalCues: v.optional(v.string()), // Raw temporal reference: "last Friday", "Q3 2025"
      keywords: v.array(v.string()),
    }),
    consolidated: v.boolean(), // Has slow-path processed this node?
  })
    .index("by_scope", ["scope"])
    .index("by_eventTime", ["eventTime"])
    .index("by_scope_eventTime", ["scope", "eventTime"])
    .index("by_createdAt", ["createdAt"])
    .searchIndex("by_content", {
      searchField: "content",
      filterFields: ["scope"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536, // text-embedding-3-small
      filterFields: ["scope"],
    }),

  // ─── TEMPORAL EDGES ───
  // Directed: fromNode happened BEFORE toNode within the same scope.
  // Built from eventTime ordering, not ingestion order.
  temporalEdges: defineTable({
    fromNode: v.id("eventNodes"),
    toNode: v.id("eventNodes"),
    scope: v.string(),
  })
    .index("by_from", ["fromNode"])
    .index("by_to", ["toNode"])
    .index("by_scope", ["scope"]),

  // ─── CAUSAL EDGES ───
  // Directed: fromNode caused/led to toNode. Inferred by slow-path LLM.
  // Cause must precede effect in eventTime.
  causalEdges: defineTable({
    fromNode: v.id("eventNodes"), // Cause
    toNode: v.id("eventNodes"), // Effect
    confidence: v.number(), // [0, 1]
    reasoning: v.string(),
    scope: v.string(),
  })
    .index("by_from", ["fromNode"])
    .index("by_to", ["toNode"])
    .index("by_scope", ["scope"]),

  // ─── SEMANTIC EDGES ───
  // Undirected: nodeA and nodeB are semantically similar (cosine > threshold).
  // Convention: nodeA < nodeB (lexicographic on ID) to prevent duplicates.
  semanticEdges: defineTable({
    nodeA: v.id("eventNodes"),
    nodeB: v.id("eventNodes"),
    similarity: v.number(),
    scope: v.string(),
  })
    .index("by_nodeA", ["nodeA"])
    .index("by_nodeB", ["nodeB"])
    .index("by_scope", ["scope"]),

  // ─── ENTITY NODES ───
  // Abstract entities: people, companies, projects, concepts, tools.
  entityNodes: defineTable({
    name: v.string(),
    type: v.string(), // "person", "company", "project", "concept", "tool", "unknown"
    aliases: v.array(v.string()),
    scope: v.string(),
    firstSeen: v.number(), // eventTime of earliest linked event
    lastSeen: v.number(), // eventTime of latest linked event
    attributes: v.optional(v.any()),
  })
    .index("by_name", ["name"])
    .index("by_name_scope", ["name", "scope"])
    .index("by_type", ["type"])
    .index("by_scope", ["scope"]),

  // ─── ENTITY EDGES ───
  // Links event nodes to entity nodes with a role.
  entityEdges: defineTable({
    eventNode: v.id("eventNodes"),
    entityNode: v.id("entityNodes"),
    role: v.string(), // "subject", "object", "participant", "owner"
    scope: v.string(),
  })
    .index("by_event", ["eventNode"])
    .index("by_entity", ["entityNode"])
    .index("by_scope", ["scope"]),

  // ─── CONSOLIDATION QUEUE ───
  // Slow-path work queue. Each new event is enqueued here for async enrichment.
  consolidationQueue: defineTable({
    eventNodeId: v.id("eventNodes"),
    priority: v.number(), // Lower = higher priority
    createdAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("done")
    ),
  })
    .index("by_status_priority", ["status", "priority"])
    .index("by_eventNode", ["eventNodeId"]),
});
