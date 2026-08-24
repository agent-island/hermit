import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Log } from "../log.mjs";
import { Body } from "../body.mjs";
import { Loop } from "../loop.mjs";
import { DEFAULT_SETUP, loadSetup } from "../setup.mjs";
import { renderWorld } from "../world.mjs";
import { rewind } from "../rewind.mjs";

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

    assert.equal(log.unit(action.id).result.content, "path: door.txt\ntext: painted red");
    assert.equal(log.search("painted red")[0].id, action.id);
    assert.equal(log.unit(oldAction.id).result.content, "legacy result without an action pointer");

    const shelvedIncoming = log.shelf(incoming.id);
    assert.equal(shelvedIncoming.state, "shelved");
    assert.equal(log.unanswered().length, 0);
    assert.equal(log.search("red door")[0].state, "shelved");

    log.shelf(action.id);
    assert.equal(log.unit(action.id).state, "shelved");
    assert.equal(log.unit(action.id).result.content, "path: door.txt\ntext: painted red");
    assert.equal(log.unit(thought.id).state, "active");

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

test("consolidate folds episodic scratch AND feel-snapshots, sparing authored consolidations and process-acts", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    log.append("world", "a moment");
    const search = log.append("action", 'search("ebola")', { name: "search", args: ["ebola"] });
    log.append("result", "results…", { name: "search", action: search.id, value: { status: "success" }, yielded: true });
    const open = log.append("action", 'open("http://e.com")', { name: "open", args: ["http://e.com"] });
    log.append("result", "page…", { name: "open", action: open.id, value: { status: "success" }, yielded: true });
    const message = log.append("incoming", "a note from cy", { from: "cy" });
    // An episodic feel-snapshot (no sources) — bloat, folds. An authored
    // consolidation (carries sources) — her distillation, must be spared.
    const episodic = log.append("memory", "an episodic feel-snapshot", { emotion: "focus" });
    const authored = log.append("memory", "a distillation she authored earlier", { sources: [search.id] });
    const feel = log.append("action", 'feel("focus")', { name: "feel", args: ["focus"] });
    log.append("result", "felt", { name: "feel", action: feel.id, value: { status: "success" }, yielded: true });
    log.append("world", "next moment");

    const out = body.consolidate("The outbreak is spreading toward Kinshasa.");
    assert.equal(out.status, "success");
    // Acts, results, the message, AND the episodic feel-snapshot fold — but not
    // the authored consolidation, so kept counts the four episodic units only.
    assert.equal(out.kept, 4);
    // The note she wrote is now a durable memory.
    assert.ok(log.activeMemories().some((m) => m.content === "The outbreak is spreading toward Kinshasa."));
    // Episodic scratch receded; her authored distillation and the feel() stand.
    assert.equal(log.unit(search.id).state, "shelved");
    assert.equal(log.unit(open.id).state, "shelved");
    assert.equal(log.unit(message.id).state, "shelved");
    assert.equal(log.unit(episodic.id).state, "shelved");
    assert.equal(log.unit(authored.id).state, "active");
    assert.equal(log.unit(feel.id).state, "active");

    // With the scratch gone, a second fold finds nothing to compress.
    assert.equal(body.consolidate("nothing left").status, "failed");
    // And it needs the note itself.
    assert.equal(body.consolidate("").status, "failed");
  });
});

test("several feelings attach to one emission without copying its memory", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    log.append("world", "the room before the experience");
    const emission = log.append("emission", "One experience, present only once.");

    const recordFeeling = (emotion, intensity) => {
      const action = log.append("action", `feel(${JSON.stringify(emotion)}, ${intensity})`, {
        name: "feel", args: [emotion, intensity],
      });
      const value = body.feel(emotion, intensity);
      log.append("result", "felt", { name: "feel", action: action.id, value, yielded: true });
      return value;
    };

    const first = recordFeeling("surprise", 0.6);
    const second = recordFeeling("equanimity", 0.7);
    const third = recordFeeling("surprise", 0.6);

    assert.equal(first.memory, second.memory);
    assert.equal(second.memory, third.memory);
    assert.equal(log.recent("memory", 100).length, 1);
    assert.equal(log.units().some((unit) => unit.id === emission.id), false);
    const [memory] = log.activeMemories();
    assert.equal(memory.content, emission.content);
    assert.deepEqual(memory.meta.feelings, [
      { emotion: "surprise", intensity: 0.6 },
      { emotion: "equanimity", intensity: 0.7 },
    ]);

    const whilePrevious = renderWorld({
      now: new Date(), previousAt: null, body, log, setup: DEFAULT_SETUP,
      incoming: [], results: [], previous: emission, files: [],
    });
    assert.equal(whilePrevious.match(/One experience, present only once\./g)?.length, 1);
    assert.match(whilePrevious, /<last>\n    One experience, present only once\./);

    const afterPrevious = renderWorld({
      now: new Date(), previousAt: null, body, log, setup: DEFAULT_SETUP,
      incoming: [], results: [], previous: { id: 9999, content: "A later experience." }, files: [],
    });
    assert.equal(afterPrevious.match(/One experience, present only once\./g)?.length, 1);
    assert.match(afterPrevious, /felt surprise \(0\.6\); then equanimity \(0\.7\): One experience/);
  });
});

