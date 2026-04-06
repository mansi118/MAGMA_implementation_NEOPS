import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { generateEmbedding } from "./embedding";
import { getChatClient, CHAT_MODEL } from "./llm";
import {
  adaptiveTraversal,
  synthesizeContext,
  DEFAULT_CONFIG,
  TraversalConfig,
} from "./traversal";
import { NeighborResult } from "./graphUtils";

// ─── Stage 1: Query Analysis ───

interface QuerySignals {
  intent: "why" | "when" | "entity" | "what" | "how";
  entities: string[];
  timeWindow: { start: number | null; end: number | null };
  keywords: string[];
  embedding: number[];
}

const ANALYSIS_PROMPT = `Analyze this query for a memory retrieval system.

Return JSON:
{
  "intent": "why" | "when" | "entity" | "what" | "how",
  "entities": ["lowercase names of people, companies, projects mentioned"],
  "time_start": "ISO date string or null",
  "time_end": "ISO date string or null",
  "keywords": ["important search terms, lowercase"]
}

Intent definitions:
- WHY: Asks for causes, reasons, explanations ("why did X happen?", "what led to X?")
- WHEN: Asks about timing, sequence, chronology ("what happened between dates?", "timeline of X")
- ENTITY: Asks about a specific person/company/project ("everything about X", "X's involvement")
- WHAT: Asks for facts, descriptions ("what is X?", "describe X")
- HOW: Asks for process, method ("how did we do X?", "what steps were taken?")

Pick the single dominant intent. If the query mentions a specific entity prominently, prefer ENTITY.
For time references, parse to ISO dates. Use the current year if not specified.`;

async function analyzeQuery(queryText: string): Promise<Omit<QuerySignals, "embedding">> {
  try {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: ANALYSIS_PROMPT },
        { role: "user", content: queryText },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");

    const validIntents = ["why", "when", "entity", "what", "how"];
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : "what";

    return {
      intent,
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((e: string) => e.toLowerCase().trim())
        : [],
      timeWindow: {
        start: parsed.time_start ? new Date(parsed.time_start).getTime() : null,
        end: parsed.time_end ? new Date(parsed.time_end).getTime() : null,
      },
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.map((k: string) => k.toLowerCase().trim())
        : [],
    };
  } catch {
    return {
      intent: "what",
      entities: [],
      timeWindow: { start: null, end: null },
      keywords: queryText.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    };
  }
}

// ─── Stage 2: Anchor Identification via RRF ───

interface RankedNode {
  node: Doc<"eventNodes">;
  rrfScore: number;
}

async function findAnchors(
  ctx: any,
  signals: QuerySignals,
  scope: string,
  topK: number
): Promise<RankedNode[]> {
  const candidatesPerSignal = topK * 3;
  const RRF_K = 60;

  // Collect ranked lists from each signal
  const rankedLists: Doc<"eventNodes">[][] = [];

  // Signal A: Vector similarity
  const vecResults = await ctx.runAction(
    internal.memory.graphUtils.findSimilarNodes,
    {
      embedding: signals.embedding,
      scope,
      limit: candidatesPerSignal,
    }
  );
  rankedLists.push(vecResults.map((r: { node: Doc<"eventNodes"> }) => r.node));

  // Signal B: Full-text search
  if (signals.keywords.length > 0) {
    const searchText = signals.keywords.join(" ");
    const textResults = await ctx.runQuery(
      internal.memory.graphUtils.searchByContent,
      { searchText, scope, limit: candidatesPerSignal }
    );
    rankedLists.push(textResults);
  }

  // Signal C: Temporal filter (only if time bounds exist)
  if (signals.timeWindow.start !== null || signals.timeWindow.end !== null) {
    const start = signals.timeWindow.start ?? 0;
    const end = signals.timeWindow.end ?? Date.now();
    const timeResults = await ctx.runQuery(
      internal.memory.graphUtils.getEventsByTimeRange,
      { scope, start, end, limit: candidatesPerSignal }
    );
    rankedLists.push(timeResults);
  }

  // Signal D: Entity lookup (only if entities detected)
  for (const entityName of signals.entities) {
    const entityResults = await ctx.runQuery(
      internal.memory.graphUtils.getEventsByEntity,
      { entityName, scope, limit: candidatesPerSignal }
    );
    if (entityResults.length > 0) {
      rankedLists.push(entityResults);
    }
  }

  // RRF Fusion
  const scores = new Map<string, { score: number; node: Doc<"eventNodes"> }>();

  for (const rankedList of rankedLists) {
    rankedList.forEach((node: Doc<"eventNodes">, rank: number) => {
      const existing = scores.get(node._id);
      const rrfContribution = 1 / (RRF_K + rank + 1);

      if (existing) {
        existing.score += rrfContribution;
      } else {
        scores.set(node._id, { score: rrfContribution, node });
      }
    });
  }

  // Sort by fused score, take topK
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({ node: entry.node, rrfScore: entry.score }));
}

