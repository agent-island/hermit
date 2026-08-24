import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.mjs";
import { readTick } from "../tick.mjs";

test("sleep takes no parameter and rests for the configured duration", async () => {
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
  const result = await body.run("sleep", [300, "ignored reason"]);

  assert.equal(result.seconds, 10);
  assert.equal("returning_for" in result, false);
  assert.equal(values.get("wake_why"), "");
  assert.ok(new Date(result.until).getTime() >= before + 9_000);
  assert.ok(new Date(result.until).getTime() <= before + 11_000);
  assert.deepEqual(body.affordances().find(([form]) => form.startsWith("sleep")), [
    "sleep()", "rests for 10 seconds",
  ]);
});

test("sleep can be removed without creating a hidden time-driven continuation", async () => {
  const values = new Map([["setup_v2", { sleepEnabled: false, gapSeconds: 30 }]]);
  const body = new Body({
    log: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      set(key, value) { values.set(key, value); },
    },
    workspace: "",
  });

  assert.equal(body.formNames().includes("sleep"), false);
  assert.equal((await body.run("sleep", [])).status, "failed");
});

test("the retired heartbeat parser remains reproducible for historical records", () => {
  for (const answer of ["rest", "rest 300 seconds", "sleep for 7200", "wait 5"]) {
    assert.equal(readTick(answer).seconds, 60);
    assert.equal(readTick(answer).wake, false);
  }
  assert.equal(readTick("a moment now").wake, true);
});
