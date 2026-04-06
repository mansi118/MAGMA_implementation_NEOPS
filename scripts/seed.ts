/**
 * Seed script: Inserts the 15 Zoo Media test events into the MAGMA Context Vault.
 *
 * Usage: npx convex run memory/ingest:ingest --args '...'
 *   or via this script with the Convex client: npx tsx scripts/seed.ts
 *
 * Events are inserted in chronological order so temporal edges form correctly.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error("Missing CONVEX_URL env var. Run: npx convex env get CONVEX_URL");
  process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

// ─── Zoo Media Test Events ───

interface TestEvent {
  content: string;
  eventTime: number; // Unix ms
  entities: string[];
  keywords: string[];
  temporalCue?: string;
}

function toMs(dateStr: string): number {
  return new Date(dateStr).getTime();
}

const EVENTS: TestEvent[] = [
  {
    content: "Met with Akhilesh from Zoo Media, discussed ICD NEop pitch",
    eventTime: toMs("2025-01-05"),
    entities: ["akhilesh", "zoo media", "icd neop"],
    keywords: ["meeting", "pitch", "icd", "neop"],
    temporalCue: "Jan 5",
  },
  {
    content: "Akhilesh shared Zoo Media's current tech stack — Laravel + AWS",
    eventTime: toMs("2025-01-07"),
    entities: ["akhilesh", "zoo media"],
    keywords: ["tech stack", "laravel", "aws"],
    temporalCue: "Jan 7",
  },
  {
    content: "Sent Zoo Media the 105-slide deck",
    eventTime: toMs("2025-01-10"),
    entities: ["zoo media"],
    keywords: ["slide deck", "presentation", "105-slide"],
    temporalCue: "Jan 10",
  },
  {
    content: "Akhilesh raised concerns about data privacy in ICD NEop",
    eventTime: toMs("2025-01-12"),
    entities: ["akhilesh", "icd neop"],
    keywords: ["data privacy", "concerns", "icd"],
    temporalCue: "Jan 12",
  },
  {
    content: "Rahul prepared a data privacy addendum addressing Akhilesh's concerns",
    eventTime: toMs("2025-01-14"),
    entities: ["rahul", "akhilesh"],
    keywords: ["data privacy", "addendum", "privacy addendum"],
    temporalCue: "Jan 14",
  },
  {
    content: "Sent revised proposal with privacy addendum to Zoo Media",
    eventTime: toMs("2025-01-15"),
    entities: ["zoo media"],
    keywords: ["revised proposal", "privacy addendum"],
    temporalCue: "Jan 15",
  },
  {
    content: "Zoo Media internal review — Akhilesh forwarded to their legal team",
    eventTime: toMs("2025-01-18"),
    entities: ["zoo media", "akhilesh"],
    keywords: ["internal review", "legal team", "forwarded"],
    temporalCue: "Jan 18",
  },
  {
    content: "Zoo Media legal flagged GDPR compliance requirement",
    eventTime: toMs("2025-01-22"),
    entities: ["zoo media"],
    keywords: ["legal", "gdpr", "compliance", "requirement"],
    temporalCue: "Jan 22",
  },
  {
    content: "Mansi researched GDPR compliance for ICD architecture",
    eventTime: toMs("2025-01-24"),
    entities: ["mansi", "icd"],
    keywords: ["gdpr", "compliance", "research", "icd architecture"],
    temporalCue: "Jan 24",
  },
  {
    content: "Updated ICD architecture to include EU data residency",
    eventTime: toMs("2025-01-25"),
    entities: ["icd"],
    keywords: ["icd architecture", "eu data residency", "updated"],
    temporalCue: "Jan 25",
  },
  {
    content: "Presented GDPR-compliant architecture to Akhilesh",
    eventTime: toMs("2025-01-28"),
    entities: ["akhilesh", "icd"],
    keywords: ["gdpr-compliant", "architecture", "presentation"],
    temporalCue: "Jan 28",
  },
  {
    content: "Zoo Media approved ICD NEop pilot — Tier 1 engagement",
    eventTime: toMs("2025-01-30"),
    entities: ["zoo media", "icd neop"],
    keywords: ["approved", "pilot", "tier 1", "engagement"],
    temporalCue: "Jan 30",
  },
  {
    content: "Signed SOW with Zoo Media for 2-month pilot at ₹5L/month",
    eventTime: toMs("2025-02-02"),
    entities: ["zoo media"],
    keywords: ["sow", "signed", "pilot", "₹5l/month", "2-month"],
    temporalCue: "Feb 2",
  },
  {
    content: "Shivam began ICD NEop deployment on Zoo Media staging",
    eventTime: toMs("2025-02-05"),
    entities: ["shivam", "icd neop", "zoo media"],
    keywords: ["deployment", "staging", "icd neop"],
    temporalCue: "Feb 5",
  },
  {
    content: "First ICD NEop successfully processed 200 customer queries",
    eventTime: toMs("2025-02-10"),
    entities: ["icd neop"],
    keywords: ["processed", "customer queries", "200", "success"],
    temporalCue: "Feb 10",
  },
];

// ─── Seed Runner ───

async function seed() {
  console.log("🌱 Seeding 15 Zoo Media test events...\n");

  for (let i = 0; i < EVENTS.length; i++) {
    const event = EVENTS[i];
    const date = new Date(event.eventTime).toISOString().slice(0, 10);

    console.log(`  [${i + 1}/15] ${date} — ${event.content.slice(0, 60)}...`);

    try {
      const nodeId = await client.action(api.memory.ingest.ingest, {
        content: event.content,
        scope: "company" as const,
        sourceType: "observation",
        sourceId: "zoo-media-seed",
        eventTime: event.eventTime,
        entities: event.entities,
        keywords: event.keywords,
        temporalCue: event.temporalCue,
      });

      console.log(`         → Node: ${nodeId}`);
    } catch (err) {
      console.error(`         ✗ Failed: ${err}`);
    }

    // Small delay between inserts to ensure temporal edge ordering
    if (i < EVENTS.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log("\n✅ Seeding complete.");
  console.log(
    "   Consolidation queue has 15 pending items. The cron will process them at ~1 per 30s."
  );
  console.log(
    "   Full consolidation takes ~7.5 minutes. Run eval after consolidation."
  );
}

seed().catch(console.error);
