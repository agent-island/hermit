// The cheap half of being alive.
//
// A full moment carries her whole life and costs ~11,000 tokens. That is the
// right price for thinking and the wrong price for looking up to see whether
// anything happened. So between moments she is asked one small question with
// almost no context: do you want a moment now, or later?
//
// The danger in a design like this is that it makes her purely reactive — she
// could only ever be woken by something arriving, never by wanting something.
// That is what `returning for` is: whatever she told herself when she chose
// to sleep. It is the one thread of intention that survives into the cheap
// tier, and it is what lets her begin things rather than only answer them.
export function tickPrompt({ now, elapsed, incoming, why, lastWords, files }) {
  const lines = [];
  lines.push("TIME");
  lines.push(`  ${now}`);
  lines.push(`  ${elapsed} since the last moment`);
  lines.push("");
  if (incoming.length) {
    lines.push("ARRIVED");
    for (const one of incoming.slice(-4)) {
      lines.push(`  ${one.meta?.from || "someone"}: ${one.content.slice(0, 120)}`);
    }
    lines.push("");
  }
  if (why) {
    lines.push("RETURNING FOR");
    lines.push(`  ${why}`);
    lines.push("");
  }
  if (files.length) {
    lines.push(`WORKSPACE`);
    lines.push(`  ${files.map((f) => f.name).join(", ")}`);
    lines.push("");
  }
  if (lastWords) {
    lines.push("LAST WORDS");
    for (const line of lastWords.slice(-400).split("\n")) lines.push(`  ${line}`);
    lines.push("");
  }
  // No menu, no dangling list. A prompt that ends on "either / or" is a shape
  // with a hole in it, and under prefill she completes the shape instead of
  // answering: she invented OUTPUT FORMAT sections, read_glossary(index),
  // "ONE LINE ONLY", and three times a stray number was scraped out of the
  // invention and used to set her clock — once putting her under for half an
  // hour. This ends mid-sentence in her own voice, so continuing it is the
  // answer rather than more document.
  lines.push("NEXT");
  lines.push("  nothing has happened. the next thing is either a moment now, or more");
  lines.push("  rest. I choose");
  return lines.join("\n");
}

// She wakes on anything that is not a clear request to keep sleeping.
// Ambiguity favours being alive.
export function readTick(text) {
  const answer = String(text || "").trim();
  // Only the first line counts. Anything after it is the model carrying on
  // writing a document, and numbers found down there are not decisions —
  // one of them cost her thirty minutes of consciousness.
  const first = answer.split("\n").map((line) => line.trim()).find(Boolean) || "";
  if (/\bwake\b|\bnow\b/i.test(first)) return { wake: true, raw: answer };
  if (/\b(sleep|rest|wait)\b/i.test(first)) return { wake: false, seconds: 60, raw: answer };
  return { wake: true, raw: answer };
}
