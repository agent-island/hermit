import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonical = "https://agent-island.github.io/project-autonomous-agent/";

test("the GitHub Pages site has one canonical, indexable project page", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const robots = await readFile(new URL("../site/robots.txt", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../site/sitemap.xml", import.meta.url), "utf8");

  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}"`));
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /"@type": "SoftwareSourceCode"/);
  assert.match(html, /https:\/\/github\.com\/agent-island\/project-autonomous-agent/);
  assert.match(robots, /Allow: \/$/m);
  assert.match(sitemap, new RegExp(`<loc>${canonical}</loc>`));
});
