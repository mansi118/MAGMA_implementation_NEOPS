import { Doc, Id } from "../_generated/dataModel";
import { NeighborResult } from "./graphUtils";

// ─── Intent Weight Vectors ───
// φ(edge_type, intent) — how much each edge type matters for each intent.
// These are the "steering wheel" of the traversal.

export const INTENT_WEIGHTS: Record<
  string,
  Record<string, number>
> = {
  why: { temporal: 0.2, causal: 0.8, semantic: 0.3, entity: 0.2 },
  when: { temporal: 0.9, causal: 0.1, semantic: 0.2, entity: 0.2 },
  entity: { temporal: 0.2, causal: 0.2, semantic: 0.3, entity: 0.9 },
  what: { temporal: 0.3, causal: 0.3, semantic: 0.8, entity: 0.3 },
  how: { temporal: 0.4, causal: 0.6, semantic: 0.5, entity: 0.2 },
};

// ─── Config ───

export interface TraversalConfig {
  maxDepth: number; // Max hops from anchors (default 3)
  beamWidth: number; // Candidates kept per depth (default 5)
  budget: number; // Max total nodes retrieved (default 20)
  decayFactor: number; // Score decay per hop (default 0.85)
  lambda1: number; // Structural alignment weight (default 0.6)
  lambda2: number; // Semantic affinity weight (default 0.4)
}

export const DEFAULT_CONFIG: TraversalConfig = {
  maxDepth: 3,
  beamWidth: 5,
  budget: 20,
  decayFactor: 0.85,
  lambda1: 0.6,
  lambda2: 0.4,
};

// ─── Scored Node ───

export interface ScoredNode {
  node: Doc<"eventNodes">;
  cumScore: number;
  depth: number; // How many hops from an anchor
}

// ─── Cosine Similarity ───

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Transition Scoring ───

// Score a transition from current node to a neighbor.
// Equation 5 from the MAGMA paper:
//   transition_score = exp(λ1 × φ(edge_type, intent) + λ2 × cos(neighbor_emb, query_emb))
export function scoreTransition(
  edgeType: string,
  neighborEmbedding: number[],
  queryEmbedding: number[],
  intent: string,
  config: TraversalConfig
): number {
  const weights = INTENT_WEIGHTS[intent] ?? INTENT_WEIGHTS["what"];
  const phi = weights[edgeType] ?? 0.1;
  const sim = cosineSimilarity(neighborEmbedding, queryEmbedding);
  return Math.exp(config.lambda1 * phi + config.lambda2 * sim);
}

// ─── Beam Search ───

// The core traversal. Takes anchors + a neighbor-fetching function (injected to
// decouple from Convex ctx) and returns the scored subgraph.
//
// `fetchNeighbors` is called by the query action, which passes a closure over ctx.
export async function adaptiveTraversal(
  anchors: Array<{ node: Doc<"eventNodes">; score: number }>,
  queryEmbedding: number[],
  intent: string,
  fetchNeighbors: (
    nodeId: Id<"eventNodes">
  ) => Promise<Array<{ node: Doc<"eventNodes">; edgeType: string }>>,
  config: TraversalConfig = DEFAULT_CONFIG
): Promise<ScoredNode[]> {
  const visited = new Map<string, ScoredNode>();

  // Initialize frontier with anchors
  const frontier: ScoredNode[] = anchors.map((a) => ({
    node: a.node,
    cumScore: a.score,
    depth: 0,
  }));

  for (const item of frontier) {
    visited.set(item.node._id, item);
  }

  let currentFrontier = frontier;

  for (let depth = 0; depth < config.maxDepth; depth++) {
    const candidates: ScoredNode[] = [];

    for (const current of currentFrontier) {
      if (visited.size >= config.budget) break;

      const neighbors = await fetchNeighbors(current.node._id);

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.node._id)) continue;

        const transitionScore = scoreTransition(
          neighbor.edgeType,
          neighbor.node.embedding,
          queryEmbedding,
          intent,
          config
        );

        const cumScore =
          current.cumScore * config.decayFactor + transitionScore;

        candidates.push({
          node: neighbor.node,
          cumScore,
          depth: depth + 1,
        });
      }
    }

    if (candidates.length === 0) break;

    // Beam: keep top-K by cumulative score
    candidates.sort((a, b) => b.cumScore - a.cumScore);
    currentFrontier = candidates.slice(0, config.beamWidth);

    for (const item of currentFrontier) {
      if (visited.size < config.budget) {
        visited.set(item.node._id, item);
      }
    }

    if (visited.size >= config.budget) break;
  }

  return Array.from(visited.values());
}

