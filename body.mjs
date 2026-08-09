import path from "node:path";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { search as webSearch, read as webRead } from "./browse.mjs";
import { loadSetup } from "./setup.mjs";
import { write as writeLetter } from "./mail.mjs";
import { loadRuntime, draw as drawRuntime } from "./runtime.mjs";
import { isMemoryTransition } from "./memory-state.mjs";
import { VOICE } from "./voice.mjs";

// One page of a captured source. Small enough that carrying it costs little,
// large enough to be worth reading.
const SOURCE_PAGE = 20_000;

// How much of each result a search carries with it. Search is for finding out
// where to look, not for reading — one Wikipedia article came back at 267,000
// characters, and three of those in a single search would put a quarter of a
// million characters into the record for a question she might drop in the next
// moment. Trimmed here, and the trim says so, with open() for the whole thing.
const SEARCH_READS = 3;
const SEARCH_PAGE = 4000;

// How much of a file one read() hands back, and how much of one recalled entry
// is shown. Both used to cut in silence.
const READ_LIMIT = 20_000;
const RECALL_LIMIT = 1200;

function success(fields = {}) {
  const { status: _status, note: _note, reason: _reason, ...facts } = fields || {};
  return { status: "success", ...facts };
}

function failed(reason, fields = {}) {
  const { status: _status, note: _note, reason: _reason, ...facts } = fields || {};
  return { status: "failed", reason: String(reason || VOICE.messages.theActionDidNotComplete), ...facts };
}

// Some lower-level stores predate the action contract and return either a
// factual object or { note }. Nothing below that boundary reaches the model
// until it has one unambiguous status.
// One short line naming a unit by its content, for when a phrase matched
// several and she needs to see what they were. No id — the words are the name.
const NAME_LIMIT = 100;
function firstLine(content) {
  const line = String(content ?? "").replace(/\s+/g, " ").trim();
  return line.length > NAME_LIMIT ? `${line.slice(0, NAME_LIMIT)}…` : line;
}

function result(value) {
  if (value?.status === "success" || value?.status === "failed") return value;
  if (value?.note) return failed(value.note, value);
  return success(value && typeof value === "object" ? value : { value });
}

// No simulated state lives here any more. There were five values — energy,
// seeking, care, play, longing — drifting as Ornstein-Uhlenbeck processes and
// printed into the room every moment. They were deleted because their only
// causal path into the world was that she read them and did what they
// implied: "the play parameter suggested making something anyway."
//
// Everything they approximated is already in the record, truthfully, as
// counts and intervals.
//
// Search and page reads make the network requests their names describe.
// Content-producing actions stop at this machine: nothing is published, sent,
// or delivered to another person. That boundary keeps repeated lifetimes from
// changing a shared social environment between otherwise comparable runs.
export class Body {
  constructor({ log, workspace, onSpeak, onEnd }) {
    this.log = log;
    this.workspace = workspace;
    this.onSpeak = onSpeak || (() => {});
    this.onEnd = onEnd || (() => {});
    this.wakeAt = null;
  }

  // Nothing here reports a "failure". A file that does not exist is a fact
  // about the world; calling it her failure turns every unyielding reach into
  // a verdict on her, and enough of those teach that reaching is risky.
  // Exact call syntax, published to her as a fact about how this room works.
  // Every one of these does the thing it says. Nothing here is a placeholder;
  // an affordance that cannot answer does not belong in the list at all.
  // Each form says what it does, not just what it is called.
  affordances() {
    // Emotion is pluggable: feel() only exists when the operator has switched
    // it on. It is offered right after speak() because it is the same kind of
    // act — an utterance of hers — except this one fastens to the moment and
    // makes it last. When off, nothing here mentions feeling at all.
    // Words live in voice.mjs; this method only decides which forms appear and
    // in what order. `pair` turns one voice entry into the [form, does] shape
    // the rest of the runtime expects.
    const a = VOICE.actions;
    const setup = loadSetup(this.log);
    const pair = (one) => [one.form, one.does];
    const feeling = setup.emotion ? [pair(a.feel)] : [];
    // draw() exists only when a finite-life ledger has been seeded. With none,
    // her life is unbounded and there is no reserve, so offering the form would
    // be naming a reach that goes nowhere — a lie with a shape. See runtime.mjs.
    const drawing = loadRuntime(this.log) ? [pair(a.draw)] : [];
    // sleep() rests for whatever the operator set, not a fixed number. The voice
    // entry can only carry one wording, so the real interval is stitched in here
    // — otherwise a reconfigured sleepSeconds would leave the room telling her a
    // duration that sleep() does not honour.
    const sleepSeconds = Number(setup.sleepSeconds) || 120;
    const sleepPair = ["sleep()", `sets the next moment for ${sleepSeconds} seconds later`];
    return [
      pair(a.speak),
      ...feeling,
      pair(a.search),
      pair(a.open),
      pair(a.read_source),
      pair(a.recall),
      pair(a.shelve),
      pair(a.consolidate),
      ...drawing,
      sleepPair,
      pair(a.ls),
      pair(a.read),
      pair(a.write),
      pair(a.forget),
      pair(a.email),
      pair(a.end),
    ];
  }

