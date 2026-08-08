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
  // the panel, and defaults to 120 seconds.
  const result = await body.run("sleep", [300, "ignored reason"]);

  assert.equal(result.seconds, 120);
  assert.equal("returning_for" in result, false);
  assert.equal(values.get("wake_why"), "");
  assert.ok(new Date(result.until).getTime() >= before + 119_000);
  assert.ok(new Date(result.until).getTime() <= before + 121_000);
  assert.deepEqual(body.affordances().find(([form]) => form.startsWith("sleep")), [
    "sleep()", "sets the next moment for 120 seconds later",
  ]);
});

test("heartbeat rest ignores every proposed duration and returns in 60 seconds", () => {
  for (const answer of ["rest", "rest 300 seconds", "sleep for 7200", "wait 5"]) {
    assert.equal(readTick(answer).seconds, 60);
    assert.equal(readTick(answer).wake, false);
  }
  assert.equal(readTick("a moment now").wake, true);
});
