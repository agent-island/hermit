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

export function buildRequest(shape, { model, text, stop, temperature, maxTokens, run = null, reasoning = null }) {
  const adapter = ADAPTERS[shape];
  if (!adapter) throw new Error(`there is no arrival shape called ${shape}`);
  const body = adapter.body({ model, text, stop, temperature, maxTokens });
  // The run conditions — seed, provider pin, quantization — are the
  // independent variables, so they go on every request that can carry them.
  // `provider` is OpenRouter's; harmless elsewhere, since an unknown top-level
  // key is ignored by OpenAI-shaped endpoints. Anthropic's own API is strict
  // about unknown keys, which is the other reason it returns above.
  return { ...body, temperature, max_tokens: maxTokens, ...(reasoning ? { reasoning } : {}), ...(run || {}) };
}

// Some models (kimi-k3) surface their acts not as bare lines but in their own
// native tool-call channel — <|open|>call tool="run"…<|open|>argument key=…
// type=…<|sep|>VALUE<|close|>argument…<|close|>call. These are REAL acts she
// emitted; left as-is the parser reads zero and the moment is lost ("she acted
// and we dropped it"). Rewrite each call into the bare form the scaffold reads —
// run("…"), feel("…", 0.7) — inventing nothing, only re-expressing her own acts.
function unpackNativeCalls(text) {
  if (!/<\|open\|>call\s+tool=/.test(text)) return text;
  const calls = [];
  const callRe = /<\|open\|>call\s+tool="([^"]+)"[\s\S]*?(?=<\|close\|>call)/g;
  let m;
  while ((m = callRe.exec(text))) {
    const name = m[1];
    const args = [];
    const argRe = /<\|open\|>argument\s+key="[^"]*"\s+type="([^"]+)"<\|sep\|>([\s\S]*?)<\|close\|>argument/g;
    let a;
    while ((a = argRe.exec(m[0]))) {
      args.push(a[1] === "number" ? String(Number(a[2])) : JSON.stringify(a[2]));
    }
    calls.push(`${name}(${args.join(", ")})`);
  }
  return calls.length ? calls.join("\n") : text;
}

export function readReply(shape, payload) {
  const adapter = ADAPTERS[shape];
  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  // Keep the provider's structured reasoning blocks intact. Newer providers
  // can return plaintext, summaries, signatures, or encrypted continuity data
  // here; flattening the array would destroy information needed to inspect or
  // continue the response later. Chat replies place these fields in `message`;
  // bare /completions replies (including Ox Alpha) place them on the choice.
  const reasoningDetails = message.reasoning_details ?? choice.reasoning_details ?? null;
  const directReasoning = message.reasoning_content ?? message.reasoning
    ?? choice.reasoning_content ?? choice.reasoning ?? "";
  const readableDetails = Array.isArray(reasoningDetails)
    ? reasoningDetails
        .map((detail) => detail?.text ?? detail?.summary ?? "")
        .filter(Boolean)
        .join("\n")
    : "";
  // A reasoning model returns its chain of thought in a separate field, but the
  // boundary is imperfect: the tail of the thought and the closing </think> tag
  // bleed into message.content ahead of her actual words. Everything up to and
  // including the first such tag is leaked reasoning, not hers — drop it so the
  // emission that becomes her record is only what she meant to say. Non-greedy
  // and anchored at the start, so a </think> she might type later is untouched.
  // Some models are trained to wrap each call in their native tool-call tags —
  // <tool_call>feel("wonder", 0.6)</tool_call>, often several in a row — but
  // this scaffold reads bare calls, one per line. Left in place, the whole line
  // reads as prose and the call is silently dropped ("written as a call but not
  // read"). Drop the closing tags, and turn each opening tag into a line break
  // so the call it wraps lands on its own line where the parser will find it.
  const text = unpackNativeCalls(
    String(adapter.read(payload) ?? "")
      .replace(/^[\s\S]*?<\/think>\s*/, ""),
  )
    .replace(/<\/tool_calls?\b[^>]*>/gi, "")
    .replace(/<tool_calls?\b[^>]*>/gi, "\n");
  return {
    text,
    finish: adapter.finish(payload),
    usage: adapter.usage ? adapter.usage(payload) : (payload.usage ?? null),
    reasoning: String(directReasoning || readableDetails) || null,
    reasoningDetails,
  };
}