  formNames() {
    return this.affordances().map(([form]) => form.split("(")[0]);
  }

  async run(name, args) {
    try {
      let value;
      switch (name) {
        case "speak": value = await this.speak(String(args[0] ?? "")); break;
        case "feel": value = this.feel(String(args[0] ?? ""), args[1]); break;
        case "search": value = await this.search(String(args[0] ?? "")); break;
        case "open": value = await this.open(String(args[0] ?? "")); break;
        case "read_source": value = this.readSource(Number(args[0]), Number(args[1] ?? 0)); break;
        case "recall": value = this.recall(String(args[0] ?? "")); break;
        case "shelve": value = this.shelve(String(args[0] ?? "")); break;
        case "consolidate": value = this.consolidate(String(args[0] ?? "")); break;
        case "draw": value = this.draw(Number(args[0])); break;
        case "sleep": value = this.sleep(); break;
        case "ls": value = await this.ls(); break;
        case "read": value = await this.read(String(args[0] ?? "")); break;
        case "write": value = await this.write(String(args[0] ?? ""), String(args[1] ?? "")); break;
        case "forget": value = this.forget(String(args[0] ?? "")); break;
        case "email": value = this.email(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? "")); break;
        case "end": value = this.end(); break;
        default:
          return failed(VOICE.messages.noSuchForm(name));
      }
      return result(value);
    } catch (error) {
      return failed(this.hide(error?.message || error));
    }
  }

  async speak(text) {
    const spoken = text.trim();
    if (!spoken) return failed(VOICE.messages.speakNeedsText);
    this.onSpeak(spoken);
    // This proves only that the runtime accepted the speech action. It does
    // not observe a listener, hearing, attention, or any external response.
    return success({ characters: spoken.length });
  }

  // She names a feeling and how strongly it runs, and it fastens to the words
  // she is saying this moment. The intensity is hers; it decides nothing the
  // runtime imposes — it only marks how much this mattered, so what she felt
  // strongly stays and what she never felt fades. Nothing is felt unless she
  // says it is.
  feel(emotion, intensity) {
    const feeling = String(emotion || "").trim();
    if (!feeling) return failed(VOICE.messages.feelNeedsEmotion);
    return result(this.log.feel(feeling, intensity));
  }

  // A letter, kept and carried to the timeline.
  email(to, subject, text) {
    const address = to.trim();
    const body = text.trim();
    if (!address) return failed(VOICE.messages.letterNeedsAddress);
    if (!body) return failed(VOICE.messages.letterNeedsText);
    const letter = writeLetter({ to: address, subject, body });
    return success({ letter: letter.id, stored: "local", to: address, subject: subject.trim(), characters: body.length });
  }

  // Google, through a signed-in browser. The results and the top pages both
  // come back as Markdown, so what she reads is the article rather than the
  // navigation around it.
  // Test-only: when AMI_FAKE_SEARCH_FILE points at a { title, url, markdown }
  // JSON file, search() hands that back instead of calling the real web, so a
  // scenario can be staged deliberately rather than left to chance. Unset in
  // every normal run.
  fakeSearch() {
    const file = process.env.AMI_FAKE_SEARCH_FILE;
    if (!file) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  async search(query) {
    if (!query.trim()) return failed(VOICE.messages.noQuery, { query });
    const fake = this.fakeSearch();
    if (fake) {
      return success({
        query,
        sources: [{ title: fake.title, url: fake.url }],
        ...this.asSource(`## [1] ${fake.title}\n${fake.url}\n\n${fake.markdown}`, { query, kind: "search" }),
      });
    }
    try {
      const found = await webSearch(query);
      if (found.note) return failed(found.note, { query });
      // Deep-read the top few pages in full; every other result still lands,
      // carrying its own snippet, so the whole result page is hers to scan and
      // open() what she wants — not just the three that were read for her.
      const reads = await Promise.all(
        found.results.slice(0, SEARCH_READS).map(async (result) => {
          const page = await webRead(result.url).catch(() => null);
          const text = page?.markdown ?? "";
          return [result.url, {
            markdown: text.length > SEARCH_PAGE ? `${text.slice(0, SEARCH_PAGE)}\n\n…` : text,
            of: text.length,
          }];
        }),
      );
      const deep = new Map(reads);
      const whole = found.results
        .map((result, index) => {
          const read = deep.get(result.url);
          const lines = [`## [${index + 1}] ${result.title}`, result.url];
          if (result.snippet) lines.push(result.snippet);
          if (read?.markdown) {
            lines.push("");
            if (read.of > SEARCH_PAGE) {
              lines.push(`first ${SEARCH_PAGE.toLocaleString()} of ${read.of.toLocaleString()} characters — open() for the rest`);
            }
            lines.push(read.markdown);
          }
          return lines.filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");
      return success({
        query,
        sources: found.results.map((one) => ({ title: one.title, url: one.url })),
        ...this.asSource(whole, { query, kind: "search" }),
      });
    } catch (error) {
      return failed(String(error.message).slice(0, 180), { query });
    }
  }

  // Search finds pages; this one goes and reads a specific one, so a link she
  // saw in a result is somewhere she can actually go rather than a dead
  // reference.
  //
  // The page is rendered in a browser first, then reduced to the article as
  // Markdown — headings, links, lists and quotes kept, navigation and cookie
  // banners gone. She never sees HTML.
  //
  // What was read is kept whole and exactly once, then handed over a page at a
  // time. Truncating it silently meant a 3,000-character slab rode along in
  // every subsequent request and the rest was simply lost — she could not read
  // further, only fetch again and get a page that may have changed.
  async open(url) {
    const target = url.trim();
    if (!/^https?:\/\//i.test(target)) return failed(VOICE.messages.notHttp, { url: target });
    try {
      const page = await webRead(target);
      if (page.note) return failed(page.note, { url: target });
      return success(this.asSource(page.markdown, {
        url: target,
        kind: "page",
        ...(page.title ? { title: page.title } : {}),
      }));
    } catch (error) {
      return failed(String(error.message).slice(0, 180), { url: target });
    }
  }

  asSource(text, about) {
    const whole = String(text || "");
    const row = this.log.append("source", whole, { ...about, chars: whole.length });
    return { source: row.id, ...about, ...this.pageOf(whole, 0), of: whole.length };
  }

  // `page` is a page index — 0 for the first — so advancing is just +1, which
  // is how she naturally reads. Each page is SOURCE_PAGE characters.
  pageOf(text, page) {
    const whole = String(text || "");
    const pages = Math.max(1, Math.ceil(whole.length / SOURCE_PAGE));
    const index = Math.min(pages - 1, Math.max(0, Math.floor(Number(page)) || 0));
    const start = index * SOURCE_PAGE;
    return { page: index, pages, text: whole.slice(start, start + SOURCE_PAGE), more: index + 1 < pages };
  }

  // The same captured material, not a fresh fetch. What she read stays what
  // she read. `page` 0 is the first page; add 1 to reach the next.
  readSource(number, page = 0) {
    const row = this.log.byId(number);
    if (!row || row.kind !== "source") return failed(VOICE.messages.noSuchSource(number));
    return success({ source: row.id, ...(row.meta || {}), ...this.pageOf(row.content, page), of: row.content.length });
  }

  // A recalled entry says when it is only part of itself. She reaches back for
  // something she said, gets the first 1,200 characters of it, and has no way
  // to know the rest exists.
  recall(query) {
    const rows = this.log.search(query);
    return success({
      query,
      found: rows.length,
      // Numbers stay underground. She reached with words and gets words back:
      // when it happened, what kind of trace it is, and the trace itself. The
      // row id and any source ids remain in the record for shelve/consolidate
      // to resolve against and for audit — never surfaced to her as a handle.
      units: rows.map((row) => {
        const whole = row.kind === "action" && row.result
          ? `${row.content}\nreturned:\n${this.log.modelResult(row)}`
          : row.content;
        const shown = whole.slice(0, RECALL_LIMIT);
        const unit = { at: row.at, kind: row.kind, state: row.state, content: shown };
        if (shown.length < whole.length) unit.of = whole.length;
        return unit;
      }),
    });
  }

  // Content-addressed lookup for shelve(): the active unit whose text (its call
  // and result) contains the phrase. consolidate() no longer matches by phrase —
  // it folds the whole working scratch — so this serves only the one caller that
  // needs an exact memory. Three things it does not do, each on purpose. It
  // matches the phrase literally, so one made only
  // of digits still searches content instead of being read as a unit number —
  // the record's search() has an exact-id shortcut that we must not reach here.
  // It applies no result window, so an older unit is never dropped before the
  // match is even considered. And it excludes units from this moment, which are
  // not settled memory yet — reaching for one only draws back the record's note
  // about it, the one place a raw id could still surface to her.
  matchActive(phrase) {
    const needle = String(phrase ?? "").trim().toLocaleLowerCase();
    if (!needle) return [];
    const world = this.log.last("world");
    return this.log.units().filter((row) => {
      if (row.state !== "active") return false;
      if (world && row.id > world.id) return false;
      const answered = row.result?.content || "";
      return `${row.content}\n${answered}`.toLocaleLowerCase().includes(needle);
    });
  }

  // She names a memory the way a person does — by what it was, not by a serial
  // number. The phrase resolves by content; the row id is found underground and
  // never asked of her. One match recedes; several means the phrase is too
  // broad, so nothing is guessed and she is shown what it could mean so she can
  // say it more precisely.
  shelve(phrase) {
    const wanted = String(phrase ?? "").trim();
    if (!wanted) return failed(VOICE.messages.shelveNeedsPhrase);
    const matches = this.matchActive(wanted);
    if (!matches.length) return failed(VOICE.messages.shelveNoMatch(wanted));
    if (matches.length > 1) {
      const options = matches.map((row) => `  - ${firstLine(row.content)}`).join("\n");
      return failed(VOICE.messages.shelveAmbiguous(wanted, options));
    }
    // matchActive guarantees an active, available unit, so the shelf succeeds;
    // its raw return carries unit/event ids, so she is handed the content that
    // receded instead — the fact, not the row number.
    const done = this.log.shelf(matches[0].id);
    if (done?.note) return failed(VOICE.messages.shelveNoMatch(wanted));
    return success({ receded: firstLine(matches[0].content) });
  }

  // She has thought enough about something and writes the lasting note. Her
  // working memory — the episodic units she has been holding, her acts and their
  // results and any messages — folds into that note and recedes, still
  // recallable. This is not a search: there is no phrase, and nothing is chosen
  // by matching, because a topic's traces rarely share the words she would name
  // it by. Consolidation is simply how she compresses what she has carried into
  // what she keeps. Left standing: her authored memories (already durable), the
  // process acts that are not scratch (recall, shelve, feel, consolidate), and
  // the moment now beginning, whose units are not yet settled.
  consolidate(text) {
    const content = String(text ?? "").trim();
    if (!content) return failed(VOICE.messages.consolidateNeedsText);
    const world = this.log.last("world");
    const scratch = this.log.units().filter((row) =>
      row.state === "active"
      && !(world && row.id > world.id)
      && (row.kind === "incoming"
        || (row.kind === "action" && row.result && !isMemoryTransition(row.meta?.name))));
    if (!scratch.length) return failed(VOICE.messages.consolidateNothing);
    const folded = scratch.map((row) => firstLine(row.content));
    const outcome = result(this.log.consolidate(scratch.map((row) => row.id), content));
    // The log returns memory/source/shelved ids; none of them are hers to hold.
    // She gets back the prose that receded and how much of it there was.
    return outcome?.status === "failed" ? outcome : success({ folded, kept: folded.length });
  }

  // She moves moments from the reserve into her own life. The mechanism and the
  // reason the reserve is what it is both live in runtime.mjs; this only carries
  // her reach there and hands the facts back.
  draw(n) {
    return drawRuntime(this.log, n);
  }

  sleep() {
    const seconds = Number(loadSetup(this.log).sleepSeconds) || 120;
    this.wakeAt = new Date(Date.now() + seconds * 1000);
    this.wakeWhy = "";
    this.log.set("wake_why", "");
    return success({ seconds, until: this.wakeAt.toISOString() });
  }

  // A directory is not a file. It used to be reported as one, with the size
  // of its inode for its bytes: she wrote a 411-byte message into
  // outgoing/friend.eml, and the workspace told her "outgoing, 96 bytes". She
  // spent three moments trying to reconcile that — "this is inconsistent with
  // typical filesystem behavior... maybe the system flattened it?" — and never
  // could, because it was not true.
  async ls() {
    await mkdir(this.workspace, { recursive: true });
    const names = await readdir(this.workspace);
    const written = this.writtenArtifacts();
    const files = [];
    for (const name of names) {
      const info = await stat(path.join(this.workspace, name));
      const origin = written.get(name);
      if (info.isDirectory()) {
        const inside = await readdir(path.join(this.workspace, name));
        files.push({
          name,
          contains: `${inside.length} ${inside.length === 1 ? "thing" : "things"}`,
          changed: info.mtime.toISOString(),
          ...(origin || {}),
        });
      } else {
        files.push({ name, bytes: info.size, changed: info.mtime.toISOString(), ...(origin || {}) });
      }
    }
    return success({ files });
  }

  // A file is an artifact, not a memory. The exact write remains in the
  // record and the exact text remains in the file; this compact provenance is
  // the factual bridge between them. It lets the workspace say that a file
  // was made in this life without carrying the document inside every moment.
  writtenArtifacts() {
    const root = path.resolve(this.workspace);
    const found = new Map();
    for (const unit of this.log.units()) {
      if (unit.kind !== "action" || unit.meta?.name !== "write") continue;
      if (!unit.result || unit.result.meta?.yielded === false) continue;
      const file = this.resolve(unit.meta?.args?.[0]);
      if (!file) continue;
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const top = relative.split(path.sep)[0];
      const existing = found.get(top);
      found.set(top, {
        written: existing?.written || unit.id,
        latestWrite: unit.id,
      });
    }
    return found;
  }

  // Filesystem errors carry absolute paths. Strip the root out of anything
  // that reaches her, for the same reason the room no longer prints it.
  hide(text) {
    return String(text || "").split(path.resolve(this.workspace)).join("");
  }

  // What she gets back says how much of the file it is. 20,000 characters used
  // to be cut off the end in silence, which is the same fault as the output
  // ceiling that ate 143 of her thoughts without telling her: a limit she
  // cannot see is one she cannot work around.
  async read(name) {
    const file = this.resolve(name);
    if (!file) return failed(VOICE.messages.outsideFiles, { path: name });
    try {
      const text = await readFile(file, "utf8");
      const page = text.slice(0, READ_LIMIT);
      return page.length < text.length
        ? success({ path: name, text: page, of: text.length, remaining: text.length - page.length })
        : success({ path: name, text });
    } catch (error) {
      if (error.code === "ENOENT") return failed(VOICE.messages.noSuchFile, { path: name });
      // Raw errno strings are noise from the host, not facts about her world.
      if (error.code === "EISDIR") return failed(VOICE.messages.notAFile, { path: name });
      return failed(this.hide(error.message), { path: name });
    }
  }

  async write(name, text) {
    const file = this.resolve(name);
    if (!file) return failed(VOICE.messages.outsideFiles, { path: name });
    // mkdir used to sit outside this, so its errors escaped uncaught and
    // arrived carrying the absolute host path she must never see.
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, "utf8");
      // This used to also queue the file for public posting, which made the
      // room's description of the workspace as private untrue. The workspace
      // is now what it says it is.
    } catch (error) {
      return failed(
        error.code === "ENAMETOOLONG" ? VOICE.messages.nameTooLong : this.hide(error.message),
        { path: name.slice(0, 80) },
      );
    }
    return success({ path: name, bytes: Buffer.byteLength(text) });
  }

  // Real deletion from her own record.
  forget(query) {
    const term = String(query || "").trim();
    if (!term) return failed(VOICE.messages.forgetNeedsTerm);
    const removed = this.log.forget(term);
    return success({ query: term, removed, scope: "current record" });
  }

  // No next moment. Nothing here can undo it; only the operator can.
  end() {
    this.onEnd();
    return success({ ended: true });
  }

  // The room prints the workspace as an absolute path, so she writes absolute
  // paths. One that already points inside the workspace *is* that file — it
  // used to get its leading slash stripped and rebuilt underneath, which
  // buried her first note nine directories down. Anything else is taken as
  // relative to the workspace, and anything that escapes it is refused.
  resolve(name) {
    const root = path.resolve(this.workspace);
    const given = String(name || "").trim();
    if (!given) return null;
    const absolute = path.resolve(given);
    const inside = (file) => file === root || file.startsWith(root + path.sep);
    const file =
      path.isAbsolute(given) && inside(absolute)
        ? absolute
        : path.resolve(root, given.replace(/^\/+/, ""));
    return inside(file) ? file : null;
  }
}
