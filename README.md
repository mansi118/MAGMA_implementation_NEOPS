# MAGMA Context Vault

A multi-graph agentic memory system for AI agents, based on the [MAGMA paper](https://github.com/FredJiang0324/MAMGA). Replaces flat embedding stores with a 4-graph substrate (semantic, temporal, causal, entity) that enables agents to reason about *why* things happened, *when* they happened, and *who* was involved — not just *what* is semantically similar.

Built on [Convex](https://convex.dev) with Groq (chat inference) and OpenRouter (embeddings).

## Architecture

```
                          MAGMA Context Vault
                          ==================

  Write Path                              Read Path
  ──────────                              ─────────
  Raw Input                               Natural Language Query
      │                                        │
      ▼                                        ▼
  ┌──────────────┐                   ┌──────────────────┐
  │ Segmentation │                   │  Query Analysis   │
  │  (GPT/Llama) │                   │ Intent + Entities │
  └──────┬───────┘                   └────────┬─────────┘
         │                                    │
         ▼                                    ▼
  ┌──────────────┐                   ┌──────────────────┐
  │  Fast Path   │                   │  RRF Anchoring   │
  │  (sync)      │                   │ Vector + Text +  │
  │              │                   │ Temporal + Entity │
  │ • Embedding  │                   └────────┬─────────┘
  │ • Event Node │                            │
  │ • Temp Edge  │                            ▼
  │ • Entity Res │                   ┌──────────────────┐
  │ • Queue      │                   │ Beam Search      │
  └──────┬───────┘                   │ Traversal        │
         │                           │                  │
         ▼                           │ Intent-weighted  │
  ┌──────────────┐                   │ edge scoring     │
  │  Slow Path   │                   └────────┬─────────┘
  │  (async/cron)│                            │
  │              │                            ▼
  │ • Causal     │                   ┌──────────────────┐
  │   Inference  │                   │ Narrative        │
  │ • Semantic   │                   │ Synthesis        │
  │   Edges      │                   │                  │
  │ • Entity     │                   │ Causal/Chrono/   │
  │   Enrichment │                   │ Score ordering   │
  └──────────────┘                   └──────────────────┘
```

### Four Graph Layers

| Graph | Edges | What it captures | Built by |
|-------|-------|------------------|----------|
| **Temporal** | `fromNode → toNode` | Event A happened before Event B | Fast Path (on ingest) |
| **Causal** | `fromNode → toNode` + confidence | Event A caused/led to Event B | Slow Path (LLM inference) |
| **Semantic** | `nodeA ↔ nodeB` + similarity | Events about similar topics | Slow Path (vector similarity) |
| **Entity** | `eventNode ↔ entityNode` + role | Who/what was involved in an event | Fast Path + Slow Path |

### Intent-Weighted Traversal

When a query comes in, intent classification determines how the beam search weights each edge type:

| Intent | Temporal | Causal | Semantic | Entity |
|--------|----------|--------|----------|--------|
| **why** | 0.2 | **0.8** | 0.3 | 0.2 |
| **when** | **0.9** | 0.1 | 0.2 | 0.2 |
| **entity** | 0.2 | 0.2 | 0.3 | **0.9** |
| **what** | 0.3 | 0.3 | **0.8** | 0.3 |
| **how** | 0.4 | **0.6** | 0.5 | 0.2 |

A "why" query heavily follows causal edges. A "when" query follows temporal edges. This is the core MAGMA algorithm — replacing cosine-similarity lookup with policy-guided graph traversal.

## Project Structure

```
Context-vault-MAGMA/
├── convex/
│   ├── schema.ts                  # 6 tables: eventNodes, temporalEdges, causalEdges,
│   │                              #   semanticEdges, entityNodes, entityEdges,
│   │                              #   consolidationQueue
│   ├── crons.ts                   # 30s consolidation cron
│   └── memory/
│       ├── llm.ts                 # Shared LLM clients (Groq + OpenRouter)
│       ├── embedding.ts           # Embedding generation + metadata extraction
│       ├── fastPath.ts            # Sync ingestion: node + temporal edge + entities
│       ├── ingest.ts              # Ingestion orchestrator (internal action)
│       ├── segmentation.ts        # Raw text → atomic events via LLM
│       ├── slowPath.ts            # Async consolidation: causal + semantic + entity enrichment
│       ├── graphUtils.ts          # Graph traversal queries (N-hop, vector search, etc.)
│       ├── traversal.ts           # Beam search algorithm + narrative synthesis
│       ├── query.ts               # 4-stage retrieval pipeline
│       └── api.ts                 # Public API + admin endpoints
├── scripts/
│   ├── seed.ts                    # Seed 15 Zoo Media test events
│   └── eval.ts                    # MAGMA vs baseline comparison
├── tests/
│   ├── helpers.ts                 # Mock event nodes + test utilities
│   ├── cosine.test.ts             # Cosine similarity tests (7)
│   ├── scoring.test.ts            # Intent weights + transition scoring (9)
│   ├── topological-sort.test.ts   # Kahn's algorithm tests (6)
│   ├── synthesis.test.ts          # Context linearization tests (8)
│   ├── traversal.test.ts          # Beam search tests (11)
│   ├── api-integration.test.ts    # Groq + OpenRouter API tests (8)
│   └── pipeline.test.ts           # Full pipeline simulation tests (7)
├── vitest.config.ts
├── package.json
└── .env.local                     # API keys + Convex deployment URL
```

## Setup

### Prerequisites

- Node.js 18+
- A [Convex](https://convex.dev) account
- [Groq](https://console.groq.com) API key (chat inference)
- [OpenRouter](https://openrouter.ai) API key (embeddings)

### Installation

```bash
git clone https://github.com/mansi118/MAGMA_implementation_NEOPS.git
cd MAGMA_implementation_NEOPS
npm install
```

### Configure Convex

```bash
# Login and create project (interactive)
npx convex dev

# Set API keys in Convex environment
npx convex env set GROQ_API_KEY <your-groq-key>
npx convex env set OPENROUTER_API_KEY <your-openrouter-key>
```

### Deploy

```bash
npx convex dev --once
```

This deploys the schema (6 tables, 24 indexes including a 1536d vector index) and all functions.

## Usage

### Seed Test Data

```bash
export CONVEX_URL="<your-convex-deployment-url>"
npx tsx scripts/seed.ts
```

Seeds 15 Zoo Media client engagement events spanning Jan 5 – Feb 10, 2025. Events are inserted chronologically with pre-extracted entities and keywords.

### Wait for Consolidation

The cron job runs every 30 seconds, processing up to 10 events per batch. For 15 events, consolidation completes in ~30 seconds. Monitor progress:

```bash
# Check consolidation status
npx convex run memory/api:getConsolidationStatus

# Check graph stats
npx convex run memory/api:getGraphStats '{"scope": "company"}'
```

Expected after consolidation: ~43 causal edges, ~47 semantic edges, 14 temporal edges, 26 entity edges.

### Run Evaluation

```bash
npx tsx scripts/eval.ts
```

Runs 4 test queries comparing MAGMA (graph traversal) vs baseline (flat vector similarity):

| Query | Type | What it tests |
|-------|------|---------------|
| "Why did we update the ICD architecture?" | Causal | Backward chain: concern → addendum → legal → GDPR → research → update |
| "What happened between Jan 12 and Jan 25?" | Temporal | Chronological range retrieval |
| "Everything involving Akhilesh" | Entity | Entity graph traversal across 6 events |
| "What led to Zoo Media signing the SOW?" | Multi-hop causal | Full chain from pitch to signing |

### Run Tests

```bash
# Unit tests only (no API keys needed, ~250ms)
npm test

# With API integration tests (requires GROQ_API_KEY + OPENROUTER_API_KEY)
GROQ_API_KEY=<key> OPENROUTER_API_KEY=<key> npm test
```

56 tests across 7 files:
- **Unit (41)**: cosine similarity, transition scoring, topological sort, narrative synthesis, beam search
- **API Integration (8)**: Groq JSON responses, intent classification, entity extraction, causal inference, segmentation, embeddings
- **Pipeline Simulation (7)**: real embeddings + mocked graph, full traversal with intent weighting

## API Reference

### Write

| Endpoint | Type | Description |
|----------|------|-------------|
| `memory.api.ingestEvent` | action | Ingest a single event with optional pre-extracted metadata |
| `memory.api.ingestBatch` | action | Ingest multiple events in parallel |
| `memory.segmentation.segmentAndIngest` | action | Segment raw text into atomic events, then ingest all |

### Read

| Endpoint | Type | Description |
|----------|------|-------------|
| `memory.query.query` | action | Full MAGMA 4-stage retrieval (the main read path) |
| `memory.api.baselineQuery` | action | Flat vector similarity search (for comparison) |
| `memory.api.getEntityHistory` | action | Timeline of events for a named entity |
| `memory.api.getTimeline` | action | Chronological events within a time range |
| `memory.api.getCausalChain` | action | Trace cause/effect chain from any event |

### Admin

| Endpoint | Type | Description |
|----------|------|-------------|
| `memory.api.getGraphStats` | query | Node/edge counts by type and scope |
| `memory.api.getConsolidationStatus` | query | Queue depth: pending/processing/done |
| `memory.api.resetStuck` | action | Reset "processing" items back to pending |
| `memory.api.forceConsolidate` | action | Bypass cron, consolidate one node immediately |

### Query Example

```typescript
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api";

const client = new ConvexHttpClient(CONVEX_URL);

const result = await client.action(api.memory.query.query, {
  queryText: "Why did we update the ICD architecture?",
  scope: "company",
  options: {
    maxNodes: 15,
    tokenBudget: 4000,
    beamWidth: 5,
    maxDepth: 3,
  },
});

// result.context   → Linearized narrative (causal-ordered for "why")
// result.intent    → "why"
// result.nodes     → [{id, content, eventTime, score}, ...]
// result.latencyMs → {total, stage1_analysis, stage2_anchors, stage3_traversal, stage4_synthesis}
```

## How It Works

### Write Path: Dual-Stream Ingestion

**Fast Path** (synchronous, on every ingest):
1. Generate 1536d embedding via OpenRouter (`text-embedding-3-small`)
2. Extract entities + keywords via Groq (`llama-3.3-70b-versatile`)
3. Insert event node into Convex
4. Create temporal edge to previous node (by `eventTime` ordering)
5. Upsert entity nodes + entity edges
6. Enqueue for slow-path consolidation

**Slow Path** (asynchronous, 30s cron):
1. Claim next pending item from consolidation queue
2. Fetch 2-hop neighborhood (temporal + causal + semantic edges)
3. **Causal inference**: LLM analyzes neighborhood, infers cause→effect edges with confidence scores
4. **Semantic edges**: Vector search for similar nodes, create edges where cosine > 0.45
5. **Entity enrichment**: Classify entity types (person/company/project), refine roles (subject/object/participant)
6. Mark as consolidated

### Read Path: 4-Stage Adaptive Retrieval

**Stage 1 — Query Analysis**: LLM classifies intent (why/when/entity/what/how), extracts entities and temporal bounds. Embedding generated in parallel.

**Stage 2 — Anchor Identification**: Reciprocal Rank Fusion (RRF) across 4 signals:
- Vector similarity (always)
- Full-text search (always)
- Temporal range filter (when time bounds detected)
- Entity lookup (when entities detected)

**Stage 3 — Adaptive Traversal**: Beam search from anchors across all 4 graph layers. Transition score per edge:
```
score = exp(lambda1 * phi(edge_type, intent) + lambda2 * cos(neighbor, query))
```
Where `phi` is the intent weight matrix and `cos` is semantic affinity. Nodes accumulate scores with depth decay.

**Stage 4 — Narrative Synthesis**: Retrieved subgraph ordered by intent:
- `why` → topological sort by causal edges (Kahn's algorithm)
- `when`/`entity` → chronological by eventTime
- `what`/`how` → by traversal score

Output is token-budgeted with provenance tags.

## Configuration

### Traversal Hyperparameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `beamWidth` | 5 | Candidates kept per traversal depth |
| `maxDepth` | 3 | Maximum hops from anchors |
| `budget` | 20 | Maximum total nodes retrieved |
| `decayFactor` | 0.85 | Score decay per hop (lower = favor closer nodes) |
| `lambda1` | 0.6 | Structural alignment weight (intent × edge type) |
| `lambda2` | 0.4 | Semantic affinity weight (cosine similarity) |

### Consolidation

| Parameter | Default | Location |
|-----------|---------|----------|
| `SEMANTIC_THRESHOLD` | 0.45 | `slowPath.ts` |
| `CAUSAL_CONFIDENCE_THRESHOLD` | 0.6 | `slowPath.ts` |
| `MAX_BATCH_SIZE` | 10 | `slowPath.ts` |
| `TIME_LIMIT_MS` | 25000 | `slowPath.ts` |
| Cron interval | 30s | `crons.ts` |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Graph storage | Convex (tables + indexes as logical graph) |
| Vector store | Convex Vector Index (1536d) |
| Embeddings | OpenRouter → `openai/text-embedding-3-small` |
| Chat inference | Groq → `llama-3.3-70b-versatile` |
| Cron/workers | Convex scheduled functions |
| Tests | Vitest |

## Schema

```
eventNodes          (content, eventTime, createdAt, embedding[1536], scope, sourceType, metadata)
temporalEdges       (fromNode → toNode, scope)
causalEdges         (fromNode → toNode, confidence, reasoning, scope)
semanticEdges       (nodeA ↔ nodeB, similarity, scope)
entityNodes         (name, type, aliases, scope, firstSeen, lastSeen)
entityEdges         (eventNode ↔ entityNode, role, scope)
consolidationQueue  (eventNodeId, priority, status, createdAt)
```

## Differences from the MAGMA Paper

| Paper (Python/standalone) | This Implementation (Convex/Production) |
|---------------------------|------------------------------------------|
| In-memory graph + FAISS | Convex tables + vector index |
| Single-user | Multi-tenant with scope isolation (company/private) |
| Batch evaluation mode | Real-time agent integration |
| GPT-4o-mini only | Groq (chat) + OpenRouter (embeddings) |
| No entity persistence | Full entity lifecycle (create → classify → merge) |
| Academic benchmark focus | Production agent workloads |

## License

ISC
