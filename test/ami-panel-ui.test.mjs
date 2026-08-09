import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Log } from "../log.mjs";
import { momentCards } from "../plain.mjs";
import { renderPage } from "../panel-ui.mjs";

function page(overrides = {}) {
  return renderPage({
    log: { total: 2, shown: 2, html: '<section class="moment">record</section>' },
    state: { awake: false, paused: false, next: "2026-07-31T12:00:00.000Z" },
    setup: { arrival: "prefix", template: "TIME\n  {{now}}" },
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
  for (const name of ["record", "room", "lives"]) {
    assert.match(html, new RegExp(`data-tab="${name}"`));
    assert.match(html, new RegExp(`id="view-${name}"`));
  }
  assert.match(html, /complete actions and results/);
  assert.match(html, /data-mode="readable"/);
  assert.match(html, /data-mode="exact"/);
  assert.match(html, /id="new-activity"/);
  assert.match(html, /fetch\("\/events\?tail=1&limit=1"\)/);
  assert.doesNotMatch(html, /id="follow"/);
  assert.doesNotMatch(html, /setInterval\(\(\) => \{[\s\S]*location\.reload\(\)/);
  assert.match(html, /id="say"/);
  assert.match(html, /id="save-room"/);
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
    assert.match(rendered.html, /characters of model reasoning/);
    assert.match(rendered.html, /consider the available actions/);
    assert.ok(rendered.html.indexOf("consider the available actions") < rendered.html.indexOf("second thought"));
    assert.match(rendered.html, /read\(&quot;note\.txt&quot;\)/);
    assert.match(rendered.html, /read all of note\.txt/);
    assert.match(rendered.html, /recorded \? characters of speech/);
    assert.match(rendered.html, /stored local letter 1 addressed to friend@example\.com/);
    assert.doesNotMatch(rendered.html, /heard in the room|sent to friend|delivered to friend/);
    assert.match(rendered.html, /ACTION #/);
    assert.match(rendered.html, /RESULT #/);

    const second = rendered.html.indexOf("second thought");
    const first = rendered.html.indexOf("first thought");
    assert.ok(second < first, "latest moment should render first");
    assert.ok(rendered.html.indexOf("a question") < second);
    assert.ok(second < rendered.html.indexOf("note.txt", second));
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
    assert.match(rendered.html, /recorded \? characters of speech/);
    assert.doesNotMatch(rendered.html, /heard in the room/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
