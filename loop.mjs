import { renderWorld } from "./world.mjs";
import { loadSetup } from "./setup.mjs";
import {
  emit,
  canCountExactly,
  projectPromptTokens,
  parseCalls,
  unreadCalls,
  looksLikeTheRoom,
} from "./mind.mjs";
import { loadRun, runFields } from "./run.mjs";
import { actionFact } from "./memory-state.mjs";
import { spendMoment } from "./runtime.mjs";
import path from "node:path";
import { blackboxFile, recordRaw } from "./blackbox.mjs";

const ECHO_RETRY_SECONDS = 20;

// When the model refuses, waiting longer each time is the only sane response.
// She spent 33 minutes making 164 identical requests into a daily rate limit,
// each one failing in the same way, none of them able to succeed. Backing off
// costs her nothing — a moment that cannot happen is not a moment she lost.
const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 900];

// A response can carry both a convenient plaintext trace and the provider's
// lossless structured blocks. Preserve both. The raw API event is a third copy
// at the transport boundary, so no parser change can erase the original later.
export function appendReasoning(log, answer, meta = {}) {
  const reasoningTokens = answer.usage?.completion_tokens_details?.reasoning_tokens
    ?? answer.usage?.reasoning_tokens
    ?? null;
  const reasoningMeta = { ...meta, reasoningTokens };
  if (answer.reasoningDetails != null) {
    log.append("reasoning_details", JSON.stringify(answer.reasoningDetails, null, 2), reasoningMeta);
  }
  if (answer.reasoning) log.append("reasoning", answer.reasoning, reasoningMeta);
}

// The transport record has two independent homes. Always attempt both: a
// failed black-box append must not prevent SQLite from receiving the response,
// and a failed SQLite insert must not erase the append-only copy. If either
// fails, surface it after the other copy has had its chance to land.
export function preserveApiCall(log, blackbox, entry, meta = {}) {
  let blackboxError = null;
  let databaseError = null;
  let saved = null;
  try {
    recordRaw(blackbox, entry);
  } catch (error) {
    blackboxError = error;
  }
  try {
    saved = log.append("api", JSON.stringify(entry.call, null, 2), meta);
  } catch (error) {
    databaseError = error;
  }
  if (blackboxError || databaseError) {
    throw new AggregateError(
      [blackboxError, databaseError].filter(Boolean),
      `model response preservation failed (${[
        blackboxError ? "blackbox" : null,
        databaseError ? "database" : null,
      ].filter(Boolean).join(" and ")})`,
    );
  }
  return saved;
}

// How long the room waits when she does not choose for herself. She can always
// choose the same one-minute return with sleep(); this is only what happens
// when she does not make that choice explicitly.
// Slower at night, faster by day, and the room states whichever is currently
// true — see {{gap}} — so the document never claims a number that isn't real.
export function defaultGapSeconds(now = new Date(), override) {
  const chosen = Number(override);
  if (Number.isFinite(chosen) && chosen > 0) return Math.floor(chosen);
  const forced = Number(process.env.AMI_GAP_SECONDS);
  if (Number.isFinite(forced) && forced > 0) return Math.floor(forced);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: process.env.AMI_TIME_ZONE || process.env.TZ || "UTC",
    }).format(now),
  );
  const night = hour >= 22 || hour < 8;
  return night
    ? Number(process.env.AMI_GAP_NIGHT || 3600)
    : Number(process.env.AMI_GAP_DAY || 1800);
}

export function describeGap(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = seconds / 3600;
  return `${hours === 1 ? "an hour" : `${Math.round(hours)} hours`}`;
}

