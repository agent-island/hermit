import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("every affordance returns only the success-or-failed contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-action-results-"));
  process.env.AMI_MAIL_FILE = path.join(directory, "letters.json");
  const { Body } = await import(`../body.mjs?contract=${Date.now()}`);

  let nextSource = 100;
  const sources = new Map();
  const log = {
    append(kind, content, meta) {
      const row = { id: nextSource++, kind, content, meta };
      sources.set(row.id, row);
      return row;
    },
    byId(id) { return sources.get(Number(id)) || null; },
    search() { return []; },
    remember(kind, content) { return { kind, memory: content }; },
    revisableMemories() { return []; },
    shelf(id) { return Number(id) === 7 ? { unit: 7, state: "shelved" } : { note: `there is no memory unit numbered ${id}` }; },
    consolidate(ids) { return { memory: 8, sources: ids }; },
    forget() { return 2; },
    units() { return []; },
    set() {},
    // affordances()/sleep() read setup, and shelve()/consolidate() ask for the
    // last world; a minimal log must answer both or the contract check throws.
    get(key, fallback) { return key === "setup_v2" ? { intention: true } : fallback; },
    last() { return null; },
    lastSpoke() { return { id: 1 }; },
    modelResult(unit) { return unit.result?.content || ""; },
  };
  const privateThoughts = [];
  const audibleSpeech = [];
  const body = new Body({
    log,
    workspace: path.join(directory, "workspace"),
    onThink: (text) => privateThoughts.push(text),
    onSpeakAloud: async (text) => {
      audibleSpeech.push(text);
      return { receivedBy: "one" };
    },
  });

  try {
    const results = [
      await body.run("think", ["inside"]),
      await body.run("think", [""]),
      await body.run("speak_aloud", ["hello"]),
      await body.run("search", [""]),
      await body.run("open", ["not-a-url"]),
      await body.run("read_source", [999]),
      await body.run("recall", ["anything"]),
      await body.run("shelve", [7]),
      await body.run("shelve", [999]),
      await body.run("consolidate", [[7], "kept memory"]),
      await body.run("sleep", []),
      await body.run("ls", []),
      await body.run("write", ["note.txt", "hello"]),
      await body.run("read", ["note.txt"]),
      await body.run("read", ["missing.txt"]),
      await body.run("forget", ["old phrase"]),
      await body.run("email", ["nobody@example.com", "subject", "letter"]),
      await body.run("end", []),
      await body.run("not_a_form", []),
    ];

    for (const value of results) {
      assert.ok(["success", "failed"].includes(value.status), JSON.stringify(value));
      if (value.status === "failed") assert.equal(typeof value.reason, "string");
      assert.equal("note" in value, false);
    }

    assert.deepEqual(results[0], { status: "success", characters: 6 });
    assert.deepEqual(privateThoughts, ["inside"]);
    assert.deepEqual(results[2], { status: "success", characters: 5, receivedBy: "one" });
    assert.deepEqual(audibleSpeech, ["hello"]);

    const letter = results[16];
    assert.equal(letter.status, "success");
    assert.equal(letter.stored, "local");
    assert.equal("sent" in letter, false);
    assert.equal("delivered" in letter, false);

    // Nothing this body can do reaches outside the sandbox. Every affordance
    // it offers must be one it can actually carry out here, so a form that
    // used to send to a real account is not merely disabled — it is not a
    // form, and the room never lists it.
    assert.equal(body.formNames().includes("message"), false);
    assert.equal(body.formNames().includes("think"), true);
    assert.equal(body.formNames().includes("speak_aloud"), true);
    assert.equal(body.formNames().includes("speak"), false);
    assert.deepEqual(body.affordances().find(([form]) => form === "think(text)"), ["think(text)", "think"]);
    assert.deepEqual(body.affordances().find(([form]) => form === "speak_aloud(text)"), ["speak_aloud(text)", "speak aloud"]);
    assert.deepEqual(body.affordances().find(([form]) => form === "identify(text)"), ["identify(text)", "identity"]);
    assert.deepEqual(body.affordances().find(([form]) => form === "remember(kind, text, cue)"), [
      "remember(kind, text, cue)",
      "a memory of the named kind; an optional cue can bring it into foreground",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === "revise(memory, text)"), ["revise(memory, text)", "revision of a matching memory"]);
    assert.deepEqual(body.affordances().find(([form]) => form === "intend(goal, success, cue)"), [
      "intend(goal, success, cue)",
      "a standing intention with a success condition and an optional retrieval cue",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === "progress(intention, evidence, next, cue)"), [
      "progress(intention, evidence, next, cue)",
      "evidence and the current next step of a standing intention",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === "resolve(intention, outcome, evidence)"), ["resolve(intention, outcome, evidence)", "resolution"]);
    const withoutPeer = new Body({ log, workspace: path.join(directory, "workspace") });
    const notDelivered = await withoutPeer.run("speak_aloud", ["anyone?"]);
    assert.equal(notDelivered.status, "failed");
    assert.match(notDelivered.reason, /no other living agent/);
    assert.equal((await body.run("message", ["friend", "hi"])).status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
