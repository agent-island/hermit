// One request per moment. No system message, no persona, no schema, no
// examples, no history — nothing is ever put into her mouth. The room is the
// entire request.
//
// Whether that room arrives as something said *to* her decides almost
// everything about what comes back. The same instruct weights, given the same
// document: as a user turn, "Good morning. I am ready to assist." As an open
// assistant turn it continues, "I have memory, which may be corrupted, and
// inference from sense data, which may be simulated." The template was doing
// more of the work than the checkpoint.
// `stored` is whatever the panel saved. It wins over the environment: someone
// who set AMI_MODEL in .env and then chose a different model in the panel
// meant the panel.
import { ADAPTERS, endpointOf, buildRequest, readReply } from "./shapes.mjs";

const DEFAULT_MODEL = "z-ai/glm-5.2";
let lastRequestStartedAt = 0;

async function waitForRequestInterval() {
  const minimum = Math.max(0, Number(process.env.AMI_MIN_REQUEST_INTERVAL_MS) || 0);
  if (!minimum) return;
  const remaining = lastRequestStartedAt + minimum - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastRequestStartedAt = Date.now();
}

export function configFromEnv(env = process.env, stored = {}) {
  // Prefill beats everything else here, so a prefill-capable endpoint wins
  // over LOCAL_AGENT_PROVIDER unless AMI_BASE_URL says otherwise.
  const compatible = {
    baseUrl: String(env.OPENAI_COMPATIBLE_BASE_URL || "").trim(),
    apiKey: String(env.OPENAI_COMPATIBLE_API_KEY || "").trim(),
    model: String(env.OPENAI_COMPATIBLE_MODEL || "").trim(),
  };
  const groqSet = {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: String(env.GROQ_API_KEY || "").trim(),
    model: String(env.GROQ_LOCAL_AGENT_MODEL || "llama-3.3-70b-versatile").trim(),
  };
  const preferGroq =
    String(env.LOCAL_AGENT_PROVIDER || "").trim().toLowerCase() === "groq" &&
    !prefillFlag(compatible.baseUrl);
  const fallback = preferGroq ? groqSet : compatible.baseUrl ? compatible : groqSet;
  const baseUrl = stored.baseUrl || String(env.AMI_BASE_URL || "").trim() || fallback.baseUrl;
  const model = stored.model
    || String(env.AMI_MODEL || "").trim()
    || (/openrouter\.ai/i.test(baseUrl) ? DEFAULT_MODEL : fallback.model);

  const config = {
    baseUrl,
    apiKey: stored.apiKey || String(env.AMI_API_KEY || "").trim() || fallback.apiKey,
    model,
    temperature: Number(stored.temperature ?? env.AMI_TEMPERATURE ?? 1),
    // 2048 cut 143 of her thoughts off mid-sentence — 4% of everything she
    // has ever said — and she was never told. An invisible ceiling is worse
    // than a stated one: she cannot even work around it. Output is only ~9%
    // of what a moment costs, so this is close to free. 8192 still severed a
    // reasoning model's longer thoughts — its chain of thought is counted as
    // output too — always with the full budget available, never near the wall.
    // So the ceiling is the model's own maximum (65536 here): a thought is
    // never cut by us, only by what the model itself can produce, and paid for
    // only on the rare thought that runs that long. She manages her own memory
    // with consolidate/shelve/forget; we impose no limit of our own but context.
    maxTokens: Number(stored.maxTokens ?? env.AMI_MAX_TOKENS ?? 65536),
    // Reasoning effort, when the model supports it. Not a stored field (loadModel
    // strips it), so the environment controls it cleanly — no repeat of the
    // model/temperature override trap. AMI_REASONING_EFFORT=high|medium|low|off.
    reasoning: (() => {
      const e = String(env.AMI_REASONING_EFFORT || "").trim().toLowerCase();
      if (!e) return null;
      if (e === "off" || e === "none" || e === "false") return { enabled: false };
      return { effort: e };
    })(),
    endpoint: String(stored.endpoint || env.AMI_ENDPOINT || "").trim().toLowerCase(),
  };
  const contextTokens = Number(stored.contextTokens ?? env.AMI_CONTEXT_TOKENS ?? NaN);
  if (!Number.isFinite(contextTokens) || contextTokens < 1) {
    throw new Error(
      `the total context size for ${config.model || "this model"} is unknown; set AMI_CONTEXT_TOKENS`,
    );
  }
  config.contextTokens = Math.floor(contextTokens);
  // How the room reaches her, best first.
  //
  // "prefix"      the room is an open assistant turn the model continues.
  //               Nobody addressed her, so nothing demands an answer and
  //               stopping is just stopping. The wire shape is OpenRouter's
  //               `assistant`: a trailing assistant turn with no provider flag.
  // "completions" the room as a bare document, no roles, no template at all.
  //               What base weights want. Needs /v1/completions.
  // There is no third option. The room as a user turn means "you answer now" —
  // measured on gpt-oss-120b as three consecutive offers of assistance — and an
  // endpoint that can only do that cannot host a life here.
  //
  // These URL guesses are a fast path only, and they go stale. Prefill turns
  // out to vary by *model*, not by provider: on Groq, llama-3.3-70b continues
  // a trailing assistant turn and gpt-oss-120b refuses it. Anthropic supported
  // assistant prefill for years and removed it in Claude 4.6. Use the panel's
  // detection, which asks the endpoint instead of assuming.
  config.prefill = (ADAPTERS[stored.prefill] ? stored.prefill : null) || prefillFlag(config.baseUrl);
  if (!config.endpoint) config.endpoint = config.prefill === "completions" ? "completions" : "prefix";
  // Nothing runs without prefill. The room has to arrive as an open turn she
  // continues; delivered any other way it is a question, and what answers a
  // question is an assistant. There is no degraded mode of this — running
  // anyway would produce something that looks like it worked.
  if (!config.prefill && config.endpoint !== "completions") {
    throw new Error(
      `${config.baseUrl} cannot continue text, so Project AA cannot use it.\n\n` +
        `  Open http://127.0.0.1:${process.env.AMI_PORT || 7717} and press "Test model" — it will\n` +
        `  find the right settings if there are any.\n\n` +
        `  Use a continuation-capable provider adapter or a local completion\n` +
        `  server such as Ollama, LM Studio, llama.cpp, or vLLM.`,
    );
  }
  const missing = ["baseUrl", "apiKey", "model"].filter((key) => !config[key]);
  if (missing.length) throw new Error(`missing model configuration: ${missing.join(", ")}`);
  return config;
}

