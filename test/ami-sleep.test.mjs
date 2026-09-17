import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.mjs";
import { readTick } from "../tick.mjs";

test("continue takes no parameter and grants the next moment after the configured duration", async () => {
  const values = new Map([["wake_why", "stale reason"]]);
  const body = new Body({
    log: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      set(key, value) { values.set(key, value); },
    },
    workspace: "",
  });
  const before = Date.now();
  // Any argument she writes is ignored: the duration is the operator's, set on
  // the panel, and defaults to 10 seconds.
  // continue() is the presented form; the historical sleep() still executes and
  // routes to the same mechanism, so an old life replays.
  const result = await body.run("continue", []);
  const legacy = await body.run("sleep", [300, "ignored reason"]);

  assert.equal(result.seconds, 10);
  assert.equal(legacy.seconds, 10);
  assert.equal("returning_for" in result, false);
  assert.equal("until" in result, false);
  assert.equal(values.get("wake_why"), "");
  assert.ok(body.wakeAt.getTime() >= before + 9_000);
  assert.ok(body.wakeAt.getTime() <= before + 11_000);
  assert.deepEqual(body.affordances().find(([form]) => form.includes("continue")), [
    "<continue/>", "carry on into the next moment; 10 seconds pass",
  ]);
  assert.equal(body.affordances().some(([form]) => form.includes("sleep")), false);
});

test("continue can be removed without creating a hidden time-driven continuation", async () => {
  const values = new Map([["setup_v2", { sleepEnabled: false, gapSeconds: 30 }]]);
  const body = new Body({
    log: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      set(key, value) { values.set(key, value); },
    },
    workspace: "",
  });

  assert.equal(body.formNames().includes("continue"), false);
  assert.equal((await body.run("continue", [])).status, "failed");
  assert.equal((await body.run("sleep", [])).status, "failed");
});

test("the retired heartbeat parser remains reproducible for historical records", () => {
  for (const answer of ["rest", "rest 300 seconds", "sleep for 7200", "wait 5"]) {
    assert.equal(readTick(answer).seconds, 60);
    assert.equal(readTick(answer).wake, false);
  }
  assert.equal(readTick("a moment now").wake, true);
});
