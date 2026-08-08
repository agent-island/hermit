// Searching and reading, through a real browser.
//
// Two things needed a browser rather than a fetch. Google has no public API and
// answers plain requests with "our systems have detected unusual traffic" —
// signing in once, in a profile of its own, gets past that. And a page fetched
// as HTML is mostly navigation, scripts and cookie banners; rendered first and
// then reduced to Markdown, it is the article and nothing else.
//
// The profile lives in ami/link/browser, beside the WhatsApp pairing: outside
// her record, not wiped by a rebirth, and never the operator's own profile.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { extensionSearch } from "./extension-search.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.AMI_BROWSER_DIR || path.join(here, "link", "browser");
const AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Whole elements that are never the article.
markdown.remove(["script", "style", "noscript", "iframe", "form", "nav", "aside", "footer"]);

let playwright = null;
let context = null;

// The one browser, kept open between calls so a search does not pay for a
// cold launch every time.
export async function shared() {
  return browser();
}

async function browser() {
  if (context && context.pages) return context;
  if (!playwright) playwright = await import("playwright");
  context = await playwright.chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    // Autonomous reads never open a window or take focus from the operator.
    // The explicit sign-in flow below is the only visible browser session.
    headless: true,
    userAgent: AGENT,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    // Chrome sets this flag on automated sessions and several sites read it.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.on("close", () => { context = null; });
  return context;
}

export async function close() {
  if (context) await context.close().catch(() => {});
  context = null;
}

// A marker per service, written only after that service is actually signed in.
// The profile directory itself appears the moment Chromium launches, so its
// existence proves nothing: an abandoned sign-in window once reported success,
// which would have offered her a way to post that could not post.
export { PROFILE };
const PROOF = { google: path.join(PROFILE, "google.json") };

export function signedIn(service = "google") {
  return existsSync(PROOF[service] ?? "");
}

const SIGNED_IN = {
  google: { url: "https://accounts.google.com/", done: /myaccount\.google\.com|google\.[a-z.]+\/?$/ },
};

// One real window with a tab for each account. The operator signs in by hand;
// nothing here types, reads or stores a password. Only the cookies the sites
// hand back afterwards persist, and they live in the profile directory.
export async function signIn({ timeoutMs = 300_000 } = {}) {
  await close();
  if (!playwright) playwright = await import("playwright");
  const window = await playwright.chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    userAgent: AGENT,
    locale: "en-US",
    viewport: { width: 1180, height: 860 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const google = window.pages()[0] ?? (await window.newPage());
  await google.goto(SIGNED_IN.google.url, { waitUntil: "domcontentloaded" }).catch(() => {});

  const done = [
    await google.waitForURL(SIGNED_IN.google.done, { timeout: timeoutMs }).then(() => "google").catch(() => null),
  ].filter(Boolean);

  for (const service of ["google"]) {
    if (done.includes(service)) writeFileSync(PROOF[service], JSON.stringify({ at: new Date().toISOString() }));
    else rmSync(PROOF[service], { force: true });
  }
  await window.close().catch(() => {});

  return done.length
    ? { ok: true, signedIn: done, note: "Signed in to Google. Search will work from now on." }
    : { ok: false, signedIn: [], note: "No sign-in was completed before the window timed out." };
}

// Search reaches for results from three places in turn, so one refusal never
// leaves her with nothing. Each returns { results } or { note }, and the first
// with results wins; a note is handed back only when all three come up empty.
//
//   1. the operator's real Chrome, via the extension — Google in a signed-in
//      tab, the best results, when it is connected.
//   2. DuckDuckGo over a plain HTTPS GET — no browser, no login, and it rarely
//      turns an automated request away. This is the net that keeps search
//      working when Google blocks her, which it does often.
//   3. a headless Google of last resort — sometimes refused, so it is tried
//      only after the other two, and its failure costs her nothing.
export async function search(query, { take = 10 } = {}) {
  const wanted = String(query || "").trim();
  if (!wanted) return { query: wanted, note: "no query was given" };

  const viaChrome = await extensionSearch.search(wanted).catch(() => null);
  if (viaChrome?.results?.length) return { query: wanted, results: viaChrome.results.slice(0, take) };

  const viaDuck = await duckDuckGo(wanted, take).catch(() => null);
  if (viaDuck?.results?.length) return { query: wanted, results: viaDuck.results };

  const viaGoogle = await googleHeadless(wanted, take).catch((error) => ({ note: String(error.message).slice(0, 180) }));
  if (viaGoogle.results?.length) return { query: wanted, results: viaGoogle.results };

  return {
    query: wanted,
    note: viaChrome?.note || viaGoogle.note || "no search engine returned anything for that",
  };
}

// DuckDuckGo's HTML endpoint, parsed off a plain fetch. Its result links are
// redirects that carry the real url in a `uddg` parameter; that is unwrapped
// here so she gets the destination, not the tracker.
async function duckDuckGo(query, take = 10) {
  let html;
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": AGENT, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { note: `duckduckgo returned ${response.status}` };
    html = await response.text();
  } catch (error) {
    return { note: `duckduckgo did not answer: ${String(error.message).slice(0, 120)}` };
  }
  const doc = new JSDOM(html).window.document;
  const seen = new Set();
  const results = [];
  for (const anchor of doc.querySelectorAll("a.result__a")) {
    let url = anchor.getAttribute("href") || "";
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const block = anchor.closest(".result, .web-result");
    const snippet = block?.querySelector(".result__snippet")?.textContent || "";
    results.push({
      title: anchor.textContent.trim().slice(0, 300),
      url,
      snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 400),
    });
    if (results.length >= take) break;
  }
  return results.length ? { results } : { note: "duckduckgo returned nothing for that" };
}

