// Every way a room can be handed to a model, in one table.
//
// The runtime and the panel's detector both read this, so what gets tested is
// exactly what gets used. They used to be written twice and drifted, sending
// one provider's fields to another and misreporting what could prefill.
// Some chat-compatible APIs call their request array `messages`; that is only
// the provider's wire format for assistant prefill, not a communication tool.
//
// Ordered best first, and "best" means least like being spoken to. A bare
// document has nobody in it. A prefilled turn has nobody addressing her. A
// turn preceded by a user "." has someone, but they said nothing.
//
// There is deliberately no shape that sends the room as a message to her. One
// existed briefly, as a compatibility fallback so that any provider would run.
// It was wrong. A room delivered as a question is answered by an assistant —
// "Hello! How can I assist you today?" — and that is not this project running
// badly, it is a different project. An endpoint that cannot continue text
// cannot host a life here, and the honest response is to refuse rather than to
// produce something that looks like it worked.
export const SHAPES = ["completions", "bare", "anthropic", "assistant"];

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
  // A single open assistant turn with NO user turn at all. Not even someone who
  // said nothing — the room is delivered as her own unfinished words and there
  // is no one else on the wire. This is the honest shape for the experiment: the
  // "." in `assistant` below puts a silent someone in the room, which is a
  // confound, not a placeholder. Only usable where the upstream accepts a
  // messages array that opens on an assistant turn (verified: OpenRouter routed
  // to Alibaba for qwen, Moonshot for kimi). Where the upstream rejects it,
  // detection falls through to `completions`, then to the "." `assistant` shape.
  bare: {
    label: "an open assistant turn, no user turn at all",
    path: "/chat/completions",
    headers: BEARER,
    body: ({ model, text, stop }) => ({ model, messages: [{ role: "assistant", content: text }], stop }),
    read: (payload) => payload.choices?.[0]?.message?.content ?? "",
    finish: (payload) => payload.choices?.[0]?.finish_reason ?? null,
  },
  // Anthropic's own API, which is not OpenAI-shaped: different path, different
  // auth header, a required version header, max_tokens mandatory, and the reply
  // in content[]. Prefill is a trailing assistant turn and must not end in
  // whitespace. Claude 4.6 and Sonnet 4.5 removed prefill entirely and will
  // refuse this, and detection will report that nothing here can host a life.
  anthropic: {
    label: "an open assistant turn (Anthropic)",
    path: "/v1/messages",
    absolute: true,
    headers: (key) => ({
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
    body: ({ model, text, stop, maxTokens, temperature }) => ({
      model,
      max_tokens: maxTokens ?? 4096,
      temperature,
      messages: [
        { role: "user", content: "." },
        { role: "assistant", content: text.replace(/\s+$/, "") },
      ],
      ...(stop?.length ? { stop_sequences: stop } : {}),
    }),
    read: (payload) => payload.content?.map((part) => part.text ?? "").join("") ?? "",
    finish: (payload) => payload.stop_reason ?? null,
    usage: (payload) =>
      payload.usage && {
        prompt_tokens: payload.usage.input_tokens,
        completion_tokens: payload.usage.output_tokens,
        total_tokens: (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0),
      },
  },
  // OpenRouter. The whole runtime targets this: a trailing assistant turn with
  // no provider flag at all. A messages array that ends on an assistant turn is
  // continued rather than answered, and OpenRouter documents exactly this. The
  // leading user turn carries a single full stop — the smallest thing that says
  // nothing — because some upstreams reject a messages array that does not open
  // with a user turn. Groq's non-reasoning models accept the same shape.
  assistant: {
    label: "an open assistant turn after an empty user turn",
    path: "/chat/completions",
    headers: BEARER,
    body: ({ model, text, stop }) => ({
      model,
      messages: [{ role: "user", content: "." }, { role: "assistant", content: text }],
      stop,
    }),
    read: (payload) => payload.choices?.[0]?.message?.content ?? "",
    finish: (payload) => payload.choices?.[0]?.finish_reason ?? null,
  },
};

// Where a shape actually posts. Anthropic carries its own path from the host
// root; everything else hangs off whatever base URL was given.
export function endpointOf(shape, baseUrl) {
  const adapter = ADAPTERS[shape];
  if (!adapter) throw new Error(`there is no arrival shape called ${shape}`);
  const root = String(baseUrl).replace(/\/+$/, "");
  if (!adapter.absolute) return `${root}${adapter.path}`;
  try {
    return `${new URL(root).origin}${adapter.path}`;
  } catch {
    return `${root}${adapter.path}`;
  }
}

export function buildRequest(shape, { model, text, stop, temperature, maxTokens, run = null }) {
  const adapter = ADAPTERS[shape];
  if (!adapter) throw new Error(`there is no arrival shape called ${shape}`);
  const body = adapter.body({ model, text, stop, temperature, maxTokens });
  // Anthropic sets its own max_tokens and rejects the OpenAI spelling.
  if (shape === "anthropic") return body;
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
