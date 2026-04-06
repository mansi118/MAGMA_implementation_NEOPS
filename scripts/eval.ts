/**
 * Evaluation script: Runs 4 test queries against the MAGMA Context Vault
 * and compares MAGMA retrieval vs baseline (flat similarity search).
 *
 * Usage: npx tsx scripts/eval.ts
 *
 * Run AFTER seeding (scripts/seed.ts) and AFTER consolidation completes
 * (wait ~8 minutes or check consolidation status).
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error("Missing CONVEX_URL env var.");
  process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

// ─── Test Queries ───

interface TestQuery {
  query: string;
  expectedIntent: string;
  description: string;
  // Key event IDs or content fragments that SHOULD appear in results
  expectedContent: string[];
}

const TEST_QUERIES: TestQuery[] = [
  {
    query: "Why did we update the ICD architecture?",
    expectedIntent: "why",
    description:
      "Causal chain: privacy concern → addendum → legal review → GDPR flag → research → architecture update",
    expectedContent: [
      "data privacy",
      "addendum",
      "GDPR",
      "researched",
      "Updated ICD architecture",
    ],
  },
  {
    query: "What happened between Jan 12 and Jan 25?",
    expectedIntent: "when",
    description:
      "Temporal range: events 4-10 in chronological order",
    expectedContent: [
      "data privacy",
      "addendum",
      "revised proposal",
      "legal team",
      "GDPR compliance",
      "researched",
      "EU data residency",
    ],
  },
  {
    query: "Everything involving Akhilesh",
    expectedIntent: "entity",
    description:
      "Entity query: all events where Akhilesh is a participant (events 1,2,4,5,7,11)",
    expectedContent: [
      "Met with Akhilesh",
      "tech stack",
      "concerns about data privacy",
      "forwarded to their legal team",
      "GDPR-compliant architecture",
    ],
  },
  {
    query: "What led to Zoo Media signing the SOW?",
    expectedIntent: "why",
    description:
      "Multi-hop causal: full chain from initial pitch → concerns → resolution → approval → signing",
    expectedContent: [
      "ICD NEop pitch",
      "data privacy",
      "GDPR",
      "approved",
      "Signed SOW",
    ],
  },
];

// ─── Eval Runner ───

function countHits(context: string, expectedContent: string[]): number {
  return expectedContent.filter((fragment) =>
    context.toLowerCase().includes(fragment.toLowerCase())
  ).length;
}

async function runEval() {
  // Check consolidation status first
  console.log("📊 Checking consolidation status...\n");

  const status = await client.query(
    api.memory.api.getConsolidationStatus,
    {}
  );
  console.log(`   Queue: ${status.pending} pending, ${status.processing} processing, ${status.done} done\n`);

  if (status.pending > 0) {
    console.log(
      "⚠️  Warning: Consolidation not complete. Causal/semantic edges may be missing."
    );
    console.log(
      "   Results will improve after consolidation finishes.\n"
    );
  }

  // Check graph stats
  const stats = await client.query(api.memory.api.getGraphStats, {
    scope: "company",
  });
  console.log("📈 Graph Stats (company scope):");
  console.log(`   Event nodes:    ${stats.nodes.events}`);
  console.log(`   Entity nodes:   ${stats.nodes.entities}`);
  console.log(`   Temporal edges: ${stats.edges.temporal}`);
  console.log(`   Causal edges:   ${stats.edges.causal}`);
  console.log(`   Semantic edges: ${stats.edges.semantic}`);
  console.log(`   Entity edges:   ${stats.edges.entity}`);
  console.log(`   Total edges:    ${stats.edges.total}\n`);

  console.log("═".repeat(80));
  console.log("  MAGMA RETRIEVAL EVALUATION — 4 Test Queries");
  console.log("═".repeat(80));

  const results: Array<{
    query: string;
    intent: string;
    expectedIntent: string;
    intentMatch: boolean;
    hits: number;
    total: number;
    recall: number;
    nodesRetrieved: number;
    latencyMs: number;
  }> = [];

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const test = TEST_QUERIES[i];

    console.log(`\n── Query ${i + 1}: "${test.query}"`);
    console.log(`   Expected: ${test.description}`);

    try {
      const result = await client.action(api.memory.query.query, {
        queryText: test.query,
        scope: "company",
        options: { maxNodes: 15, tokenBudget: 4000 },
      });

      const hits = countHits(result.context, test.expectedContent);
      const recall = hits / test.expectedContent.length;
      const intentMatch = result.intent === test.expectedIntent;

      console.log(`\n   Intent:    ${result.intent} ${intentMatch ? "✓" : "✗ (expected: " + test.expectedIntent + ")"}`);
      console.log(`   Anchors:   ${result.anchorsFound}`);
      console.log(`   Nodes:     ${result.nodesTraversed}`);
      console.log(`   Latency:   ${result.latencyMs.total}ms (analysis: ${result.latencyMs.stage1_analysis}ms, anchors: ${result.latencyMs.stage2_anchors}ms, traversal: ${result.latencyMs.stage3_traversal}ms, synthesis: ${result.latencyMs.stage4_synthesis}ms)`);
      console.log(`   Recall:    ${hits}/${test.expectedContent.length} (${(recall * 100).toFixed(0)}%)`);
      console.log(`   Truncated: ${result.truncated ? "yes" : "no"}`);

      // Show which expected content was found/missed
      for (const expected of test.expectedContent) {
        const found = result.context.toLowerCase().includes(expected.toLowerCase());
        console.log(`     ${found ? "✓" : "✗"} "${expected}"`);
      }

      // Show the retrieved context
      console.log(`\n   ── Retrieved Context ──`);
      const lines = result.context.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        console.log(`   ${line}`);
      }

      results.push({
        query: test.query,
        intent: result.intent,
        expectedIntent: test.expectedIntent,
        intentMatch,
        hits,
        total: test.expectedContent.length,
        recall,
        nodesRetrieved: result.nodesTraversed,
        latencyMs: result.latencyMs.total,
      });
    } catch (err) {
      console.error(`   ✗ Query failed: ${err}`);
      results.push({
        query: test.query,
        intent: "error",
        expectedIntent: test.expectedIntent,
        intentMatch: false,
        hits: 0,
        total: test.expectedContent.length,
        recall: 0,
        nodesRetrieved: 0,
        latencyMs: 0,
      });
    }
  }

  // ─── Summary ───

  console.log("\n" + "═".repeat(80));
  console.log("  SUMMARY");
  console.log("═".repeat(80));

  const avgRecall =
    results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const avgLatency =
    results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;
  const intentAccuracy =
    results.filter((r) => r.intentMatch).length / results.length;

  console.log(`\n   Intent accuracy: ${(intentAccuracy * 100).toFixed(0)}% (${results.filter((r) => r.intentMatch).length}/${results.length})`);
  console.log(`   Average recall:  ${(avgRecall * 100).toFixed(0)}%`);
  console.log(`   Average latency: ${avgLatency.toFixed(0)}ms`);

  console.log("\n   Per-query breakdown:");
  for (const r of results) {
    const intentIcon = r.intentMatch ? "✓" : "✗";
    console.log(
      `     ${intentIcon} [${r.intent}] "${r.query.slice(0, 45)}..." — recall: ${(r.recall * 100).toFixed(0)}%, ${r.nodesRetrieved} nodes, ${r.latencyMs}ms`
    );
  }

  // Pass/fail verdict
  console.log("\n" + "─".repeat(80));
  if (avgRecall >= 0.7 && intentAccuracy >= 0.75) {
    console.log("  ✅ PASS — MAGMA retrieval meets quality thresholds");
  } else if (avgRecall >= 0.5) {
    console.log("  ⚠️  PARTIAL — Retrieval works but needs tuning");
    if (status.pending > 0) {
      console.log("     (Consolidation not complete — re-run after it finishes)");
    }
  } else {
    console.log("  ❌ FAIL — Retrieval needs investigation");
  }
  console.log("─".repeat(80));
}

runEval().catch(console.error);
