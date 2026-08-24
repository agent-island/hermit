import { DatabaseSync } from "node:sqlite";
import { actionFact, isMemoryTransition, withFeeling } from "./memory-state.mjs";

const ACTIVITY_GROUPS = `
  WITH marked AS (
    SELECT
      id, at, kind, content, meta,
      MAX(CASE WHEN kind = 'world' THEN id END)
        OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_world,
      MAX(CASE WHEN kind = 'sleep' THEN id END)
        OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_sleep
    FROM events
  ),
  classified AS (
    SELECT
      *,
      CASE
        WHEN last_world IS NOT NULL AND last_world > COALESCE(prior_sleep, 0)
          THEN last_world
        ELSE id
      END AS group_id
    FROM marked
  )
`;

// Append-only. Nothing in here is ever edited, relabelled, or summarised.
// `content` holds exactly what happened, byte for byte. Anything we want to
// say *about* an event goes in `kind` or `meta`, never inside the content.
//
// kinds:
//   world     the exact document rendered for a moment
//   api       the untouched request and provider response
//   reasoning the readable reasoning text returned by the provider
//   reasoning_details the complete structured reasoning blocks, unflattened
//   emission  her raw output, verbatim, before anything is parsed out of it
//   action    one parsed call
//   result    what that call actually returned, including failures
//   incoming  something the observer said
//   memory    a long-term memory she authored from exact source units
//   shelf     one unit leaving automatic context without leaving the record
//   body      a change in her values, with the cause
//   sleep     when she chose to return
//   error     a request that did not complete
export class Log {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    // WAL lets many readers coexist with the one writer, so the pair monitor
    // (and any diagnostic) reading the record cannot lock the agent out of its
    // own next moment — the "database is locked" crash that killed a life.
    // busy_timeout makes a write wait for a lock instead of failing instantly.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind, id DESC);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.insert = this.db.prepare(
      "INSERT INTO events (at, kind, content, meta) VALUES (?, ?, ?, ?)",
    );
  }

  append(kind, content, meta = {}) {
    const at = new Date().toISOString();
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const info = this.insert.run(at, kind, text, JSON.stringify(meta));
    return { id: Number(info.lastInsertRowid), at, kind, content: text, meta };
  }

  since(id, limit = 500) {
    return this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(Number(id) || 0, limit)
      .map(parse);
  }

  // The observer is a live instrument, so its first screen starts at now
  // rather than replaying an entire life from the beginning. Both methods
  // return newest first; older pages can be appended directly underneath.
  tail(limit = 120) {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Number(limit) || 120))
      .map(parse);
  }

  before(id, limit = 120) {
    return this.db
      .prepare("SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?")
      .all(Number(id) || 0, Math.max(1, Number(limit) || 120))
      .map(parse);
  }

  // A moment begins with its exact world document and ends with sleep. Events
  // outside that interval remain standalone, because attaching an incoming
  // message or room edit to the completed prior moment would change what the
  // record says. Groups are newest first; events within a moment remain exact
  // and chronological.
  activityPage(beforeGroupId = null, limit = 6) {
    const size = Math.max(1, Number(limit) || 6);
    const before = Number(beforeGroupId) || 0;
    const groups = before
      ? this.db
          .prepare(
            `${ACTIVITY_GROUPS}
             SELECT
               group_id AS id,
               MIN(at) AS at,
               MAX(CASE WHEN id = group_id AND kind = 'world' THEN 1 ELSE 0 END) AS is_moment
             FROM classified
             WHERE group_id < ?
             GROUP BY group_id
             ORDER BY group_id DESC
             LIMIT ?`,
          )
          .all(before, size)
      : this.db
          .prepare(
            `${ACTIVITY_GROUPS}
             SELECT
               group_id AS id,
               MIN(at) AS at,
               MAX(CASE WHEN id = group_id AND kind = 'world' THEN 1 ELSE 0 END) AS is_moment
             FROM classified
             GROUP BY group_id
             ORDER BY group_id DESC
             LIMIT ?`,
          )
          .all(size);
    const eventsInGroup = this.db.prepare(
      `${ACTIVITY_GROUPS}
       SELECT id, at, kind, content, meta
       FROM classified
       WHERE group_id = ?
       ORDER BY id ASC`,
    );

    return groups.map((group) => {
      return {
        id: group.id,
        at: group.at,
        type: group.is_moment ? "moment" : "standalone",
        events: eventsInGroup.all(group.id).map(parse),
      };
    });
  }

  activityCount() {
    return this.db
      .prepare(`${ACTIVITY_GROUPS} SELECT COUNT(DISTINCT group_id) AS n FROM classified`)
      .get().n;
  }

  recent(kinds, limit = 20) {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    const holes = list.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM events WHERE kind IN (${holes}) ORDER BY id DESC LIMIT ?`,
      )
      .all(...list, limit)
      .map(parse)
      .reverse();
  }

  // Memory units are the parts of the record that can be carried, recalled,
  // shelved, or consolidated. An action and its result are one unit, named by
  // the action id. New results point back explicitly; old records are paired
  // by order so they remain usable without a migration.
  units() {
    const rows = this.since(0, 1_000_000);
    const shelved = this.shelvedIds();
    const forgotten = this.forgottenIds();
    const revised = this.revisedIds();
    // Forgotten is the stronger recession: gone from context and from recall.
    // Shelved recedes from context but stays reachable. A unit can be neither.
    const stateOf = (id) => forgotten.has(id)
      ? "forgotten"
      : (revised.has(id) ? "revised" : (shelved.has(id) ? "shelved" : "active"));
    const units = [];
    const actions = new Map();
    const memories = new Map();
    const representedEmissions = new Set();
    let pending = null;
    for (const row of rows) {
      if (["incoming", "emission", "memory", "identity"].includes(row.kind)) {
        const unit = row.kind === "identity"
          ? { ...row, kind: "memory", meta: { ...row.meta, mental: "identity", authored: true, legacyKind: "identity" }, state: stateOf(row.id) }
          : { ...row, state: stateOf(row.id) };
        units.push(unit);
        if (unit.kind === "memory") {
          memories.set(row.id, unit);
          const felt = Number(row.meta?.felt);
          if (Number.isInteger(felt) && felt > 0) representedEmissions.add(felt);
        }
        continue;
      }
      if (row.kind === "action") {
        pending = { ...row, result: null, state: stateOf(row.id) };
        actions.set(row.id, pending);
        units.push(pending);
        continue;
      }
      if (row.kind !== "result") continue;
      const linked = actions.get(Number(row.meta?.action)) || pending;
      if (linked && !linked.result) {
        linked.result = row;
        // Facts are projected from the exact call and result using the current
        // contract. Old metadata contained unsupported labels such as
        // "heard" and "delivered"; retaining the raw record is important,
        // carrying those labels forward as facts is not.
        linked.fact = actionFact(linked.meta, {
          value: row.meta?.value,
          yielded: row.meta?.yielded,
          error: row.meta?.error,
        });
        // A second feel() in the same emission reuses its first memory. Its
        // distinct feeling stays in the exact action/result record and is
        // projected onto that one memory here, without copying the emission.
        if (linked.meta?.name === "feel") {
          const value = row.meta?.value && typeof row.meta.value === "object" ? row.meta.value : {};
          const memory = memories.get(Number(value.memory));
          if (memory) {
            memory.meta = withFeeling(
              memory.meta,
              value.emotion ?? linked.meta?.args?.[0],
              value.intensity ?? linked.meta?.args?.[1],
            );
          }
        }
      }
      if (linked === pending) pending = null;
    }
    // A felt memory is the model-facing identity of that experience. The raw
    // emission remains byte-for-byte in the event record, but carrying both
    // would make one experience appear twice in recall, consolidation, and
    // conversation history.
    return units.filter((unit) => !(unit.kind === "emission" && representedEmissions.has(unit.id)));
  }

  unit(id) {
    return this.units().find((row) => row.id === Number(id)) || null;
  }

  shelvedIds() {
    const ids = new Set();
    for (const row of this.recent("shelf", 1_000_000)) {
      const target = Number(row.meta?.target);
      if (Number.isInteger(target) && target > 0) ids.add(target);
    }
    return ids;
  }

  // Targets of forget events. These units are gone from her — out of context
  // and out of recall — but their rows remain in the record as the operator's
  // kept copy. A forget is never undone from her side.
  forgottenIds() {
    const ids = new Set();
    for (const row of this.recent("forget", 1_000_000)) {
      const target = Number(row.meta?.target);
      if (Number.isInteger(target) && target > 0) ids.add(target);
    }
    return ids;
  }

  revisedIds() {
    const ids = new Map();
    for (const row of this.recent("revise", 1_000_000)) {
      const target = Number(row.meta?.target);
      const replacement = Number(row.meta?.replacement);
      if (Number.isInteger(target) && target > 0) ids.set(target, replacement || null);
    }
    return ids;
  }

  isShelved(id) {
    const target = Number(id);
    if (!Number.isInteger(target) || target < 1) return false;
    return this.db
      .prepare("SELECT 1 FROM events WHERE kind = 'shelf' AND CAST(json_extract(meta, '$.target') AS INTEGER) = ? LIMIT 1")
      .get(target) != null;
  }

  // What recall() reaches. Shelving changes automatic context, never reach.
  // A bare integer is an exact unit number; every other value is a text
  // search across thought, incoming words, memories, calls, and call results.
  search(query, limit = Infinity) {
    const wanted = String(query || "").trim();
    const needle = wanted.toLocaleLowerCase();
    const resolved = this.resolvedIds();
    const matches = this.units()
      .map((row) => this.withResolution(row, resolved))
      .filter((row) => row.state !== "forgotten")
      .filter((row) => {
        const result = row.result?.content || "";
        return `${row.content}\n${result}`.toLocaleLowerCase().includes(needle);
      });
    const size = Number(limit);
    const kept = Number.isFinite(size) && size > 0 ? matches.slice(-Math.floor(size)) : matches;
    return kept.reverse();
  }

  activeMemories() {
    const standing = this.standingIntentionIds();
    const resolved = this.resolvedIds();
    return this.units().filter((row) =>
      row.kind === "memory"
      && row.state === "active"
      && row.meta?.mental !== "identity"
      && !standing.has(row.id))
      .map((row) => this.withResolution(row, resolved));
  }

  // What follows as durable memory: completed actions as compact objective
  // facts, plus the long-term memories she authored. Thoughts and incoming
  // words remain exact episodic sources and can be consolidated, but are not
  // silently rewritten into summaries by the runtime. An UNRESOLVED intention is
  // excluded here — it lives in the INTENTION view instead; once resolved it
  // falls back into ordinary memory, consolidate/shelve/recall-able like any.
  followingMemories() {
    const standing = this.standingIntentionIds();
    const resolved = this.resolvedIds();
    return this.units().filter((row) =>
      row.state === "active" && !standing.has(row.id) && (
        (row.kind === "memory" && row.meta?.mental !== "identity") ||
        (row.kind === "action" && row.result && !isMemoryTransition(row.meta?.name))
      ),
    ).map((row) => this.withResolution(row, resolved));
  }

  withResolution(row, resolved = this.resolvedIds()) {
    const resolution = row.kind === "memory" && row.meta?.intention ? resolved.get(row.id) : null;
    return resolution ? { ...row, meta: { ...row.meta, resolution } } : row;
  }

  // --- Intention: a memory the mind stands behind until it resolves it. Stored
  // as an ordinary memory unit tagged {intention:true}; its standing/resolved
  // status is a marker layer over the append-only log, exactly like shelve. It
  // is never deleted — resolving only records how it ended.
  resolvedIds() {
    const out = new Map(); // target id -> exact resolution
    for (const row of this.recent("resolve", 1_000_000)) {
      const target = Number(row.meta?.target);
      if (Number.isInteger(target)) out.set(target, {
        id: row.id,
        outcome: row.meta?.outcome || "done",
        evidence: String(row.meta?.evidence || ""),
        at: row.at,
      });
    }
    return out;
  }

  // Ids of intentions still standing in active attention: set, not resolved,
  // and not shelved or forgotten. Shelving or forgetting an intention is a
  // legitimate way to let a goal recede — it then leaves the INTENTION view
  // like any receding memory (still recallable if only shelved), which is why
  // this requires state "active", not merely "not forgotten".
  standingIntentionIds() {
    const resolved = this.resolvedIds();
    const ids = new Set();
    for (const row of this.units()) {
      if (row.kind === "memory" && (row.meta?.intention || row.meta?.mental === "intention") && !resolved.has(row.id) && row.state === "active") {
        ids.add(row.id);
      }
    }
    return ids;
  }

  // The standing intentions, oldest first — what she is currently trying to do.
  activeIntentions() {
    const standing = this.standingIntentionIds();
    const updates = new Map();
    for (const row of this.recent("progress", 1_000_000)) {
      const target = Number(row.meta?.target);
      if (!Number.isInteger(target)) continue;
      const list = updates.get(target) || [];
      list.push(row);
      updates.set(target, list);
    }
    return this.units().filter((row) => standing.has(row.id)).map((row) => {
      const progress = updates.get(row.id) || [];
      const latest = progress.at(-1);
      const carried = Array.isArray(row.meta?.evidence) ? row.meta.evidence.filter(Boolean) : [];
      return {
        ...row,
        meta: {
          ...row.meta,
          evidence: [...carried, ...progress.map((one) => String(one.content || "")).filter(Boolean)],
          next: String(latest?.meta?.next || row.meta?.next || ""),
          cue: String(latest?.meta?.cue || row.meta?.cue || ""),
        },
      };
    });
  }

  intend(text, success = "", cue = "") {
    const goal = String(text || "").trim();
    if (!goal) return { note: "intend needs the goal as text" };
    const doneWhen = String(success || "").trim();
    const when = String(cue || "").trim();
    this.append("memory", goal, {
      mental: "intention", intention: true, authored: true,
      success: doneWhen, cue: when,
    });
    return {
      intention: goal,
      ...(doneWhen ? { success: doneWhen } : {}),
      ...(when ? { cue: when } : {}),
    };
  }

  currentIdentity() {
    return this.units().filter((row) =>
      row.kind === "memory" && row.meta?.mental === "identity" && row.state === "active").at(-1) || null;
  }

  identify(text) {
    const identity = String(text || "").trim();
    if (!identity) return { note: "identify needs identity text" };
    const previous = this.currentIdentity();
    const memory = this.append("memory", identity, {
      mental: "identity", authored: true, previous: previous?.id || null,
    });
    if (previous) this.append("revise", previous.content, { target: previous.id, replacement: memory.id });
    return { identity };
  }

  remember(kind, text, cue = "") {
    const mental = String(kind || "").trim().toLocaleLowerCase().replace(/\s+/g, " ").slice(0, 40);
    const content = String(text || "").trim();
    if (!mental) return { note: "remember needs a kind" };
    if (!content) return { note: "remember needs text" };
    if (mental === "identity") return this.identify(content);
    const when = String(cue || "").trim();
    if (mental === "intention") return this.intend(content, "", when);
    this.append("memory", content, { mental, authored: true, cue: when });
    return { kind: mental, memory: content, ...(when ? { cue: when } : {}) };
  }

  revisableMemories(query) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle) return [];
    const world = this.last("world");
    return this.units().filter((row) =>
      row.kind === "memory"
      && row.state === "active"
      && !(world && row.id > world.id)
      && String(row.content).toLocaleLowerCase().includes(needle));
  }

  revise(id, text) {
    const target = this.unit(id);
    const content = String(text || "").trim();
    if (!target || target.kind !== "memory" || target.state !== "active") return { note: "that memory is not active" };
    if (!content) return { note: "revise needs the new memory as text" };
    const enriched = target.meta?.intention
      ? this.activeIntentions().find((row) => row.id === target.id) || target
      : target;
    const meta = {
      ...enriched.meta,
      authored: true,
      previous: target.id,
    };
    delete meta.resolution;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replacement = this.append("memory", content, meta);
      this.append("revise", target.content, { target: target.id, replacement: replacement.id });
      this.db.exec("COMMIT");
      return { kind: meta.mental || "memory", before: target.content, memory: content };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  visibleIntention(query) {
    const raw = String(query ?? "").trim();
    if (!raw) return { note: "no intention was named" };
    const world = this.last("world");
    const standing = this.activeIntentions()
      .filter((row) => !(world && row.id > world.id));
    if (!standing.length) return { note: "there are no standing intentions" };
    const needle = raw.toLocaleLowerCase();
    const target = standing.find((row) => String(row.content).toLocaleLowerCase().includes(needle));
    return target || { note: `no standing intention matches ${JSON.stringify(raw)}` };
  }

  progress(query, evidence, next = "", cue = "") {
    const target = this.visibleIntention(query);
    if (target?.note) return target;
    const observed = String(evidence || "").trim();
    if (!observed) return { note: "progress needs evidence" };
    const following = String(next || "").trim();
    const when = String(cue || "").trim();
    this.append("progress", observed, { target: target.id, next: following, cue: when });
    return {
      intention: target.content,
      evidence: observed,
      ...(following ? { next: following } : {}),
      ...(when ? { cue: when } : {}),
    };
  }

  // Resolve by a phrase in the intention's text. Unit numbers stay underground
  // like every other memory key; a numeric phrase is still ordinary content.
  // Marks the intention done (default) or dropped; the memory unit remains.
  resolve(query, outcome = "done", evidence = "") {
    const target = this.visibleIntention(query);
    if (target?.note) return target;
    const mark = /^(drop|dropp?ed|abandon|cancel)/i.test(String(outcome)) ? "dropped" : "done";
    const observed = String(evidence || "").trim();
    this.append("resolve", target.content, { target: target.id, outcome: mark, evidence: observed });
    return {
      intention: target.content,
      outcome: mark,
      ...(observed ? { evidence: observed } : {}),
    };
  }

  lastCarriedEmission() {
    const row = this.last("emission");
    if (!row) return null;
    const units = this.units();
    const felt = units.filter((unit) =>
      unit.kind === "memory" && Number(unit.meta?.felt) === row.id);
    // Once feel() gives an emission one memory identity, that identity owns
    // whether the experience remains present. Shelving or forgetting it must
    // not let the raw emission resurrect through PREVIOUS.
    if (felt.length) return felt.some((unit) => unit.state === "active") ? row : null;
    const raw = units.find((unit) => unit.id === row.id);
    return raw?.state === "active" ? row : null;
  }

  // The calls of the most recent completed moment. A shelved action takes its
  // result with it; neither half can remain in automatic context by itself.
  lastMomentResults() {
    const world = this.last("world");
    if (!world) return [];
    const units = this.units().filter((row) => row.kind === "action" && row.id > world.id);
    return units
      .filter((row) => row.state === "active" && row.result)
      .map((row) => ({ id: row.id, call: row.content, value: modelResultContent(row) }));
  }

  // Lines from the most recent moment that were written in the shape of a call
  // but could not be read as one. Surfaced so the drop is a visible result in
  // her room, not a silence: she sees the exact text and that it did not become
  // an act, and can put each call on its own line next time. Same boundary as
  // lastMomentResults — everything since the previous room.
  lastMomentUnread() {
    const world = this.last("world");
    if (!world) return [];
    return this.recent("error", 1_000_000)
      .filter((row) => row.id > world.id && row.meta?.stage === "unread")
      .flatMap((row) => String(row.content).split("\n").slice(1))
      .map((line) => line.trim())
      .filter(Boolean);
  }

  modelResult(unit) {
    return modelResultContent(unit);
  }

  shelf(id) {
    const target = this.unit(id);
    if (!target) return { note: `there is no memory unit numbered ${Number(id) || id}` };
    const world = this.last("world");
    if (world && target.id > world.id) {
      return { note: `unit #${target.id} was not available when this moment began` };
    }
    if (target.state === "shelved") return { unit: target.id, state: "shelved", already: true };
    const event = this.append("shelf", `unit #${target.id}`, { target: target.id });
    return { unit: target.id, kind: target.kind, state: "shelved", event: event.id };
  }

  // Shelve several units in one pass without rebuilding the projection per id
  // (calling shelf() in a loop is O(n²) and hangs on a large bulk shelve). The
  // caller passes ids it already matched as active; we still guard the moment
  // boundary and skip anything already receded. Returns the ids that receded.
  shelfMany(ids, label = null) {
    const world = this.last("world");
    const index = new Map(this.units().map((unit) => [unit.id, unit]));
    const done = [];
    const name = String(label || "").trim() || null;
    for (const id of [...new Set(ids.map(Number))]) {
      const target = index.get(id);
      if (!target || (world && target.id > world.id)) continue;
      if (target.state === "shelved" || target.state === "forgotten") continue;
      this.append("shelf", `unit #${target.id}`, { target: target.id, label: name });
      done.push(target.id);
    }
    return done;
  }

  // The names memories have been shelved under, each still holding at least one
  // memory not since forgotten. These are the folder labels she reaches back for
  // with recall(); without them a shelved memory is lost as surely as a
  // forgotten one — the reference is what separates shelve from forget. Only
  // labels from her explicit shelve() appear; a consolidation leaves its summary
  // as the reference instead, so its auto-shelved detail carries no label here.
  shelfLabels() {
    const forgotten = this.forgottenIds();
    const seen = new Set();
    const labels = [];
    for (const row of this.recent("shelf", 1_000_000)) {
      const label = row.meta?.label;
      if (!label || forgotten.has(Number(row.meta?.target)) || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    return labels;
  }

  // One transaction creates the authored memory and shelves every active
  // source. Either the whole change enters her life or none of it does.
  consolidate(ids, text) {
    if (!Array.isArray(ids) || !ids.length) return { note: "consolidate takes a non-empty array of unit numbers" };
    const content = String(text || "").trim();
    if (!content) return { note: "consolidate needs the long-term memory as text" };
    // Tolerant: keep the numbers that are real memory units and were available
    // this moment, and skip the rest instead of throwing the whole thing away.
    // One stray action number should not cost her a long consolidation.
    const asked = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id >= 1);
    const world = this.last("world");
    // Build the unit index ONCE. Calling this.unit(id) per id rebuilds the whole
    // projection for every number — O(n²) — which pins a core for minutes when a
    // consolidation folds hundreds of memories at once.
    const index = new Map(this.units().map((unit) => [unit.id, unit]));
    const units = [];
    const skipped = [];
    for (const id of asked) {
      const unit = index.get(id);
      if (!unit || unit.state === "forgotten" || (world && unit.id > world.id)) skipped.push(id);
      else units.push(unit);
    }
    if (!units.length) {
      return { note: `none of those were memory units available to consolidate${skipped.length ? `; not units: ${skipped.join(", ")}` : ""}` };
    }
    const sources = units.map((unit) => unit.id);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const memory = this.append("memory", content, { mental: "memory", authored: true, sources });
      const shelved = [];
      for (const unit of units) {
        if (unit.state === "shelved") continue;
        this.append("shelf", `unit #${unit.id}`, { target: unit.id, by: memory.id });
        shelved.push(unit.id);
      }
      this.db.exec("COMMIT");
      return { memory: memory.id, sources, shelved, state: "active", ...(skipped.length ? { skipped } : {}) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // A feeling. She names it and how strongly, and it fastens onto the words
  // she is saying this moment — the way an emotion in a person attaches to what
  // they were thinking when it struck. What she felt strongly about becomes a
  // memory that lasts; what she never felt anything about fades to recall.
  //
  // This is emotion she wields, not emotion put in her. The runtime never
  // decides she is sad and shows her a number — the five drifting values that
  // did that were deleted for exactly that reason. Here nothing feels anything
  // until she says so, and when she does it is her own word, carried exactly.
  feel(emotion, intensity) {
    const feeling = String(emotion || "").trim();
    if (!feeling) return { note: "feel takes an emotion and how strong it is" };
    // Intensity is a point number from 0 to 1, kept as she gave it — not rounded
    // to an integer (which flattened every 0.7 to 1) and not left unbounded (a
    // model that guesses a 0–10 scale would store 8). Clamped to [0,1], decimal
    // preserved.
    const level = Math.round(Math.min(1, Math.max(0, Number(intensity) || 0)) * 100) / 100;
    const said = this.last("emission");
    const words = said ? String(said.content || "").trim() : "";
    // Her words are what the feeling is about; keeping them is not putting
    // anything in her mouth, it is holding onto what she was saying when it
    // struck. Capped so one long moment cannot dominate, never silently — the
    // record keeps the whole emission regardless.
    const kept = words;
    // The emission is the remembered experience. More than one feeling can
    // attach to it, but the words enter memory only once. Every feel() call is
    // still preserved independently as an action/result in the exact record.
    const existing = said
      ? this.db.prepare(`
          SELECT id FROM events
          WHERE kind = 'memory'
            AND CAST(json_extract(meta, '$.felt') AS INTEGER) = ?
          ORDER BY id ASC LIMIT 1
        `).get(said.id)
      : null;
    const memory = existing || this.append("memory", kept || feeling, {
      mental: "episode", emotion: feeling, intensity: level, felt: said?.id ?? null,
    });
    return { emotion: feeling, intensity: level, memory: memory.id, felt: said?.id ?? null };
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  }

  // Her own past, let go by her. A tombstone, not a deletion: each unit gets a
  // forget event that moves it beyond both automatic context and recall, so to
  // her it is gone for good and cannot be reached back. The rows themselves are
  // never removed — the operator keeps the full copy for the record. Phrase→id
  // resolution happens in body so a number never surfaces to her; this takes
  // the resolved ids and returns the ones newly forgotten.
  forget(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const already = this.forgottenIds();
    const forgotten = [];
    for (const id of list) {
      const target = Number(id);
      if (!Number.isInteger(target) || target < 1 || already.has(target)) continue;
      this.append("forget", `unit #${target}`, { target });
      forgotten.push(target);
    }
    return forgotten;
  }

  // Everything after a point, removed. Used by rewind.mjs; see the note there
  // about why this is not undo.
  rewind(toId) {
    const info = this.db.prepare("DELETE FROM events WHERE id > ?").run(Number(toId));
    return Number(info.changes || 0);
  }

  // A new birth. Everything she ever did goes, which is the point — a reset
  // that kept her past would not be a first moment. The authored setup is
  // deliberately spared: the room is the operator's, not hers, and rewriting
  // it every time would make experiments impossible to repeat.
  wipe({ keep = [] } = {}) {
    const spared = keep.map((key) => [key, this.get(key, null)]);
    this.db.exec("DELETE FROM events; DELETE FROM kv;");
    for (const [key, value] of spared) if (value != null) this.set(key, value);
  }

  // Messages only. This used to be done by taking the next 50 events of any
  // kind and filtering them, which meant a message arriving while she was
  // busy fell outside the window and was never shown to her — the count in
  // CONTEXT went up and the words never appeared. Six of them were lost that
  // way in one afternoon.
  incomingSince(id, limit = 50) {
    return this.db
      .prepare("SELECT * FROM events WHERE kind = 'incoming' AND id > ? ORDER BY id ASC LIMIT ?")
      .all(Number(id) || 0, limit)
      .map(parse);
  }

  // Everything said to her that she has not answered, tracked per context.
  //
  // Two ways this went wrong before. Clearing on any outgoing message meant
  // that when both contexts wrote and she replied to one, the other's message
  // vanished. And inferring "answered" from id order meant a message arriving
  // while she was mid-call counted as answered by a reply written before it
  // existed — she was never shown it at all.
  //
  // So: answered is recorded explicitly, per context, and only for messages
  // that were actually in front of her when she replied.
  unanswered(limit = Infinity) {
    const answered = this.get("answered_v1", {}) || {};
    const shelved = this.shelvedIds();
    const forgotten = this.forgottenIds();
    const rows = this.db
      .prepare("SELECT * FROM events WHERE kind = 'incoming' ORDER BY id ASC")
      .all()
      .map(parse)
      .filter((row) => !shelved.has(row.id) && !forgotten.has(row.id))
      .filter((row) => row.id > (answered[row.meta?.from || "someone"] ?? 0));
    const size = Number(limit);
    return Number.isFinite(size) && size > 0 ? rows.slice(-Math.floor(size)) : rows;
  }

  markAnswered(who, upToId) {
    const answered = this.get("answered_v1", {}) || {};
    if (!(upToId > (answered[who] ?? 0))) return answered;
    answered[who] = upToId;
    this.set("answered_v1", answered);
    return answered;
  }

  // What living has cost today, kept in its three real parts. Cached input is
  // billed differently but still has to be attended to, so it cannot be
  // netted off against the rest — it belongs next to it, not inside it.
  spentToday(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    return this.spent(`${day}%`);
  }

  // The same exact accounting across the current life, from its first event.
  spentLife() {
    return this.spent();
  }

  spent(atLike = null) {
    const read = (kind) => atLike
      ? this.db.prepare("SELECT meta FROM events WHERE kind = ? AND at LIKE ?").all(kind, atLike)
      : this.db.prepare("SELECT meta FROM events WHERE kind = ?").all(kind);
    let fresh = 0;
    let cached = 0;
    let output = 0;
    let moments = 0;
    for (const row of read("emission")) {
      try {
        const u = (JSON.parse(row.meta).usage) || {};
        const hit = u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
        fresh += Math.max(0, (u.prompt_tokens || 0) - hit);
        cached += hit;
        output += u.completion_tokens || 0;
        moments += 1;
      } catch {
        // an unparseable meta is not worth failing a count over
      }
    }
    let beats = 0;
    let beatTokens = 0;
    for (const row of read("beat")) {
      try {
        beatTokens += JSON.parse(row.meta).tokens || 0;
        beats += 1;
      } catch {
        // same
      }
    }
    return { fresh, cached, output, beatTokens, moments, beats, tokens: fresh + cached + output + beatTokens };
  }

  byId(id) {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(Number(id));
    return row ? parse(row) : null;
  }

  countOf(kind) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind).n;
  }

  first() {
    const row = this.db.prepare("SELECT * FROM events ORDER BY id ASC LIMIT 1").get();
    return row ? parse(row) : null;
  }

  last(kind) {
    const row = this.db
      .prepare("SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1")
      .get(kind);
    return row ? parse(row) : null;
  }

  // Every call she has made, by name, and how many of them came back with
  // something rather than a failure. Counts, not a score.
  reaching() {
    const rows = this.db
      .prepare("SELECT content, meta FROM events WHERE kind = 'result'")
      .all();
    const tally = new Map();
    for (const row of rows) {
      let meta = {};
      try {
        meta = JSON.parse(row.meta);
      } catch {
        meta = {};
      }
      const name = meta.name || "?";
      const entry = tally.get(name) || { called: 0, returned: 0 };
      entry.called += 1;
      if (meta.yielded !== false) entry.returned += 1;
      tally.set(name, entry);
    }
    return tally;
  }

  // The last explicit language action, including the historical name `speak`,
  // and whether anything has been said to her since.
  lastSpoke() {
    const row = this.db
      .prepare("SELECT * FROM events WHERE kind = 'action' AND (meta LIKE '%\"name\":\"speak\"%' OR meta LIKE '%\"name\":\"think\"%' OR meta LIKE '%\"name\":\"speak_aloud\"%') ORDER BY id DESC LIMIT 1")
      .get();
    if (!row) return null;
    const answered = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'incoming' AND id > ?")
      .get(row.id).n;
    return { ...parse(row), answered };
  }

  get(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}

function modelResultContent(unit) {
  const recorded = unit?.result?.meta?.value;
  const raw = recorded && typeof recorded === "object" ? recorded : {};
  const didFail = unit?.result?.meta?.yielded === false || unit?.result?.meta?.error || raw.status === "failed" || raw.note;
  const reason = String(raw.reason || raw.note || unit?.result?.meta?.error || unit?.result?.content || "the action did not complete");
  if (didFail) return formatModelResult({ status: "failed", reason });

  const name = String(unit?.meta?.name || unit?.result?.meta?.name || "");
  const args = Array.isArray(unit?.meta?.args) ? unit.meta.args : [];
  if (["speak", "think", "speak_aloud"].includes(name)) {
    return formatModelResult({
      status: "success",
      characters: Number(raw.characters) || String(args[0] || raw.spoken || "").trim().length,
      ...(name === "speak_aloud" && raw.receivedBy ? { receivedBy: raw.receivedBy } : {}),
    });
  }
  if (name === "email") {
    return formatModelResult({
      status: "success",
      ...(raw.letter ? { letter: raw.letter } : {}),
      stored: "local",
      to: raw.to || args[0] || "",
      subject: raw.subject ?? args[1] ?? "",
      characters: Number(raw.characters) || String(args[2] || "").trim().length,
    });
  }
  if (name === "forget") {
    return formatModelResult({
      status: "success",
      query: raw.query || args[0] || "",
      removed: Number(raw.removed || 0),
      scope: "current record",
    });
  }

  const { status: _status, note: _note, reason: _reason, ...facts } = raw;
  return formatModelResult({ status: "success", ...(Object.keys(facts).length ? facts : { result: unit?.result?.content || "completed" }) });
}

function formatModelResult(value) {
  // No artificial window on what a result carries. A command's output — however
  // long — is a perception, and a brain must not silently drop half of what it
  // sees. The token ledger (active attention vs. capacity) is the ONLY bound on
  // the room; its cost is felt there and managed by consolidate/shelve/forget,
  // never sliced away here where the loss would be invisible. This matches the
  // record's stated discipline: "nothing is removed to make it fit."
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (item == null || item === "") continue;
    if (Array.isArray(item)) {
      lines.push(`${key}: ${item.length}`);
      for (const entry of item) lines.push(`  ${modelValue(entry)}`);
    } else {
      lines.push(`${key}: ${modelValue(item)}`);
    }
  }
  return lines.join("\n");
}

function modelValue(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return Object.entries(value)
    .filter(([, item]) => item != null && item !== "")
    .map(([key, item]) => `${key} ${typeof item === "object" ? modelValue(item) : item}`)
    .join(", ");
}

function parse(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta);
  } catch {
    meta = {};
  }
  return { ...row, meta };
}
