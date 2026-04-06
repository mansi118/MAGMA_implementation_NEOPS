import { chatClient, embeddingClient, CHAT_MODEL, EMBEDDING_MODEL } from "./llm";

// Generate a 1536d embedding via OpenRouter (Groq doesn't support embeddings)
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// Extract entities, keywords, and temporal cues from raw content via Groq
export interface ExtractedMetadata {
  entities: string[];
  keywords: string[];
  temporalCue: string | null;
}

const EXTRACTION_PROMPT = `Extract structured metadata from this event text.

Return JSON with exactly this shape:
{
  "entities": ["lowercase name of each person, company, project, or tool mentioned"],
  "keywords": ["important nouns and noun phrases, lowercase, no stopwords"],
  "temporal_cue": "any time reference like 'last Friday', 'Jan 5', 'Q3 2025', or null if none"
}

Rules:
- Entity names: lowercase, use the most complete name mentioned (e.g., "zoo media" not "zoo")
- Keywords: 3-8 keywords, lowercase, no generic words like "the", "was", "about"
- temporal_cue: extract the raw time reference as-is, or null if no time is mentioned
- If unsure about an entity, include it — downstream processing will filter`;

export async function extractMetadata(
  content: string
): Promise<ExtractedMetadata> {
  try {
    const response = await chatClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");

    return {
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((e: string) => e.toLowerCase().trim())
        : [],
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.map((k: string) => k.toLowerCase().trim())
        : [],
      temporalCue: parsed.temporal_cue ?? null,
    };
  } catch {
    return { entities: [], keywords: [], temporalCue: null };
  }
}