test("consolidation folds an unfelt emission out of conversation memory", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    log.append("world", "first room");
    const thought = log.append("emission", "A raw thought that needs folding.");
    log.append("world", "second room");

    const loop = new Loop({ log, body, config: {}, workspace: directory, observer: {} });
    assert.match(loop.history(), /A raw thought that needs folding/);
    const folded = body.consolidate("The thought became one concise understanding.");
    assert.equal(folded.status, "success");
    assert.equal(folded.kept, 1);
    assert.equal(log.unit(thought.id).state, "shelved");
    assert.doesNotMatch(loop.history(), /A raw thought that needs folding/);
    assert.ok(log.activeMemories().some((memory) => memory.content === "The thought became one concise understanding."));
  });
});

test("forgotten thoughts and incoming words do not return through another view", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    log.append("world", "first room");
    const thought = log.append("emission", "A thought with the unique word celadon.");
    const incoming = log.append("incoming", "A message with the unique word vermilion.", { from: "friend" });
    log.append("world", "second room");

    assert.equal(body.forget("celadon").status, "success");
    assert.equal(body.forget("vermilion").status, "success");
    assert.equal(log.unit(thought.id).state, "forgotten");
    assert.equal(log.lastCarriedEmission(), null);
    assert.equal(log.unanswered().some((row) => row.id === incoming.id), false);
    assert.equal(log.search("celadon").length, 0);
    assert.equal(log.search("vermilion").length, 0);
  });
});

test("active incoming memory is not silently capped", async () => {
  await withLog((log) => {
    for (let index = 0; index < 240; index += 1) {
      log.append("incoming", `message ${index}`, { from: "friend" });
    }
    const incoming = log.unanswered();
    assert.equal(incoming.length, 240);
    assert.equal(incoming[0].content, "message 0");
    assert.equal(incoming.at(-1).content, "message 239");
  });
});

test("recall searches content rather than hidden ids and does not stop at eight", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    const unrelated = log.append("incoming", "an unrelated memory", { from: "friend" });
    assert.equal(log.search(String(unrelated.id)).length, 0);
    for (let index = 0; index < 12; index += 1) {
      log.append("incoming", `shared recall phrase, occurrence ${index}`, { from: "friend" });
    }
    const recalled = body.recall("shared recall phrase");
    assert.equal(recalled.status, "success");
    assert.equal(recalled.found, 12);
    assert.equal(recalled.units.length, 12);
  });
});

test("forgotten content cannot be rebuilt through low-level consolidation", async () => {
  await withLog((log) => {
    const source = log.append("incoming", "This memory has been forgotten.", { from: "friend" });
    log.forget(source.id);
    const before = log.countOf("memory");
    const outcome = log.consolidate([source.id], "This must not resurrect it.");
    assert.match(outcome.note, /none of those were memory units available/);
    assert.equal(log.countOf("memory"), before);
  });
});

