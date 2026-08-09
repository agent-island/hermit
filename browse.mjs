import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { extensionSearch } from "./extension-search.mjs";

const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Whole elements that are never the article.
markdown.remove(["script", "style", "noscript", "iframe", "form", "nav", "aside", "footer"]);

export async function search(query, { take = 10 } = {}) {
  const wanted = String(query || "").trim();
  if (!wanted) return { query: wanted, note: "no query was given" };

  const viaChrome = await extensionSearch.search(wanted).catch(() => null);
  if (viaChrome?.results?.length) return { query: wanted, results: viaChrome.results.slice(0, take) };
  return { query: wanted, note: viaChrome?.note || "browser extension is not connected" };
}

// One page, turned into Markdown. Two ways in, tried in order of reach:
//
//   1. the operator's real Chrome, via the extension, when it is connected —
//      it renders JavaScript and carries their signed-in session, so it reads
//      pages a bare request cannot: SPAs, paywalled-by-login, bot-walled.
//   2. a plain HTTP GET — fast, no browser, enough for ordinary article pages.
//
// Either way the bytes become a DOM (jsdom), Readability lifts the article out
// of the page's furniture, and turndown renders it.
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
