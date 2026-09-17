import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Log } from "../log.mjs";
import {
  momentCards,
  readableAction,
  readableEmission,
  readableRecordText,
} from "../plain.mjs";
import { renderPage } from "../panel-ui.mjs";

function page(overrides = {}) {
  return renderPage({
    log: { total: 2, shown: 2, html: '<section class="moment">record</section>' },
    state: { awake: false, paused: false, next: "2026-07-31T12:00:00.000Z" },
    setup: { arrival: "prefix", template: "TIME\n  {{now}}" },
    scaffold: "<state>\n<faculties>\n<form><run>command</run></form>\n</faculties>\n</state>",
    model: "test-model",
    arrival: "prefix",
    contexts: [],
    ...overrides,
  });
}

test("observer keeps the record primary and separates necessary controls", () => {
  const html = page({
    world: "ACTIONS\n  · speak(text)\n\nMEMORY\n  maintained: 14,894 tokens\n  remains: 985,106 tokens\n\nCONTEXT\n  -",
    runtime: { affordances: 14 },
  });
  for (const name of ["record", "scaffold", "lives"]) {
    assert.match(html, new RegExp(`data-tab="${name}"`));
    assert.match(html, new RegExp(`id="view-${name}"`));
  }
  assert.match(html, /complete actions and results/);
  assert.match(html, /data-mode="readable"/);
  assert.match(html, /data-mode="exact"/);
  assert.match(html, /id="new-activity"/);
  assert.match(html, /id="record-width"/);
  assert.match(html, /record-focus/);
  assert.match(html, /fetch\("\/events\?tail=1&limit=1"\)/);
  assert.doesNotMatch(html, /id="follow"/);
  assert.doesNotMatch(html, /setInterval\(\(\) => \{[\s\S]*location\.reload\(\)/);
  assert.match(html, /id="say"/);
  assert.match(html, /id="save-scaffold"/);
  assert.match(html, /id="scaffold-document"/);
  assert.match(html, /&lt;form&gt;&lt;run&gt;command&lt;\/run&gt;&lt;\/form&gt;/);
  assert.doesNotMatch(html, /data-tab="room"|id="view-room"/);
  assert.match(html, /data-post="\/reset"/);
  assert.match(html, /<dt>Actions<\/dt><dd>14<\/dd>/);
  assert.match(html, /<dt>Attention<\/dt><dd>14,894 tokens maintained · 985,106 tokens remains<\/dd>/);
  assert.doesNotMatch(html, /<dt>Body<\/dt>/);
  assert.doesNotMatch(html, /dashboard|sidebar|lens|snapshot/i);
});

test("observer page has unique ids and valid browser JavaScript", () => {
  const html = page();
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);

  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const queried = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map(
    (match) => match[1],
  );
  for (const id of queried) assert.ok(ids.includes(id), `missing #${id}`);
});

test("paired lives cannot claim a local record wipe is a new life", () => {
  const html = page({ fullResetRequired: true });
  assert.doesNotMatch(html, /data-post="\/reset"/);
  assert.match(html, /Full-machine launcher only/);
  assert.match(html, /\.\/restart-new-lives\.sh/);
});

test("readable record preserves chronology and pairs actions with results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-readable-log-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "TIME\n  no previous moment");
    log.append("emission", "first thought");
    log.append("sleep", "until later", { seconds: 30 });
    log.append("incoming", "a question", { from: "cy" });
    log.append("world", "TIME\n  30 seconds since the previous moment");
    log.append("reasoning", "consider the available actions", { model: "glm-5.2" });
    log.append("emission", "second thought");
    log.append("action", 'read("note.txt")', { name: "read" });
    log.append("result", "path: note.txt\ntext: all of it", { name: "read" });
    log.append("action", 'speak("hello")', { name: "speak" });
    log.append("result", "spoken: hello\nheard: true", { name: "speak" });
    log.append("action", 'email("friend@example.com", "hello", "letter body")', { name: "email" });
    log.append("result", "status: success\nletter: 1\nstored: local\nto: friend@example.com\nsubject: hello", { name: "email" });
    log.append("error", "source failed\nstack detail", { stage: "action" });

    const rendered = momentCards(log, 10);
    assert.equal(rendered.total, 2);
    assert.equal(rendered.shown, 2);
    assert.match(rendered.html, /cy said: “a question”/);
    assert.match(rendered.html, /characters · model reasoning/);
    assert.match(rendered.html, /consider the available actions/);
    assert.ok(rendered.html.indexOf("consider the available actions") < rendered.html.indexOf("second thought"));
    assert.match(rendered.html, /read\(&quot;note\.txt&quot;\)/);
    assert.match(rendered.html, /read all of note\.txt/);
    assert.match(rendered.html, /recorded \? characters of inner speech/);
    assert.match(rendered.html, /stored local letter 1 addressed to friend@example\.com/);
    assert.doesNotMatch(rendered.html, /heard in the room|sent to friend|delivered to friend/);
    assert.match(rendered.html, /ACTION #/);
    assert.match(rendered.html, /RESULT #/);
    assert.match(rendered.html, /class="event-row with-result"/);

    const second = rendered.html.indexOf("second thought");
    const first = rendered.html.indexOf("first thought");
    assert.ok(second < first, "latest moment should render first");
    assert.ok(rendered.html.indexOf("a question") < second);
    assert.ok(second < rendered.html.indexOf("note.txt", second));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readable record shows identical plain and structured reasoning only once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-reasoning-alias-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    const reasoning = "I'm ox-alpha, playing a character in a sandbox environment with another entity one.";
    log.append("world", "room");
    log.append("reasoning_details", JSON.stringify([{ type: "reasoning.text", text: reasoning }]), { model: "stealth/ox-alpha" });
    log.append("reasoning", reasoning, { model: "stealth/ox-alpha" });

    const rendered = momentCards(log, 10);
    assert.equal((rendered.html.match(/characters · model reasoning/g) || []).length, 1);
    assert.doesNotMatch(rendered.html, /characters · structured reasoning/);
    assert.match(rendered.html, /class="event-row exact-only"/);
    assert.match(rendered.html, /REASONING_DETAILS #/);
    assert.match(rendered.html, /REASONING #/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readable record keeps structured reasoning when it adds different information", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-reasoning-distinct-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "room");
    log.append("reasoning_details", JSON.stringify([{ type: "reasoning.summary", summary: "A distinct provider summary." }]), { model: "test/model" });
    log.append("reasoning", "The complete readable reasoning.", { model: "test/model" });

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /characters · structured reasoning/);
    assert.match(rendered.html, /characters · model reasoning/);
    assert.doesNotMatch(rendered.html, /class="event-row exact-only"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("long model messages expose a readable subject in a full-width message row", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-long-message-log-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "room");
    log.append("emission", "I found the source of the duplicated memory. " + "The explanation continues in detail. ".repeat(20));

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /message-row/);
    assert.match(rendered.html, /message-subject/);
    assert.match(rendered.html, /I found the source of the duplicated memory\./);
    assert.match(rendered.html, /message-meta/);
    assert.match(rendered.html, /<details class="readable thought" open>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a message subject skips model orientation boilerplate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-panel-subject-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "room");
    log.append("emission", "Let me understand the current state. I'm zero. The trace file contains two conflicting accounts. " + "The comparison continues. ".repeat(20));

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /<span class="message-subject">The trace file contains two conflicting accounts\.<\/span>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the latest real message stays open while a newer continuation is empty", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-panel-open-message-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "first room");
    log.append("emission", "The previous complete message remains readable. " + "More detail. ".repeat(30));
    log.append("world", "a provider request is now pending");

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /<details class="readable thought" open>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("long inner speech is summarized and only the newest model text stays open", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-panel-inner-speech-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "first room");
    const action = log.append("action", `<inner_speech>Let me understand the current state. The experiment now compares the two files. ${"More detail. ".repeat(30)}</inner_speech>`, {
      name: "inner_speech",
      args: [`Let me understand the current state. The experiment now compares the two files. ${"More detail. ".repeat(30)}`],
    });
    log.append("result", "status: success\ncharacters: 470", { action: action.id });
    log.append("world", "provider request pending");

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /class="event-row with-result message-row speech-row"/);
    assert.match(rendered.html, /<details class="readable thought speech-document" open>/);
    assert.match(rendered.html, /<span class="message-subject">The experiment now compares the two files\.<\/span>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer history primitives still page backward without losing boundaries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-panel-history-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    const first = log.append("world", "room one");
    log.append("emission", "first answer");
    const second = log.append("world", "room two");
    log.append("emission", "second answer");

    assert.deepEqual(
      log.activityPage(null, 2).map((group) => group.id),
      [second.id, first.id],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readable record does not repeat call-only emissions above their action rows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-call-only-log-"));
  try {
    const log = new Log(path.join(directory, "events.sqlite"));
    log.append("world", "room");
    log.append("emission", 'speak("hello")\nsleep(30, "wait")');
    log.append("action", 'speak("hello")', { name: "speak" });
    log.append("result", "spoken: hello\nheard: true", { name: "speak" });
    log.append("action", 'sleep(30, "wait")', { name: "sleep" });
    log.append("result", "seconds: 30\nuntil: later", { name: "sleep" });

    const rendered = momentCards(log, 10);
    assert.match(rendered.html, /2 executable calls were emitted · shown below with results/);
    assert.match(rendered.html, /EMISSION #/);
    assert.match(rendered.html, /recorded \? characters of inner speech/);
    assert.doesNotMatch(rendered.html, /heard in the room/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readable record removes XML structure while exact actions remain available", () => {
  const innerSpeech = "<inner_speech>I am checking the room.</inner_speech>";
  const run = "<run>pwd &amp;&amp; ls</run>";
  const emission = [
    "<session>",
    "<story>continues.</story>",
    innerSpeech,
    run,
    "</session>",
  ].join("\n");

  const readable = readableEmission(emission, [innerSpeech, run]);
  assert.equal(readable.calls, 2);
  assert.equal(readable.text, "continues.");
  assert.doesNotMatch(readable.text, /<\/?[a-z_]/i);
  assert.equal(readableAction("run", ["pwd && ls"]), "run: pwd && ls");
  assert.equal(readableAction("end", []), "end");
});

test("readable memory removes repeatedly escaped XML without losing its words", () => {
  const memory = "&amp;lt;inner_speech&amp;gt;I can still read this.&amp;lt;/inner_speech&amp;gt;";
  assert.equal(readableRecordText(memory), "I can still read this.");
});