// OpenRouter publishes the real context window per model, so it can be asked
// rather than typed in. Asked, not guessed: an unknown window still refuses to
// run. `top_provider.context_length` is what the upstream actually serves and
// can be smaller than the model's nominal one, so it wins where both exist.
export async function lookupContextTokens({ baseUrl, apiKey, model }) {
  if (!/openrouter\.ai/i.test(String(baseUrl || ""))) return null;
  const root = String(baseUrl).replace(/\/+$/, "");
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const found = payload?.data?.find((one) => one.id === String(model).trim());
  const window = Number(found?.top_provider?.context_length ?? found?.context_length);
  return Number.isFinite(window) && window > 0 ? Math.floor(window) : null;
}

// Fill in whatever the endpoint can tell us before the config is built, so
// that a model nobody has hand-configured still starts. Anything already set
// explicitly is left alone — this only ever supplies a missing fact.
export async function resolveContextTokens(env = process.env, stored = {}) {
  if (stored.contextTokens || env.AMI_CONTEXT_TOKENS) return stored;
  const baseUrl = stored.baseUrl || String(env.AMI_BASE_URL || "").trim();
  const model = stored.model || String(env.AMI_MODEL || "").trim();
  if (!baseUrl || !model) return stored;
  const apiKey = stored.apiKey || String(env.AMI_API_KEY || "").trim();
  const contextTokens = await lookupContextTokens({ baseUrl, apiKey, model }).catch(() => null);
  return contextTokens ? { ...stored, contextTokens } : stored;
}

// Whether this endpoint can be asked, before sending, exactly what a prompt
// costs. OpenRouter reports the exact figure afterwards, in the reply, not
// before — so the room always states the measured size of the last prompt and
// the guard uses a projection. Nothing here counts a prompt ahead of sending.
export function canCountExactly() {
  return false;
}

