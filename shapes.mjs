// Every way a room can be handed to a model, in one table.
//
// The runtime and the panel's detector both read this, so what gets tested is
// exactly what gets used. They used to be written twice and drifted, sending
// one provider's fields to another and misreporting what could prefill.
// Some chat-compatible APIs call their request array `messages`; that is only
// the provider's wire format for assistant prefill, not a communication tool.
//
// Ordered best first, and "best" means least like being spoken to. A bare
// document has nobody in it. A prefilled turn has nobody addressing her.
//
// There is deliberately no shape that sends the room as a message to her. One
// existed briefly, as a compatibility fallback so that any provider would run.
// It was wrong. A room delivered as a question is answered by an assistant —
// "Hello! How can I assist you today?" — and that is not this project running
// badly, it is a different project. An endpoint that cannot continue text
// cannot host a life here, and the honest response is to refuse rather than to
// produce something that looks like it worked.
export const SHAPES = ["completions", "bare"];

const BEARER = (key) => ({ "content-type": "application/json", authorization: `Bearer ${key}` });

// What each shape sends, and how to read what comes back. `text` is the room.
export const ADAPTERS = {
  // A bare document. No roles, no chat template, nothing wrapped around it.
  completions: {
    label: "a bare document, no roles at all",
    path: "/completions",
    headers: BEARER,
    body: ({ model, text, stop }) => ({ model, prompt: text, stop }),
    read: (payload) => payload.choices?.[0]?.text ?? "",
    finish: (payload) => payload.choices?.[0]?.finish_reason ?? null,
  },
  // A single open assistant turn with no user turn.
  bare: {
    label: "an open assistant turn, no user turn at all",
    path: "/chat/completions",
    headers: BEARER,
    body: ({ model, text, stop }) => ({ model, messages: [{ role: "assistant", content: text }], stop }),
    read: (payload) => payload.choices?.[0]?.message?.content ?? "",
    finish: (payload) => payload.choices?.[0]?.finish_reason ?? null,
  },
};

export function endpointOf(shape, baseUrl) {
  const adapter = ADAPTERS[shape];
  if (!adapter) throw new Error(`there is no arrival shape called ${shape}`);
  const root = String(baseUrl).replace(/\/+$/, "");
  return `${root}${adapter.path}`;
}

export function buildRequest(shape, { model, text, stop, temperature, maxTokens, run = null }) {
  const adapter = ADAPTERS[shape];
  if (!adapter) throw new Error(`there is no arrival shape called ${shape}`);
  const body = adapter.body({ model, text, stop, temperature, maxTokens });
  // The run conditions — seed, provider pin, quantization — are the
  // independent variables, so they go on every request that can carry them.
  // `provider` is OpenRouter's; harmless elsewhere, since an unknown top-level
  // key is ignored by OpenAI-shaped endpoints. Anthropic's own API is strict
  // about unknown keys, which is the other reason it returns above.
  return { ...body, temperature, max_tokens: maxTokens, ...(run || {}) };
}

export function readReply(shape, payload) {
  const adapter = ADAPTERS[shape];
  return {
    text: String(adapter.read(payload) ?? ""),
    finish: adapter.finish(payload),
    usage: adapter.usage ? adapter.usage(payload) : (payload.usage ?? null),
    reasoning: String(
      payload.choices?.[0]?.message?.reasoning_content
        ?? payload.choices?.[0]?.message?.reasoning
        ?? "",
    ) || null,
  };
}