test("rewind preserves the authored room and does not replay failed writes", async () => {
  await withLog(async (log, directory) => {
    log.set("setup_v2", { ...DEFAULT_SETUP, template: "MY EXACT AUTHORED ROOM\n  {{time}}" });
    log.append("world", "a room");
    const write = log.append("action", 'write("ghost.txt", "never existed")', {
      name: "write", args: ["ghost.txt", "never existed"],
    });
    const failed = log.append("result", "status: failed", {
      name: "write", action: write.id,
      value: { status: "failed", reason: "write failed" }, yielded: false,
    });
    log.append("emission", "later history to remove");

    await rewind(log, directory, failed.id);
    assert.equal(loadSetup(log).template, "MY EXACT AUTHORED ROOM\n  {{time}}");
    await assert.rejects(readFile(path.join(directory, "ghost.txt"), "utf8"), /ENOENT/);
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
    assert.match(world, /<foreground_memory>\n    maintained: 321 tokens\n    remains: 999,679 tokens/);
    assert.doesNotMatch(world, /TOKENS\n/);
    assert.ok(world.indexOf("<faculties>") < world.indexOf("<heard>"));
    // Incoming words, returned facts, and her last thought all read as content
    // with a time, never as "#id" — nothing she reads is addressed by number.
    assert.match(world, /<heard>\n    \d\d:\d\d:\d\dZ  cy: hello/);
    assert.match(world, /<returned call="read\(&quot;x&quot;\)">/);
    assert.match(world, /<last>\n    last thought/);
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

test("the current transition stays in last and returned while standing intentions remain visible", async () => {
  await withLog((log) => {
    const older = log.append("action", 'think("older")', { name: "think", args: ["older"] });
    log.append("result", "status: success\ncharacters: 5", {
      name: "think", action: older.id, yielded: true, fact: "older action fact",
    });
    const previous = log.append("emission", 'think("current")');
    const current = log.append("action", 'think("current")', { name: "think", args: ["current"] });
    log.append("result", "status: success\ncharacters: 7", {
      name: "think", action: current.id, yielded: true, fact: "current action fact",
    });
    log.intend("continue the conversation");

    const setup = {
      ...DEFAULT_SETUP,
      format: "faculties",
      template: `<intentions>\n  {{intentions}}\n</intentions>\n\n<memory>\n  {{memories}}\n</memory>\n\n<returned>\n  {{returned}}\n</returned>\n\n<last>\n  {{previous}}\n</last>`,
    };
    const world = renderWorld({
      now: new Date(), previousAt: null, body: { affordances: () => [] },
      log, setup, incoming: [],
      results: [{ call: 'think("current")', value: "status: success\ncharacters: 7" }],
      previous: { id: previous.id, content: previous.content }, files: [],
    });

    assert.match(world, /<intentions>\n  <intention>\n    <goal>continue the conversation<\/goal>\n  <\/intention>\n<\/intentions>/);
    assert.match(world, /<memory>\n  thought: older/);
    assert.doesNotMatch(world, /<memory>[\s\S]*thought: current/);
    assert.match(world, /<last>\n  think\("current"\)\n<\/last>/);
    assert.match(world, /<returned call="think\(&quot;current&quot;\)">/);
  });
});

test("identity is empty until self-authored, revisions are versioned, and intentions carry progress evidence", async () => {
  await withLog((log) => {
    assert.equal(log.currentIdentity(), null);
    log.identify("I am the first version.");
    const first = log.currentIdentity();
    log.identify("I am a <curious> maker.");
    const current = log.currentIdentity();
    assert.equal(current.content, "I am a <curious> maker.");
    assert.equal(current.meta.previous, first.id);
    const identityUnits = log.units().filter((row) => row.kind === "memory" && row.meta?.mental === "identity");
    assert.equal(identityUnits.length, 2);
    assert.equal(identityUnits[0].state, "revised");
    assert.equal(identityUnits[1].state, "active");

    log.intend("map the room", "every visible file has been described");
    log.append("world", "the intention was visible");
    assert.deepEqual(log.progress(
      "map the room",
      "the directory listing returned two files",
      "open each file",
    ), {
      intention: "map the room",
      evidence: "the directory listing returned two files",
      next: "open each file",
    });

    const setup = {
      ...DEFAULT_SETUP,
      format: "faculties",
      template: `<identity>\n  {{identity}}\n</identity>\n\n<intentions>\n  {{intentions}}\n</intentions>\n\n<memory>\n  {{memories}}\n</memory>\n\n<latent>\n  {{latent}}\n</latent>`,
    };
    const activeWorld = renderWorld({
      now: new Date(), previousAt: null, body: { affordances: () => [] },
      log, setup, incoming: [], results: [], previous: null, files: [],
    });
    assert.match(activeWorld, /<identity>\n  I am a &lt;curious&gt; maker\./);
    assert.match(activeWorld, /<goal>map the room<\/goal>/);
    assert.match(activeWorld, /<success>every visible file has been described<\/success>/);
    assert.match(activeWorld, /<evidence>the directory listing returned two files<\/evidence>/);
    assert.match(activeWorld, /<next>open each file<\/next>/);

    assert.deepEqual(log.resolve(
      "map the room",
      "done",
      "both files were opened and described",
    ), {
      intention: "map the room",
      outcome: "done",
      evidence: "both files were opened and described",
    });
    assert.equal(log.activeIntentions().length, 0);
    const resolvedWorld = renderWorld({
      now: new Date(), previousAt: null, body: { affordances: () => [] },
      log, setup, incoming: [], results: [], previous: null, files: [],
    });
    assert.doesNotMatch(resolvedWorld, /resolved intention: map the room/);
    assert.match(resolvedWorld, /<available kind="intention" count="1"\/>/);
    const recalled = new Body({ log, workspace: "" }).recall("map the room");
    assert.equal(recalled.status, "success");
    assert.match(recalled.units[0].content, /outcome: done/);
    assert.match(recalled.units[0].content, /evidence: both files were opened and described/);
  });
});

test("typed memory units support create, read, revise, and forget without erasing history", async () => {
  await withLog((log) => {
    assert.deepEqual(log.remember("belief", "Zero and One share trace.txt"), {
      kind: "belief",
      memory: "Zero and One share trace.txt",
    });
    const first = log.units().find((row) => row.meta?.mental === "belief");
    assert.ok(first);
    assert.equal(first.kind, "memory");
    assert.equal(first.state, "active");

    log.append("world", "the belief was visible");
    assert.equal(log.revisableMemories("share trace.txt").length, 1);
    assert.deepEqual(log.revise(first.id, "Zero and One have separate private trace.txt files"), {
      kind: "belief",
      before: "Zero and One share trace.txt",
      memory: "Zero and One have separate private trace.txt files",
    });

    const beliefs = log.units().filter((row) => row.meta?.mental === "belief");
    assert.equal(beliefs.length, 2);
    assert.equal(beliefs[0].state, "revised");
    assert.equal(beliefs[1].state, "active");
    assert.equal(beliefs[1].meta.previous, beliefs[0].id);
    assert.equal(log.search("share trace.txt").at(0).state, "revised");

    const world = renderWorld({
      now: new Date(), previousAt: null, body: { affordances: () => [] },
      log, setup: DEFAULT_SETUP, incoming: [], results: [], previous: null, files: [],
    });
    assert.match(world, /belief: Zero and One have separate private trace\.txt files/);
    assert.doesNotMatch(world, /belief: Zero and One share trace\.txt/);

    assert.deepEqual(log.forget([beliefs[1].id]), [beliefs[1].id]);
    assert.equal(log.search("separate private trace.txt").length, 0);
    const archived = log.byId(beliefs[1].id);
    assert.equal(archived.content, "Zero and One have separate private trace.txt files");
    assert.equal(log.unit(beliefs[1].id).state, "forgotten");
  });
});

test("identity and revised intentions are typed memory units with continuing evidence", async () => {
  await withLog((log) => {
    log.remember("identity", "I am learning this room.");
    assert.equal(log.currentIdentity().kind, "memory");
    assert.equal(log.currentIdentity().meta.mental, "identity");

    log.intend("map the room", "every file is described");
    log.append("world", "the intention was visible");
    log.progress("map the room", "two files were listed", "open both files");
    const original = log.activeIntentions()[0];
    assert.ok(original);
    log.revise(original.id, "map and describe the room");

    const current = log.activeIntentions()[0];
    assert.equal(current.content, "map and describe the room");
    assert.equal(current.meta.success, "every file is described");
    assert.deepEqual(current.meta.evidence, ["two files were listed"]);
    assert.equal(current.meta.next, "open both files");
    assert.equal(log.unit(original.id).state, "revised");

    const identity = log.currentIdentity();
    assert.deepEqual(log.forget([identity.id]), [identity.id]);
    assert.equal(log.currentIdentity(), null);
  });
});

test("historical identity events enter the common memory projection without rewriting history", async () => {
  await withLog((log) => {
    const legacy = log.append("identity", "I came from the earlier identity format.", { previous: null });
    const projected = log.currentIdentity();
    assert.equal(projected.id, legacy.id);
    assert.equal(projected.kind, "memory");
    assert.equal(projected.meta.mental, "identity");
    assert.equal(projected.meta.legacyKind, "identity");

    log.identify("I now persist as a typed memory unit.");
    assert.equal(log.currentIdentity().content, "I now persist as a typed memory unit.");
    assert.equal(log.unit(legacy.id).state, "revised");
    assert.equal(log.byId(legacy.id).kind, "identity");
  });
});

test("consolidation folds episodic scratch without swallowing authored mind states", async () => {
  await withLog((log, directory) => {
    const body = new Body({ log, workspace: directory });
    const scratch = log.append("incoming", "temporary observations to distill", { from: "someone" });
    log.remember("belief", "The two workspaces are separate.");
    log.remember("value", "Preserving exact evidence matters.");
    log.identify("I am investigating the environment.");
    log.intend("finish the investigation", "the evidence answers the question");
    log.append("world", "all durable states were visible");

    const folded = body.consolidate("The temporary observation was examined.");
    assert.equal(folded.status, "success");
    assert.equal(log.unit(scratch.id).state, "shelved");
    assert.equal(log.currentIdentity().content, "I am investigating the environment.");
    assert.equal(log.activeIntentions()[0].content, "finish the investigation");
    assert.deepEqual(
      log.activeMemories().filter((row) => ["belief", "value"].includes(row.meta?.mental)).map((row) => row.state),
      ["active", "active"],
    );
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
    assert.match(world, /<returned>/);
    assert.match(world, /written like an act but did not become one/);
    assert.match(world, /<returned call="speak\(&quot;beyond just watching\.&quot;\)search/);
  });
});