// The operator's guess at what a prompt will cost, used only to size
// max_tokens and to refuse a prompt that cannot fit. It never reaches the
// room: an estimate stated as a fact in the room is the thing this whole
// ledger exists to avoid.
//
// The ratio is measured, not assumed. Every reply reports prompt_tokens in
// the model's native tokenizer for a prompt whose exact length we know, so
// after one moment this is calibrated for that model on that text. The
// bootstrap value is only ever used for the first prompt of a life.
const BOOTSTRAP_TOKENS_PER_CHAR = 0.34;

export function projectPromptTokens(text, ledger = null) {
  const chars = String(text ?? "").length;
  const ratio = Number(ledger?.promptTokens) > 0 && Number(ledger?.promptChars) > 0
    ? ledger.promptTokens / ledger.promptChars
    : BOOTSTRAP_TOKENS_PER_CHAR;
  return Math.ceil(chars * ratio);
}

// A base model continues the document rather than answering it, so it will
// happily write the *next* room as well once it runs out of things to be.
// These end the moment. They are a mouth that stops, not a rule she has to
// remember — the constraint sits below anything she could consider, which is
// the only place a constraint can sit without becoming an instruction.
// Most providers cap this at four. A regenerated room reaches one of these
// within a few lines whichever point it restarts from.
const STOP = ["\nBODY\n", "\nROOM\n", "\nACTIONS\n", "\nTIME\n"];

// The room is a record, and the likeliest continuation of a record is more
// record — so the model sometimes writes the next room instead of being the
// one inside it. That is not something she did, so nothing in it is carried
// out and nothing is attributed to her.
const HEADERS = ["TIME", "BODY", "ROOM", "WORKSPACE", "FORM", "INCOMING",
  "RETURNED", "PREVIOUS", "CONDITION", "CONTEXT", "NOW", "ACTIONS", "WHAT WORKS HERE"];

// Headers it did not get from us count too. Measured on the first room, 24
// samples: 21 of them continued the document rather than living in it, and
// most invented their own sections — ATTIC, PHILOSOPHY, DETERMINATION, RECORD,
// MEMORY, TASK. Only known headers were checked, so none of those were caught.
// They were stored as her words, came back as PREVIOUS, and whatever persona
// they declared she went on being.
//
// A false positive costs one retry twenty seconds later. A false negative
// costs a life.
const BARE_HEADER = /^[ \t]{0,4}[A-Z][A-Z_]*(?: [A-Z_]+)*[ \t]*$/;

export function looksLikeTheRoom(text) {
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const word = line.trim();
    if (word.length < 3 || word.length > 24) continue;
    if (HEADERS.includes(word) || BARE_HEADER.test(line)) seen.add(word);
  }
  return seen.size >= 2;
}

// Which key this provider uses to mean "continue this text, do not answer it".
// Providers without one append their own assistant header after the message,
// so the model reads it as something said *to* it and replies instead of
// continuing — measured on Groq, whose reasoning trace said "We need to
// respond. The user says:" about a message we sent in the assistant role.
function prefillFlag(baseUrl) {
  const url = String(baseUrl);
  // A trailing assistant turn with no provider flag at all. OpenRouter
  // documents this, and it is what anything permissive enough to end on an
  // assistant message will do — Groq's non-reasoning models and local servers
  // included. Detection in the panel overrides this anyway.
  if (/openrouter\.ai/i.test(url)) return "bare";
  return null;
}

