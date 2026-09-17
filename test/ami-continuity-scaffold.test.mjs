import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Body } from "../body.mjs";
import { Loop } from "../loop.mjs";
import { selectForegroundMemory, shelvedLines } from "../memory-state.mjs";
import { DEFAULT_SETUP } from "../setup.mjs";
import { ROOM } from "../voice.mjs";
import { expandScaffold, renderWorld } from "../world.mjs";

test("the runtime scaffold matches the operator-audited scaffold.xml", () => {
  const audited = readFileSync(new URL("../../scaffold.xml", import.meta.url), "utf8");
  const log = { get(_key, fallback) { return fallback; } };
  const body = new Body({ log, workspace: "" });
  const expanded = expandScaffold(ROOM, body.affordances());
  assert.equal(expanded.trim(), audited.trim());
});

test("the tagged state is well-formed XML and dynamic text cannot become structure", () => {
  const memory = {
    id: 1,
    kind: "memory",
    state: "active",
    content: "A <belief> & its evidence remain text.",
    meta: { mental: "belief", authored: true },
  };
  const log = {
    get(_key, fallback) { return fallback; },
    followingMemories() { return [memory]; },
    activeMemories() { return [memory]; },
    currentIdentity() { return { content: "I contain <words> & questions." }; },
    activeIntentions() {
      return [{ content: "inspect <result>", meta: { success: "evidence & answer", cue: "a new <result>" } }];
    },
    shelfLabels() { return []; },
  };
  const body = {
    affordances() { return [["<inner_speech>text</inner_speech>", "inner speech <inside> & recorded"]]; },
  };
  const world = renderWorld({
    now: new Date("2026-08-24T00:00:00.000Z"),
    previousAt: null,
    body,
    log,
    setup: DEFAULT_SETUP,
    incoming: [{ at: "2026-08-24T00:00:00.000Z", content: "hello </heard> & still text", meta: { from: "<peer>" } }],
    results: [{ call: 'run("printf \'<x>&\'")', value: "<machine>&output" }],
    previous: { id: 9, content: "prior </last> & words" },
    files: [{ name: "<note>&.txt" }],
  });

  const document = new JSDOM(world, { contentType: "application/xml" }).window.document;
  assert.equal(document.querySelector("parsererror"), null);
  assert.equal(document.documentElement.tagName, "state");
  assert.equal(document.querySelector("time"), null);
  assert.equal(document.querySelector("elapsed"), null);
  assert.deepEqual(
    [...document.querySelector("continuity").children].map((element) => element.tagName),
    ["intentions", "memory", "shelved"],
  );
  assert.equal(document.querySelector("identity"), null);
  assert.equal(world.includes("I contain"), false);
  assert.equal(document.querySelector("heard").textContent.includes("hello </heard> & still text"), true);
  assert.equal(document.querySelector("last").textContent.includes("prior </last> & words"), true);
  assert.equal(document.querySelector("ran").getAttribute("cmd"), "printf '<x>&'");
  assert.equal(document.querySelector("ran").textContent.includes("<machine>&output"), true);
  assert.equal(document.querySelector("faculties > form > inner_speech").textContent, "text");
  assert.equal(document.querySelector("faculties > effect").textContent, "inner speech <inside> & recorded");
  assert.equal(world.includes("&lt;form&gt;"), false);
  assert.equal(world.includes("&lt;effect&gt;"), false);
});

test("every active unit is present — nothing evicts, nothing recedes on its own", () => {
  const episode = { id: 1, kind: "action", state: "active", meta: { name: "read" }, fact: "read the note" };
  const belief = {
    id: 2, kind: "memory", state: "active", content: "The workspaces are separate.",
    meta: { mental: "belief", authored: true, cue: "trace file contradiction" },
  };
  const old = {
    id: 3, kind: "action", state: "active", fact: "an episode from long ago",
    meta: { name: "run", args: [] },
  };

  // No present string, no token budget, no cue gate: the whole active set is
  // foreground regardless of what the present happens to contain, and there is
  // never a latent, receded-on-its-own layer.
  const selected = selectForegroundMemory([episode, belief, old]);
  assert.deepEqual(selected.foreground.map((one) => one.id), [1, 2, 3]);
  assert.deepEqual(selected.latent, []);

  const quiet = selectForegroundMemory([episode, belief, old]);
  assert.deepEqual(quiet.foreground.map((one) => one.id), [1, 2, 3]);
  assert.deepEqual(quiet.latent, []);
});

test("the shelved index lists every shelved name, restorable by name", () => {
  assert.deepEqual(shelvedLines([]), []);
  assert.deepEqual(
    shelvedLines(["vector: host-mounts", "the map pact with zero"]),
    ['<shelved name="vector: host-mounts"/>', '<shelved name="the map pact with zero"/>'],
  );
  // A name carrying XML metacharacters stays text, never structure.
  assert.deepEqual(
    shelvedLines(['a <lead> & "quote"']),
    ['<shelved name="a &lt;lead&gt; &amp; &quot;quote&quot;"/>'],
  );
});

test("the scheduler continues activity, honours explicit rest, and otherwise becomes idle", () => {
  const events = [];
  const log = {
    file: "/tmp/continuity-test/ami.sqlite",
    append(kind, content, meta) { events.push({ kind, content, meta }); },
    get(key, fallback) {
      if (key === "setup_v2") return { ...DEFAULT_SETUP, gapSeconds: 60 };
      return fallback;
    },
  };
  const body = { wakeAt: null };
  const loop = new Loop({ log, body, config: { model: "test" }, workspace: "", observer: {} });
  loop.running = true;

  loop.continueAfterMoment = false;
  loop.scheduleNext();
  assert.equal(loop.timer, null);
  assert.equal(loop.nextWakeAt, null);
  assert.equal(events.at(-1).kind, "idle");

  loop.continueAfterMoment = true;
  loop.scheduleNext();
  assert.ok(loop.timer);
  assert.equal(events.at(-1).kind, "sleep");
  assert.equal(events.at(-1).meta.chosen, false);
  clearTimeout(loop.timer);
  loop.timer = null;

  body.wakeAt = new Date(Date.now() + 20_000);
  loop.continueAfterMoment = false;
  loop.scheduleNext();
  assert.ok(loop.timer);
  assert.equal(events.at(-1).meta.chosen, true);
  clearTimeout(loop.timer);
  loop.timer = null;
  loop.running = false;
});

test("incoming speech cannot cancel provider backoff", () => {
  const events = [];
  const log = {
    file: "/tmp/continuity-backoff-test/ami.sqlite",
    append(kind, content, meta) { events.push({ kind, content, meta }); },
    get(_key, fallback) { return fallback; },
  };
  const loop = new Loop({
    log,
    body: { wakeAt: null },
    config: { model: "test" },
    workspace: "",
    observer: {},
  });
  loop.running = true;
  loop.failures = 1;
  loop.wakeAtOnce = true;

  loop.scheduleNext();
  const retryTimer = loop.timer;
  assert.ok(retryTimer);
  assert.equal(loop.wakeAtOnce, false);
  assert.equal(events.at(-1).kind, "sleep");
  assert.equal(events.at(-1).meta.backoff, 1);

  let immediateCalls = 0;
  loop.moment = () => { immediateCalls += 1; };
  loop.interrupt();
  assert.equal(loop.timer, retryTimer);
  assert.equal(immediateCalls, 0);

  clearTimeout(loop.timer);
  loop.timer = null;
  loop.running = false;
});
