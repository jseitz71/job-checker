import type { Config, Context } from "@netlify/functions";
import { getDeployStore, getStore } from "@netlify/blobs";

/*
 * Company lookups for Job Checker.
 *
 * Receives only a company name, a job title and (optionally) the company's website.
 * Runs a few web and news searches, checks public job-board feeds, and asks Claude
 * to turn the results into suggested answers. Every suggestion carries the search
 * results it was based on, so the user can check it.
 *
 * Environment variables (set in Netlify, never in code):
 *   BRAVE_API_KEY       Brave Search API key (required)
 *   ANTHROPIC_API_KEY   Claude API key (required)
 *   DAILY_LOOKUP_LIMIT  Fresh lookups allowed per day for the whole site (default 100)
 *   VISITOR_DAILY_LIMIT Fresh lookups allowed per visitor per day (default 5)
 */

type Source = { title: string; url: string; site: string; date: string; desc?: string };
type Answer = "yes" | "no" | "none";
type Suggestion = { answer: Answer; summary: string; sources: Omit<Source, "desc">[] };

const CACHE_HOURS = 24;
const CHECK_IDS = ["careers", "reposted", "layoffs", "frozen", "funding", "address"] as const;
type CheckId = (typeof CHECK_IDS)[number];

const QUESTIONS: Record<CheckId, string> = {
  careers: "Is this job listed on the company's own careers page or job board?",
  reposted: "Has this same job been posted repeatedly or for a long time (older copies on other job sites)?",
  layoffs: "Has the company had layoffs in the past 12 months?",
  frozen: "Was the company acquired, or reported to have a hiring freeze, in the past 12 months?",
  funding: "Did the company announce a funding round in the past 12 months?",
  address: "Can a real company address and main phone number be found for this company?",
};

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const braveKey = Netlify.env.get("BRAVE_API_KEY");
  const claudeKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!braveKey || !claudeKey) {
    return json({ error: "Automatic lookups aren't switched on yet. Use the search links for now." }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "The request couldn't be read." }, 400); }
  const company = cleanText(body?.company, 100);
  const title = cleanText(body?.title, 140);
  const site = cleanDomain(body?.site);
  if (!company) return json({ error: "Add the company name in step 2 first." }, 400);

  const production = context.deploy?.context === "production";
  const cache = production ? getStore("lookup-cache") : getDeployStore("lookup-cache");
  const usage = production ? getStore({ name: "lookup-usage", consistency: "strong" }) : getDeployStore("lookup-usage");

  // 1. Serve a recent result for the same company and title without searching again.
  const cacheKey = await sha256(`${company}|${title}|${site}`.toLowerCase());
  const cached = await cache.get(cacheKey, { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.at < CACHE_HOURS * 3600_000) {
    return json({ ...cached.result, cached: true });
  }

  // 2. Spending caps. Visitors are counted by a one-way hash of their IP and the date.
  const day = new Date().toISOString().slice(0, 10);
  const dailyLimit = intEnv("DAILY_LOOKUP_LIMIT", 100);
  const visitorLimit = intEnv("VISITOR_DAILY_LIMIT", 5);
  const dayKey = `day/${day}`;
  const visitorKey = `visitor/${day}/${await sha256(day + "|" + (context.ip || "unknown"))}`;
  const used = (await usage.get(dayKey, { type: "json" }).catch(() => null))?.n ?? 0;
  const mine = (await usage.get(visitorKey, { type: "json" }).catch(() => null))?.n ?? 0;
  if (used >= dailyLimit) return json({ error: "Lookups are paused until tomorrow. The rest of Job Checker still works." }, 429);
  if (mine >= visitorLimit) return json({ error: `You've used today's ${visitorLimit} lookups. They reset tomorrow, and the search links still work.` }, 429);
  await usage.setJSON(dayKey, { n: used + 1 });
  await usage.setJSON(visitorKey, { n: mine + 1 });

  // 3. Gather evidence in parallel.
  const q = (s: string) => s.replace(/"/g, "");
  const t = title ? ` "${q(title)}"` : "";
  const [board, careersWeb, reposted, layoffs, frozen, funding, address] = await Promise.all([
    checkJobBoards(company, site, title),
    braveSearch(braveKey, "web", `"${q(company)}" careers${t}`, 8),
    title ? braveSearch(braveKey, "web", `"${q(title)}" "${q(company)}"`, 10) : Promise.resolve([] as Source[]),
    braveSearch(braveKey, "news", `"${q(company)}" layoffs`, 8, "py"),
    braveSearch(braveKey, "news", `"${q(company)}" acquired OR acquisition OR "hiring freeze"`, 8, "py"),
    braveSearch(braveKey, "news", `"${q(company)}" raises funding round`, 8, "py"),
    braveSearch(braveKey, "web", `"${q(company)}" headquarters address phone`, 6),
  ]);

  const evidence: Record<CheckId, Source[]> = { careers: careersWeb, reposted, layoffs, frozen, funding, address };
  const suggestions: Partial<Record<CheckId, Suggestion>> = {};

  // Careers: a public job-board feed is direct evidence, so it answers without the model.
  if (board) {
    const boardSource = { title: `${company} job board on ${board.name}: ${board.count} open roles`, url: board.url, site: board.name, date: "" };
    suggestions.careers = board.matches.length
      ? { answer: "yes", summary: `Their job board on ${board.name} lists a matching role: “${board.matches[0].title}”.`, sources: board.matches.slice(0, 3).map(strip) }
      : title
        ? { answer: "no", summary: `Their job board on ${board.name} lists ${board.count} open roles, and none matches “${title}”.`, sources: [boardSource] }
        : { answer: "none", summary: `Found their job board on ${board.name}, but there's no job title to match against.`, sources: [boardSource] };
  }

  // 4. Ask Claude to read the remaining evidence.
  const toJudge = CHECK_IDS.filter(id => !suggestions[id] && !(id === "reposted" && !title));
  const judged = await judgeWithClaude(claudeKey, company, title, site, toJudge, evidence);
  for (const id of toJudge) suggestions[id] = judged[id];

  const result = { suggestions, checked: new Date().toISOString() };
  await cache.setJSON(cacheKey, { at: Date.now(), result }).catch(() => {});
  return json(result);
};

export const config: Config = { path: "/api/lookup" };

/* ---------------- Search ---------------- */

async function braveSearch(key: string, kind: "web" | "news", query: string, count: number, freshness?: string): Promise<Source[]> {
  const params = new URLSearchParams({ q: query, count: String(count), safesearch: "moderate" });
  if (freshness) params.set("freshness", freshness);
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/${kind}/search?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.log(`Brave ${kind} search failed: ${res.status}`); return []; }
    const data: any = await res.json();
    const rows: any[] = (kind === "web" ? data?.web?.results : data?.results) || [];
    return rows.filter(r => r?.url && /^https?:\/\//i.test(r.url)).slice(0, count).map(r => ({
      title: plain(r.title).slice(0, 160),
      url: String(r.url),
      site: r.meta_url?.hostname || hostname(r.url),
      date: prettyDate(r.page_age) || plain(r.age),
      desc: plain(r.description).slice(0, 300),
    }));
  } catch (e) {
    console.log(`Brave ${kind} search error: ${(e as Error).message}`);
    return [];
  }
}

