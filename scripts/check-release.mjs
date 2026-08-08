import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const forbiddenRoots = new Set(["archive", "data", "link", "node_modules"]);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|password)\s*[:=]\s*["'](?!(?:test-key|replace-me)["'])[^"']{8,}["']/i,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

async function files(directory, relative = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (relative === "" && forbiddenRoots.has(entry.name)) continue;
    if ([".git", ".DS_Store"].includes(entry.name)) continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await files(path.join(directory, entry.name), next));
    else found.push(next);
  }
  return found;
}

const failures = [];
for (const relative of await files(root)) {
  const absolute = path.join(root, relative);
  const text = await readFile(absolute, "utf8").catch(() => null);
  if (text == null) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) failures.push(`${relative}: matches ${pattern}`);
  }
}

const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
for (const required of ["archive/", "data/", "link/", ".env"]) {
  if (!ignore.split(/\r?\n/).includes(required)) failures.push(`.gitignore: missing ${required}`);
}

if (failures.length) {
  console.error("Release check failed:\n" + failures.map((one) => `- ${one}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Release check passed: private runtime roots are excluded and no obvious source secrets were found.");
}
