import OpenAI from "openai";

// Shared OpenRouter client — used by all modules for both chat and embeddings.
// OpenRouter provides an OpenAI-compatible API at a different base URL.
export const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Model constants — OpenRouter uses provider/model format
export const CHAT_MODEL = "openai/gpt-4o-mini";
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
