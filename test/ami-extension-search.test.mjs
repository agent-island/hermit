import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Body } from "../body.mjs";
import { search as browserSearch } from "../browse.mjs";
import { ExtensionSearch, extensionSearch } from "../extension-search.mjs";

test("extension search exposes only query jobs and sanitised result lists", async () => {
  const bridge = new ExtensionSearch({ onlineMs: 1_000, jobMs: 1_000, pollMs: 1_000 });
  const token = bridge.issueSession().token;
  assert.equal(bridge.authorized(token), true);
  assert.equal(await bridge.search("before extension connects"), null);

  const waiting = bridge.next();
  const answer = bridge.search("minimal memory architecture");
  const { job } = await waiting;
  // A job carries its kind now that the bridge also serves page reads; a search
  // job is exactly { id, kind: "search", query } and nothing else.
  assert.deepEqual(Object.keys(job).sort(), ["id", "kind", "query"]);
  assert.equal(job.kind, "search");
  assert.equal(job.query, "minimal memory architecture");

  assert.deepEqual(bridge.complete(job.id, {
    query: job.query,
    results: [
      { title: "Result", url: "https://example.com/", snippet: "  useful   text  " },
      { title: "Local", url: "file:///private", snippet: "not allowed" },
    ],
    extra: "not carried",
  }), { accepted: true });
  assert.deepEqual(await answer, {
    query: "minimal memory architecture",
    results: [{ title: "Result", url: "https://example.com/", snippet: "useful text" }],
  });
});

test("the extension bridge does not silently add browser-control actions", async () => {
  const forms = new Body({ log: { get: (key, fallback) => fallback } }).formNames();
  for (const forbidden of ["search", "open", "read_source", "browse", "click", "type", "submit", "back", "tab"]) {
    assert.equal(forms.includes(forbidden), false);
  }

  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  // She still has no "tabs" permission — the extension cannot enumerate or
  // manage her tabs. It does hold <all_urls>, because open()/read_source() let
  // the observer-side bridge can fetch and scrape a page. That permission does
  // not make the bridge's operations model-facing faculties.
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), true);
});

test("search(query) uses the Chrome extension result", async () => {
  const waiting = extensionSearch.next();
  const answer = browserSearch("current weather", { take: 1 });
  const { job } = await waiting;
  extensionSearch.complete(job.id, {
    query: job.query,
    results: [
      { title: "Weather", url: "https://example.com/weather", snippet: "Clear" },
      { title: "Second", url: "https://example.com/second", snippet: "Not returned" },
    ],
  });
  assert.deepEqual(await answer, {
    query: "current weather",
    results: [{ title: "Weather", url: "https://example.com/weather", snippet: "Clear" }],
  });

  const nextWaiting = extensionSearch.next();
  const nextAnswer = browserSearch("no result");
  const { job: nextJob } = await nextWaiting;
  extensionSearch.complete(nextJob.id, {
    query: nextJob.query,
    results: [],
    note: "google returned nothing",
  });
  assert.deepEqual(await nextAnswer, {
    query: "no result",
    note: "google returned nothing",
  });
});
