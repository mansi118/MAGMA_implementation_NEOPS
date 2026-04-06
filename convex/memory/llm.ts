import OpenAI from "openai";

// Groq client — fast inference for chat completions (causal inference, intent
// classification, entity extraction, segmentation). Does NOT support embeddings.
export const chatClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// OpenRouter client — used for embeddings (Groq doesn't support them).
// Falls back to this for chat if Groq is unavailable.
export const embeddingClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Model constants
export const CHAT_MODEL = "llama-3.3-70b-versatile"; // Groq model
export const EMBEDDING_MODEL = "openai/text-embedding-3-small"; // OpenRouter model
