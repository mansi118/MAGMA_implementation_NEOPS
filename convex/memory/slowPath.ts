import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Id, Doc } from "../_generated/dataModel";
import { chatClient, CHAT_MODEL } from "./llm";

// ─── Config ───

const MAX_BATCH_SIZE = 10; // Max items per cron invocation
const TIME_LIMIT_MS = 25_000; // 25s safety margin within 30s cron interval
const SEMANTIC_THRESHOLD = 0.75;
const CAUSAL_CONFIDENCE_THRESHOLD = 0.6;

// ─── Mutations ───

// Atomically claim the next pending queue item
export const claimNext = internalMutation({
  handler: async (ctx) => {
    const item = await ctx.db
      .query("consolidationQueue")
      .withIndex("by_status_priority", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();

    if (!item) return null;

    await ctx.db.patch(item._id, { status: "processing" });
    return item;
  },
});

// Mark consolidation as done
export const markDone = internalMutation({
  args: {
    queueId: v.id("consolidationQueue"),
    eventNodeId: v.id("eventNodes"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueId, { status: "done" });
    await ctx.db.patch(args.eventNodeId, { consolidated: true });
  },
});

// Reset a stuck item back to pending
export const resetItem = internalMutation({
  args: { queueId: v.id("consolidationQueue") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueId, { status: "pending" });
  },
});

// Reset ALL stuck "processing" items back to pending
export const resetAllStuck = internalMutation({
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query("consolidationQueue")
      .withIndex("by_status_priority", (q) => q.eq("status", "processing"))
      .collect();

    for (const item of stuck) {
      await ctx.db.patch(item._id, { status: "pending" });
    }

    return { reset: stuck.length };
  },
});

// Batch insert causal edges with dedup
export const writeCausalEdges = internalMutation({
  args: {
    edges: v.array(
      v.object({
        fromNode: v.id("eventNodes"),
        toNode: v.id("eventNodes"),
        confidence: v.number(),
        reasoning: v.string(),
        scope: v.string(),
      })
    ),
    existingPairs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existingSet = new Set(args.existingPairs);
    let inserted = 0;

    for (const edge of args.edges) {
      const key = `${edge.fromNode}->${edge.toNode}`;
      if (existingSet.has(key)) continue;

      await ctx.db.insert("causalEdges", {
        fromNode: edge.fromNode,
        toNode: edge.toNode,
        confidence: edge.confidence,
        reasoning: edge.reasoning,
        scope: edge.scope,
      });
      existingSet.add(key);
      inserted++;
    }

    return inserted;
  },
});

// Batch insert semantic edges with dedup + nodeA < nodeB ordering
export const writeSemanticEdges = internalMutation({
  args: {
    edges: v.array(
      v.object({
        nodeA: v.id("eventNodes"),
        nodeB: v.id("eventNodes"),
        similarity: v.number(),
        scope: v.string(),
      })
    ),
    existingPairs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existingSet = new Set(args.existingPairs);
    let inserted = 0;

    for (const edge of args.edges) {
      const [a, b] =
        edge.nodeA < edge.nodeB
          ? [edge.nodeA, edge.nodeB]
          : [edge.nodeB, edge.nodeA];

      const key = `${a}<>${b}`;
      if (existingSet.has(key)) continue;

      await ctx.db.insert("semanticEdges", {
        nodeA: a as Id<"eventNodes">,
        nodeB: b as Id<"eventNodes">,
        similarity: edge.similarity,
        scope: edge.scope,
      });
      existingSet.add(key);
      inserted++;
    }

    return inserted;
  },
});

