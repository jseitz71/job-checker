# Job Checker

Is this job actually being filled? Job Checker rates a LinkedIn job posting from 1 (likely a ghost job) to 5 (actively hiring), with a secondary check for job scams. Every finding shows where it came from, so users can verify it themselves.

## How it works

1. **Paste** – the user copies the whole LinkedIn job page and pastes it in.
2. **Review** – Job Checker pulls out the title, company, posting age, applicants, pay, poster, website, recruiter email and description. Each detail can be edited in place.
3. **Verify** – optional questions the page can't answer, each with a one-click search link.
4. **Results** – the 1–5 rating, every warning sign and good sign with its source, the score math and next steps.

Everything runs in the browser. Pasted text is never sent or stored, and Job Checker never visits LinkedIn itself.

## Company lookups

Step 3's **Look up company facts** button calls `/api/lookup`, a Netlify function in `netlify/functions/lookup.mts`. It receives only the company name, job title and website, then:

1. checks the company's public job board on Greenhouse, Lever or Ashby, if it has one;
2. runs six Brave searches (careers page, copies of the posting, layoffs, acquisitions or hiring freezes, funding, address);
3. asks Claude Haiku to turn the results into suggested answers, each citing the results it used.

Results are cached for 24 hours in Netlify Blobs. Daily caps keep costs predictable.

### Settings (Netlify → Project configuration → Environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BRAVE_API_KEY` | yes | | Brave Search API key |
| `ANTHROPIC_API_KEY` | yes | | Claude API key |
| `DAILY_LOOKUP_LIMIT` | no | 100 | Fresh lookups per day for the whole site |
| `VISITOR_DAILY_LIMIT` | no | 5 | Fresh lookups per visitor per day |

Without the two keys the button shows "Automatic lookups aren't switched on yet." Cached results don't count toward the limits.

## Files

| File | Purpose |
|---|---|
| `tokens.css` | Design tokens: every color, font, spacing and radius value, light and dark |
| `index.html` | The whole app: markup, styles and script in one file |
| `privacy.html`, `terms.html`, `legal.css` | Privacy policy and terms of use |
| `netlify.toml` | Netlify settings: no build step, publish the repo root |
| `netlify/functions/lookup.mts` | The company lookup service |
| `package.json` | The lookup service's library (Netlify Blobs) and the check commands |
| `CLAUDE.md` | Rules for AI coding agents working in this repo |
| `.claude/settings.json` | Turns on the token hook for Claude Code |
| `scripts/` | The token check and the accessibility check |
| `.github/workflows/checks.yml` | Runs both checks on every pull request |

## Running locally

Open `index.html` in a browser. There is no build step, and the app itself needs nothing installed.

To run the checks: `npm install`, then `npm run check`.

## How AI agents work in this repo

Most changes to Job Checker are made with an AI coding agent (Claude Code). Without guidance, an agent makes reasonable-looking choices that drift: a new shade of blue, a one-off button, a missing label. This repo carries a small **harness** so agent output stays on-system and repeatable, and so problems are caught by a machine before a person has to spot them.

| Layer | What it does | When it runs |
|---|---|---|
| **Tokens** (`tokens.css`) | One source of truth for color, type, spacing and radius, in light and dark. | Always: every page loads it first. |
| **Instructions** (`CLAUDE.md`) | The standing brief: which tokens and components to use, accessibility rules, content rules, the AI lookup's contract, and what "done" means. | Read by the agent at the start of every session. |
| **Hook** (`.claude/settings.json` → `scripts/check-tokens.mjs --hook`) | Inspects each edit *before* it's written. Hard-coded colors, font names and inline styles are blocked, and the agent is told which token to use instead. | Every time the agent edits or writes a file. |
| **Accessibility check** (`scripts/check-a11y.mjs`) | Runs axe (WCAG 2.2 A/AA) on every reachable screen: step 1, all three examples through steps 2–4, the criteria drawer and the legal pages, each in light and dark at desktop and phone widths (56 combinations). | `npm run check`, and on every pull request. |
| **CI** (`.github/workflows/checks.yml`) | Runs the token check and the accessibility check on GitHub. | Every pull request and every push to `main`. |

The instructions *ask*, the hook *enforces while the agent works*, and CI *enforces at the door*. Rules people care about most (accessibility, the token system, source tracing) are written down once and checked automatically.

The AI inside the product has a harness too: the company lookup's output contract (answers limited to yes / no / none, citations checked against real search results, "none" when evidence is unclear) is described in `CLAUDE.md` so agents don't weaken it.

**Adding a rule:** write it in `CLAUDE.md`. If it can be checked mechanically, add the check to `scripts/` so it doesn't depend on the agent remembering.

## Deploying

The site deploys on Netlify from the `main` branch. Every change merged into `main` goes live automatically.
