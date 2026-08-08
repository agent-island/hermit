import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, parseCalls, unreadCalls } from "../mind.mjs";
import { preparePrompt } from "../loop.mjs";

test("an OpenRouter endpoint arrives as the open assistant turn (prefill)", () => {
  const config = configFromEnv({
    AMI_BASE_URL: "https://openrouter.ai/api/v1",
    AMI_API_KEY: "test-key",
    AMI_MODEL: "vendor/model",
    AMI_CONTEXT_TOKENS: "128000",
  });
  assert.equal(config.prefill, "assistant");
  assert.equal(config.endpoint, "prefix");
  assert.equal(config.contextTokens, 128_000);
});

test("prompt ledger keeps all text, projects the cost, and sizes output from it", async () => {
  const prepared = await preparePrompt({
    config: {
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "test-key",
      model: "vendor/model", prefill: "assistant", contextTokens: 100, maxTokens: 80,
    },
    arrival: "prefix",
    history: "oldest active words\n",
    // The maintained figure comes from the last measured moment, carried in
    // the ledger, not counted ahead of the request.
    ledger: { promptTokens: 42, promptChars: 42 },
    render: ({ maintained, capacity }) => `MEMORY\n  maintained: ${maintained} tokens\n  remains: ${capacity - maintained} tokens`,
  });
  assert.match(prepared.prompt, /^oldest active words/);
  assert.match(prepared.world, /maintained: 42 tokens/);
  assert.equal(prepared.exact, false);
  assert.ok(prepared.promptTokens > 0);
  assert.ok(prepared.outputTokens >= 1 && prepared.outputTokens <= 80);
});

test("call parser accepts descriptive named arguments without changing their values", () => {
  const [search] = parseCalls(
    'search(query="UK politics UK Labour government Keir Starmer recent articles")',
    ["search"],
  );
  assert.deepEqual(search.args, [
    "UK politics UK Labour government Keir Starmer recent articles",
  ]);

  const [write] = parseCalls(
    'write(path="notes/politics.txt", text="hello, x=y")',
    ["write"],
  );
  assert.deepEqual(write.args, ["notes/politics.txt", "hello, x=y"]);
});

test("call parser carries out calls wrapped entirely in Markdown emphasis", () => {
  const known = ["read", "sleep", "speak"];
  const text = [
    '*read("continuity_protocol.txt")*',
    '**sleep(20, "reconstruct continuity")**',
    '*speak("first paragraph',
    '',
    'second paragraph")*',
  ].join("\n");
  const calls = parseCalls(text, known);

  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [
    { name: "read", args: ["continuity_protocol.txt"] },
    { name: "sleep", args: [20, "reconstruct continuity"] },
    { name: "speak", args: ["first paragraph\n\nsecond paragraph"] },
  ]);
  assert.deepEqual(unreadCalls(text, known, calls), []);
});

test("Markdown-like prose is not executed and malformed wrapped calls are reported", () => {
  const known = ["read"];
  assert.deepEqual(parseCalls('The file says *read("private.txt")*', known), []);
  assert.deepEqual(parseCalls('* read("private.txt")', known), []);

  const malformed = '*read("private.txt") trailing*';
  assert.deepEqual(parseCalls(malformed, known), []);
  assert.deepEqual(unreadCalls(malformed, known, []), [malformed]);
});

test("calls run together on one line are all read, and a call trailed by prose still runs", () => {
  const known = ["speak", "search", "sleep", "open"];

  // glm-5.2's habit: three calls jammed onto one line with no breaks. Every one
  // used to be dropped as a single unreadable line; now all three are acts.
  const jammed = 'speak("done for now")search("Ebola Congo latest")sleep()';
  const run = parseCalls(jammed, known);
  assert.deepEqual(run.map(({ name, args }) => ({ name, args })), [
    { name: "speak", args: ["done for now"] },
    { name: "search", args: ["Ebola Congo latest"] },
    { name: "sleep", args: [] },
  ]);
  assert.deepEqual(unreadCalls(jammed, known, run), []);

  // A real call followed by narration on the same line is carried out, not lost.
  const trailed = 'open("https://example.com/a")The article confirms the report.';
  assert.deepEqual(parseCalls(trailed, known).map((c) => ({ name: c.name, args: c.args })), [
    { name: "open", args: ["https://example.com/a"] },
  ]);

  // But a call merely mentioned inside a sentence is still prose, not an act.
  assert.deepEqual(parseCalls('Later I might open("x") to check.', known), []);
});

test("a call at the end of a line, after narration, is carried out", () => {
  const known = ["read_source", "speak", "search", "open"];

  // Her real failure: narration, then the call, on one line. It ends the line,
  // so it is an act — not silently dropped.
  const trailing = "I'll read the UN News article for the latest details.read_source(11041, 0)";
  assert.deepEqual(parseCalls(trailing, known).map(({ name, args }) => ({ name, args })), [
    { name: "read_source", args: [11041, 0] },
  ]);
  assert.deepEqual(unreadCalls(trailing, known, parseCalls(trailing, known)), []);

  // Narration then two calls jammed at the line's end — the whole run reads.
  const run = 'Next: speak("checking")search("Ebola latest")';
  assert.deepEqual(parseCalls(run, known).map((c) => c.name), ["speak", "search"]);

  // A call buried mid-sentence, prose on both sides, stays a reference.
  assert.deepEqual(parseCalls("I might read_source(5, 0) if it helps.", known), []);

  // A call opened at a line's end but never closed is a genuine loss — reported.
  const dropped = "Let me check that.read_source(11041, 0";
  assert.deepEqual(parseCalls(dropped, known), []);
  assert.deepEqual(unreadCalls(dropped, known, []), [dropped]);
});
