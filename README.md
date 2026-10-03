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
| `index.html` | The whole app: markup, styles and script in one file |
| `privacy.html`, `terms.html`, `legal.css` | Privacy policy and terms of use |
| `netlify.toml` | Netlify settings: no build step, publish the repo root |
| `netlify/functions/lookup.mts` | The company lookup service |
| `package.json` | The one library the lookup service uses (Netlify Blobs) |

## Running locally

Open `index.html` in a browser. There is no build step and nothing to install.

## Deploying

The site deploys on Netlify from the `main` branch. Every change merged into `main` goes live automatically.
