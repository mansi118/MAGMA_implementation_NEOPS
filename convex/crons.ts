import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run consolidation every 30 seconds.
// Each invocation processes one pending event node:
// - Infers causal edges via GPT-4o-mini
// - Builds semantic edges via vector similarity
// - Classifies entities and refines roles
crons.interval(
  "consolidate memory graph",
  { seconds: 30 },
  internal.memory.slowPath.consolidateNext
);

export default crons;
