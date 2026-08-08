import assert from "node:assert/strict";
import test from "node:test";
import {
  actionFact,
  emptyMemoryState,
  followingState,
  isMemoryTransition,
  memoryState,
  projectMemory,
  transitionMemory,
} from "../memory-state.mjs";

function row(id, kind, meta = {}, content = "") {
  return { id, kind, meta, content, at: `2026-08-02T00:00:${String(id).padStart(2, "0")}.000Z` };
}

test("email memory states only the real outcome and excludes the body", () => {
  const body = "the complete private body must remain only in the exact record";
  const action = { name: "email", args: ["meryl@example.com", "Ladakh follow-up", body] };
  const stored = actionFact(action, {
    yielded: true,
    value: { status: "success", to: "meryl@example.com", subject: "Ladakh follow-up", stored: "local" },
  });
  const failed = actionFact(action, {
    yielded: false,
    value: { note: "the mail service was unavailable" },
  });

  assert.equal(stored, 'stored local letter addressed to "meryl@example.com"; subject "Ladakh follow-up"');
  assert.doesNotMatch(stored, /complete private body/);
  assert.match(failed, /did not complete/);
  assert.doesNotMatch(failed, /stored local letter/);
});

test("the reference state machine preserves shelf, consolidation, recall, and rewind semantics", () => {
  const events = [
    row(1, "action", { name: "email", args: ["friend@example.com", "hello", "body"] }, 'email("friend@example.com", "hello", "body")'),
    row(2, "result", {
      action: 1,
      yielded: true,
      value: { status: "success", to: "friend@example.com", subject: "hello", stored: "local" },
      // Deliberately stale metadata: projection must use the current factual
      // contract rather than perpetuate this historical overclaim.
      fact: 'sent email to "friend@example.com"; subject "hello"',
    }),
    row(3, "memory", { sources: [1] }, "Reaching outward became a deliberate choice."),
    row(4, "shelf", { target: 1, by: 3 }, "unit #1"),
    row(5, "recall", { target: 1 }),
    row(6, "shelf", { target: 3 }, "unit #3"),
  ];

  const afterAction = memoryState(events.slice(0, 2));
  assert.deepEqual(followingState(afterAction).map((unit) => unit.id), [1]);
  assert.match(afterAction.units.get(1).fact, /stored local letter/);
  assert.doesNotMatch(afterAction.units.get(1).fact, /sent email/);

  const afterConsolidation = memoryState(events.slice(0, 5));
  assert.equal(afterConsolidation.units.get(1).state, "shelved");
  assert.equal(afterConsolidation.units.get(1).by, 3);
  assert.equal(afterConsolidation.units.get(3).state, "active");
  assert.deepEqual(followingState(afterConsolidation).map((unit) => unit.id), [3]);

  const afterMemoryShelf = memoryState(events);
  assert.deepEqual(followingState(afterMemoryShelf), []);

  // Rewind is reduction of the surviving exact prefix, not an inverse guess.
  const rewound = memoryState(events.slice(0, 2));
  assert.equal(rewound.units.get(1).state, "active");
  assert.equal(rewound.units.has(3), false);
});

test("all short transition sequences preserve state exclusivity and recall is read-only", () => {
  const action = row(1, "action", { name: "read", args: ["note.txt"] });
  const result = row(2, "result", {
    action: 1, yielded: true, value: { path: "note.txt", text: "hello" },
  });
  const operations = [
    row(3, "shelf", { target: 1 }),
    row(4, "memory", { sources: [1] }, "I read the note."),
    row(5, "shelf", { target: 4 }),
    row(6, "recall", { target: 1 }),
  ];

  const sequences = [[]];
  for (let depth = 0; depth < 4; depth += 1) {
    for (const prefix of sequences.filter((one) => one.length === depth)) {
      for (const operation of operations) sequences.push([...prefix, operation]);
    }
  }
  for (const sequence of sequences) {
    const state = memoryState([action, result, ...sequence]);
    for (const unit of state.units.values()) assert.ok(["active", "shelved"].includes(unit.state));
    assert.ok(followingState(state).every((unit) => unit.state === "active"));

    const beforeRecall = sequence.reduce(transitionMemory, memoryState([action, result]));
    const afterRecall = transitionMemory(beforeRecall, row(99, "recall", { target: 1 }));
    assert.deepEqual([...afterRecall.units.entries()], [...beforeRecall.units.entries()]);
  }
});

test("projection includes every active unit and reports the token ledger", () => {
  const state = emptyMemoryState();
  for (let id = 1; id <= 5; id += 1) {
    state.units.set(id, {
      id, kind: "action", state: "active", fact: `completed consequential action number ${id}`,
    });
  }
  const active = followingState(state);
  const projection = projectMemory(active, { maintained: 73, capacity: 1_000_000 });

  assert.equal(active.length, 5);
  assert.equal(projection.shown, 5);
  assert.equal(projection.hidden, 0);
  assert.ok(projection.lines.includes("maintained: 73 tokens"));
  assert.ok(projection.lines.includes("remains: 999,927 tokens"));
  // Each active unit shows by its content, not a leading unit number: a mind
  // carries the thing, not "#1". The number stays the record's private key.
  for (let id = 1; id <= 5; id += 1) {
    assert.ok(projection.lines.includes(`completed consequential action number ${id}`));
  }
  assert.doesNotMatch(projection.lines.join("\n"), /#\d/);
  assert.equal(followingState(state).length, 5);
});

test("memory-management transitions do not create a recursive active episode", () => {
  for (const name of ["recall", "shelve", "consolidate"]) assert.equal(isMemoryTransition(name), true);
  assert.equal(isMemoryTransition("email"), false);

  const events = [
    row(1, "action", { name: "shelve", args: [8] }),
    row(2, "result", { action: 1, yielded: true, value: { unit: 8, state: "shelved" } }),
  ];
  assert.deepEqual(followingState(memoryState(events)), []);
});
