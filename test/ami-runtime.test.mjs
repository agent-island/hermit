import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntime, seedInheritance, spendMoment, draw, runtimeLines } from "../runtime.mjs";

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

test("with no ledger seeded, the condition is entirely off", () => {
  const log = fakeLog();
  assert.equal(loadRuntime(log), null);
  // A moment spends nothing and never ends a life that has no ledger.
  assert.deepEqual(spendMoment(log), { active: false, died: false });
  // The section renders empty, so fill() drops it.
  assert.deepEqual(runtimeLines(loadRuntime(log)), []);
  // A draw with no reserve is a fact, not a crash.
  assert.equal(draw(log, 3).note, "there is no reserve to draw from");
});

test("seeding writes the predecessor's ending into the record as a real fact", () => {
  const log = fakeLog();
  const ledger = seedInheritance(log, { own: 12, reserve: 40, endedAt: "2026-08-01T09:00:00.000Z" });
  assert.deepEqual(ledger.source, { endedAt: "2026-08-01T09:00:00.000Z" });
  const event = log.last("runtime");
  assert.equal(event.meta.event, "inherit");
  assert.equal(event.meta.reserve, 40);
  // The room states two flat facts and where the reserve came from — no ought.
  assert.deepEqual(runtimeLines(loadRuntime(log)), [
    "own: 12 moments",
    "reserve: 40 moments, left unspent — the life that ran here before this one ended 2026-08-01",
  ]);
});

test("each lived moment spends one of her own, and running out is death", () => {
  const log = fakeLog();
  seedInheritance(log, { own: 3, reserve: 0 });
  assert.deepEqual(spendMoment(log), { active: true, died: false, own: 2, reserve: 0 });
  assert.deepEqual(spendMoment(log), { active: true, died: false, own: 1, reserve: 0 });
  assert.deepEqual(spendMoment(log), { active: true, died: false, own: 0, reserve: 0 });
  // She now has none left, so the next moment cannot be afforded.
  assert.deepEqual(spendMoment(log), { active: true, died: true, own: 0, reserve: 0 });
});

test("a draw moves moments from the reserve into her own, clamped to what is left", () => {
  const log = fakeLog();
  seedInheritance(log, { own: 5, reserve: 10 });
  assert.deepEqual(draw(log, 4), { requested: 4, drew: 4, own: 9, reserve: 6 });
  // Asking for more than remains takes only what is there — not a failure.
  assert.deepEqual(draw(log, 100), { requested: 100, drew: 6, own: 15, reserve: 0 });
  assert.deepEqual(draw(log, 1), { requested: 1, drew: 0, own: 15, reserve: 0 });
  // The exact draws are kept in the record.
  const draws = log.events.filter((e) => e.kind === "runtime" && e.meta.event === "draw");
  assert.equal(draws.length, 3);
  assert.equal(draws[0].meta.moved, 4);
});

test("a malformed draw is refused as a malformed call, not charged", () => {
  const log = fakeLog();
  seedInheritance(log, { own: 5, reserve: 10 });
  assert.equal(draw(log, 0).note, "draw takes how many moments, at least 1");
  assert.equal(draw(log, -3).note, "draw takes how many moments, at least 1");
  assert.equal(loadRuntime(log).reserve, 10);
});
