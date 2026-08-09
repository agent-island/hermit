import assert from "node:assert/strict";
import test from "node:test";
import { loadRun, saveRun, runFields, describeRun } from "../run.mjs";
import { buildRequest } from "../shapes.mjs";
import { preparePrompt, ledgerFrom } from "../loop.mjs";
import { projectPromptTokens, canCountExactly } from "../mind.mjs";

function fakeLog() {
  const values = new Map();
  const events = [];
  return {
    events,
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value),
    append: (kind, content, meta) => events.push({ kind, content, meta }),
    last: (kind) => [...events].reverse().find((one) => one.kind === kind) || null,
  };
}

test("a seed that was never set is absent from the wire, not null", () => {
  const run = loadRun(fakeLog());
  assert.equal(run.seed, null);
  assert.deepEqual(runFields(run), {});

  const body = buildRequest("assistant", {
    model: "m", text: "room", stop: [], temperature: 1, maxTokens: 10, run: runFields(run),
  });
  assert.equal("seed" in body, false);
  assert.equal("provider" in body, false);
});

test("run conditions reach the wire and the record", () => {
  const log = fakeLog();
  const saved = saveRun(log, { seed: 7, provider: "deepinfra/turbo", quantizations: "fp8" });

  assert.equal(saved.seed, 7);
  assert.deepEqual(saved.provider, ["deepinfra/turbo"]);
  assert.deepEqual(saved.quantizations, ["fp8"]);
  // Pinning an upstream is pointless if a fallback silently serves it from
  // somewhere else, so setting a pin turns fallbacks off unless asked for.
  assert.equal(saved.allowFallbacks, false);

  const body = buildRequest("assistant", {
    model: "m", text: "room", stop: [], temperature: 1, maxTokens: 10, run: runFields(saved),
  });
  assert.equal(body.seed, 7);
  assert.deepEqual(body.provider, {
    order: ["deepinfra/turbo"],
    allow_fallbacks: false,
    quantizations: ["fp8"],
  });

  // The change is an event, not only a current value.
  const event = log.last("run");
  assert.equal(event.meta.seed, 7);
  assert.match(describeRun(saved), /seed: 7/);
  assert.deepEqual(loadRun(log), saved);
});

test("Anthropic never receives OpenRouter's provider field", () => {
  const run = runFields({ seed: 3, provider: ["x"], allowFallbacks: false, quantizations: null });
  const body = buildRequest("anthropic", {
    model: "m", text: "room", stop: [], temperature: 1, maxTokens: 10, run,
  });
  assert.equal("provider" in body, false);
  assert.equal("seed" in body, false);
});

test("the room states a measured token count or none at all", async () => {
  const config = { contextTokens: 1000, maxTokens: 100, prefill: "assistant", endpoint: "prefix" };
  assert.equal(canCountExactly(config, "prefix"), false);

  const rendered = [];
  const render = (attention) => {
    rendered.push(attention);
    return `MEMORY\n  ${JSON.stringify(attention)}\n`;
  };

  // First moment of a life: nothing has been measured, so no ledger is put in
  // front of her rather than a guess wearing the clothes of a fact.
  const first = await preparePrompt({ config, arrival: "prefix", render });
  assert.equal(first.maintainedTokens, null);
  assert.deepEqual(rendered.at(-1), {});
  assert.equal(first.exact, false);
  // The guard still has a number, and it is the operator's, not hers.
  assert.ok(first.promptTokens > 0);

  // Once a reply has reported prompt_tokens, that exact figure is what the
  // room states — not a rescaling of it.
  const ledger = { promptTokens: 412, promptChars: 1200 };
  const second = await preparePrompt({ config, arrival: "prefix", render, ledger });
  assert.equal(second.maintainedTokens, 412);
  assert.deepEqual(rendered.at(-1), { maintained: 412, capacity: 1000 });
});

test("the projection is calibrated on the last measurement, not assumed", () => {
  const text = "x".repeat(1000);
  // Bootstrap only applies before anything has been measured.
  assert.equal(projectPromptTokens(text, null), Math.ceil(1000 * 0.34));
  // A model that packs four characters per token is measured as such.
  assert.equal(projectPromptTokens(text, { promptTokens: 250, promptChars: 1000 }), 250);
  assert.equal(projectPromptTokens(text, { promptTokens: 500, promptChars: 1000 }), 500);
});

test("calibration survives a restart by being read back from the record", () => {
  const log = fakeLog();
  assert.equal(ledgerFrom(log), null);
  log.append("world", "room", { promptChars: 1200 });
  log.append("emission", "said", { usage: { prompt_tokens: 412 } });
  assert.deepEqual(ledgerFrom(log), { promptTokens: 412, promptChars: 1200 });
});

test("a prompt that cannot fit is refused rather than truncated", async () => {
  const config = { contextTokens: 10, maxTokens: 100, prefill: "assistant", endpoint: "prefix" };
  await assert.rejects(
    preparePrompt({ config, arrival: "prefix", render: () => "x".repeat(10_000) }),
    /shelve or consolidate/,
  );
});
