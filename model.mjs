// Which mind she is, set from the panel instead of a text file.
//
// This is kept in its own local file, deliberately outside her record.
// Everything in the record is archived on every rebirth and
// exported to html, markdown, sqlite and json — a key stored there would be
// copied into every one of those, and the archives are the part people share.
// It is also not hers to see: nothing here ever reaches the room.
//
// Precedence is stored-over-environment. Someone who sets AMI_MODEL in .env and
// then picks a different model in the panel meant the panel.
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTERS, SHAPES, endpointOf, buildRequest, readReply } from "./shapes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AMI_MODEL_FILE || path.join(here, "link", "model.json");

const FIELDS = ["baseUrl", "apiKey", "model", "temperature", "maxTokens", "contextTokens", "endpoint", "prefill"];

export function loadModel() {
  try {
    const stored = JSON.parse(readFileSync(FILE, "utf8"));
    return Object.fromEntries(FIELDS.filter((key) => stored[key] !== undefined && stored[key] !== "")
      .map((key) => [key, stored[key]]));
  } catch {
    return {};
  }
}

export function saveModel(value) {
  const next = { ...loadModel() };
  for (const key of FIELDS) {
    if (value?.[key] === undefined) continue;
    // An empty string means "stop overriding this", not "set it to nothing".
    if (value[key] === "") delete next[key];
    else next[key] = ["temperature", "maxTokens", "contextTokens"].includes(key) ? Number(value[key]) : String(value[key]).trim();
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

// What the panel is allowed to show. The key is never sent back — only enough
// of it to recognise which one is in place.
export function describeModel(config) {
  const key = String(config.apiKey || "");
  return {
    baseUrl: config.baseUrl || "",
    model: config.model || "",
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    contextTokens: config.contextTokens,
    endpoint: config.endpoint,
    prefill: config.prefill || null,
    apiKeySet: Boolean(key),
    apiKeyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : "",
    source: Object.keys(loadModel()).length ? "panel" : "environment",
  };
}

// Does this endpoint actually continue text, or does it answer it?
//
// The whole design rests on the room arriving as an open turn she continues.
// A provider without prefill appends its own assistant header, the model reads
// the room as a request, and you get an assistant instead of a life — which
// looks like working software right up until you read what it said.
//
// The check is a half-finished count. Prefill continues it — "eight nine ten".
// Anything else is the endpoint reading the prefix as a message and replying
// to it, which is the failure this exists to catch.
//
// A word cut mid-syllable was tried first and gave a false negative: DeepSeek
// prefills correctly but answered "The capital of France is Par" with "... wait,
// the user said" — a genuine continuation of the turn that simply went meta.
// Counting leaves no room for that.
export async function probe({ baseUrl, apiKey, model, prefill }) {
  const shape = ADAPTERS[prefill] ? prefill : null;
  if (!shape) return { ok: false, note: "no such arrival shape" };
  const url = endpointOf(shape, baseUrl);
  const request = buildRequest(shape, {
    model,
    text: "one two three four five six seven",
    temperature: 0,
    maxTokens: 256,
  });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: ADAPTERS[shape].headers(apiKey),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return { ok: false, note: `Could not reach that address: ${String(error.message).slice(0, 120)}` };
  }
  const text = await response.text();
  if (!response.ok) return { ok: false, note: `${response.status} ${text.replace(/\s+/g, " ").slice(0, 180)}` };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, note: "That address did not return JSON. Check the URL." };
  }
  const said = readReply(shape, payload).text.trim();
  if (!said) {
    return { ok: false, continued: "", note: "The model returned nothing. Reasoning models often do this — try a non-reasoning one." };
  }
  const continued = /^\W*eight\b/i.test(said);
  return {
    ok: continued,
    continued: said.replace(/\s+/g, " ").slice(0, 70),
    note: continued
      ? "Works. This model continues text, so Project AA can use it."
      : "This model replies instead of continuing the text, so Project AA cannot use it.",
  };
}



export async function detect({ baseUrl, apiKey, model }) {
  const tried = [];
  for (const shape of SHAPES) {
    const result = await probe({ baseUrl, apiKey, model, prefill: shape });
    if (result.ok) {
      return {
        ok: true,
        endpoint: shape === "completions" ? "completions" : "prefix",
        prefill: shape,
        continued: result.continued,
        note: "Works. Project AA can use this model.",
        tried,
      };
    }
    tried.push({ shape, note: result.note.slice(0, 120) });
  }
  return {
    ok: false,
    tried,
    endpoint: null,
    prefill: null,
    note: "This model cannot continue text, so Project AA will not run on it. Models that do work include compatible continuation endpoints and local completion servers such as Ollama, LM Studio, llama.cpp, and vLLM.",
  };
}
