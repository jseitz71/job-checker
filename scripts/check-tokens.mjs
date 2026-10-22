#!/usr/bin/env node
/**
 * Design-token check for Job Checker.
 *
 * Rule: colors and font families live ONLY in tokens.css. Everywhere else must use
 * the variables (var(--accent), var(--f-body) ...). Inline style="" attributes are
 * not allowed either; add a class instead.
 *
 * Two ways to run it:
 *   node scripts/check-tokens.mjs           Scan every page and stylesheet (CI, npm run check).
 *   node scripts/check-tokens.mjs --hook    Claude Code PreToolUse hook: reads the proposed
 *                                           edit from stdin and blocks it (exit 2) if it breaks
 *                                           the rule, telling the agent exactly what to fix.
 *
 * Escape hatch: a line containing the comment "token-ok" is skipped. Use it rarely, and
 * say why on the same line (e.g. a third-party embed that needs a literal color).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = new Set([".html", ".css", ".js"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".netlify", "scripts", "netlify"]);
const TOKEN_FILE = "tokens.css";

/* ---------- Load token values so messages can name the right variable ---------- */
const tokenByValue = new Map();
try {
  const t = readFileSync(join(ROOT, TOKEN_FILE), "utf8");
  // Light theme block only: that's the value people usually copy by accident.
  const light = t.slice(0, t.indexOf("@media"));
  for (const m of light.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
    if (!tokenByValue.has(m[2].toLowerCase())) tokenByValue.set(m[2].toLowerCase(), m[1]);
  }
} catch { /* token file missing: messages just won't suggest a name */ }

/* ---------- Rules ---------- */
const COLOR_PROP = /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color)?|outline(-color)?|(box|text)-shadow|fill|stroke|stop-color|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|--[\w-]+)$/;
const NAMED = "white|black|red|green|blue|gray|grey|silver|maroon|purple|fuchsia|lime|olive|yellow|navy|teal|aqua|orange|pink|brown|gold|indigo|violet|cyan|magenta|beige|tan|coral|salmon|crimson|khaki|lavender|plum|orchid|turquoise|ivory|azure";
const NAMED_RE = new RegExp(`(^|[\\s,(])(${NAMED})(?=$|[\\s,);!])`, "i");
const HEX_RE = /#[0-9a-f]{3,8}\b/i;
const FN_RE = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

function colorLiteral(value) {
  const v = value.replace(/var\([^)]*\)/g, ""); // ignore anything inside var(...)
  const hex = v.match(HEX_RE); if (hex) return hex[0];
  const fn = v.match(FN_RE); if (fn) return fn[0] + "…)";
  const named = v.match(NAMED_RE); if (named) return named[2];
  return null;
}

function suggest(lit) {
  const name = tokenByValue.get(lit.toLowerCase());
  return name ? `${lit} is ${name}; write var(${name})` : `pick the matching color token from ${TOKEN_FILE} (or add one there, light and dark)`;
}

/** Returns a list of { line, text, why, fix } problems in a chunk of source. */
export function findProblems(source, startLine = 1) {
  const problems = [];
  source.split("\n").forEach((text, i) => {
    if (text.includes("token-ok")) return;
    const line = startLine + i;
    const add = (why, fix) => problems.push({ line, text: text.trim().slice(0, 140), why, fix });

    if (/\bstyle\s*=\s*["'`]/.test(text)) {
      add("inline style attribute", "add or reuse a class in the page's stylesheet (spacing utilities: .mt-2, .mt-3, .mb-2), using tokens for values");
    }
    // CSS declarations, in stylesheets, <style> blocks, and JS template strings alike.
    for (const m of text.matchAll(/(?<![\w-])(--[\w-]+|[a-z][a-z-]*)\s*:\s*([^;{}<>"`\n]+)/g)) {
      const [, prop, value] = m;
      if (COLOR_PROP.test(prop)) {
        const lit = colorLiteral(value);
        if (lit) add(`hard-coded color ${lit} in "${prop}"`, suggest(lit));
      } else if ((prop === "font" || prop === "font-family") && !/var\(--f-/.test(value) && !/^\s*(inherit|initial|unset|revert)\b/.test(value)) {
        add(`hard-coded font in "${prop}"`, "use var(--f-display), var(--f-body) or var(--f-mono)");
      }
    }
    // SVG presentation attributes: fill="#fff", stroke="red" ...
    for (const m of text.matchAll(/\b(fill|stroke|stop-color|color)\s*=\s*["']([^"']+)["']/g)) {
      const lit = colorLiteral(m[2]);
      if (lit) add(`hard-coded color ${lit} in SVG ${m[1]}=`, `use ${m[1]}="var(--…)" with a token, or currentColor`);
    }
  });
  return problems;
}

const inScope = (file) => SCANNED.has(extname(file)) && basename(file) !== TOKEN_FILE;

function format(file, problems) {
  return problems.map(p => `  ${file}:${p.line}  ${p.why}\n      ${p.text}\n      fix: ${p.fix}`).join("\n");
}

/* ---------- Hook mode: check only the text the agent is about to write ---------- */
async function hook() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); } // never block on a malformed payload
  const ti = data.tool_input || {};
  const file = ti.file_path || "";
  if (!file || !inScope(file)) process.exit(0);

  const chunks = [];
  if (typeof ti.content === "string") chunks.push(ti.content);              // Write
  if (typeof ti.new_string === "string") chunks.push(ti.new_string);        // Edit
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof e?.new_string === "string") chunks.push(e.new_string); // MultiEdit

  const problems = chunks.flatMap(c => findProblems(c));
  if (!problems.length) process.exit(0);

  const rel = file.startsWith(ROOT) ? relative(ROOT, file) : file;
  process.stderr.write(
`Blocked by the design-token check (scripts/check-tokens.mjs). This edit to ${rel} adds ${problems.length} value(s) that must come from ${TOKEN_FILE}:
${format(rel + " (new text)", problems)}
Rewrite the edit using the tokens, then try again. Rules are in CLAUDE.md under "Design tokens".
`);
  process.exit(2);
}

/* ---------- Full scan mode ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(p, out); }
    else if (inScope(p)) out.push(p);
  }
  return out;
}

function scanAll() {
  let total = 0;
  for (const file of walk(ROOT)) {
    const problems = findProblems(readFileSync(file, "utf8"));
    if (problems.length) { total += problems.length; console.error(format(relative(ROOT, file), problems)); }
  }
  if (total) {
    console.error(`\nToken check failed: ${total} hard-coded value(s). Colors and fonts belong in ${TOKEN_FILE}.`);
    process.exit(1);
  }
  console.log("Token check passed: no hard-coded colors, fonts or inline styles outside tokens.css.");
}

if (process.argv.includes("--hook")) hook(); else scanAll();