// Update entity types and roles
export const enrichEntities = internalMutation({
  args: {
    updates: v.array(
      v.object({
        entityId: v.id("entityNodes"),
        edgeId: v.id("entityEdges"),
        type: v.string(),
        role: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const update of args.updates) {
      await ctx.db.patch(update.entityId, { type: update.type });
      await ctx.db.patch(update.edgeId, { role: update.role });
    }
  },
});

// ─── LLM Helpers ───

interface CausalEdgeCandidate {
  fromLabel: string;
  toLabel: string;
  confidence: number;
  reasoning: string;
}

async function inferCausalEdges(
  targetNode: Doc<"eventNodes">,
  neighborhood: Doc<"eventNodes">[],
  labelMap: Map<string, string>
): Promise<CausalEdgeCandidate[]> {
  const targetLabel =
    [...labelMap.entries()].find(([, id]) => id === targetNode._id)?.[0] ??
    "n0";

  const neighborLines = neighborhood
    .filter((n) => n._id !== targetNode._id)
    .map((n) => {
      const label =
        [...labelMap.entries()].find(([, id]) => id === n._id)?.[0] ?? "?";
      const date = new Date(n.eventTime).toISOString().slice(0, 10);
      return `[${label}] [${date}] ${n.content}`;
    })
    .join("\n");

  const targetDate = new Date(targetNode.eventTime).toISOString().slice(0, 10);

  const prompt = `You are a memory consolidation agent. Given an event and its neighborhood, infer direct causal relationships.

IMPORTANT: Causality ≠ temporal sequence. "A happened before B" does NOT mean "A caused B".
Only infer edges where one event directly influenced, triggered, or led to another.

TARGET EVENT:
[${targetLabel}] [${targetDate}] ${targetNode.content}

NEIGHBORHOOD:
${neighborLines}

Return JSON:
{
  "causal_edges": [
    {
      "from_label": "the label of the cause event",
      "to_label": "the label of the effect event",
      "confidence": 0.0-1.0,
      "reasoning": "one sentence explaining the causal link"
    }
  ]
}

Rules:
- The cause event must have an earlier date than the effect event
- Only include edges with confidence > ${CAUSAL_CONFIDENCE_THRESHOLD}
- Maximum 5 edges
- At least one endpoint of each edge must be the target event [${targetLabel}]
- If no causal relationships exist, return {"causal_edges": []}`;

  const response = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
  return Array.isArray(parsed.causal_edges) ? parsed.causal_edges : [];
}

interface EntityEnrichment {
  name: string;
  type: string;
  role: string;
}

async function classifyEntities(
  eventContent: string,
  entityNames: string[]
): Promise<EntityEnrichment[]> {
  if (entityNames.length === 0) return [];

  const prompt = `Given this event and the entities mentioned in it, classify each entity and determine its role.

EVENT: ${eventContent}

ENTITIES: ${entityNames.join(", ")}

Return JSON:
{
  "entities": [
    {
      "name": "entity name (lowercase, as given)",
      "type": "person" | "company" | "project" | "concept" | "tool",
      "role": "subject" | "object" | "participant" | "owner"
    }
  ]
}

Role definitions:
- subject: the primary actor/agent performing the action
- object: the thing being acted upon or discussed
- participant: involved but not primary actor or target
- owner: the entity that owns/controls something referenced`;

  const response = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
  return Array.isArray(parsed.entities) ? parsed.entities : [];
}

// ─── Single Node Consolidation (extracted for reuse) ───

interface ConsolidationResult {
  nodeId: string;
  causalEdgesInserted: number;
  semanticEdgesInserted: number;
  entitiesEnriched: number;
  errors: string[];
}

async function consolidateOne(
  ctx: any,
  item: Doc<"consolidationQueue">
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    nodeId: item.eventNodeId,
    causalEdgesInserted: 0,
    semanticEdgesInserted: 0,
    entitiesEnriched: 0,
    errors: [],
  };

  // Fetch target node
  const targetNode = await ctx.runQuery(internal.memory.graphUtils.getNode, {
    id: item.eventNodeId,
  });
  if (!targetNode) {
    await ctx.runMutation(internal.memory.slowPath.markDone, {
      queueId: item._id,
      eventNodeId: item.eventNodeId,
    });
    result.errors.push("Node not found — marked done");
    return result;
  }

  // Fetch 2-hop neighborhood
  const neighborhood: Doc<"eventNodes">[] = await ctx.runQuery(
    internal.memory.graphUtils.getNeighborhood,
    { nodeId: targetNode._id, hops: 2, maxNodes: 20 }
  );

  const labelMap = new Map<string, string>();
  neighborhood.forEach((node: Doc<"eventNodes">, i: number) => {
    labelMap.set(`n${i}`, node._id);
  });

  // Step 1: Causal inference (try/catch — don't block other steps)
  try {
    if (neighborhood.length > 1) {
      const causalCandidates = await inferCausalEdges(
        targetNode,
        neighborhood,
        labelMap
      );

      const existingCausal = await ctx.runQuery(
        internal.memory.graphUtils.getCausalEdgesForNode,
        { nodeId: targetNode._id }
      );
      const existingPairs = existingCausal.map(
        (e: Doc<"causalEdges">) => `${e.fromNode}->${e.toNode}`
      );

      const validEdges: Array<{
        fromNode: Id<"eventNodes">;
        toNode: Id<"eventNodes">;
        confidence: number;
        reasoning: string;
        scope: string;
      }> = [];

      for (const candidate of causalCandidates) {
        const fromId = labelMap.get(candidate.fromLabel);
        const toId = labelMap.get(candidate.toLabel);
        if (!fromId || !toId) continue;
        if (candidate.confidence < CAUSAL_CONFIDENCE_THRESHOLD) continue;

        const fromNode = neighborhood.find((n) => n._id === fromId);
        const toNode = neighborhood.find((n) => n._id === toId);
        if (!fromNode || !toNode) continue;
        if (fromNode.eventTime >= toNode.eventTime) continue;

        validEdges.push({
          fromNode: fromId as Id<"eventNodes">,
          toNode: toId as Id<"eventNodes">,
          confidence: candidate.confidence,
          reasoning: candidate.reasoning,
          scope: targetNode.scope,
        });
      }

      if (validEdges.length > 0) {
        const inserted = await ctx.runMutation(
          internal.memory.slowPath.writeCausalEdges,
          { edges: validEdges, existingPairs }
        );
        result.causalEdgesInserted = inserted;
      }
    }
  } catch (err: any) {
    result.errors.push(`causal: ${err.message ?? err}`);
  }

  // Step 2: Semantic edges (try/catch)
  try {
    const similarNodes = await ctx.runQuery(
      internal.memory.graphUtils.findSimilarNodes,
      {
        embedding: targetNode.embedding,
        scope: targetNode.scope,
        limit: 10,
        excludeId: targetNode._id,
      }
    );

    const aboveThreshold = similarNodes.filter(
      (s: { score: number }) => s.score >= SEMANTIC_THRESHOLD
    );

    if (aboveThreshold.length > 0) {
      const existingSemantic = await ctx.runQuery(
        internal.memory.graphUtils.getSemanticEdgesForNode,
        { nodeId: targetNode._id }
      );
      const existingPairs = existingSemantic.map(
        (e: Doc<"semanticEdges">) => {
          const [a, b] =
            e.nodeA < e.nodeB ? [e.nodeA, e.nodeB] : [e.nodeB, e.nodeA];
          return `${a}<>${b}`;
        }
      );

      const semanticEdges = aboveThreshold.map(
        (s: { node: Doc<"eventNodes">; score: number }) => ({
          nodeA: targetNode._id,
          nodeB: s.node._id,
          similarity: s.score,
          scope: targetNode.scope,
        })
      );

      const inserted = await ctx.runMutation(
        internal.memory.slowPath.writeSemanticEdges,
        { edges: semanticEdges, existingPairs }
      );
      result.semanticEdgesInserted = inserted;
    }
  } catch (err: any) {
    result.errors.push(`semantic: ${err.message ?? err}`);
  }

  // Step 3: Entity enrichment (try/catch)
  try {
    const entityInfo = await ctx.runQuery(
      internal.memory.graphUtils.getEntityInfo,
      { eventNodeId: targetNode._id }
    );

    const toEnrich = entityInfo.filter(
      (e: { entity: Doc<"entityNodes">; edge: Doc<"entityEdges"> }) =>
        e.entity.type === "unknown" || e.edge.role === "participant"
    );

    if (toEnrich.length > 0) {
      const entityNames = toEnrich.map(
        (e: { entity: Doc<"entityNodes"> }) => e.entity.name
      );
      const enrichments = await classifyEntities(
        targetNode.content,
        entityNames
      );

      const updates: Array<{
        entityId: Id<"entityNodes">;
        edgeId: Id<"entityEdges">;
        type: string;
        role: string;
      }> = [];

      for (const enrichment of enrichments) {
        const match = toEnrich.find(
          (e: { entity: Doc<"entityNodes"> }) =>
            e.entity.name === enrichment.name.toLowerCase()
        );
        if (!match) continue;

        updates.push({
          entityId: match.entity._id,
          edgeId: match.edge._id,
          type: enrichment.type,
          role: enrichment.role,
        });
      }

      if (updates.length > 0) {
        await ctx.runMutation(internal.memory.slowPath.enrichEntities, {
          updates,
        });
        result.entitiesEnriched = updates.length;
      }
    }
  } catch (err: any) {
    result.errors.push(`entities: ${err.message ?? err}`);
  }

  // Mark done
  await ctx.runMutation(internal.memory.slowPath.markDone, {
    queueId: item._id,
    eventNodeId: targetNode._id,
  });

  return result;
}

// ─── Batch Consolidation Action (called by cron) ───

export const consolidateNext = internalAction({
  handler: async (ctx) => {
    const startTime = Date.now();
    const batchResults: ConsolidationResult[] = [];
    let itemsProcessed = 0;

    for (let i = 0; i < MAX_BATCH_SIZE; i++) {
      // Time check — stop if we're nearing the cron interval
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        console.log(
          `[consolidation] Time limit reached after ${itemsProcessed} items`
        );
        break;
      }

      // Claim next item
      const item = await ctx.runMutation(internal.memory.slowPath.claimNext);
      if (!item) break; // Queue empty

      const result = await consolidateOne(ctx, item);
      batchResults.push(result);
      itemsProcessed++;

      // Log per-item result
      const errStr =
        result.errors.length > 0 ? ` errors=[${result.errors.join("; ")}]` : "";
      console.log(
        `[consolidation] ${result.nodeId}: causal=${result.causalEdgesInserted} semantic=${result.semanticEdgesInserted} entities=${result.entitiesEnriched}${errStr}`
      );
    }

    if (itemsProcessed === 0) {
      return { status: "idle", processed: 0 };
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[consolidation] Batch done: ${itemsProcessed} items in ${elapsed}ms`
    );

    return {
      status: "done",
      processed: itemsProcessed,
      elapsedMs: elapsed,
      results: batchResults,
    };
  },
});

// ─── Force-consolidate a specific node (admin/debug) ───

export const forceConsolidate = internalAction({
  args: { eventNodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    // Find queue item for this node
    const queueItem = await ctx.runQuery(
      internal.memory.slowPath.findQueueItem,
      { eventNodeId: args.eventNodeId }
    );

    if (!queueItem) {
      return { status: "error", message: "No queue item found for this node" };
    }

    // Reset to pending if stuck, then process
    if (queueItem.status !== "pending") {
      await ctx.runMutation(internal.memory.slowPath.resetItem, {
        queueId: queueItem._id,
      });
    }

    // Claim it
    await ctx.runMutation(internal.memory.slowPath.claimItem, {
      queueId: queueItem._id,
    });

    const result = await consolidateOne(ctx, {
      ...queueItem,
      status: "processing",
    });

    return { status: "done", result };
  },
});

// Helper: find queue item by eventNodeId
export const findQueueItem = internalMutation({
  args: { eventNodeId: v.id("eventNodes") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("consolidationQueue")
      .withIndex("by_eventNode", (q) => q.eq("eventNodeId", args.eventNodeId))
      .first();
  },
});

// Helper: claim a specific queue item
export const claimItem = internalMutation({
  args: { queueId: v.id("consolidationQueue") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queueId, { status: "processing" });
  },
});
