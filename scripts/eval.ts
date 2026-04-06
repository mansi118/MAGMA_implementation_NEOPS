/**
 * Evaluation script: Compares MAGMA retrieval vs baseline (flat similarity search)
 * across 4 test queries that expose the limitations of flat search.
 *
 * Prerequisites:
 *   1. Run seed.ts first
 *   2. Wait for consolidation to complete (~8 min) for best results
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
  expectedContent: string[]; // Fragments that SHOULD appear in results
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
  },
];

// ─── Helpers ───

function countHits(context: string, expected: string[]): number {
  return expected.filter((frag) =>
    context.toLowerCase().includes(frag.toLowerCase())
  ).length;
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

  const status = await client.query(
    api.memory.api.getConsolidationStatus,
    {}
  );
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

  if (stats.nodes.events === 0) {
    console.error("\n  No events found. Run seed.ts first.");
    process.exit(1);
  }

  // ── Run queries ──
  console.log(
    "\n" + "=".repeat(90) + "\n  MAGMA vs BASELINE — Side-by-Side Evaluation\n" + "=".repeat(90)
  );

  const magmaResults: Array<{
    hits: number;
    total: number;
    recall: number;
    intentMatch: boolean;
    latency: number;
    nodes: number;
  }> = [];

  const baselineResults: Array<{
    hits: number;
    total: number;
    recall: number;
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
        options: { maxNodes: 15, tokenBudget: 4000 },
      });
    } catch (err: any) {
      console.log(`  MAGMA: FAILED — ${err.message ?? err}`);
      magmaResults.push({
        hits: 0,
        total: test.expectedContent.length,
        recall: 0,
        intentMatch: false,
        latency: 0,
        nodes: 0,
      });
      baselineResults.push({
        hits: 0,
        total: test.expectedContent.length,
        recall: 0,
        latency: 0,
        nodes: 0,
      });
      continue;
    }

    // ── Run baseline query ──
    let baseline: any;
    try {
      baseline = await client.action(api.memory.api.baselineQuery, {
        queryText: test.query,
        scope: "company",
        maxNodes: 15,
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

    magmaResults.push({
      hits: magmaHits,
      total: test.expectedContent.length,
      recall: magmaRecall,
      intentMatch,
      latency: magma.latencyMs?.total ?? 0,
      nodes: magma.nodesTraversed ?? 0,
    });
    baselineResults.push({
      hits: baseHits,
      total: test.expectedContent.length,
      recall: baseRecall,
      latency: baseline.latencyMs ?? 0,
      nodes: baseline.nodesRetrieved ?? 0,
    });

    // ── Print comparison ──
    console.log(
      `\n  ${pad("", 25)} ${pad("MAGMA", 20)} ${pad("BASELINE", 20)}`
    );
    console.log(`  ${pad("─".repeat(25), 25)} ${pad("─".repeat(20), 20)} ${pad("─".repeat(20), 20)}`);
    console.log(
      `  ${pad("Intent", 25)} ${pad(magma.intent + (intentMatch ? " ✓" : " ✗"), 20)} ${pad("n/a (no classification)", 20)}`
    );
    console.log(
      `  ${pad("Nodes retrieved", 25)} ${pad(String(magma.nodesTraversed), 20)} ${pad(String(baseline.nodesRetrieved), 20)}`
    );
    console.log(
      `  ${pad("Recall", 25)} ${pad(`${magmaHits}/${test.expectedContent.length} (${pct(magmaRecall)})`, 20)} ${pad(`${baseHits}/${test.expectedContent.length} (${pct(baseRecall)})`, 20)}`
    );
    console.log(
      `  ${pad("Latency", 25)} ${pad(`${magma.latencyMs?.total ?? "?"}ms`, 20)} ${pad(`${baseline.latencyMs}ms`, 20)}`
    );

    // Show per-fragment hits
    console.log(`\n  Expected content fragments:`);
    for (const frag of test.expectedContent) {
      const inMagma = magma.context.toLowerCase().includes(frag.toLowerCase());
      const inBase = baseline.context.toLowerCase().includes(frag.toLowerCase());
      const magmaIcon = inMagma ? "✓" : "✗";
      const baseIcon = inBase ? "✓" : "✗";
      console.log(
        `    MAGMA:${magmaIcon}  BASE:${baseIcon}  "${frag}"`
      );
    }

    // Show MAGMA latency breakdown
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

  const avgMagmaRecall =
    magmaResults.reduce((s, r) => s + r.recall, 0) / magmaResults.length;
  const avgBaseRecall =
    baselineResults.reduce((s, r) => s + r.recall, 0) / baselineResults.length;
  const avgMagmaLatency =
    magmaResults.reduce((s, r) => s + r.latency, 0) / magmaResults.length;
  const avgBaseLatency =
    baselineResults.reduce((s, r) => s + r.latency, 0) / baselineResults.length;
  const intentAccuracy =
    magmaResults.filter((r) => r.intentMatch).length / magmaResults.length;

  console.log(
    `\n  ${pad("", 25)} ${pad("MAGMA", 15)} ${pad("BASELINE", 15)} ${pad("DELTA", 10)}`
  );
  console.log(
    `  ${pad("─".repeat(25), 25)} ${pad("─".repeat(15), 15)} ${pad("─".repeat(15), 15)} ${pad("─".repeat(10), 10)}`
  );
  console.log(
    `  ${pad("Avg recall", 25)} ${pad(pct(avgMagmaRecall), 15)} ${pad(pct(avgBaseRecall), 15)} ${pad((avgMagmaRecall - avgBaseRecall > 0 ? "+" : "") + pct(avgMagmaRecall - avgBaseRecall), 10)}`
  );
  console.log(
    `  ${pad("Avg latency", 25)} ${pad(`${avgMagmaLatency.toFixed(0)}ms`, 15)} ${pad(`${avgBaseLatency.toFixed(0)}ms`, 15)} ${pad(`+${(avgMagmaLatency - avgBaseLatency).toFixed(0)}ms`, 10)}`
  );
  console.log(
    `  ${pad("Intent accuracy", 25)} ${pad(pct(intentAccuracy), 15)} ${pad("n/a", 15)}`
  );

  // Per-query delta
  console.log("\n  Per-query recall delta (MAGMA - BASELINE):");
  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const delta = magmaResults[i].recall - baselineResults[i].recall;
    const icon = delta > 0 ? "+" : delta === 0 ? "=" : "";
    console.log(
      `    ${icon}${pct(delta)}  "${TEST_QUERIES[i].query.slice(0, 50)}"`
    );
  }

  // Verdict
  console.log("\n" + "─".repeat(90));
  if (avgMagmaRecall > avgBaseRecall && intentAccuracy >= 0.75) {
    console.log(
      `  PASS: MAGMA outperforms baseline by ${pct(avgMagmaRecall - avgBaseRecall)} recall with ${pct(intentAccuracy)} intent accuracy`
    );
  } else if (avgMagmaRecall >= avgBaseRecall) {
    console.log(
      "  PARTIAL: MAGMA matches or slightly beats baseline — check if consolidation is complete"
    );
  } else {
    console.log(
      "  FAIL: Baseline outperforms MAGMA — investigate traversal weights and graph edges"
    );
  }
  console.log("─".repeat(90));
}

runEval().catch(console.error);