// The original headless-Google path, kept as a last resort. It launches the
// persistent browser, so it is the most expensive of the three and often the
// least reliable — Google refuses automated sessions even when signed in.
async function googleHeadless(query, take = 10) {
  const ctx = await browser();
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=20`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1200);

    const found = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const heading of document.querySelectorAll("a h3")) {
        const anchor = heading.closest("a");
        if (!anchor?.href || seen.has(anchor.href)) continue;
        if (/google\.[a-z.]+\/|\/search\?/.test(anchor.href)) continue;
        seen.add(anchor.href);
        // The snippet is whatever text sits under the result block.
        const block = anchor.closest("div[data-hveid], div.g") ?? anchor.parentElement;
        const text = (block?.innerText ?? "").replace(heading.textContent, "").trim();
        out.push({ title: heading.textContent.trim(), url: anchor.href, snippet: text.replace(/\s+/g, " ").slice(0, 400) });
      }
      return { results: out, blocked: /unusual traffic|not a robot/i.test(document.body.innerText.slice(0, 400)) };
    });

    if (found.blocked) return { note: "google is refusing this connection — sign in again from the panel" };
    if (!found.results.length) return { note: "google returned nothing for that" };
    return { results: found.results.slice(0, take) };
  } finally {
    await page.close().catch(() => {});
  }
}

// One page, rendered and then reduced to the article as Markdown. Headings,
// links, lists and code survive; navigation, scripts and cookie banners do not.
// One page, turned into Markdown. Two ways in, tried in order of reach:
//
//   1. the operator's real Chrome, via the extension, when it is connected —
//      it renders JavaScript and carries their signed-in session, so it reads
//      pages a bare request cannot: SPAs, paywalled-by-login, bot-walled.
//   2. a plain HTTP GET — fast, no browser, enough for ordinary article pages.
//
// Either way the bytes become a DOM (jsdom), Readability lifts the article out
// of the page's furniture, and turndown renders it. No headless browser ever
// launches here; search still uses one only because Google refuses a bare GET.
export async function read(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { url: target, note: "that is not an http address" };

  // Real Chrome first, when it is there.
  if (extensionSearch.online()) {
    const viaChrome = await extensionSearch.read(target).catch(() => null);
    if (viaChrome?.html) return articleFrom(viaChrome.html, viaChrome.url || target, viaChrome.title);
    if (viaChrome?.note) return { url: target, ...(viaChrome.title ? { title: viaChrome.title } : {}), note: viaChrome.note };
    // no answer in time — fall through to a plain fetch
  }

  let response;
  try {
    response = await fetch(target, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const why = /timeout|abort/i.test(String(error.message)) ? "the page took too long to answer" : `could not reach the page: ${String(error.message).slice(0, 120)}`;
    return { url: target, note: why };
  }
  if (!response.ok) return { url: target, note: `the page returned ${response.status}` };
  const type = response.headers.get("content-type") || "";
  if (type && !/html|xml|text\b/i.test(type)) {
    return { url: target, note: `that is not a readable web page (${type.split(";")[0].trim() || "unknown type"})` };
  }

  let html;
  try {
    html = await response.text();
  } catch {
    return { url: target, note: "the page could not be decoded" };
  }
  return articleFrom(html, response.url || target);
}

// Raw HTML → the article as Markdown. Readability pulls the story out of the
// navigation, ads and cookie banners; when it gives up (a list, a dashboard, a
// directory) the body text is still worth having.
function articleFrom(html, target, fallbackTitle = "") {
  let title = fallbackTitle;
  let articleHtml = "";
  let byline = "";
  try {
    const dom = new JSDOM(html, { url: target });
    const doc = dom.window.document;
    title = doc.title || fallbackTitle;
    const bodyText = doc.body?.textContent || "";
    if (bodyText.length < 3000 && /captcha|verify you are human|are you a robot|challenge-platform/i.test(bodyText)) {
      return { url: target, title, note: "the page is waiting for human verification" };
    }
    const parsed = new Readability(doc).parse();
    if (parsed?.content) {
      articleHtml = parsed.content;
      title = parsed.title || title;
      byline = parsed.byline || "";
    } else {
      // Readability gives up on lists, docs, forums and dashboards. Rather than
      // dump the whole body, take the page's own main region when it declares
      // one — the part a reader's eye goes to — and fall back to the body only
      // when the page names no main content at all.
      const main = doc.querySelector("main, article, [role='main']");
      articleHtml = main?.innerHTML || doc.body?.innerHTML || "";
    }
  } catch {
    articleHtml = html;
  }

  const body = markdown.turndown(articleHtml || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return { url: target, title, note: "the page contained no readable text" };
  return {
    url: target,
    title,
    ...(byline ? { byline } : {}),
    markdown: body,
    characters: body.length,
  };
}