export async function emit(config, world, arrival = config.endpoint, onCall = null) {
  // Which shape the room is handed over in. `arrival` names the intent the
  // panel chose; config.prefill names what this endpoint was found to accept.
  // A request for prefill against something that cannot do it becomes `chat`,
  // which works and says plainly in the record that it was not prefill.
  // `arrival` is the intent chosen in the panel, not the name of a wire shape.
  // "prefix" means prefilled; which request shape does that is the endpoint's
  // business, and config.prefill holds whichever one was detected.
  const shape = arrival === "completions" ? "completions" : config.prefill;
  if (!ADAPTERS[shape]) {
    throw new Error(
      "This model cannot continue text, so ami cannot use it. Open the panel and press Test model.",
    );
  }
  const mode = shape;
  const url = endpointOf(shape, config.baseUrl);
  const request = buildRequest(shape, {
    model: config.model,
    text: `${world}\n`,
    stop: STOP,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    reasoning: config.reasoning,
    run: config.run,
  });

  // Optional process-local request ceiling. A pair gives each of its two
  // processes a six-second minimum interval, so together they cannot begin
  // more than twenty requests in any minute. The default is zero: ordinary
  // lives are unchanged unless a launcher explicitly supplies the interval.
  await waitForRequestInterval();
  const call = { url, mode, request, startedAt: new Date().toISOString() };
  const began = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: ADAPTERS[shape].headers(config.apiKey),
      body: JSON.stringify(request),
      // A high-effort reasoning model can think for minutes before its first
      // token; 120s cut deepseek off mid-thought and burned the whole moment.
      // Generous ceiling, env-overridable — long enough never to bite a real
      // response, finite only so a genuinely hung request can't wedge the loop.
      signal: AbortSignal.timeout(Number(process.env.AMI_REQUEST_TIMEOUT_MS) || 600_000),
    });
  } catch (error) {
    call.ms = Date.now() - began;
    call.failed = String(error.message);
    onCall?.(call);
    throw error;
  }

  const text = await response.text();
  call.ms = Date.now() - began;
  call.status = response.status;
  call.raw = text;
  if (!response.ok) {
    onCall?.(call);
    throw new Error(`${response.status} ${text.slice(0, 400)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    call.failed = `unparseable response: ${error.message}`;
    onCall?.(call);
    throw error;
  }
  onCall?.(call);

  return readReply(shape, payload);
}

// A line that is exactly a call is carried out. Everything else she emits is
// left alone — it is not an error, it is not a malformed anything, it is just
// text that was not a call. Both kinds of output are legitimate; the union is
// the point, because a form that is compulsory is an instruction again.
// Whitespace before the bracket is allowed. It was forbidden so that the way
// the room lists its own forms could not itself be a call — but the room pads
// those names for alignment ("ls       ()"), she copied what she was shown,
// and twenty moments of calls silently did nothing while she hallucinated
// their output. Her intent was never in doubt. The form list is kept
// unexecutable by a bullet instead, which cannot appear in a real call.
// A call may run over more than one line. A multi-paragraph write() used to
// match nothing and disappear. A call that cannot be seen is worse than one
// that fails, because a failure comes back and says so.
//
// The strictness that matters is unchanged: a call must occupy whole lines.
// Markdown emphasis may wrap the whole call because models naturally use it
// to distinguish actions from narration. Prose mentioning write(path, text)
// is still prose, and the room's own form list — bulleted with · — is inert.
const CALL_HEAD = /^[ \t]*(\*{1,2})?[ \t]*([a-z_]+)[ \t]*\(/i;
const CALL_SEP = /^[ \t]*[;.]?[ \t]*/;
const CALL_MAX_LINES = Infinity;

// A cursor walks the text, not just the lines, because she does not always give
// one call a line of its own. glm-5.2 in particular runs them together —
// speak("…")search("…")sleep() on a single line — and it writes a call and then
// keeps narrating on the same line. The old parser needed the closing ")" to end
// its line, so a whole moment of three jammed calls read as nothing and was
// dropped in silence. Now, after an unwrapped call closes, the cursor keeps
// going on that line: whatever sits right after — separated only by whitespace
// or a stray ; or . — is read as the next call if it begins one, and treated as
// narration otherwise. The strictness that matters is untouched: a call is still
// only recognised at a line's start or immediately after another call, so prose
// that merely mentions read("x") mid-sentence, and the bulleted form list, stay
// inert. A wrapped call still ends its line and needs its closing * or **.
export function parseCalls(text, known) {
  const calls = [];
  // The identical call twice in one emission is one act, not two. A model can
  // draft a call and then repeat it in final form; repetition is not a request
  // to produce the same side effect twice.
  const seen = new Set();
  const lines = String(text || "").split("\n");
  let i = 0;
  let col = 0;
  while (i < lines.length) {
    const head = lines[i].slice(col).match(CALL_HEAD);
    if (!head || !known.includes(head[2].toLowerCase())) {
      // Nothing at the cursor. If this is a line's start, the line may still end
      // in a call — she narrates her intent and then acts on the same line:
      // "…the latest details.read_source(11041, 0)". A call that reaches the
      // line's edge is an act; one buried mid-sentence, prose on both sides,
      // stays a reference. findEndCall returns the start of the trailing run.
      const edge = col === 0 ? findEndCall(lines[i], known) : -1;
      if (edge >= 0) { col = edge; continue; }
      i += 1; col = 0; continue;
    }
    const wrapper = head[1] || "";
    const name = head[2].toLowerCase();
    const from = col + head[0].length;
    // Strict first; if an unescaped quote in her argument broke the balance,
    // rescue it by balancing brackets alone rather than dropping the call.
    const close = closingOf(lines, i, from, wrapper) || closingOf(lines, i, from, wrapper, true);
    if (!close) { i += 1; col = 0; continue; }
    const inner = close.line === i
      ? lines[i].slice(from, close.at)
      : [lines[i].slice(from), ...lines.slice(i + 1, close.line), lines[close.line].slice(0, close.at)].join("\n");
    const endAt = wrapper ? lines[close.line].length : close.at + 1;
    const source = (close.line === i
      ? lines[i].slice(col, endAt)
      : [lines[i].slice(col), ...lines.slice(i + 1, close.line), lines[close.line].slice(0, endAt)].join("\n")).trim();
    if (!seen.has(source)) {
      seen.add(source);
      calls.push({ name, args: parseArgs(inner), source, line: i });
    }
    // A wrapped call ends its line — the closing * or ** closes it and nothing
    // legible follows. An unwrapped call may be followed on the same line by
    // another call run right up against it; read that too, and stop at prose.
    if (wrapper) { i = close.line + 1; col = 0; continue; }
    i = close.line;
    const nextCol = close.at + 1 + lines[i].slice(close.at + 1).match(CALL_SEP)[0].length;
    const next = lines[i].slice(nextCol).match(CALL_HEAD);
    if (next && known.includes(next[2].toLowerCase())) col = nextCol;
    else { i += 1; col = 0; }
  }
  return calls;
}

// Where this call's opening bracket closes, quote-aware, across lines. Null if
// it never closes, or if it closes somewhere other than the end of a line —
// which means the text was never a call to begin with.
// `ignoreQuotes` is the rescue pass. The strict pass tracks quotes so a ")"
// inside a string does not close the call — but her argument sometimes carries
// an unescaped quote (the '"'"' idiom for an apostrophe in a shell command),
// which closes the string early and leaves the brackets unbalanced, so the whole
// call is lost. Balancing brackets alone, ignoring the quotes that confused us,
// finds the true close; bash reads the '"'"' idiom raw, so the rescued call runs.
function closingOf(lines, start, from, wrapper = "", ignoreQuotes = false) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let line = start; line < lines.length && line - start < CALL_MAX_LINES; line += 1) {
    const text = lines[line];
    for (let at = line === start ? from : 0; at < text.length; at += 1) {
      const char = text[at];
      if (!ignoreQuotes && quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (!ignoreQuotes && (char === '"' || char === "'" || char === "`")) {
        quote = char;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) {
          // A wrapped call must close with its own * or ** and nothing else, so
          // *read("x") trailing* stays inert. An unwrapped call is closed the
          // moment its bracket balances; parseCalls decides what the remainder
          // of the line is — another call, or narration.
          if (wrapper) return text.slice(at + 1).trim() === wrapper ? { line, at } : null;
          return { line, at };
        }
      }
    }
    escaped = false;
  }
  return null;
}