/* ---------------- Public job-board feeds ---------------- */

type Board = { name: string; url: string; count: number; matches: Source[] };

async function checkJobBoards(company: string, site: string, title: string): Promise<Board | null> {
  const slugs = unique([
    company.toLowerCase().replace(/[^a-z0-9]/g, ""),
    company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    company.toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs)\b\.?/g, "").replace(/[^a-z0-9]/g, ""),
    site ? site.split(".")[0] : "",
  ]).filter(s => s.length >= 2);

  for (const slug of slugs) {
    const found = (await greenhouse(slug)) || (await lever(slug)) || (await ashby(slug));
    if (found) {
      const matches = title ? found.jobs.filter(j => titleMatches(title, j.title)) : [];
      return { name: found.name, url: found.url, count: found.jobs.length, matches };
    }
  }
  return null;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function greenhouse(slug: string) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!d || !Array.isArray(d.jobs)) return null;
  return { name: "Greenhouse", url: `https://boards.greenhouse.io/${slug}`,
    jobs: d.jobs.map((j: any) => ({ title: plain(j.title), url: j.absolute_url, site: "boards.greenhouse.io", date: prettyDate(j.updated_at) })) as Source[] };
}
async function lever(slug: string) {
  const d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(d)) return null;
  return { name: "Lever", url: `https://jobs.lever.co/${slug}`,
    jobs: d.map((j: any) => ({ title: plain(j.text), url: j.hostedUrl, site: "jobs.lever.co", date: j.createdAt ? prettyDate(new Date(j.createdAt).toISOString()) : "" })) as Source[] };
}
async function ashby(slug: string) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (!d || !Array.isArray(d.jobs)) return null;
  return { name: "Ashby", url: `https://jobs.ashbyhq.com/${slug}`,
    jobs: d.jobs.map((j: any) => ({ title: plain(j.title), url: j.jobUrl, site: "jobs.ashbyhq.com", date: prettyDate(j.publishedAt) })) as Source[] };
}

