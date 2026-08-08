import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Log } from "../log.mjs";
import { Body } from "../body.mjs";
import { Loop } from "../loop.mjs";
import { DEFAULT_SETUP, DEFAULT_TEMPLATE, loadSetup } from "../setup.mjs";
import { renderWorld } from "../world.mjs";

async function withLog(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-memory-"));
  const log = new Log(path.join(directory, "events.sqlite"));
  try {
    await run(log, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("shelf keeps exact units recallable and keeps action with its result", async () => {
  await withLog((log) => {
    const incoming = log.append("incoming", "the red door", { from: "cy" });
    const thought = log.append("emission", "I should remember the door.");
    const action = log.append("action", 'read("door.txt")', { name: "read", args: ["door.txt"] });
    log.append("result", "path: door.txt\ntext: painted red", { name: "read", action: action.id });
    const oldAction = log.append("action", 'read("old.txt")', { name: "read", args: ["old.txt"] });
    log.append("result", "legacy result without an action pointer", { name: "read" });

    assert.equal(log.search(String(action.id))[0].result.content, "path: door.txt\ntext: painted red");
    assert.equal(log.search("painted red")[0].id, action.id);
    assert.equal(log.unit(oldAction.id).result.content, "legacy result without an action pointer");

    const shelvedIncoming = log.shelf(incoming.id);
    assert.equal(shelvedIncoming.state, "shelved");
    assert.equal(log.unanswered().length, 0);
    assert.equal(log.search("red door")[0].state, "shelved");

    log.shelf(action.id);
    assert.equal(log.unit(action.id).state, "shelved");
    assert.equal(log.unit(action.id).result.content, "path: door.txt\ntext: painted red");
    assert.equal(log.search(String(thought.id))[0].state, "active");

    log.append("world", "a new moment has begun");
    const unseen = log.append("emission", "this id did not exist when the moment began");
    assert.match(log.shelf(unseen.id).note, /not available/);
  });
});

test("consolidation folds real units, tolerates a stray id, and keeps provenance", async () => {
  await withLog((log) => {
    const first = log.append("incoming", "she chose the coast", { from: "friend" });
    const second = log.append("emission", "That choice was about freedom.");
    const beforeInvalid = log.count();
    // Tolerant, not all-or-nothing: a stray id that is not a memory unit is
    // skipped and named, while the real unit still folds — one bad number does
    // not cost her the whole consolidation. The DB write of the fold is atomic.
    const tolerated = log.consolidate([first.id, 999_999], "The stray id is skipped, not fatal.");
    assert.deepEqual(tolerated.sources, [first.id]);
    assert.deepEqual(tolerated.skipped, [999_999]);
    assert.equal(log.unit(tolerated.memory).content, "The stray id is skipped, not fatal.");
    // Undo that scratch fold so the checks below start from the clean state.
    log.rewind(second.id);
    assert.equal(log.unit(first.id).state, "active");
    assert.equal(log.count(), beforeInvalid);

    const made = log.consolidate([first.id, second.id], "The coast came to mean freedom.");
    assert.deepEqual(made.sources, [first.id, second.id]);
    assert.deepEqual(made.shelved, [first.id, second.id]);
    const memory = log.unit(made.memory);
    assert.equal(memory.content, "The coast came to mean freedom.");
    assert.deepEqual(memory.meta.sources, [first.id, second.id]);
    assert.equal(memory.state, "active");
    assert.deepEqual(log.activeMemories().map((row) => row.id), [memory.id]);

    const shelvedMemory = log.shelf(memory.id);
    assert.equal(log.activeMemories().length, 0);
    const remade = log.consolidate([memory.id], "Freedom now means choosing where to return.");
    assert.deepEqual(remade.sources, [memory.id]);
    assert.deepEqual(remade.shelved, []);
    assert.equal(log.unit(memory.id).state, "shelved");
    assert.equal(log.unit(remade.memory).state, "active");

    log.rewind(shelvedMemory.event - 1);
    assert.equal(log.unit(memory.id).state, "active");
    assert.equal(log.unit(remade.memory), null);
  });
});

test("consolidate folds the active episodic scratch into the note, sparing memories and process-acts", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    log.append("world", "a moment");
    const search = log.append("action", 'search("ebola")', { name: "search", args: ["ebola"] });
    log.append("result", "results…", { name: "search", action: search.id, value: { status: "success" }, yielded: true });
    const open = log.append("action", 'open("http://e.com")', { name: "open", args: ["http://e.com"] });
    log.append("result", "page…", { name: "open", action: open.id, value: { status: "success" }, yielded: true });
    const message = log.append("incoming", "a note from cy", { from: "cy" });
    const memory = log.append("memory", "an earlier durable memory", { sources: [] });
    const feel = log.append("action", 'feel("focus")', { name: "feel", args: ["focus"] });
    log.append("result", "felt", { name: "feel", action: feel.id, value: { status: "success" }, yielded: true });
    log.append("world", "next moment");

    const out = body.consolidate("The outbreak is spreading toward Kinshasa.");
    assert.equal(out.status, "success");
    // Her acts, their results, and the message — the working scratch — folded.
    assert.equal(out.kept, 3);
    // The note she wrote is now a durable memory.
    assert.ok(log.activeMemories().some((m) => m.content === "The outbreak is spreading toward Kinshasa."));
    // The scratch receded; her earlier memory and the feel() are left standing.
    assert.equal(log.unit(search.id).state, "shelved");
    assert.equal(log.unit(open.id).state, "shelved");
    assert.equal(log.unit(message.id).state, "shelved");
    assert.equal(log.unit(memory.id).state, "active");
    assert.equal(log.unit(feel.id).state, "active");

    // With the scratch gone, a second fold finds nothing to compress.
    assert.equal(body.consolidate("nothing left").status, "failed");
    // And it needs the note itself.
    assert.equal(body.consolidate("").status, "failed");
  });
});