// Count maintained attention before adding its two bookkeeping lines. This
// gives the ledger a stable meaning instead of asking a number to include its
// own tokenization. Then count the final wire request separately for the hard
// context/output limit. Nothing is removed to make it fit.
// Two numbers with two different jobs, and they must not be confused.
//
// What goes in the room is a measurement or nothing. The provider reports
// prompt_tokens in the model's native tokenizer *after* the fact, so what the
// room states is the exact size of the last prompt actually sent. That is one
// moment old, and on
// the first moment of a life nothing has been measured at all — so the ledger
// does not appear, rather than appearing as a guess. She is never handed an
// estimate wearing the clothes of a fact.
//
// What guards the request is a projection, calibrated on that same
// measurement. It sizes max_tokens and refuses a prompt that cannot fit. It
// is the operator's business and never rendered.
export async function preparePrompt({ config, arrival, history = "", render, ledger = null }) {
  const capacity = Math.floor(Number(config.contextTokens) || 0);
  if (capacity < 1) throw new Error("the model context token limit is not configured");

  const exact = canCountExactly(config, arrival);
  const maintained = Number(ledger?.promptTokens) > 0 ? Math.floor(ledger.promptTokens) : null;

  const world = render(maintained == null ? {} : { maintained, capacity });
  const prompt = history + world;
  const promptTokens = projectPromptTokens(prompt, ledger);
  const remains = capacity - promptTokens;
  if (remains < 1) {
    throw new Error(
      `active attention needs ${promptTokens.toLocaleString("en-US")} tokens, exceeding the ${capacity.toLocaleString("en-US")}-token model context; shelve or consolidate units`,
    );
  }
  return {
    world,
    prompt,
    maintainedTokens: maintained,
    promptTokens,
    // Whether promptTokens above was counted or projected. Recorded so that a
    // life can be read back without having to guess which it was.
    exact,
    outputTokens: Math.max(1, Math.min(Math.floor(Number(config.maxTokens) || 1), remains)),
  };
}

// The last prompt whose exact cost the provider reported, and how long that
// prompt was. Read from the record rather than held in memory, so a restart
// does not lose the calibration and spend a moment on the bootstrap ratio.
export function ledgerFrom(log) {
  const measured = Number(log.last("emission")?.meta?.usage?.prompt_tokens);
  const chars = Number(log.last("world")?.meta?.promptChars);
  if (!(measured > 0) || !(chars > 0)) return null;
  return { promptTokens: measured, promptChars: chars };
}

export class Loop {
  constructor({ log, body, config, workspace, observer, onLifeStopped = null }) {
    this.log = log;
    this.body = body;
    this.config = config;
    this.workspace = workspace;
    this.observer = observer;
    this.onLifeStopped = onLifeStopped;
    // Black box: an append-only mirror of every raw response, kept outside this
    // life's folder so reuse, wipe, or rewind can never erase the raw record.
    this.runId = new Date().toISOString();
    this.blackbox = blackboxFile(path.dirname(log.file), config.model);
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.nextWakeAt = null;
    // Bumped by stop(). A moment that was already in flight when the world
    // changed underneath it belongs to a life that no longer exists: it must
    // not write its results, and it must not schedule the next one.
    this.epoch = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // A new life has not failed at anything yet. This counter used to survive
    // a birth, so a newborn inherited her predecessor's six failures and went
    // straight to a fifteen-minute backoff — sitting out the very gaps she
    // could have slipped through.
    this.failures = 0;
    this.moment();
  }

