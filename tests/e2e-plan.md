# MAGMA Context Vault — End-to-End Testing Plan

## Layer 1: Unit Tests (no external deps)
Pure algorithm correctness — cosine similarity, scoring, topological sort, synthesis, beam search.
**Status**: 41 tests passing.

## Layer 2: API Integration Tests (real API calls, no Convex)
Verify Groq and OpenRouter keys work, models respond correctly, response shapes match expectations.
- Groq chat completion (llama-3.3-70b-versatile)
- OpenRouter embedding (openai/text-embedding-3-small)
- Intent classification prompt
- Entity extraction prompt
- Causal inference prompt
- Event segmentation prompt

## Layer 3: TypeScript Compilation
Verify all Convex files compile without type errors (requires `_generated/` from `npx convex dev`).

## Layer 4: Pipeline Simulation (real APIs, mocked Convex)
End-to-end pipeline test using real LLM/embedding calls but simulating Convex DB in memory.
- Ingest 3 test events → verify embeddings + metadata extraction
- Run consolidation on the events → verify causal edges inferred
- Run a query → verify full 4-stage pipeline returns expected results

## Layer 5: Deployed E2E (requires Convex deployment)
Full system test against live Convex.
- Seed 15 events via seed.ts
- Wait for consolidation
- Run eval.ts (MAGMA vs baseline)
- Verify graph stats
