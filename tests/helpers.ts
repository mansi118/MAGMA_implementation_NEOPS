/**
 * Test helpers: mock event nodes and graph structures for unit tests.
 * These mimic Convex Doc<"eventNodes"> shape without importing Convex types.
 */

export interface MockEventNode {
  _id: string;
  _creationTime: number;
  content: string;
  eventTime: number;
  createdAt: number;
  embedding: number[];
  scope: "company" | "private";
  sourceType: string;
  sourceId?: string;
  metadata: {
    entities: string[];
    temporalCues?: string;
    keywords: string[];
  };
  consolidated: boolean;
}

// Generate a simple mock embedding (unit vector in a specific direction)
export function mockEmbedding(seed: number, dims: number = 8): number[] {
  const emb = new Array(dims).fill(0);
  emb[seed % dims] = 1.0;
  return emb;
}

// Generate a mock embedding that's similar to another (shifted slightly)
export function similarEmbedding(
  base: number[],
  noise: number = 0.1
): number[] {
  return base.map((v) => v + (Math.random() - 0.5) * noise);
}

// Create a mock event node from the Zoo Media test data
export function makeNode(
  id: string,
  content: string,
  eventTime: number,
  embedding: number[],
  entities: string[] = [],
  keywords: string[] = []
): MockEventNode {
  return {
    _id: id,
    _creationTime: Date.now(),
    content,
    eventTime,
    createdAt: Date.now(),
    embedding,
    scope: "company",
    sourceType: "observation",
    metadata: { entities, keywords },
    consolidated: true,
  };
}

// The 15 Zoo Media events as mock nodes (with small mock embeddings for fast tests)
export function makeZooMediaNodes(): MockEventNode[] {
  return [
    makeNode("e1", "Met with Akhilesh from Zoo Media, discussed ICD NEop pitch", new Date("2025-01-05").getTime(), mockEmbedding(0), ["akhilesh", "zoo media", "icd neop"], ["meeting", "pitch"]),
    makeNode("e2", "Akhilesh shared Zoo Media's current tech stack — Laravel + AWS", new Date("2025-01-07").getTime(), mockEmbedding(1), ["akhilesh", "zoo media"], ["tech stack", "laravel"]),
    makeNode("e3", "Sent Zoo Media the 105-slide deck", new Date("2025-01-10").getTime(), mockEmbedding(2), ["zoo media"], ["slide deck"]),
    makeNode("e4", "Akhilesh raised concerns about data privacy in ICD NEop", new Date("2025-01-12").getTime(), mockEmbedding(3), ["akhilesh", "icd neop"], ["data privacy", "concerns"]),
    makeNode("e5", "Rahul prepared a data privacy addendum addressing Akhilesh's concerns", new Date("2025-01-14").getTime(), mockEmbedding(4), ["rahul", "akhilesh"], ["addendum", "privacy"]),
    makeNode("e6", "Sent revised proposal with privacy addendum to Zoo Media", new Date("2025-01-15").getTime(), mockEmbedding(5), ["zoo media"], ["revised proposal", "addendum"]),
    makeNode("e7", "Zoo Media internal review — Akhilesh forwarded to their legal team", new Date("2025-01-18").getTime(), mockEmbedding(6), ["zoo media", "akhilesh"], ["legal team"]),
    makeNode("e8", "Zoo Media legal flagged GDPR compliance requirement", new Date("2025-01-22").getTime(), mockEmbedding(7), ["zoo media"], ["gdpr", "compliance"]),
    makeNode("e9", "Mansi researched GDPR compliance for ICD architecture", new Date("2025-01-24").getTime(), mockEmbedding(0), ["mansi", "icd"], ["gdpr", "research"]),
    makeNode("e10", "Updated ICD architecture to include EU data residency", new Date("2025-01-25").getTime(), mockEmbedding(1), ["icd"], ["architecture", "eu data"]),
    makeNode("e11", "Presented GDPR-compliant architecture to Akhilesh", new Date("2025-01-28").getTime(), mockEmbedding(2), ["akhilesh", "icd"], ["gdpr-compliant"]),
    makeNode("e12", "Zoo Media approved ICD NEop pilot — Tier 1 engagement", new Date("2025-01-30").getTime(), mockEmbedding(3), ["zoo media", "icd neop"], ["approved", "pilot"]),
    makeNode("e13", "Signed SOW with Zoo Media for 2-month pilot at ₹5L/month", new Date("2025-02-02").getTime(), mockEmbedding(4), ["zoo media"], ["sow", "signed"]),
    makeNode("e14", "Shivam began ICD NEop deployment on Zoo Media staging", new Date("2025-02-05").getTime(), mockEmbedding(5), ["shivam", "icd neop", "zoo media"], ["deployment"]),
    makeNode("e15", "First ICD NEop successfully processed 200 customer queries", new Date("2025-02-10").getTime(), mockEmbedding(6), ["icd neop"], ["processed", "success"]),
  ];
}
