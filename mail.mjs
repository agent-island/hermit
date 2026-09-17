// Letters she writes.
//
// Nothing leaves this machine. There is no SMTP server, no account, no
// recipient — an address she found while reading is a name she is writing to,
// not an inbox that receives anything. The letter is kept, shown in the panel,
// and carried to the timeline like anything else she says.
//
// Kept beside the outbox rather than in her record, for the same reason: where
// her words are carried is an operator setting, not a fact about her, and a
// rebirth does not clear it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.HERMIT_MAIL_FILE || path.join(here, "link", "letters.json");

const KEEP = Number(process.env.HERMIT_MAIL_KEEP) || 2000;

function load() {
  try {
    const stored = JSON.parse(readFileSync(FILE, "utf8"));
    return { letters: stored.letters ?? [], next: stored.next ?? 1 };
  } catch {
    return { letters: [], next: 1 };
  }
}

function save(state) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

export function write({ to, subject, body }) {
  const state = load();
  const letter = {
    id: state.next,
    to: String(to || "").trim().slice(0, 200),
    subject: String(subject || "").trim().slice(0, 300),
    body: String(body || "").trim(),
    at: new Date().toISOString(),
  };
  state.letters.push(letter);
  state.next += 1;
  if (state.letters.length > KEEP) state.letters = state.letters.slice(-KEEP);
  save(state);
  return letter;
}

export function letters(limit = 50) {
  return load().letters.slice(-limit).reverse();
}

export function count() {
  return load().letters.length;
}

// What goes to the timeline. The whole letter, because a letter with the
// address and subject stripped off is just more speech — the fact that she
// addressed it to someone is the interesting part.
export function asPost(letter) {
  return [`To: ${letter.to}`, letter.subject ? `Subject: ${letter.subject}` : "", "", letter.body]
    .filter((line, index) => line !== "" || index === 2)
    .join("\n");
}
