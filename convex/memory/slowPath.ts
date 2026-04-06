import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Id, Doc } from "../_generated/dataModel";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Mutations ───

// Atomically claim the next pending queue item
export const claimNext = internalMutation({
  handler: async (ctx) => {
    const item = await ctx.db
      .query("consolidationQueue")
      .withIndex("by_status_priority", (q) => q.eq("status", "pending"))
      .order("asc") // Lowest priority number = highest priority
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
    existingPairs: v.array(v.string()), // "fromId->toId" strings for dedup
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
    existingPairs: v.array(v.string()), // "nodeA<>nodeB" strings for dedup
  },
  handler: async (ctx, args) => {
    const existingSet = new Set(args.existingPairs);
    let inserted = 0;

    for (const edge of args.edges) {
      // Enforce nodeA < nodeB ordering
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
  labelMap: Map<string, string> // label → convex ID
): Promise<CausalEdgeCandidate[]> {
  // Build the prompt with short labels
  const targetLabel = [...labelMap.entries()].find(
    ([, id]) => id === targetNode._id
  )?.[0] ?? "n0";

  const neighborLines = neighborhood
    .filter((n) => n._id !== targetNode._id)
    .map((n) => {
      const label = [...labelMap.entries()].find(
        ([, id]) => id === n._id
      )?.[0] ?? "?";
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
- Only include edges with confidence > 0.6
- Maximum 5 edges
- At least one endpoint of each edge must be the target event [${targetLabel}]
- If no causal relationships exist, return {"causal_edges": []}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    return Array.isArray(parsed.causal_edges) ? parsed.causal_edges : [];
  } catch {
    return [];
  }
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

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    return Array.isArray(parsed.entities) ? parsed.entities : [];
  } catch {
    return [];
  }
}

// ─── Main Consolidation Action ───

export const consolidateNext = internalAction({
  handler: async (ctx) => {
    // 1. Claim next pending item
    const item = await ctx.runMutation(internal.memory.slowPath.claimNext);
    if (!item) return { status: "idle", message: "No pending items" };

    // 2. Fetch target node
    const targetNode = await ctx.runQuery(
      internal.memory.graphUtils.getNode,
      { id: item.eventNodeId }
    );
    if (!targetNode) {
      await ctx.runMutation(internal.memory.slowPath.markDone, {
        queueId: item._id,
        eventNodeId: item.eventNodeId,
      });
      return { status: "skipped", message: "Node not found" };
    }

    // 3. Fetch 2-hop neighborhood
    const neighborhood = await ctx.runQuery(
      internal.memory.graphUtils.getNeighborhood,
      { nodeId: targetNode._id, hops: 2, maxNodes: 20 }
    );

    // Build label map: short labels → Convex IDs
    const labelMap = new Map<string, string>();
    neighborhood.forEach((node, i) => {
      labelMap.set(`n${i}`, node._id);
    });

    // 4. Causal inference via LLM
    if (neighborhood.length > 1) {
      const causalCandidates = await inferCausalEdges(
        targetNode,
        neighborhood,
        labelMap
      );

      // Fetch existing causal edges for dedup
      const existingCausal = await ctx.runQuery(
        internal.memory.graphUtils.getCausalEdgesForNode,
        { nodeId: targetNode._id }
      );
      const existingPairs = existingCausal.map(
        (e) => `${e.fromNode}->${e.toNode}`
      );

      // Map labels back to Convex IDs and filter valid edges
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
        if (candidate.confidence < 0.6) continue;

        // Verify temporal ordering
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
        await ctx.runMutation(internal.memory.slowPath.writeCausalEdges, {
          edges: validEdges,
          existingPairs,
        });
      }
    }

    // 5. Semantic edge building (no LLM — pure vector search)
    const similarNodes = await ctx.runQuery(
      internal.memory.graphUtils.findSimilarNodes,
      {
        embedding: targetNode.embedding,
        scope: targetNode.scope,
        limit: 10,
        excludeId: targetNode._id,
      }
    );

    const SEMANTIC_THRESHOLD = 0.75;
    const aboveThreshold = similarNodes.filter(
      (s) => s.score >= SEMANTIC_THRESHOLD
    );

    if (aboveThreshold.length > 0) {
      // Fetch existing semantic edges for dedup
      const existingSemantic = await ctx.runQuery(
        internal.memory.graphUtils.getSemanticEdgesForNode,
        { nodeId: targetNode._id }
      );
      const existingPairs = existingSemantic.map((e) => {
        const [a, b] = e.nodeA < e.nodeB ? [e.nodeA, e.nodeB] : [e.nodeB, e.nodeA];
        return `${a}<>${b}`;
      });

      const semanticEdges = aboveThreshold.map((s) => ({
        nodeA: targetNode._id,
        nodeB: s.node._id,
        similarity: s.score,
        scope: targetNode.scope,
      }));

      await ctx.runMutation(internal.memory.slowPath.writeSemanticEdges, {
        edges: semanticEdges,
        existingPairs,
      });
    }

    // 6. Entity classification + role refinement
    const entityInfo = await ctx.runQuery(
      internal.memory.graphUtils.getEntityInfo,
      { eventNodeId: targetNode._id }
    );

    // Only enrich entities that are still "unknown" type or "participant" role
    const toEnrich = entityInfo.filter(
      (e) => e.entity.type === "unknown" || e.edge.role === "participant"
    );

    if (toEnrich.length > 0) {
      const entityNames = toEnrich.map((e) => e.entity.name);
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
          (e) => e.entity.name === enrichment.name.toLowerCase()
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
      }
    }

    // 7. Mark done
    await ctx.runMutation(internal.memory.slowPath.markDone, {
      queueId: item._id,
      eventNodeId: targetNode._id,
    });

    return {
      status: "done",
      nodeId: targetNode._id,
      causalEdgesConsidered: neighborhood.length > 1,
      semanticEdgesFound: aboveThreshold.length,
      entitiesEnriched: toEnrich.length,
    };
  },
});
