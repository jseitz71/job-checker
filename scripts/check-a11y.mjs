#!/usr/bin/env node
/**
 * Accessibility check for Job Checker (WCAG 2.2 A/AA rules via axe-core).
 *
 * Serves the site locally, then walks every screen a person can reach:
 * step 1, each example job through steps 2–4, the scoring-criteria drawer,
 * and the privacy and terms pages. Each screen is checked in light and dark
 * themes at desktop (1280px) and phone (375px) widths.
 *
 *   npm run check:a11y
 *
 * Exits 1 if any violation is found, listing each rule, the elements involved
 * and the screens where it appeared. External requests (Google Fonts) are blocked
 * so results don't depend on the network.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/* ---------- Tiny static server for the repo root ---------- */
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, path === "/" ? "index.html" : path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "text/html" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---------- Screens: how to reach each one from a fresh page ---------- */
const go = (n) => async (page) => { await page.click(`.stepper button[data-go="${n}"]`); };
const example = (id) => async (page) => { await page.click(`#${id}`); };
const SCREENS = [
  { name: "Step 1: paste", url: "/" },
  { name: "Manual entry (step 2, editor open)", url: "/", steps: [async p => p.click("#manual")] },
  ...[["exGhost", "ghost job"], ["exLegit", "active job"], ["exScam", "scam message"]].flatMap(([id, label]) => [
    { name: `Step 2: review (${label})`, url: "/", steps: [example(id)] },
    { name: `Step 3: verify (${label})`, url: "/", steps: [example(id), go(3)] },
    { name: `Step 4: results (${label})`, url: "/", steps: [example(id), go(4), async p => p.evaluate(() => document.querySelectorAll("#s4 details").forEach(d => d.open = true))] },
  ]),
  { name: "Scoring criteria drawer", url: "/", steps: [async p => p.evaluate(() => { document.getElementById("rulesWrap").open = true; })] },
  { name: "Privacy page", url: "/privacy.html" },
  { name: "Terms page", url: "/terms.html" },
];
const MODES = [
  { label: "light, desktop", scheme: "light", width: 1280 },
  { label: "dark, desktop", scheme: "dark", width: 1280 },
  { label: "light, phone", scheme: "light", width: 375 },
  { label: "dark, phone", scheme: "dark", width: 375 },
];

/* ---------- Run ---------- */
const browser = await chromium.launch();
const found = new Map(); // rule id -> { help, impact, url, targets:Set, where:Set }
let checked = 0;
try {
  for (const mode of MODES) {
    const context = await browser.newContext({ colorScheme: mode.scheme, viewport: { width: mode.width, height: 900 } });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    for (const screen of SCREENS) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(BASE + screen.url);
      for (const step of screen.steps || []) { await step(page); }
      await page.waitForTimeout(150);
      if (errors.length) throw new Error(`${screen.name} (${mode.label}) threw: ${errors[0]}`);
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      for (const v of violations) {
        const f = found.get(v.id) || { help: v.help, impact: v.impact, url: v.helpUrl, targets: new Set(), where: new Set() };
        v.nodes.forEach(n => f.targets.add(n.target.join(" ")));
        f.where.add(`${screen.name} (${mode.label})`);
        found.set(v.id, f);
      }
      checked++;
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (!found.size) {
  console.log(`Accessibility check passed: ${checked} screen/theme/width combinations, no WCAG 2.2 AA violations found by axe.`);
  process.exit(0);
}
console.error(`Accessibility check failed: ${found.size} rule(s) violated.\n`);
for (const [id, f] of found) {
  console.error(`✗ ${id} [${f.impact}] ${f.help}\n  ${f.url}`);
  console.error(`  elements: ${[...f.targets].slice(0, 8).join(" | ")}${f.targets.size > 8 ? ` (+${f.targets.size - 8} more)` : ""}`);
  console.error(`  seen on: ${[...f.where].slice(0, 6).join("; ")}${f.where.size > 6 ? ` (+${f.where.size - 6} more)` : ""}\n`);
}
process.exit(1);
