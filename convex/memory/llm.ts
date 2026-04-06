import OpenAI from "openai";

// Lazy-initialized clients. Convex analyzes modules at deploy time before env
// vars are available, so we can't create clients at module scope — OpenAI's
// constructor throws if apiKey is missing.

let _chatClient: OpenAI | null = null;
let _embeddingClient: OpenAI | null = null;

// Groq client — fast inference for chat completions
export function getChatClient(): OpenAI {
  if (!_chatClient) {
    _chatClient = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return _chatClient;
}

// OpenRouter client — used for embeddings (Groq doesn't support them)
export function getEmbeddingClient(): OpenAI {
  if (!_embeddingClient) {
    _embeddingClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return _embeddingClient;
}

// Model constants
export const CHAT_MODEL = "llama-3.3-70b-versatile";
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
