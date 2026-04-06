import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { getChatClient, CHAT_MODEL } from "./llm";

// ─── Types ───

interface SegmentedEvent {
  content: string;
  entities: string[];
  keywords: string[];
  temporalCue: string | null;
  eventType: string; // "observation" | "action" | "decision" | "state_change"
}

// ─── Segmentation Helper ───

const SEGMENTATION_PROMPT = `You are an event segmentation agent. Break the following text into atomic events.

Each event should be a self-contained fact, decision, observation, or action.
A single event should describe ONE thing that happened.

Return JSON:
{
  "events": [
    {
      "content": "Clear, self-contained description of what happened",
      "entities": ["lowercase names of people, companies, projects, tools mentioned"],
      "keywords": ["important nouns and phrases, lowercase"],
      "temporal_cue": "any time reference like 'last Monday', 'Jan 5', or null if none",
      "event_type": "observation" | "action" | "decision" | "state_change"
    }
  ]
}

Rules:
- Each event must be understandable on its own without reading the others
- Include enough context in each event (e.g., "Akhilesh from Zoo Media" not just "he")
- Preserve specific details: numbers, dates, names, amounts
- Entity names must be lowercase
- If the text is already a single atomic event, return it as-is in a 1-element array
- Order events chronologically if the text implies a sequence
- Maximum 20 events per input — summarize if the text would produce more`;

export async function segmentText(rawText: string): Promise<SegmentedEvent[]> {
  try {
    const response = await getChatClient().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SEGMENTATION_PROMPT },
        { role: "user", content: rawText },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");

    if (!Array.isArray(parsed.events)) return [];

    return parsed.events.slice(0, 20).map(
      (e: any): SegmentedEvent => ({
        content: typeof e.content === "string" ? e.content : rawText,
        entities: Array.isArray(e.entities)
          ? e.entities.map((x: string) => x.toLowerCase().trim())
          : [],
        keywords: Array.isArray(e.keywords)
          ? e.keywords.map((x: string) => x.toLowerCase().trim())
          : [],
        temporalCue: e.temporal_cue ?? null,
        eventType: e.event_type ?? "observation",
      })
    );
  } catch {
    // Fallback: treat entire input as a single event
    return [
      {
        content: rawText,
        entities: [],
        keywords: [],
        temporalCue: null,
        eventType: "observation",
      },
    ];
  }
}

// ─── Convex Action ───

export const segmentAndIngest = action({
  args: {
    rawText: v.string(),
    scope: v.union(v.literal("company"), v.literal("private")),
    sourceType: v.string(),
    sourceId: v.optional(v.string()),
    baseEventTime: v.optional(v.number()), // Default eventTime for events without temporal cues
  },
  handler: async (ctx, args) => {
    const baseTime = args.baseEventTime ?? Date.now();

    // 1. Segment the raw text into atomic events
    const events = await segmentText(args.rawText);

    if (events.length === 0) {
      return { ingested: 0, nodeIds: [] };
    }

    // 2. Ingest all events in parallel.
    //    Pre-extracted entities/keywords skip the redundant extractMetadata call.
    const nodeIds = await Promise.all(
      events.map((event) =>
        ctx.runAction(internal.memory.ingest.ingest, {
          content: event.content,
          scope: args.scope,
          sourceType: event.eventType || args.sourceType,
          sourceId: args.sourceId,
          eventTime: baseTime,
          entities: event.entities,
          keywords: event.keywords,
          temporalCue: event.temporalCue ?? undefined,
        })
      )
    );

    return {
      ingested: nodeIds.length,
      nodeIds,
      events: events.map((e) => ({
        content: e.content,
        eventType: e.eventType,
        entities: e.entities,
      })),
    };
  },
});