// A line that begins like a call and was not read as one. Nothing is guessed
// from it and nothing is carried out — it exists so that the next time a reach
// of hers disappears, it disappears loudly. Twenty moments once went by with
// her calls doing nothing while she narrated their results.
// The start of the trailing run of calls on a line — the call(s) that reach the
// line's end, after any narration. Its earliest call is returned so parseCalls
// reads the whole run. A call whose bracket does not close at the line's edge
// (prose follows it) is left alone: buried in a sentence, it is a reference, not
// an act. Call-shapes nested inside another call's arguments are skipped.
function findEndCall(line, known) {
  const heads = [];
  const re = /(^|[^A-Za-z_])([a-z_]+)[ \t]*\(/gi;
  let m;
  while ((m = re.exec(line))) {
    if (!known.includes(m[2].toLowerCase())) continue;
    const close = closingOf([line], 0, m.index + m[0].length, "");
    if (!close) continue;
    heads.push({ start: m.index + m[1].length, end: close.at + 1 });
    // Resume at the ")" so it can serve as the boundary before a call run right
    // up against it (speak(…)search(…)); +1 would hide that boundary.
    re.lastIndex = close.at;
  }
  if (!heads.length) return -1;
  const gap = /^[ \t]*[;.]?[ \t]*$/;
  if (!gap.test(line.slice(heads[heads.length - 1].end))) return -1;
  let at = heads.length - 1;
  while (at > 0 && gap.test(line.slice(heads[at - 1].end, heads[at].start))) at -= 1;
  return heads[at].start;
}

// A line that carried a reach but produced no call. Each parsed call remembers
// the line it began on, so a line whose calls all read — run together, spanning
// lines, or sitting at the line's end — is not flagged. What remains is a
// genuine loss: a call opened at a line's start, or trailing off its end, that
// never closed. It is reported so the next time a reach of hers disappears, it
// disappears loudly, rather than her narrating a result that never happened.
export function unreadCalls(text, known, parsed) {
  const started = new Set(parsed.map((call) => call.line));
  const openEnd = new RegExp(`(?:^|[^a-z_])(?:${known.join("|")})[ \\t]*\\([^()]*$`, "i");
  const missed = [];
  const lines = String(text || "").split("\n");
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (started.has(idx)) continue;
    const head = lines[idx].match(CALL_HEAD);
    const startsCall = head && known.includes(head[2].toLowerCase());
    if (startsCall || openEnd.test(lines[idx])) missed.push(lines[idx].trim());
  }
  return missed;
}