// ─── Narrative Synthesis ───

export interface SynthesisResult {
  context: string; // Linearized narrative for LLM consumption
  nodes: Array<{
    id: string;
    content: string;
    eventTime: number;
    score: number;
  }>;
  truncated: boolean;
}

// Topological sort by causal edges. Falls back to eventTime for disconnected nodes.
export function topologicalSortByCausalEdges(
  nodes: ScoredNode[],
  causalEdges: Array<{ fromNode: string; toNode: string }>
): ScoredNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.node._id, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const n of nodes) {
    inDegree.set(n.node._id, 0);
    adjacency.set(n.node._id, []);
  }

  // Build graph from causal edges that connect our retrieved nodes
  for (const edge of causalEdges) {
    if (nodeMap.has(edge.fromNode) && nodeMap.has(edge.toNode)) {
      adjacency.get(edge.fromNode)!.push(edge.toNode);
      inDegree.set(edge.toNode, (inDegree.get(edge.toNode) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Sort zero-degree nodes by eventTime (earliest causes first)
  queue.sort((a, b) => {
    const na = nodeMap.get(a)!;
    const nb = nodeMap.get(b)!;
    return na.node.eventTime - nb.node.eventTime;
  });

  const sorted: ScoredNode[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(nodeMap.get(current)!);

    for (const neighbor of adjacency.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  // Any remaining nodes (cycles or disconnected) — append sorted by eventTime
  const sortedIds = new Set(sorted.map((s) => s.node._id));
  const remaining = nodes
    .filter((n) => !sortedIds.has(n.node._id))
    .sort((a, b) => a.node.eventTime - b.node.eventTime);
  sorted.push(...remaining);

  return sorted;
}

// Linearize retrieved nodes into a context string for LLM consumption.
export function synthesizeContext(
  nodes: ScoredNode[],
  intent: string,
  causalEdges: Array<{ fromNode: string; toNode: string }>,
  tokenBudget: number = 4000
): SynthesisResult {
  // 1. Order by intent
  let sorted: ScoredNode[];
  if (intent === "why") {
    sorted = topologicalSortByCausalEdges(nodes, causalEdges);
  } else if (intent === "when" || intent === "entity") {
    sorted = [...nodes].sort((a, b) => a.node.eventTime - b.node.eventTime);
  } else {
    sorted = [...nodes].sort((a, b) => b.cumScore - a.cumScore);
  }

  // 2. Build context with token budget
  let context = "";
  let tokenCount = 0;
  let truncated = false;
  const outputNodes: SynthesisResult["nodes"] = [];

  for (const item of sorted) {
    const date = new Date(item.node.eventTime).toISOString().slice(0, 10);
    const line = `[${date}] ${item.node.content} [ref:${item.node._id}]\n`;
    const lineTokens = Math.ceil(line.length / 4); // ~4 chars per token

    if (tokenCount + lineTokens > tokenBudget) {
      const remaining = sorted.length - outputNodes.length;
      context += `[...${remaining} additional events omitted for brevity...]\n`;
      truncated = true;
      break;
    }

    context += line;
    tokenCount += lineTokens;
    outputNodes.push({
      id: item.node._id,
      content: item.node.content,
      eventTime: item.node.eventTime,
      score: item.cumScore,
    });
  }

  return { context, nodes: outputNodes, truncated };
}
