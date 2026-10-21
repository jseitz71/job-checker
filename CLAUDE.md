# Job Checker: rules for coding agents

Job Checker rates a LinkedIn job posting 1 (likely ghost job) to 5 (actively hiring), with a secondary scam check. Its promise to users is **every finding is traced to its source**, so they can check it themselves. Protect that promise in every change.

Read this file before changing anything. The checks named here run automatically. You can't merge work that fails them, so follow the rules up front instead of fixing later.

## Map

| File | What it is |
|---|---|
| `tokens.css` | Design tokens: every color, font, spacing and radius value. Loaded first by every page. |
| `index.html` | The whole app: markup, page styles and script in one file. No build step, no framework. |
| `privacy.html`, `terms.html`, `legal.css` | Legal pages. |
| `netlify/functions/lookup.mts` | Server-side company lookup (Brave search + Claude). The only code that calls an AI model. |
| `scripts/check-tokens.mjs` | Token rule check. Also runs as a hook before every file edit you make. |
| `scripts/check-a11y.mjs` | Accessibility check (axe, WCAG 2.2 AA) across every screen, both themes, desktop and phone. |

Keep the app as a single static `index.html`. Don't add a framework, bundler or build step.

## Design tokens

- **Colors and font families exist only in `tokens.css`.** Everywhere else, use `var(--token)`. No hex, `rgb()`, `hsl()` or named colors; no font names.
- **No inline `style=""` attributes**, including inside JavaScript template strings. Add or reuse a class.
- **New spacing and radius values use the scale:** `--space-1` to `--space-8` (4px base), `--radius-s` to `--radius-xl`. Existing CSS predates the scale; when you touch a rule, move it onto the scale.
- **Status colors are meaning, not decoration:** `--bad` (warning signs, scams), `--warn` (uncertain), `--good` (good signs, edited), `--ghost` (ghost-job signs, looked-up suggestions). Only `--accent` is the brand color.
- **Adding a token:** add it to `tokens.css` in the light block and both dark blocks, with a comment saying what it's for. Then check contrast in both themes.
- Escape hatch: a line with `token-ok` and a reason is skipped by the check. Don't use it without the person's agreement.

The `PreToolUse` hook in `.claude/settings.json` runs `scripts/check-tokens.mjs --hook` before every Edit or Write. If it blocks you, its message says which value to replace and with which token. Rewrite the edit; don't work around the hook.

## Components: reuse before you build

These already exist in `index.html`. Use them instead of creating look-alikes:

- **Buttons:** `button` (default), `.primary` (one per screen area: the main next action), `.small`, `.link` (text-style), `.iconbtn` (icon only, needs `aria-label`).
- **Containers:** `.panel` (card), `.sub` / `.next` / `.lookup` (sunk boxes), `.msg` / `.msg.warn` (status messages; empty ones hide themselves).
- **Labels:** `.pill` (+ `.bad` / `.warn` / `.good`), `.tag.scam`, `.tag.ghost`, `.chip` (Edited), `.prov` (where a detail came from), `.sample`, `.eyebrow`.
- **Inputs:** `label.f` wrapping a field, with `.lab` and `.hint`; `.seg` for Yes / No / Not sure (buttons with `aria-pressed`).
- **Lists:** `.findings` with `li.bad`, `li.good`, `li.unk`; `.frow` for editable detail rows.
- **Layout helpers:** `.btnrow`, `.navrow`, `.fields`, spacing utilities `.mt-2`, `.mt-3`, `.mb-2`.

If something new is truly needed, build it from tokens, follow the patterns above, and tell the person what you added and why.

## Accessibility (non-negotiable)

- Every control has a visible label or an `aria-label`. Icon-only buttons always need one.
- Use real `button`, `a`, `label`, `details` / `summary` elements. No clickable `div`s.
- Keep the focus ring (`:focus-visible` outline in `--accent`). Never remove an outline without replacing it.
- Text contrast is at least 4.5:1 (3:1 for large text and UI parts) **in both light and dark themes**.
- Status changes are announced: use the existing `role="status"`, `role="alert"` or `aria-live` regions.
- Color never carries meaning alone: pair it with a word, icon or label (e.g. a pill says "Likely ghost job", not just red).
- Animations go inside `@media (prefers-reduced-motion: no-preference)`.
- Works at 375px wide with no horizontal scrolling, except the criteria table, which scrolls inside its own box.

## Content and trust

- Plain, calm language. Sentence case. No jargon, no exclamation marks.
- Every finding shown to users names its source: the posting line it came from, a search result link, or "you entered this".
- Ratings are a screening aid, not an accusation. Don't write copy that states a company is fraudulent.
- Pasted posting text stays in the browser. Never send it to the server or any third party.

## The AI lookup (`netlify/functions/lookup.mts`)

The model's output is a contract. Keep every part of it:

- Answers are only `"yes"`, `"no"` or `"none"`; anything else is discarded.
- The model may only cite the numbered results it was given. Source numbers are checked against the real results, so links can't be invented.
- When evidence is unclear or missing, the answer is `"none"`. A missing result is never a "no".
- `temperature: 0`, results cached 24 hours, and direct evidence (a public job-board feed) answers without the model.
- If the model fails or replies badly, fall back to the raw search results, never to a guess.
- Users confirm each suggestion before it counts toward the rating.

Don't loosen any of these, change the model, or raise the daily limits without asking the person first.

## Never

- Commit API keys or secrets. They live in Netlify environment variables only.
- Change the legal pages' meaning (`privacy.html`, `terms.html`) without the person's review.
- Change the scoring weights or default rules without saying so explicitly in your summary. They change every user's rating.

## Before you say you're done

1. Run `npm run check`. It runs the token check and the accessibility check, and both must pass. (First time: `npm install`.)
2. Look at what you changed in a browser in light and dark themes, and at phone width.
3. In your summary, list any new components or tokens, and anything you couldn't verify.

The same checks run on every pull request in GitHub Actions (`.github/workflows/checks.yml`).
