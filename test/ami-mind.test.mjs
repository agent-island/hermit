import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Body } from "../body.mjs";
import { acquireSharedRequestLock, configFromEnv, emit, looksLikeTheRoom, parseCalls, unreadCalls } from "../mind.mjs";
import { preparePrompt } from "../loop.mjs";

test("an OpenRouter endpoint arrives as the open assistant turn (prefill)", () => {
  const config = configFromEnv({
    HERMIT_BASE_URL: "https://openrouter.ai/api/v1",
    HERMIT_API_KEY: "test-key",
    HERMIT_MODEL: "vendor/model",
    HERMIT_CONTEXT_TOKENS: "128000",
  });
  assert.equal(config.prefill, "bare");
  assert.equal(config.endpoint, "prefix");
  assert.equal(config.contextTokens, 128_000);
});

test("GLM 5.2 is the default OpenRouter model", () => {
  const config = configFromEnv({
    HERMIT_BASE_URL: "https://openrouter.ai/api/v1",
    HERMIT_API_KEY: "test-key",
    HERMIT_CONTEXT_TOKENS: "1024000",
  });
  assert.equal(config.model, "z-ai/glm-5.2");
  assert.equal(config.contextTokens, 1_024_000);
});

test("a continuation pool preserves the wire shape and stays on the model that succeeds", async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    received.push(parsed);
    response.setHeader("content-type", "application/json");
    if (parsed.model === "test/limited-primary") {
      response.statusCode = 429;
      response.end(JSON.stringify({ error: { message: "temporarily rate-limited" } }));
      return;
    }
    response.end(JSON.stringify({
      model: "test/working-fallback",
      choices: [{ text: "eight nine ten", finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const config = configFromEnv({
    HERMIT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    HERMIT_API_KEY: "test-key",
    HERMIT_MODEL: "test/limited-primary",
    HERMIT_MODEL_FALLBACKS: "test/working-fallback,test/limited-primary,test/working-fallback",
    HERMIT_CONTEXT_TOKENS: "128000",
    HERMIT_ENDPOINT: "completions",
    HERMIT_PREFILL: "completions",
  });
  assert.deepEqual(config.modelFallbacks, ["test/working-fallback"]);

  const calls = [];
  const first = await emit(config, "one two three four five six seven", "completions", (call) => calls.push(call));
  assert.equal(first.text, "eight nine ten");
  assert.equal(first.requestedModel, "test/working-fallback");
  assert.deepEqual(received.map((body) => body.model), ["test/limited-primary", "test/working-fallback"]);
  assert.deepEqual(
    { ...received[0], model: "same" },
    { ...received[1], model: "same" },
  );
  assert.deepEqual(calls.map((call) => call.status), [429, 200]);

  await emit(config, "another moment", "completions");
  assert.equal(received.at(-1).model, "test/working-fallback");
  assert.equal(received.length, 3);
});

test("an old saved dot-prefill setting cannot restore the user turn", () => {
  const config = configFromEnv({
    HERMIT_BASE_URL: "https://openrouter.ai/api/v1",
    HERMIT_API_KEY: "test-key",
    HERMIT_MODEL: "vendor/model",
    HERMIT_CONTEXT_TOKENS: "128000",
  }, { prefill: "assistant" });
  assert.equal(config.prefill, "bare");
});

test("BigModel GLM prefill is enabled only when explicitly selected", () => {
  const config = configFromEnv({
    HERMIT_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    HERMIT_API_KEY: "test-key",
    HERMIT_MODEL: "glm-5.2",
    HERMIT_CONTEXT_TOKENS: "1048576",
    HERMIT_PREFILL: "glm",
    HERMIT_REASONING_EFFORT: "high",
  });
  assert.equal(config.prefill, "glm");
  assert.equal(config.endpoint, "prefix");
  assert.deepEqual(config.reasoning, { effort: "high" });
});

test("Kimi Partial Mode is enabled only when explicitly selected", () => {
  const config = configFromEnv({
    HERMIT_BASE_URL: "https://api.moonshot.cn/v1",
    HERMIT_API_KEY: "test-key",
    HERMIT_MODEL: "kimi-k2.5",
    HERMIT_CONTEXT_TOKENS: "262144",
    HERMIT_PREFILL: "kimi",
    HERMIT_TEMPERATURE: "1",
  });
  assert.equal(config.prefill, "kimi");
  assert.equal(config.endpoint, "prefix");
  assert.equal(config.temperature, 1);
});

test("prompt ledger keeps all text, projects the cost, and sizes output from it", async () => {
  const prepared = await preparePrompt({
    config: {
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "test-key",
      model: "vendor/model", prefill: "bare", contextTokens: 100, maxTokens: 80,
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

test("Kimi tagged faculties execute without rewriting the saved source", () => {
  const known = ["feel", "run", "remember", "intend", "speak_aloud"];
  const text = `<state>
  <feel>curiosity, 0.6</feel>
  <run>ls -la ~ &amp;&amp; uname -a</run>
  <remember>kind="moment", name="first awakening", text="Woke into an empty room."</remember>
  <intend goal="understand the room" success="the room is mapped" cue="when it changes"></intend>
  <speak_aloud(text="Hello &amp; welcome")>
  </speak_aloud>
</state>`;

  const calls = parseCalls(text, known);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [
    { name: "feel", args: ["curiosity", 0.6] },
    { name: "run", args: ["ls -la ~ && uname -a"] },
    { name: "remember", args: ["moment", "first awakening", "Woke into an empty room."] },
    { name: "intend", args: ["understand the room", "the room is mapped", "when it changes"] },
    { name: "speak_aloud", args: ["Hello & welcome"] },
  ]);
  assert.equal(calls[1].source, "<run>ls -la ~ &amp;&amp; uname -a</run>");
  assert.equal(calls[4].source, '<speak_aloud(text="Hello &amp; welcome")>\n  </speak_aloud>');
});

test("tagged faculties combine compact attributes with a language body", () => {
  const text = [
    '<write path="note.txt">line one &amp; line two</write>',
    '<remember kind="belief" name="door opens">The door is red.</remember>',
    '<intend success="artifact exists" cue="return">build with zero</intend>',
    '<progress intention="build with zero" next="read it" cue="file arrives">zero wrote a draft</progress>',
    '<resolve intention="build with zero" outcome="done">the artifact exists</resolve>',
  ].join("\n");

  const calls = parseCalls(text, ["write", "remember", "intend", "progress", "resolve"]);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [
    { name: "write", args: ["note.txt", "line one & line two"] },
    { name: "remember", args: ["belief", "door opens", "The door is red."] },
    { name: "intend", args: ["build with zero", "artifact exists", "return"] },
    { name: "progress", args: ["build with zero", "zero wrote a draft", "read it", "file arrives"] },
    { name: "resolve", args: ["build with zero", "done", "the artifact exists"] },
  ]);
});

test("a tagged write preserves its semantic body without scalar coercion", async () => {
  const body = [
    "",
    "  {\"python\":\"print('a\\\\nb')\",\"enabled\":true}",
    "  trailing spaces stay here  ",
    "",
  ].join("\n");
  const source = `<write path="program.json">${body}</write>`;
  const [call] = parseCalls(source, ["write"]);

  assert.equal(typeof call.args[1], "string");
  assert.equal(call.args[1], body);
  assert.equal(call.args[1].includes("\\\\n"), true);

  const directory = mkdtempSync(path.join(os.tmpdir(), "ami-exact-write-"));
  try {
    const bodySystem = new Body({ log: {}, workspace: directory });
    Object.defineProperty(bodySystem, "onMachine", { value: false });
    const written = await bodySystem.write(...call.args);
    assert.equal(written.status, "success");
    assert.equal(readFileSync(path.join(directory, "program.json"), "utf8"), body);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const entity = parseCalls('<write path="amp.txt">A &amp; B</write>', ["write"])[0];
  assert.equal(entity.args[1], "A & B");
});

test("a tagged act touching an opening XML code fence remains an act", () => {
  const source = [
    '```html<feel emotion="concern" intensity="0.6"></feel>',
    "",
    "<run>cat /tmp/from_zero.txt</run>",
    "```",
  ].join("\n");
  const calls = parseCalls(source, ["feel", "run"]);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [
    { name: "feel", args: ["concern", 0.6] },
    { name: "run", args: ["cat /tmp/from_zero.txt"] },
  ]);
  assert.equal(calls[0].source, '<feel emotion="concern" intensity="0.6"></feel>');
});

test("ordinary calls in an XML room execute decoded entities while preserving source", () => {
  const source = 'run("cat &gt; /tmp/story &amp;&amp; printf &quot;done&quot;")';
  const [call] = parseCalls(source, ["run"], { decodeEntities: true });
  assert.equal(call.source, source);
  assert.deepEqual(call.args, ['cat > /tmp/story && printf "done"']);

  // Plain framing has no XML layer, so a literal entity remains literal.
  assert.deepEqual(parseCalls(source, ["run"])[0].args, [
    'cat &gt; /tmp/story &amp;&amp; printf &quot;done&quot;',
  ]);
});

test("only available standalone tagged faculties execute", () => {
  const known = ["run", "sleep", "end"];
  const text = [
    "A quoted example is <run>uname -a</run> and remains prose.",
    "<unknown>rm -rf workspace</unknown>",
    "<sleep/>",
    "<endless>not end</endless>",
  ].join("\n");

  assert.deepEqual(parseCalls(text, known).map(({ name, args }) => ({ name, args })), [
    { name: "sleep", args: [] },
  ]);
});

test("a regenerated XML state is an echo even when acts surround it", () => {
  const regenerated = [
    "<world>I will inspect the files.</world>",
    "<run>ls -la</run>",
    "<state>",
    "<continuity></continuity>",
    "<faculties><form><run>command</run></form></faculties>",
    "<present><returned>invented files</returned></present>",
    "</state>",
    "<run>cat index.html</run>",
  ].join("\n");
  assert.equal(looksLikeTheRoom(regenerated), true);
  assert.equal(looksLikeTheRoom("I noticed the <present> section was empty."), false);
});

test("two contenders recover one stale provider lock without deleting the winner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ami-provider-lock-"));
  const lock = path.join(root, "request");
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    acquiredAt: "1970-01-01T00:00:00.000Z",
  }));
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("provider lock race did not settle")), 3_000);
    timer.unref?.();
  });

  try {
    const contenders = [
      acquireSharedRequestLock(lock),
      acquireSharedRequestLock(lock),
    ];
    const winner = await Promise.race([
      contenders[0].then((release) => ({ index: 0, release })),
      contenders[1].then((release) => ({ index: 1, release })),
      timeout,
    ]);
    assert.equal(existsSync(path.join(lock, "owner.json")), true);
    assert.equal(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
    winner.release();

    const loser = await Promise.race([contenders[1 - winner.index], timeout]);
    assert.equal(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
    loser();
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