// ─── Main Query Action ───

export const query = action({
  args: {
    queryText: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    options: v.optional(
      v.object({
        maxNodes: v.optional(v.number()),
        tokenBudget: v.optional(v.number()),
        beamWidth: v.optional(v.number()),
        maxDepth: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const startTime = Date.now();

    // ── Stage 1: Query Analysis + Embedding (parallel) ──
    const [analysis, embedding] = await Promise.all([
      analyzeQuery(args.queryText),
      generateEmbedding(args.queryText),
    ]);

    const signals: QuerySignals = { ...analysis, embedding };

    const stage1Time = Date.now();

    // ── Stage 2: Anchor Identification via RRF ──
    // Anchors are entry points into the graph — keep them small so the beam
    // search has room to discover nodes via graph traversal. Without this,
    // all events become anchors and traversal never fires.
    const maxNodes = args.options?.maxNodes ?? 10;
    const anchorCount = Math.min(Math.ceil(maxNodes / 3), 8);
    const anchors = await findAnchors(ctx, signals, args.scope, anchorCount);

    if (anchors.length === 0) {
      return {
        context: "No relevant memories found.",
        nodes: [],
        intent: signals.intent,
        anchorsFound: 0,
        nodesTraversed: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    const stage2Time = Date.now();

    // ── Stage 3: Adaptive Traversal ──
    const config: TraversalConfig = {
      ...DEFAULT_CONFIG,
      budget: args.options?.maxNodes ?? DEFAULT_CONFIG.budget,
      beamWidth: args.options?.beamWidth ?? DEFAULT_CONFIG.beamWidth,
      maxDepth: args.options?.maxDepth ?? DEFAULT_CONFIG.maxDepth,
    };

    // Build the neighbor-fetching closure over ctx
    const fetchNeighbors = async (
      nodeId: Id<"eventNodes">
    ): Promise<Array<{ node: Doc<"eventNodes">; edgeType: string }>> => {
      // Get temporal + causal + semantic neighbors
      const neighbors: NeighborResult[] = await ctx.runQuery(
        internal.memory.graphUtils.getNeighbors,
        { nodeId }
      );

      const results: Array<{ node: Doc<"eventNodes">; edgeType: string }> =
        neighbors.map((n) => ({
          node: n.node,
          edgeType: n.edgeType,
        }));

      // Also get entity-linked events (the entity graph 2-hop)
      const entityLinked = await ctx.runQuery(
        internal.memory.graphUtils.getEntityLinkedEvents,
        { eventNodeId: nodeId, limit: 10 }
      );

      for (const e of entityLinked) {
        results.push({ node: e.node, edgeType: "entity" });
      }

      return results;
    };

    const traversalAnchors = anchors.map((a) => ({
      node: a.node,
      score: a.rrfScore,
    }));

    const subgraph = await adaptiveTraversal(
      traversalAnchors,
      embedding,
      signals.intent,
      fetchNeighbors,
      config
    );

    const stage3Time = Date.now();

    // ── Stage 4: Narrative Synthesis ──

    // For "why" intent, fetch causal edges between retrieved nodes for topological sort
    let causalEdges: Array<{ fromNode: string; toNode: string }> = [];
    if (signals.intent === "why") {
      const nodeIds = subgraph.map((s) => s.node._id);
      const edges = await ctx.runQuery(
        internal.memory.graphUtils.getCausalEdgesBetween,
        { nodeIds }
      );
      causalEdges = edges.map((e: { fromNode: string; toNode: string }) => ({
        fromNode: e.fromNode,
        toNode: e.toNode,
      }));
    }

    const tokenBudget = args.options?.tokenBudget ?? 4000;
    const synthesis = synthesizeContext(
      subgraph,
      signals.intent,
      causalEdges,
      tokenBudget
    );

    const endTime = Date.now();

    const response = {
      context: synthesis.context,
      nodes: synthesis.nodes,
      intent: signals.intent,
      entities: signals.entities,
      timeWindow: signals.timeWindow,
      anchorsFound: anchors.length,
      nodesTraversed: subgraph.length,
      truncated: synthesis.truncated,
      latencyMs: {
        total: endTime - startTime,
        stage1_analysis: stage1Time - startTime,
        stage2_anchors: stage2Time - stage1Time,
        stage3_traversal: stage3Time - stage2Time,
        stage4_synthesis: endTime - stage3Time,
      },
    };

    // Structured query trace for observability
    console.log(
      `[query] "${args.queryText.slice(0, 50)}" → intent=${signals.intent} anchors=${anchors.length} nodes=${subgraph.length} latency=${response.latencyMs.total}ms (analysis=${response.latencyMs.stage1_analysis} anchors=${response.latencyMs.stage2_anchors} traversal=${response.latencyMs.stage3_traversal} synthesis=${response.latencyMs.stage4_synthesis})`
    );

    return response;
  },
});