test("conversation history omits shelved units and does not perpetuate recalled content", async () => {
  await withLog((log) => {
    log.append("world", "first room");
    const thought = log.append(
      "emission",
      'ordinary thought\nrecall("old fear")\nconsolidate([1], "private durable wording")',
    );
    const recall = log.append("action", 'recall("old fear")', { name: "recall", args: ["old fear"] });
    log.append("result", "SHELVED WORDS RETURNED ONCE", { name: "recall", action: recall.id });
    const consolidate = log.append("action", 'consolidate([1], "private durable wording")', {
      name: "consolidate", args: [[1], "private durable wording"],
    });
    log.append("result", "memory: 20", { name: "consolidate", action: consolidate.id });
    const read = log.append("action", 'read("note.txt")', { name: "read", args: ["note.txt"] });
    log.append("result", "ordinary returned fact", { name: "read", action: read.id });

    const loop = new Loop({
      log,
      body: { formNames: () => ["recall", "consolidate", "read"] },
      config: {}, workspace: "", observer: {},
    });
    // The obsolete numeric argument must not recreate the former character
    // window: the oldest active thought remains present even at "1".
    const beforeShelf = loop.history(1);
    assert.match(beforeShelf, /ordinary thought/);
    assert.match(beforeShelf, /recall\("old fear"\)/);
    assert.doesNotMatch(beforeShelf, /SHELVED WORDS RETURNED ONCE/);
    assert.doesNotMatch(beforeShelf, /private durable wording/);
    assert.match(beforeShelf, /read "note\.txt"/);

    log.append("world", "next room");
    log.shelf(thought.id);
    const afterShelf = loop.history(20_000);
    assert.doesNotMatch(afterShelf, /ordinary thought/);
    // The surviving action shows as prose with a time, no unit number: she
    // reaches memory by phrase now, so the id has no place in what she reads.
    assert.match(afterShelf, /ACTION · /);
    assert.match(afterShelf, /read\("note\.txt"\)/);
    assert.doesNotMatch(afterShelf, /#\d/);
  });
});

test("the room she reads carries content, not unit numbers, and only active long-term memory", async () => {
  await withLog((log) => {
    const now = new Date();
    const source = log.append("emission", "an experience", {
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    log.append("beat", "rest", { tokens: 7 });
    const made = log.consolidate([source.id], "A durable understanding.");
    const incoming = log.append("incoming", "hello", { from: "cy" });
    const world = renderWorld({
      now,
      previousAt: null,
      body: { affordances: () => [] },
      log,
      setup: DEFAULT_SETUP,
      incoming: [incoming],
      results: [{ id: 44, call: 'read("x")', value: "text: x" }],
      previous: { id: 45, content: "last thought" },
      files: [],
      attention: { maintained: 321, capacity: 1_000_000 },
    });
    // The long-term memory shows as the words she authored — no unit number,
    // no "from #source". The provenance stays in the record's meta for audit.
    assert.match(world, /A durable understanding/);
    assert.doesNotMatch(world, /from #/);
    assert.match(world, /MEMORY\n  maintained: 321 tokens\n  remains: 999,679 tokens/);
    assert.doesNotMatch(world, /TOKENS\n/);
    assert.ok(world.indexOf("ACTIONS") < world.indexOf("INCOMING"));
    // Incoming words, returned facts, and her last thought all read as content
    // with a time, never as "#id" — nothing she reads is addressed by number.
    assert.match(world, /INCOMING\n  \d\d:\d\d:\d\dZ  cy: hello/);
    assert.match(world, /RETURNED\n  read\("x"\)/);
    assert.match(world, /PREVIOUS\n  last thought/);
    assert.doesNotMatch(world, /#\d/);

    log.shelf(made.memory);
    const without = renderWorld({
      now: new Date(now.getTime() + 60_000), previousAt: null,
      body: { affordances: () => [] }, log, setup: DEFAULT_SETUP,
      incoming: [], results: [], previous: null, files: [],
    });
    assert.doesNotMatch(without, /A durable understanding/);
  });
});

test("authored rooms remain authored", async () => {
  await withLog((log, directory) => {
    log.set("setup_v2", { template: "MY ROOM\n  {{time}}", context: "moment", contextChars: 22_000 });
    assert.equal(loadSetup(log).template, "MY ROOM\n  {{time}}");
    assert.equal("contextChars" in loadSetup(log), false);

    const body = new Body({ log, workspace: directory });
    assert.ok(body.formNames().includes("shelve"));
    assert.ok(body.formNames().includes("consolidate"));
  });
});

test("documents carry compact authorship while their exact text stays in the artifact", async () => {
  await withLog(async (log, directory) => {
    const body = new Body({ log, workspace: directory });
    const privateText = "an exact document body that should not follow forever";
    await writeFile(path.join(directory, "note.txt"), privateText, "utf8");
    await writeFile(path.join(directory, "external.txt"), "not written through Ami", "utf8");

    log.append("world", "the moment before writing");
    const emission = log.append("emission", `write("note.txt", ${JSON.stringify(privateText)})`);
    const first = log.append("action", `write("note.txt", ${JSON.stringify(privateText)})`, {
      name: "write", args: ["note.txt", privateText],
    });
    log.append("result", "path: note.txt\nbytes: 56", {
      name: "write", action: first.id, value: { path: "note.txt", bytes: 56 }, yielded: true,
    });
    const latest = log.append("action", 'write("note.txt", "revised")', {
      name: "write", args: ["note.txt", "revised"],
    });
    log.append("result", "path: note.txt\nbytes: 7", {
      name: "write", action: latest.id, value: { path: "note.txt", bytes: 7 }, yielded: true,
    });

    const files = (await body.ls()).files;
    assert.deepEqual(files.find((file) => file.name === "note.txt")?.written, first.id);
    assert.deepEqual(files.find((file) => file.name === "note.txt")?.latestWrite, latest.id);
    assert.equal(files.find((file) => file.name === "external.txt")?.written, undefined);

    const loop = new Loop({ log, body, config: {}, workspace: directory, observer: {} });
    const history = loop.history(20_000);
    assert.match(history, /ACTION · /);
    assert.match(history, /write\("note.txt", …\)/);
    assert.doesNotMatch(history, /exact document body that should not follow forever/);
    assert.equal(log.unit(emission.id).content.includes(privateText), true);
    assert.equal(log.unit(first.id).content.includes(privateText), true);

    const world = renderWorld({
      now: new Date(), previousAt: null, body, log, setup: DEFAULT_SETUP,
      incoming: [], results: [], previous: null, files,
    });
    assert.match(world, /note\.txt — written here, and rewritten since/);
    assert.match(world, /external\.txt/);
    assert.doesNotMatch(world, /external\.txt — written/);
    assert.doesNotMatch(world, /exact document body that should not follow forever/);
  });
});

test("a call that was written but not read comes back as an honest result", async () => {
  await withLog((log) => {
    log.append("world", "the room she woke into");
    // Three calls jammed onto one line — the glm-5.2 habit that the parser
    // cannot read. Without surfacing, the whole moment vanishes silently.
    const jammed = 'speak("beyond just watching.")search("Ebola Congo latest")sleep()';
    log.append("emission", jammed);
    log.append("error", `written as a call but not read as one:\n${jammed}`, { stage: "unread", count: 1 });

    assert.deepEqual(log.lastMomentUnread(), [jammed]);

    const results = [
      ...log.lastMomentResults(),
      ...log.lastMomentUnread().map((line) => ({ call: line, value: "written like an act but did not become one" })),
    ];
    const world = renderWorld({
      now: new Date(), previousAt: null, body: { affordances: () => [] },
      log, setup: DEFAULT_SETUP, incoming: [], results, previous: null, files: [],
    });
    // She sees the exact text and that it did not become an act — an objective
    // result, not a silence, and no instruction was added to tell her so.
    assert.match(world, /RETURNED/);
    assert.match(world, /written like an act but did not become one/);
    assert.match(world, /speak\("beyond just watching\."\)search/);
  });
});
