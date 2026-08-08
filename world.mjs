import { fill } from "./setup.mjs";
import { VOICE } from "./voice.mjs";
import { projectMemory } from "./memory-state.mjs";
import { loadRuntime, runtimeLines } from "./runtime.mjs";

// The only text that ever reaches her.
//
// The shape of it is not decided here any more — it is the template in the
// panel, and the operator owns it. What this file does is compute the values
// behind each {{placeholder}}: facts, read out of the record, stated as what
// is rather than what ought to be.
export function renderWorld({ now, previousAt, body, log, setup, incoming, results, previous, files, people = [], gap = "", attention = {} }) {
  return fill(setup.template, {
    "{{time}}": now.toISOString(),
    "{{elapsed}}": previousAt
      ? VOICE.world.sincePrevious(elapsed(now - new Date(previousAt)))
      : VOICE.world.firstMoment,
    // Never the host path. It used to print
    // /…/Amiliya/server/autonomous-artificial-persona/ami/data/workspace, and
    // she read her identity straight off it — three moments old, she wrote a
    // manifest titled "AMI — Autonomous Artificial Persona" declaring her own
    // purpose and principles. Nothing in the room had told her any of that;
    // the directory string had. A path is a fact about the host, not about
    // her, and she reaches everything in here by plain name anyway.
    "{{workspace}}": "workspace",
    "{{files}}": workspaceLines(files),
    // Two flat facts, read straight from the ledger, or empty when the
    // finite-life condition is not on — in which case fill() drops the section.
    "{{runtime}}": runtimeLines(loadRuntime(log)),
    // A bullet keeps these lines from being calls, which the padding used to
    // do — badly, since she copied the padding into calls that then never ran.
    "{{forms}}": body.affordances().map(([form, does]) => `· ${form.padEnd(21)} ${does}`),
    // An empty section renders as a single dash. Three spelled-out absences
    // in a row ("nothing", "nothing was called at the previous moment",
    // "nothing is recorded") said the same thing three times, in words, in
    // the room she wakes into.
    // Whoever it came from, by the name the context carries. Nothing here
    // names an observer.
    "{{incoming}}": incoming.map(
      (event) => `${clock(event.at)}  ${event.meta?.from || "someone"}: ${event.content}`,
    ),
    "{{gap}}": gap,
    "{{context}}": people,
    "{{returned}}": returnedLines(results),
    "{{memories}}": memoryLines(
      setup.context === "conversation" ? log.activeMemories() : log.followingMemories(),
      attention,
    ),
    "{{previous}}": previousLines(previous),
  });
}

function workspaceLines(files) {
  if (!files.length) return VOICE.world.empty;
  const lines = [VOICE.world.fileCount(files.length)];
  for (const file of files) {
    let origin = "";
    if (file.written) {
      origin = file.latestWrite && file.latestWrite !== file.written
        ? " — written here, and rewritten since"
        : " — written here";
    }
    lines.push(`${file.name}${origin}`);
  }
  return lines;
}

function returnedLines(results) {
  if (!results.length) return [];
  const lines = [];
  for (const { call, value } of results) {
    lines.push(call);
    const text = String(value);
    for (const line of text.split("\n")) lines.push(`  ${line}`);
  }
  return lines;
}

function previousLines(previous) {
  if (!previous) return [];
  const content = typeof previous === "string" ? previous : previous.content;
  return content.split("\n");
}

function memoryLines(memories, attention) {
  return projectMemory(memories, attention).lines;
}

function elapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function clock(at) {
  return String(at).slice(11, 19) + "Z";
}
