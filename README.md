# Job Checker

Is this job actually being filled? Job Checker rates a LinkedIn job posting from 1 (likely a ghost job) to 5 (actively hiring), with a secondary check for job scams. Every finding shows where it came from, so users can verify it themselves.

## How it works

1. **Paste** – the user copies the whole LinkedIn job page and pastes it in.
2. **Review** – Job Checker pulls out the title, company, posting age, applicants, pay, poster, website, recruiter email and description. Each detail can be edited in place.
3. **Verify** – optional questions the page can't answer, each with a one-click search link.
4. **Results** – the 1–5 rating, every warning sign and good sign with its source, the score math and next steps.

Everything runs in the browser. Pasted text is never sent or stored, and Job Checker never visits LinkedIn itself.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app: markup, styles and script in one file |
| `privacy.html`, `terms.html`, `legal.css` | Privacy policy and terms of use |
| `netlify.toml` | Netlify settings: no build step, publish the repo root |

## Running locally

Open `index.html` in a browser. There is no build step and nothing to install.

## Deploying

The site deploys on Netlify from the `main` branch. Every change merged into `main` goes live automatically.

## Planned

Automatic company lookups (careers page, reposts, layoffs, acquisitions, funding), run by a Netlify function that receives only the company name and job title. The interface is already in place; set `LOOKUP_URL` in `index.html` once the function exists.
