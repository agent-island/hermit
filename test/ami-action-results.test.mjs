import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("every affordance returns only the success-or-failed contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-action-results-"));
  process.env.HERMIT_MAIL_FILE = path.join(directory, "letters.json");
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
    get(key, fallback) { return key === "setup_v2" ? { scaffoldVersion: 4, format: "faculties", intention: true } : fallback; },
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
      await body.run("inner_speech", ["inside"]),
      await body.run("inner_speech", [""]),
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
    assert.equal(body.formNames().includes("inner_speech"), true);
    // Hidden only for continuity with an existing life.
    assert.equal(body.formNames().includes("think"), true);
    assert.equal(body.formNames().includes("identify"), false);
    assert.equal(body.formNames().includes("speak_aloud"), true);
    assert.equal(body.formNames().includes("speak"), false);
    assert.deepEqual(body.affordances().find(([form]) => form === "<inner_speech>text</inner_speech>"), ["<inner_speech>text</inner_speech>", ""]);
    assert.deepEqual(body.affordances().find(([form]) => form === "<speak_aloud>text</speak_aloud>"), ["<speak_aloud>text</speak_aloud>", ""]);
    assert.equal(body.affordances().some(([form]) => form.includes("identify")), false);
    assert.deepEqual(body.affordances().find(([form]) => form === '<remember kind="kind" name="name">text</remember>'), [
      '<remember kind="kind" name="name">text</remember>',
      "keeps text as an active memory named name",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === '<revise name="name">text</revise>'), ['<revise name="name">text</revise>', "the earlier wording stays in the record"]);
    assert.deepEqual(body.affordances().find(([form]) => form === '<intend name="name" success="success" cue="cue" under="under">goal</intend>'), [
      '<intend name="name" success="success" cue="cue" under="under">goal</intend>',
      "keeps goal active under name until resolved; under names its parent intention",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === '<progress intention="intention" next="next" cue="cue">evidence</progress>'), [
      '<progress intention="intention" next="next" cue="cue">evidence</progress>',
      "",
    ]);
    assert.deepEqual(body.affordances().find(([form]) => form === '<resolve intention="intention" outcome="outcome">evidence</resolve>'), ['<resolve intention="intention" outcome="outcome">evidence</resolve>', ""]);

    // Old, plain rooms retain the function notation, so archived responses and
    // deliberately plain experiments remain reproducible.
    const plainLog = { ...log, get(key, fallback) { return key === "setup_v2" ? { format: "plain", intention: true } : fallback; } };
    const plainBody = new Body({ log: plainLog, workspace: path.join(directory, "plain-workspace") });
    assert.deepEqual(plainBody.affordances().find(([form]) => form === "inner_speech(text)"), ["inner_speech(text)", ""]);
    assert.equal((await plainBody.run("think", ["historical words"])).status, "success");
    assert.equal(plainBody.formNames().includes("think"), true);
    const withoutPeer = new Body({ log, workspace: path.join(directory, "workspace") });
    const notDelivered = await withoutPeer.run("speak_aloud", ["anyone?"]);
    assert.equal(notDelivered.status, "failed");
    assert.match(notDelivered.reason, /no other living agent/);
    assert.equal((await body.run("message", ["friend", "hi"])).status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