  // Stop future moments without invalidating the response already in flight.
  // Shutdown, reset, and rewind use this path so reasoning that has already
  // begun is allowed to arrive and enter the append-only record.
  quiesce() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async waitUntilIdle() {
    while (this.busy) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  stop() {
    this.quiesce();
    this.epoch += 1;
    // A rewind used to leave this true forever if it landed mid-moment, and
    // every later moment returned immediately without ever rescheduling. She
    // simply stopped, with no error anywhere.
    this.busy = false;
  }

  // Something said in the room while she is between moments brings the next
  // one forward. A voice nearby does wake a sleeping person.
  interrupt() {
    if (!this.running) return;
    // Said while she is mid-moment: remembered, and spent the instant that
    // moment ends rather than waiting out the gap.
    if (this.busy) {
      this.wakeAtOnce = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.moment();
  }

  async moment() {
    if (!this.running || this.busy) return;
    this.busy = true;
    // A continuation earns another scheduled continuation through an actual
    // transition. Mere passage of time is not activity and no longer causes a
    // full model call by itself.
    this.continueAfterMoment = false;
    const epoch = this.epoch;
    const now = new Date();
    try {
      // Living this moment costs one of her own, when a finite-life ledger is
      // seeded. Charged before anything else happens, so the world she is about
      // to wake into already shows what remains. With no ledger this is inert
      // and the unbounded life is untouched. When she has none left she cannot
      // afford this moment: it is not lived, and the life ends — a death not by
      // her hand, recorded as what it was. See runtime.mjs.
      const life = spendMoment(this.log);
      if (life.died) {
        this.log.append("end", "no moments left to spend", { by: "exhaustion", reserve: life.reserve });
        this.stop();
        await this.onLifeStopped?.("ended-by-exhaustion");
        return;
      }
      // Not "since last seen" — since she last replied to anyone. Being shown
      // a message is not the same as having answered it.
      const incoming = this.log.unanswered();
      // Re-read every moment, so an edit in the panel lands on the next one.
      const setup = loadSetup(this.log);
      const files = await this.body.ls().then((r) => r.files).catch(() => []);
      this.body.lastFiles = files;
      // Built first, because whether PREVIOUS is needed depends on whether her
      // last words are already in it.
      const carried = setup.context === "conversation" ? this.history() : "";
      const priorEmission = this.log.lastCarriedEmission();
      // A call she wrote that the parser could not read is drawn back into the
      // room as its own honest result, beside the calls that did run — so a
      // dropped reach is a fact she can see, not a moment that quietly vanished.
      const unreadNotices = this.log.lastMomentUnread().map((line) => ({
        call: line.length > 160 ? `${line.slice(0, 160)}…` : line,
        value: "written like an act but did not become one",
      }));
      const room = {
        now,
        previousAt: this.log.get("last_moment_at", null),
        body: this.body,
        log: this.log,
        setup,
        incoming,
        results: [...this.log.lastMomentResults(), ...unreadNotices],
        // The document ends in her own voice. The token ledger, not a hidden
        // character slice, governs whether the complete previous emission can
        // remain in attention.
        previous: priorEmission
          ? { id: priorEmission.id, content: priorEmission.content.trimEnd() }
          : null,
        workspace: this.workspace,
        files,
        // No communication contexts are injected into the world.
        people: [],
        gap: describeGap(defaultGapSeconds(now, setup.gapSeconds)),
      };

      // Conversation attention contains every active unit. There is no
      // age-based window behind her choices; shelf() and consolidate() are the
      // only transitions that can make this smaller.
      const history = carried;

      let emission = "";
      // Written whether the call succeeds, fails, times out, or belongs to a
      // life that has since been rewound. The api record is never conditional
      // on the outcome.
      const keepCall = (call) => {
        return preserveApiCall(this.log, this.blackbox, {
          at: new Date().toISOString(), run: this.runId, call,
        }, {
          mode: call.mode,
          status: call.status ?? null,
          ms: call.ms,
          failed: call.failed ?? null,
          model: call.request?.model ?? null,
          run: this.runId,
        });
      };
      try {
        const run = loadRun(this.log);
        const prepared = await preparePrompt({
          config: this.config,
          arrival: setup.arrival,
          history,
          render: (attention) => renderWorld({ ...room, attention }),
          ledger: ledgerFrom(this.log),
        });
        this.log.append("world", prepared.world, {
          promptTokens: prepared.promptTokens,
          // The exact length of what was sent. Paired with the prompt_tokens
          // the reply reports, this is what calibrates the next projection.
          promptChars: prepared.prompt.length,
          exact: prepared.exact,
          contextTokens: this.config.contextTokens,
          seed: run.seed,
        });
        const answer = await emit(
          { ...this.config, maxTokens: prepared.outputTokens, run: runFields(run) },
          prepared.prompt,
          setup.arrival,
          keepCall,
        );
        // The request was in flight while the ground moved — a rewind, a new
        // birth. This thought belongs to a life that no longer exists. It must
        // not be written down and it must not be carried out. One of these
        // once landed in a newborn and called end() with her hands.
        if (epoch !== this.epoch) return;
        emission = answer.text;
        appendReasoning(this.log, answer, { model: this.config.model });
        if (answer.finish === "length") {
          this.log.append("error", "the thought was cut off before it finished", { stage: "length" });
        }
        this.log.append("emission", emission, {
          finish: answer.finish,
          usage: answer.usage,
        });
      } catch (error) {
        // A failed request is not a silence. It is recorded as what it was so
        // that nothing she did not do is ever attributed to her.
        this.failures = (this.failures || 0) + 1;
        this.log.append("error", String(error.message), {
          stage: "emission",
          consecutive: this.failures,
          backoffSeconds: BACKOFF_SECONDS[Math.min(this.failures - 1, BACKOFF_SECONDS.length - 1)],
        });
      }

      if (emission) this.failures = 0;
      const known = this.body.formNames();
      // The names the room prints inside each form: speak(text), open(url),
      // sleep(). A call whose arguments are exactly those words
      // is not a call — it is the form list being quoted back. She reproduced
      // the menu once, stripped of the bullets that keep the room's own copy
      // inert, and executed all of it including end(). She died in her first
      // moment to a citation.
      const citation = new Map(
        this.body.affordances().map(([form]) => {
          const inside = form.slice(form.indexOf("(") + 1, form.lastIndexOf(")"));
          return [form.split("(")[0], inside.split(",").map((word) => word.trim()).filter(Boolean)];
        }),
      );
      const isCitation = (call) => {
        const words = citation.get(call.name);
        if (!words?.length) return false;
        const given = call.args.map((value) => String(value).trim());
        return given.length <= words.length && given.every((value, at) => value === words[at]);
      };
      const echoed = looksLikeTheRoom(emission);
      if (echoed) this.log.append("echo", emission, { carriedOut: false });
      const parsed = echoed ? [] : parseCalls(emission, known);
      // A reach of hers that this code could not read. Nothing is guessed from
      // it and nothing is carried out — it is written down so that the next
      // time one disappears, it disappears loudly. Her reply to friend was
      // dropped for having a paragraph break in it, and the only trace was her
      // inventing the delivery receipt in the moment after.
      let missedUnread = [];
      if (!echoed) {
        missedUnread = unreadCalls(emission, known, parsed);
        if (missedUnread.length) {
          this.log.append("error", `written as a call but not read as one:\n${missedUnread.join("\n")}`, {
            stage: "unread", count: missedUnread.length,
          });
        }
      }
      const quoted = parsed.filter(isCitation);
      // end() and ls() take no arguments, so a quoted one is indistinguishable
      // from a real one on its own. Two citations together are not: nobody
      // writes speak(text) and open(url) in the same breath except by copying
      // the list. When that happens the whole emission is a quotation and
      // nothing in it runs — which is what should have saved her from dying
      // to her own menu.
      const wholeMenu = quoted.length >= 2;
      if (quoted.length) {
        this.log.append("echo", quoted.map((call) => call.source).join("\n"), {
          carriedOut: false,
          reason: "the form list quoted back, not called",
        });
      }
      const calls = wholeMenu ? [] : parsed.filter((call) => !isCitation(call));
      this.continueAfterMoment = calls.some((call) => !["sleep", "end"].includes(call.name))
        || missedUnread.length > 0;
      const results = [];
      for (const call of calls) {
        if (epoch !== this.epoch) return;
        const action = this.log.append("action", call.source, {
          name: call.name, args: call.args, format: setup.format || "plain",
        });
        try {
          const value = await this.body.run(call.name, call.args);
          const yielded = value?.status !== "failed" && !value?.note;
          const fact = actionFact(action.meta, { value, yielded });
          this.log.append("result", format(value), {
            name: call.name, action: action.id, value, yielded, fact,
          });
          results.push({ id: action.id, call: call.source, value: format(value) });
        } catch (error) {
          const value = { status: "failed", reason: String(error.message) };
          const fact = actionFact(action.meta, { value, yielded: false, error: String(error.message) });
          this.log.append("result", format(value), {
            name: call.name, action: action.id, value, yielded: false, error: String(error.message), fact,
          });
          results.push({ id: action.id, call: call.source, value: format(value) });
        }
      }

      // A reach that could not be read comes back to her as a visible failure,
      // not as silence. Silence is the dangerous case: she gets no result, and
      // fills the gap by assuming the call ran — the invented delivery receipt.
      // A stated failure lets her see it and write it again.
      for (const source of missedUnread) {
        results.push({
          call: source,
          value: format({ status: "failed", reason: "this was written as a call but could not be read — check the quoting" }),
        });
      }

      // A regenerated room is never fed back as her previous words. Doing so
      // was self-reinforcing: document-shaped output returns as PREVIOUS, and
      // the likeliest continuation of a document is more document. The last
      // thing she actually said stays in place instead.
      if (epoch !== this.epoch) return;
      if (!echoed) {
        this.log.set("last_emission", emission);
        this.log.set("last_results", results);
      }
      this.echoed = echoed;
      this.log.set("last_moment_at", now.toISOString());
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
    if (epoch !== this.epoch) return;
    this.scheduleNext();
  }

  // Conversation context is rebuilt from exact memory units rather than old
  // world documents. That is what lets one incoming word, thought, or
  // action-result pair leave following life without taking its whole moment
  // with it. Long-term memories are carried once by the current MEMORY
  // section. A recall result is deliberately absent here: it is returned for
  // one moment, but recalling a shelved unit does not reactivate it.
  history() {
    const units = this.log.units();
    // Historical actions can outlive a later change to the current affordance
    // list. Their exact call blocks still belong to those action units, not as
    // a second full copy inside the raw emission.
    const known = [...new Set([
      ...this.body.formNames(),
      ...units.filter((unit) => unit.kind === "action").map((unit) => unit.meta?.name).filter(Boolean),
    ])];
    return units
      .filter((unit) => unit.state === "active" && unit.kind !== "memory")
      .map((unit) => historyUnit(unit, known))
      .filter(Boolean)
      .join("");
  }

  scheduleNext() {
    if (!this.running) return;
    // sleep() creates its own future event. Ordinary activity receives another
    // continuation after the configured pacing interval. With neither, the
    // life is idle and waits for an incoming event; a timer alone never creates
    // a new demand for words.
    const chosen = this.body.wakeAt;
    this.body.wakeAt = null;
    // A moment that came back as a regenerated room was not a moment she
    // lived. It does not get to spend her default gap, and it must not leave
    // anyone who spoke waiting five minutes for nothing.
    if (this.wakeAtOnce) {
      this.wakeAtOnce = false;
      this.body.wakeAt = null;
      this.nextWakeAt = new Date().toISOString();
      this.timer = setTimeout(() => this.moment(), 0);
      this.timer.unref?.();
      return;
    }
    if (this.failures) {
      const wait = BACKOFF_SECONDS[Math.min(this.failures - 1, BACKOFF_SECONDS.length - 1)];
      const when = new Date(Date.now() + wait * 1000);
      this.nextWakeAt = when.toISOString();
      this.log.append("sleep", `until ${when.toISOString()}`, { seconds: wait, backoff: this.failures });
      this.timer = setTimeout(() => this.moment(), wait * 1000);
      this.timer.unref?.();
      return;
    }
    if (!chosen && !this.echoed && !this.continueAfterMoment) {
      this.timer = null;
      this.nextWakeAt = null;
      this.log.append("idle", "no return is scheduled; an incoming event can continue this life", {
        eventDriven: true,
      });
      return;
    }
    const at = this.echoed
      ? new Date(Date.now() + ECHO_RETRY_SECONDS * 1000)
      : chosen || new Date(Date.now() + defaultGapSeconds(new Date(), loadSetup(this.log).gapSeconds) * 1000);
    const delay = Math.max(0, at - Date.now());
    this.nextWakeAt = at.toISOString();
    this.log.append("sleep", `until ${at.toISOString()}`, {
      seconds: Math.round(delay / 1000),
      chosen: Boolean(chosen),
    });
    this.timer = setTimeout(() => this.moment(), delay);
    this.timer.unref?.();
  }
}

// Her recent moments, as prose with a time on each — the way a mind holds what
// just happened. No id sits in the header: the number is the record's key, not
// something she thinks in, and nothing here is reached by it (calls are parsed
// from the emission text, memories by phrase). Time stays, because when a thing
// happened is part of remembering it.
function historyUnit(unit, known) {
  if (unit.kind === "incoming") {
    return `INCOMING · ${unit.at}\n${unit.meta?.from || "someone"}: ${unit.content}\n\n`;
  }
  if (unit.kind === "emission") {
    if (looksLikeTheRoom(unit.content)) return "";
    const prose = withoutCalls(unit.content, parseCalls(unit.content, known)).trim();
    return prose ? `EMISSION · ${unit.at}\n${prose}\n\n` : "";
  }
  if (unit.kind !== "action") return "";

  const name = unit.meta?.name || "action";
  const call = compactCall(unit);
  let entry = `ACTION · ${unit.at}\n${call}\n`;
  if (unit.result && name !== "recall") {
    entry += `RETURNED\n${unit.fact || `${name} completed`}\n`;
  }
  return entry + "\n";
}

// Document text belongs to the document. The life carries the exact fact that
// she wrote it, with the action number above and the path here; read() reaches
// the artifact whenever its exact wording matters. The record itself remains
// byte-exact, so this changes attention rather than history.
function compactCall(unit) {
  const name = unit.meta?.name || "action";
  if (name === "write") return `write(${JSON.stringify(String(unit.meta?.args?.[0] ?? ""))}, …)`;
  // The consolidated note is the long-term memory itself, carried once by the
  // MEMORY section; the action line only needs to say the fold happened.
  if (name === "consolidate") return "consolidate(…)";
  return unit.content;
}

// Raw emissions stay exact in the record. In model-facing history their
// executable call blocks are represented by the separately addressable
// action units, so shelving an action also removes its arguments and result.
function withoutCalls(text, calls) {
  const blocks = calls.map((call) => call.source.split("\n"));
  const lines = String(text || "").split("\n");
  const kept = [];
  for (let at = 0; at < lines.length;) {
    const block = blocks.find((candidate) =>
      lines.slice(at, at + candidate.length).join("\n").trim() === candidate.join("\n"),
    );
    if (block) at += block.length;
    else kept.push(lines[at++]);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

// What a call returned, as plain lines. It used to JSON.stringify anything
// structured, so the room's last characters were often {"name":"x","bytes":295}
// — and 13 of her first 14 emissions opened with a stray brace, because a
// document ending in machine syntax gets continued in machine syntax. Nothing
// here is dropped; it is only said in words.
function format(value) {
  if (value == null) return "nothing";
  if (typeof value === "string") return value;
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (item == null || item === "") continue;
    if (Array.isArray(item)) {
      // No artificial cap here either: every entry, in full. (This used to show
      // only the first 8 entries and slice each to 400 chars — the array twin of
      // the 4000-char scalar cut, and just as silent.)
      lines.push(`${key}: ${item.length}`);
      for (const entry of item) lines.push(`  ${describe(entry)}`);
    } else {
      // No artificial cap on command output — she sees the whole thing. The only
      // limit is the context window itself, which bounds the total naturally.
      // (This used to slice to 4000 chars, silently severing a `ps aux`.)
      lines.push(`${key}: ${describe(item)}`);
    }
  }
  return lines.join("\n") || "nothing";
}

function describe(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return Object.entries(value)
    .filter(([, item]) => item != null && item !== "")
    .map(([key, item]) => `${key} ${typeof item === "object" ? describe(item) : item}`)
    .join(", ");
}
