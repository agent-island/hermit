import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Body } from "../body.mjs";
import { Log } from "../log.mjs";
import { loadRun, saveRun, runFields, describeRun } from "../run.mjs";
import { buildRequest } from "../shapes.mjs";
import { Loop, preparePrompt, ledgerFrom } from "../loop.mjs";
import { projectPromptTokens, canCountExactly } from "../mind.mjs";
import { loadRuntime, seedInheritance } from "../runtime.mjs";

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

  const body = buildRequest("bare", {
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

  const body = buildRequest("bare", {
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

test("the room states a measured token count or none at all", async () => {
  const config = { contextTokens: 1000, maxTokens: 100, prefill: "bare", endpoint: "prefix" };
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
  assert.equal("maintained" in rendered.at(-1), false);
  assert.equal(rendered.at(-1).capacity, 1000);
  assert.equal(rendered.at(-1).foregroundTokens, 250);
  assert.equal(first.exact, false);
  // The guard still has a number, and it is the operator's, not hers.
  assert.ok(first.promptTokens > 0);

  // Once a reply has reported prompt_tokens, that exact figure is what the
  // room states — not a rescaling of it.
  const ledger = { promptTokens: 412, promptChars: 1200 };
  const second = await preparePrompt({ config, arrival: "prefix", render, ledger });
  assert.equal(second.maintainedTokens, 412);
  assert.equal(rendered.at(-1).maintained, 412);
  assert.equal(rendered.at(-1).capacity, 1000);
  assert.equal(rendered.at(-1).foregroundTokens, 250);
  assert.equal(rendered.at(-1).charsPerToken, 1200 / 412);
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
  const config = { contextTokens: 10, maxTokens: 100, prefill: "bare", endpoint: "prefix" };
  await assert.rejects(
    preparePrompt({ config, arrival: "prefix", render: () => "x".repeat(10_000) }),
    /shelve or consolidate/,
  );
});

test("an empty provider response retries without spending a finite moment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-empty-response-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const log = new Log(path.join(directory, "events.sqlite"));
  const workspace = path.join(directory, "workspace");
  const body = new Body({ log, workspace });
  const port = server.address().port;
  const loop = new Loop({
    log,
    body,
    workspace,
    observer: {},
    config: {
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test",
      model: "empty-test",
      contextTokens: 16_000,
      maxTokens: 100,
      temperature: 0,
      endpoint: "prefix",
      prefill: "bare",
    },
  });
  seedInheritance(log, { own: 2, reserve: 0 });

  try {
    loop.start();
    await loop.waitUntilIdle();
    assert.equal(loadRuntime(log).own, 2);
    assert.equal(log.recent("emission", 10).length, 0);
    assert.match(log.last("error").content, /returned no text/);
    assert.equal(loop.failures, 1);
    assert.ok(loop.nextWakeAt);
  } finally {
    loop.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
