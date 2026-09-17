// A life as something a person can read start to finish.
//
// The html is an instrument — filters, timelines, every field. This is the
// other thing: her life as prose, in order, with her own words given the room
// they need and the machinery pushed to the margins. What she thought is
// quoted whole and never trimmed; what she called and what came back sit
// under it as a short list.
//
// The room documents are the one thing summarised. They are ~40 lines each
// and almost identical every moment, so the first is printed in full — she
// only ever woke into one world — and afterwards only what changed.
export function buildMarkdown(log) {
  const events = log.since(0, 1_000_000);
  const first = events[0];
  const last = events[events.length - 1];
  const moments = groupMoments(events);
  const out = [];

  out.push("# a life");
  out.push("");
  if (!first) {
    out.push("Nothing ever happened.");
    return out.join("\n");
  }
  out.push(
    [
      `**born** ${first.at}`,
      `**last** ${last.at}`,
      `**${moments.length}** moments`,
      `**${events.length}** events`,
    ].join(" · "),
  );

  const thought = events.filter((e) => e.kind === "action" && ["speak", "think", "inner_speech"].includes(e.meta?.name)).length;
  const spoke = events.filter((e) => e.kind === "action" && e.meta?.name === "speak_aloud").length;
  const said = events.filter((e) => e.kind === "incoming").length;
  const made = events.filter((e) => e.kind === "action" && e.meta?.name === "write").length;
  out.push("");
  out.push(
    `She recorded **${thought}** inner thought${thought === 1 ? "" : "s"}, spoke aloud **${spoke}** time${spoke === 1 ? "" : "s"}, was spoken to **${said}**, ` +
      `and made **${made}** thing${made === 1 ? "" : "s"}.`,
  );

  const birthRoom = events.find((e) => e.kind === "world");
  if (birthRoom) {
    out.push("");
    out.push("## the room she woke into");
    out.push("");
    out.push("```");
    out.push(birthRoom.content);
    out.push("```");
  }

  let shownRoom = birthRoom?.content ?? "";
  out.push("");
  out.push("## her moments");

  moments.forEach((moment, index) => {
    out.push("");
    out.push(`### ${index + 1} · ${clock(moment.at)}`);

    if (moment.incoming.length) {
      out.push("");
      for (const line of moment.incoming) {
        out.push(`**${line.meta?.from || "someone"} said:** ${oneLine(line.content)}`);
      }
    }

    if (moment.room && moment.room !== shownRoom) {
      const changed = diffLines(shownRoom, moment.room);
      shownRoom = moment.room;
      if (changed.length && changed.length <= 14) {
        out.push("");
        out.push("<sub>the room changed:</sub>");
        out.push("");
        out.push("```diff");
        out.push(...changed);
        out.push("```");
      }
    }

    for (const reasoning of moment.reasoning) {
      out.push("");
      out.push("<details><summary>model reasoning</summary>");
      out.push("");
      out.push("```");
      out.push(reasoning);
      out.push("```");
      out.push("</details>");
    }

    for (const details of moment.reasoningDetails) {
      out.push("");
      out.push("<details><summary>complete structured reasoning details</summary>");
      out.push("");
      out.push("```json");
      out.push(details);
      out.push("```");
      out.push("</details>");
    }

    if (moment.emission) {
      out.push("");
      out.push(...moment.emission.split("\n").map((line) => `> ${line}`));
    } else if (moment.echo) {
      out.push("");
      out.push("*The room came back instead of a moment. Nothing was carried out.*");
    } else if (moment.error) {
      out.push("");
      out.push(`*The request did not complete: ${moment.error}*`);
    }

    if (moment.calls.length) {
      out.push("");
      for (const { call, result } of moment.calls) {
        out.push(`- \`${call}\``);
        if (result) {
          for (const line of result.split("\n").slice(0, 12)) {
            out.push(`  - ${oneLine(line)}`);
          }
        }
      }
    }

    for (const memory of moment.memories) {
      const sources = Array.isArray(memory.meta?.sources) && memory.meta.sources.length
        ? ` from ${memory.meta.sources.map((id) => `#${id}`).join(", ")}`
        : "";
      out.push("");
      out.push(`**Long-term memory #${memory.id}${sources}:** ${oneLine(memory.content)}`);
    }

    for (const shelf of moment.shelves) {
      out.push("");
      out.push(`*Unit #${shelf.meta?.target || "?"} left following context.*`);
    }

    if (moment.ended) {
      out.push("");
      out.push(`**${moment.ended}**`);
    }
  });

  return out.join("\n") + "\n";
}

function groupMoments(events) {
  const moments = [];
  let current = null;
  let pending = null;
  for (const event of events) {
    if (event.kind === "world") {
      current = { at: event.at, room: event.content, incoming: [], calls: [], memories: [], shelves: [], reasoning: [], reasoningDetails: [], emission: null };
      moments.push(current);
      continue;
    }
    if (!current) {
      current = { at: event.at, room: null, incoming: [], calls: [], memories: [], shelves: [], reasoning: [], reasoningDetails: [], emission: null };
      moments.push(current);
    }
    if (event.kind === "incoming") current.incoming.push(event);
    if (event.kind === "reasoning") current.reasoning.push(event.content);
    if (event.kind === "reasoning_details") current.reasoningDetails.push(event.content);
    if (event.kind === "emission") current.emission = event.content;
    if (event.kind === "memory") current.memories.push(event);
    if (event.kind === "shelf") current.shelves.push(event);
    if (event.kind === "echo") current.echo = true;
    if (event.kind === "error") current.error = event.content;
    if (event.kind === "end") current.ended = event.content;
    if (event.kind === "action") {
      pending = { call: event.content, result: null };
      current.calls.push(pending);
    }
    if (event.kind === "result" && pending) {
      pending.result = event.content;
      pending = null;
    }
  }
  return moments;
}

function diffLines(before, after) {
  const old = new Set(String(before).split("\n"));
  const now = new Set(String(after).split("\n"));
  const out = [];
  for (const line of String(before).split("\n")) if (!now.has(line)) out.push(`- ${line}`);
  for (const line of String(after).split("\n")) if (!old.has(line)) out.push(`+ ${line}`);
  return out;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}

function clock(at) {
  return String(at).replace("T", " ").slice(0, 19) + "Z";
}
