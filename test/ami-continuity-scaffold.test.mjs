import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Loop } from "../loop.mjs";
import { cueMatches, latentMemoryLines, selectForegroundMemory } from "../memory-state.mjs";
import { DEFAULT_SETUP } from "../setup.mjs";
import { renderWorld } from "../world.mjs";

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
    affordances() { return [["think(text)", "thought <inside> & recorded"]]; },
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
  assert.equal(document.querySelector("heard").textContent.includes("hello </heard> & still text"), true);
  assert.equal(document.querySelector("last").textContent.includes("prior </last> & words"), true);
  assert.equal(document.querySelector("ran").getAttribute("cmd"), "printf '<x>&'");
  assert.equal(document.querySelector("ran").textContent.includes("<machine>&output"), true);
});

test("cued durable memory moves between latent availability and foreground", () => {
  const episode = { id: 1, kind: "action", state: "active", meta: { name: "read" }, fact: "read the note" };
  const belief = {
    id: 2, kind: "memory", state: "active", content: "The workspaces are separate.",
    meta: { mental: "belief", authored: true, cue: "trace file contradiction" },
  };
  const resolved = {
    id: 3, kind: "memory", state: "active", content: "map the room",
    meta: { mental: "intention", intention: true, authored: true, resolution: { outcome: "done" } },
  };

  assert.equal(cueMatches("trace file contradiction", "trace.txt now contradicts the earlier file"), true);
  assert.equal(cueMatches("trace file contradiction", "ordinary unrelated message"), false);

  const quiet = selectForegroundMemory([episode, belief, resolved], "ordinary unrelated message");
  assert.deepEqual(quiet.foreground.map((one) => one.id), [1]);
  assert.deepEqual(quiet.latent.map((one) => one.id), [2, 3]);
  assert.deepEqual(latentMemoryLines(quiet.latent), [
    '<available kind="belief" count="1"/>',
    '<available kind="intention" count="1"/>',
  ]);

  const triggered = selectForegroundMemory([episode, belief, resolved], "trace.txt contains a file contradiction");
  assert.deepEqual(triggered.foreground.map((one) => one.id), [1, 2]);
  assert.deepEqual(triggered.latent.map((one) => one.id), [3]);
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