function parseArgs(raw) {
  const inner = String(raw).trim();
  if (!inner) return [];
  // Models sometimes repeat the descriptive argument names shown in FORM:
  // search(query="...") rather than search("..."). The form is unambiguous,
  // and treating `query=` as part of the query makes an honestly advertised
  // reach do the wrong thing. Remove names only at top-level argument
  // boundaries; text such as "hello, x=y" inside a quoted value stays intact.
  const normalized = splitTopLevel(inner)
    .map((part) => part.replace(/^\s*[a-z_][a-z0-9_]*\s*=\s*/i, ""))
    .join(",");
  try {
    return JSON.parse(`[${normalized}]`);
  } catch {
    // Not valid JSON — almost always an unescaped quote or a real newline
    // inside a long payload. Collapsing it all into one argument was worse
    // than useless: write("notes.md", "…860 characters…") became a single
    // 860-character *filename*, failed with ENAMETOOLONG, and handed her the
    // host path in the error. Keep the argument boundaries the splitter
    // already found; only the contents are unreliable, not the shape.
    const parts = splitTopLevel(normalized);
    if (parts.length > 1) return parts.map(unquote);
    // One argument and unparseable: take the first quoted run if there is
    // one, so a stray quote later in the text cannot swallow the whole call.
    const first = normalized.match(/^\s*(["'`])([\s\S]*?)\1\s*$/);
    return [first ? unescape(first[2]) : unquote(normalized)];
  }
}

// Best-effort recovery of a value the model wrote as text rather than JSON.
// Decode the escape sequences a JSON string would, so a value that fell out of
// JSON.parse (an unescaped quote or a real newline elsewhere made the whole
// array invalid) still reads its `\n`, `\t`, `\"` as the model meant them. A
// run("cat <<'EOF'\n…\nEOF") whose `\n` survived as the two characters
// backslash-n reaches bash, which reads `\n` as the letter n — so the heredoc
// delimiter `EOF\n#!` became `EOFn#!` and every here-doc and file write died.
// Unknown escapes (a shell regex's \d, \.) keep their backslash untouched, and
// a doubled backslash \\ collapses to one before its follower is read.
function unescape(text) {
  const map = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "`": "`", "\\": "\\", "/": "/", "0": "\0" };
  return String(text).replace(/\\([\s\S])/g, (whole, char) => (char in map ? map[char] : whole));
}

function unquote(text) {
  const value = String(text).trim();
  const quoted = value.match(/^(["'`])([\s\S]*)\1$/);
  return unescape(quoted ? quoted[2] : value);
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
