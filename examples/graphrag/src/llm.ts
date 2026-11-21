/** A text-in, text-out language model call. Any provider fits behind this. */
export type Complete = (prompt: string) => Promise<string>;

export interface OpenAICompatibleChatOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
}

/** `POST /chat/completions` on any OpenAI-compatible API, one user message, temperature 0. */
export function openAICompatibleChat(options: OpenAICompatibleChatOptions): Complete {
  const { baseUrl, apiKey, model } = options;
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (prompt) => {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Chat request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0]?.message.content ?? "";
  };
}

/** `LLM_URL` set: an OpenAI-compatible chat API (`LLM_API_KEY`, `LLM_MODEL`). Otherwise `null`. */
export function chatFromEnv(env: NodeJS.ProcessEnv = process.env): Complete | null {
  if (!env.LLM_URL) return null;
  return openAICompatibleChat({
    baseUrl: env.LLM_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL ?? "gpt-4o-mini",
  });
}
