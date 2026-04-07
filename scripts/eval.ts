/**
 * Evaluation script: Compares MAGMA retrieval vs baseline (flat similarity search)
 * across 4 test queries. Measures recall, ordering quality, and precision.
 *
 * Prerequisites:
 *   1. Run seed.ts first
 *   2. Wait for consolidation to complete (~30s)
 *   3. Set CONVEX_URL env var
 *
 * Usage: npx tsx scripts/eval.ts
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error(
    "Missing CONVEX_URL. Set it via:\n" +
      '  export CONVEX_URL="your-convex-deployment-url"'
  );
  process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

// ─── Test Queries ───

interface TestQuery {
  query: string;
  expectedIntent: string;
  description: string;
  expectedContent: string[];
  // For ordering tests: fragments that should appear in this order
  expectedOrder?: string[];
}

const TEST_QUERIES: TestQuery[] = [
  {
    query: "Why did we update the ICD architecture?",
    expectedIntent: "why",
    description:
      "Causal: privacy concern -> addendum -> legal -> GDPR -> research -> update",
    expectedContent: [
      "data privacy",
      "addendum",
      "GDPR",
      "researched",
      "Updated ICD architecture",
    ],
    // Causal order: cause before effect
    expectedOrder: [
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
    description: "Temporal: chronological events 4-10",
    expectedContent: [
      "data privacy",
      "addendum",
      "revised proposal",
      "legal team",
      "GDPR compliance",
      "researched",
      "EU data residency",
    ],
    // Chronological order
    expectedOrder: [
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
    description: "Entity: all events where Akhilesh participates",
    expectedContent: [
      "Met with Akhilesh",
      "tech stack",
      "concerns about data privacy",
      "forwarded to their legal",
      "GDPR-compliant architecture",
    ],
  },
  {
    query: "What led to Zoo Media signing the SOW?",
    expectedIntent: "why",
    description: "Multi-hop causal: full chain from pitch to signing",
    expectedContent: [
      "ICD NEop pitch",
      "data privacy",
      "GDPR",
      "approved",
      "Signed SOW",
    ],
    expectedOrder: [
      "ICD NEop pitch",
      "data privacy",
      "GDPR",
      "approved",
      "Signed SOW",
    ],
  },
];

// Use constrained budget — small enough to force differentiation
const EVAL_MAX_NODES = 8;

// ─── Helpers ───

function countHits(context: string, expected: string[]): number {
  return expected.filter((frag) =>
    context.toLowerCase().includes(frag.toLowerCase())
  ).length;
}

// Measure ordering quality: what fraction of expected-order pairs are correctly ordered?
// Returns a score between 0 and 1 where 1 means perfect order.
function measureOrdering(context: string, expectedOrder: string[]): number {
  // Find positions of each fragment in the context
  const positions: number[] = [];
  for (const frag of expectedOrder) {
    const pos = context.toLowerCase().indexOf(frag.toLowerCase());
    if (pos === -1) continue; // Skip missing fragments
    positions.push(pos);
  }

  if (positions.length < 2) return 1; // Can't measure with < 2 items

  // Count correctly ordered pairs
  let correctPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      totalPairs++;
      if (positions[i] < positions[j]) correctPairs++;
    }
  }

  return totalPairs === 0 ? 1 : correctPairs / totalPairs;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

// ─── Main ───

async function runEval() {
  // ── Pre-flight checks ──
  console.log("Checking system state...\n");

  const status = await client.query(api.memory.api.getConsolidationStatus, {});
  console.log(
    `  Consolidation queue: ${status.pending} pending, ${status.processing} processing, ${status.done} done`
  );

  if (status.pending > 0 || status.processing > 0) {
    console.log(
      "  WARNING: Consolidation not complete. Causal/semantic edges may be missing.\n"
    );
  }

  const stats = await client.query(api.memory.api.getGraphStats, {
    scope: "company",
  });
  console.log(`  Event nodes:    ${stats.nodes.events}`);
  console.log(`  Entity nodes:   ${stats.nodes.entities}`);
  console.log(`  Temporal edges: ${stats.edges.temporal}`);
  console.log(`  Causal edges:   ${stats.edges.causal}`);
  console.log(`  Semantic edges: ${stats.edges.semantic}`);
  console.log(`  Entity edges:   ${stats.edges.entity}`);
  console.log(`\n  Eval config: maxNodes=${EVAL_MAX_NODES} (constrained to force differentiation)`);

  if (stats.nodes.events === 0) {
    console.error("\n  No events found. Run seed.ts first.");
    process.exit(1);
  }

  // ── Run queries ──
  console.log(
    "\n" +
      "=".repeat(90) +
      "\n  MAGMA vs BASELINE — Side-by-Side Evaluation\n" +
      "=".repeat(90)
  );

  const magmaResults: Array<{
    hits: number;
    total: number;
    recall: number;
    ordering: number;
    intentMatch: boolean;
    latency: number;
    nodes: number;
  }> = [];

  const baselineResults: Array<{
    hits: number;
    total: number;
    recall: number;
    ordering: number;
    latency: number;
    nodes: number;
  }> = [];

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const test = TEST_QUERIES[i];

    console.log(`\n${"─".repeat(90)}`);
    console.log(`  Query ${i + 1}: "${test.query}"`);
    console.log(`  Expected: ${test.description}`);
    console.log(`${"─".repeat(90)}`);

    // ── Run MAGMA query ──
    let magma: any;
    try {
      magma = await client.action(api.memory.query.query, {
        queryText: test.query,
        scope: "company",
        options: { maxNodes: EVAL_MAX_NODES, tokenBudget: 4000 },
      });
    } catch (err: any) {
      console.log(`  MAGMA: FAILED — ${err.message ?? err}`);
      magmaResults.push({
        hits: 0, total: test.expectedContent.length, recall: 0,
        ordering: 0, intentMatch: false, latency: 0, nodes: 0,
      });
      baselineResults.push({
        hits: 0, total: test.expectedContent.length, recall: 0,
        ordering: 0, latency: 0, nodes: 0,
      });
      continue;
    }

    // ── Run baseline query ──
    let baseline: any;
    try {
      baseline = await client.action(api.memory.api.baselineQuery, {
        queryText: test.query,
        scope: "company",
        maxNodes: EVAL_MAX_NODES,
        tokenBudget: 4000,
      });
    } catch (err: any) {
      console.log(`  Baseline: FAILED — ${err.message ?? err}`);
      baseline = { context: "", nodes: [], nodesRetrieved: 0, latencyMs: 0 };
    }

    const magmaHits = countHits(magma.context, test.expectedContent);
    const baseHits = countHits(baseline.context, test.expectedContent);
    const magmaRecall = magmaHits / test.expectedContent.length;
    const baseRecall = baseHits / test.expectedContent.length;
    const intentMatch = magma.intent === test.expectedIntent;

    // Ordering quality
    const magmaOrder = test.expectedOrder
      ? measureOrdering(magma.context, test.expectedOrder)
      : 1;
    const baseOrder = test.expectedOrder
      ? measureOrdering(baseline.context, test.expectedOrder)
      : 1;

    magmaResults.push({
      hits: magmaHits, total: test.expectedContent.length,
      recall: magmaRecall, ordering: magmaOrder, intentMatch,
      latency: magma.latencyMs?.total ?? 0, nodes: magma.nodesTraversed ?? 0,
    });
    baselineResults.push({
      hits: baseHits, total: test.expectedContent.length,
      recall: baseRecall, ordering: baseOrder,
      latency: baseline.latencyMs ?? 0, nodes: baseline.nodesRetrieved ?? 0,
    });

    // ── Print comparison ──
    console.log(
      `\n  ${pad("", 25)} ${pad("MAGMA", 20)} ${pad("BASELINE", 20)}`
    );
    console.log(
      `  ${pad("─".repeat(25), 25)} ${pad("─".repeat(20), 20)} ${pad("─".repeat(20), 20)}`
    );
    console.log(
      `  ${pad("Intent", 25)} ${pad(magma.intent + (intentMatch ? " ✓" : " ✗"), 20)} ${pad("n/a", 20)}`
    );
    console.log(
      `  ${pad("Nodes retrieved", 25)} ${pad(String(magma.nodesTraversed), 20)} ${pad(String(baseline.nodesRetrieved), 20)}`
    );
    console.log(
      `  ${pad("Recall", 25)} ${pad(`${magmaHits}/${test.expectedContent.length} (${pct(magmaRecall)})`, 20)} ${pad(`${baseHits}/${test.expectedContent.length} (${pct(baseRecall)})`, 20)}`
    );
    if (test.expectedOrder) {
      console.log(
        `  ${pad("Ordering", 25)} ${pad(pct(magmaOrder), 20)} ${pad(pct(baseOrder), 20)}`
      );
    }
    console.log(
      `  ${pad("Latency", 25)} ${pad(`${magma.latencyMs?.total ?? "?"}ms`, 20)} ${pad(`${baseline.latencyMs}ms`, 20)}`
    );

    // Per-fragment hits
    console.log(`\n  Expected content fragments:`);
    for (const frag of test.expectedContent) {
      const inMagma = magma.context.toLowerCase().includes(frag.toLowerCase());
      const inBase = baseline.context.toLowerCase().includes(frag.toLowerCase());
      const magmaIcon = inMagma ? "✓" : "✗";
      const baseIcon = inBase ? "✓" : "✗";
      console.log(`    MAGMA:${magmaIcon}  BASE:${baseIcon}  "${frag}"`);
    }

    if (magma.latencyMs && typeof magma.latencyMs === "object") {
      console.log(
        `\n  MAGMA latency: analysis=${magma.latencyMs.stage1_analysis}ms ` +
          `anchors=${magma.latencyMs.stage2_anchors}ms ` +
          `traversal=${magma.latencyMs.stage3_traversal}ms ` +
          `synthesis=${magma.latencyMs.stage4_synthesis}ms`
      );
    }
  }

  // ── Summary ──
  console.log("\n" + "=".repeat(90));
  console.log("  SUMMARY");
  console.log("=".repeat(90));

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const avgMagmaRecall = avg(magmaResults.map((r) => r.recall));
  const avgBaseRecall = avg(baselineResults.map((r) => r.recall));
  const avgMagmaOrder = avg(magmaResults.map((r) => r.ordering));
  const avgBaseOrder = avg(baselineResults.map((r) => r.ordering));
  const avgMagmaLatency = avg(magmaResults.map((r) => r.latency));
  const avgBaseLatency = avg(baselineResults.map((r) => r.latency));
  const intentAccuracy =
    magmaResults.filter((r) => r.intentMatch).length / magmaResults.length;

  console.log(
    `\n  ${pad("", 25)} ${pad("MAGMA", 15)} ${pad("BASELINE", 15)} ${pad("DELTA", 10)}`
  );
  console.log(
    `  ${pad("─".repeat(25), 25)} ${pad("─".repeat(15), 15)} ${pad("─".repeat(15), 15)} ${pad("─".repeat(10), 10)}`
  );
  console.log(
    `  ${pad("Avg recall", 25)} ${pad(pct(avgMagmaRecall), 15)} ${pad(pct(avgBaseRecall), 15)} ${pad((avgMagmaRecall - avgBaseRecall >= 0 ? "+" : "") + pct(avgMagmaRecall - avgBaseRecall), 10)}`
  );
  console.log(
    `  ${pad("Avg ordering", 25)} ${pad(pct(avgMagmaOrder), 15)} ${pad(pct(avgBaseOrder), 15)} ${pad((avgMagmaOrder - avgBaseOrder >= 0 ? "+" : "") + pct(avgMagmaOrder - avgBaseOrder), 10)}`
  );
  console.log(
    `  ${pad("Avg latency", 25)} ${pad(`${avgMagmaLatency.toFixed(0)}ms`, 15)} ${pad(`${avgBaseLatency.toFixed(0)}ms`, 15)} ${pad(`+${(avgMagmaLatency - avgBaseLatency).toFixed(0)}ms`, 10)}`
  );
  console.log(
    `  ${pad("Intent accuracy", 25)} ${pad(pct(intentAccuracy), 15)} ${pad("n/a", 15)}`
  );

  // Per-query breakdown
  console.log("\n  Per-query breakdown:");
  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const mr = magmaResults[i];
    const br = baselineResults[i];
    const recallDelta = mr.recall - br.recall;
    const orderDelta = mr.ordering - br.ordering;
    const intentIcon = mr.intentMatch ? "✓" : "✗";
    console.log(
      `    ${intentIcon} [${mr.intentMatch ? magmaResults[i].nodes + " nodes" : "FAIL"}] ` +
        `"${TEST_QUERIES[i].query.slice(0, 40)}" ` +
        `recall: ${pct(recallDelta >= 0 ? recallDelta : recallDelta)} ` +
        `ordering: ${pct(orderDelta >= 0 ? orderDelta : orderDelta)}`
    );
  }

  // Composite score: recall (40%) + ordering (40%) + intent (20%)
  const magmaComposite =
    avgMagmaRecall * 0.4 + avgMagmaOrder * 0.4 + intentAccuracy * 0.2;
  const baseComposite = avgBaseRecall * 0.4 + avgBaseOrder * 0.4 + 0 * 0.2;

  console.log(
    `\n  Composite score (40% recall + 40% ordering + 20% intent):`
  );
  console.log(`    MAGMA:    ${pct(magmaComposite)}`);
  console.log(`    BASELINE: ${pct(baseComposite)}`);

  // Verdict
  console.log("\n" + "─".repeat(90));
  if (magmaComposite > baseComposite + 0.05) {
    console.log(
      `  PASS: MAGMA outperforms baseline — composite ${pct(magmaComposite)} vs ${pct(baseComposite)}`
    );
  } else if (magmaComposite >= baseComposite) {
    console.log(
      `  PARTIAL: MAGMA matches baseline — composite ${pct(magmaComposite)} vs ${pct(baseComposite)}`
    );
  } else {
    console.log(
      `  FAIL: Baseline outperforms MAGMA — composite ${pct(magmaComposite)} vs ${pct(baseComposite)}`
    );
  }
  console.log("─".repeat(90));
}

runEval().catch(console.error);