const STOP = new Set(["and", "the", "for", "with", "all", "levels", "remote", "hybrid", "onsite", "level", "of", "to", "in"]);
function titleWords(s: string) {
  return s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/\bsr\b/g, "senior").split(/[^a-z0-9+#]+/).filter(w => w.length > 1 && !STOP.has(w));
}
function titleMatches(wanted: string, candidate: string) {
  const w = titleWords(wanted), c = new Set(titleWords(candidate));
  if (!w.length) return false;
  return w.filter(x => c.has(x)).length / w.length >= 0.75;
}

/* ---------------- Claude ---------------- */

async function judgeWithClaude(key: string, company: string, title: string, site: string, ids: CheckId[], evidence: Record<CheckId, Source[]>): Promise<Record<string, Suggestion>> {
  const out: Record<string, Suggestion> = {};
  if (!ids.length) return out;

  const blocks = ids.map(id => {
    const rows = evidence[id];
    const list = rows.length
      ? rows.map((r, i) => `[${i + 1}] ${r.title} | ${r.site}${r.date ? " | " + r.date : ""}\n    ${r.desc || ""}`).join("\n")
      : "(no results)";
    return `### ${id}\nQuestion: ${QUESTIONS[id]}\nResults:\n${list}`;
  }).join("\n\n");

  const system = `You help job seekers check whether a job posting is real and actively hiring. You read search results and suggest an answer to each question.
Rules:
- Use only the numbered results given. Never use outside knowledge and never invent facts, numbers or dates.
- Answer "yes" or "no" only when a result clearly refers to this exact company. Different companies often share names; if it's unclear, answer "none".
- If the results don't settle the question, answer "none". A missing result is not evidence of "no".
- For "careers": "yes" only if a result is the company's own careers page or job board listing this role; "no" only if the company's own job board is shown and the role clearly isn't on it.
- For "reposted": "yes" if results show the same role posted repeatedly or with dates spanning several weeks or more; "no" if the only copies are recent.
- "summary" is one plain sentence (under 30 words) saying what the results show, e.g. "2 news articles from the past 6 months report layoffs at Acme."
- "sources" lists the numbers of the results that support the answer (empty for "none" unless a result is still useful to read).
Reply with JSON only, no other text.`;

  const user = `Today's date: ${new Date().toISOString().slice(0, 10)}
Company: ${company}
Job title: ${title || "(not given)"}
Company website: ${site || "(not given)"}

${blocks}

Return JSON shaped like: {${ids.map(id => `"${id}":{"answer":"yes|no|none","summary":"...","sources":[1]}`).join(",")}}`;

  let parsed: any = null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, temperature: 0, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const a = text.indexOf("{"), z = text.lastIndexOf("}");
      if (a >= 0 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
    } else {
      console.log(`Claude request failed: ${res.status}`);
    }
  } catch (e) {
    console.log(`Claude request error: ${(e as Error).message}`);
  }

  for (const id of ids) {
    const rows = evidence[id];
    const p = parsed?.[id];
    if (p && ["yes", "no", "none"].includes(p.answer) && typeof p.summary === "string") {
      // Only keep source numbers that point at real results, so links can't be invented.
      const nums: number[] = Array.isArray(p.sources) ? p.sources.filter((n: any) => Number.isInteger(n) && n >= 1 && n <= rows.length) : [];
      out[id] = { answer: p.answer, summary: p.summary.slice(0, 300), sources: unique(nums).slice(0, 4).map(n => strip(rows[n - 1])) };
    } else {
      out[id] = rows.length
        ? { answer: "none", summary: "The results couldn't be summarized automatically. Here's what the search found.", sources: rows.slice(0, 3).map(strip) }
        : { answer: "none", summary: "The search found nothing for this check.", sources: [] };
    }
  }
  return out;
}

/* ---------------- Helpers ---------------- */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function cleanText(v: unknown, max: number) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function cleanDomain(v: unknown) {
  const s = cleanText(v, 100).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/?#\s]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}
function intEnv(name: string, fallback: number) {
  const n = parseInt(Netlify.env.get(name) || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function plain(v: unknown) {
  return String(v ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function hostname(u: string) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function prettyDate(v: unknown) {
  if (!v) return "";
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
function strip(s: Source) {
  return { title: s.title, url: s.url, site: s.site, date: s.date };
}
function unique<T>(a: T[]) { return [...new Set(a)]; }
