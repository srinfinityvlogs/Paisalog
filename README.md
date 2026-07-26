# Telegram Expense Bot — Build Guide

A Telegram bot that logs expenses to Google Sheets from plain text (`Grocery 250`)
and, in phase 2, from receipt photos via OCR. Runs entirely on free-tier
services with no always-on server.

---

## 1. Recommended architecture

```
Telegram user
     │  (text or photo)
     ▼
Telegram Bot API  ──webhook (HTTPS POST)──▶  Vercel Serverless Function  (/api/webhook.js)
                                                      │
                                    ┌─────────────────┼──────────────────┐
                                    ▼                                    ▼
                          Google Sheets API                      OCR.space API
                        (service account, REST)                (receipt → text)
                                    │
                                    ▼
                          Your Google Sheet
                     (Transactions / Pending / Meta tabs)
```

**Why this shape:**

- **Webhook, not polling.** A bot with long polling needs a process running
  24/7 to keep asking Telegram "any new messages?". That's exactly the
  always-on server you said you want to avoid. A webhook flips it around:
  Telegram calls *you* only when there's actually a message, so a stateless
  serverless function is enough — it wakes up, does its job, and shuts down.
- **Google Sheets API directly (service account), not a spreadsheet-side
  script as the primary path.** A service account gives you a normal
  request/response API you can call from anywhere, version-control your
  logic in a real repo, and unit-test locally. Google Apps Script *can* do
  this too (see the fallback below) but it's harder to develop against from
  VS Code on Windows and harder to extend with npm packages later.
- **No database.** Google Sheets *is* the database. For a personal
  expense log at human-typing volume, this is genuinely enough, and it's
  free with no separate account to manage.
- **No persistent connection anywhere.** Telegram → your function → Google
  Sheets / OCR.space are all plain HTTPS request/response calls. Nothing in
  this design needs a socket held open.

---

## 2. Free-tier stack options

| Layer | Recommended | Alternative | Why recommended wins |
|---|---|---|---|
| Bot host | **Vercel Serverless Functions (Node.js)** | Cloudflare Workers | Workers' runtime doesn't support Node's `googleapis` SDK cleanly (no full `fs`/`net`); you'd hand-roll JWT signing with the Web Crypto API for Sheets auth. Vercel gives you a normal Node runtime, so the official Google SDK just works, and its free tier now runs functions with up to a 300s duration by default (Fluid Compute), 100 GB bandwidth, ~1M invocations/month, more than enough for a personal bot. |
| Sheets access | **Google Sheets API v4 + service account** | Google Apps Script Web App | Service account = real REST API, works from any host, no separate Google Sheets-side deployment to keep in sync with your repo. |
| OCR | **OCR.space free API** | Google Cloud Vision, self-hosted Tesseract | OCR.space needs just a free API key (no card, no GCP billing account to enable) and 25,000 requests/month (~500/day) is far beyond personal receipt volume. Cloud Vision is more accurate but wants a GCP billing account attached even to use its free quota. Tesseract is free and offline but needs a real compute runtime (won't run well inside a lightweight serverless function) — a good phase-3 upgrade, not a phase-2 starting point. |
| Local dev | **Node.js + a simulate-update script** | ngrok + real Telegram round-trip | You can develop and test the parsing/Sheets/Telegram logic without exposing anything to the internet. Use ngrok only for the final pre-deploy check. |

**Fallback if you want zero external hosting at all:** Google Apps Script,
deployed as a Web App, can itself receive the Telegram webhook and write to
the Sheet it lives in — no Vercel account needed. It's simpler to set up but
more limited (harder local dev, no npm ecosystem, clunkier OCR/state
handling). A minimal version is included in `apps-script-fallback/Code.gs`.
Start with the main stack; keep this in your pocket if you ever want to
strip hosting down to just Google.

---

## 3. Step-by-step build plan

1. Create the Telegram bot with BotFather → get a token. (Section 4)
2. Create the Google Sheet + service account → get credentials. (Section 5)
3. Clone/download this project, install dependencies, fill in `.env`.
4. Test the parsing + Sheets + Telegram logic locally with
   `npm run simulate` (no public URL needed).
5. Push the repo to GitHub, import it into Vercel, add the same environment
   variables in the Vercel dashboard, deploy.
6. Point Telegram's webhook at your deployed URL with `npm run set-webhook`.
7. Message your bot for real: `Grocery 250` → check the Sheet.
8. Add your OCR.space key, send a receipt photo, confirm the extraction
   flow works end to end.
9. Build the monthly-summary tab (Section 5) and iterate on categories.

---

## 4. Telegram bot setup

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, pick a name and a unique username ending in `bot`.
3. BotFather replies with an API token — this is `TELEGRAM_BOT_TOKEN`.
4. Message **@userinfobot** to get your own numeric Telegram user ID — this
   is `ALLOWED_TELEGRAM_USER_ID`. Setting it restricts the bot to only you,
   which matters because the webhook URL will be public.
5. (Optional) Send `/setcommands` to BotFather and register:
   ```
   last - show the last logged expense
   undo - delete the last logged expense
   setcategory - fix the last entry's category
   ```

---

## 5. Google Sheets setup

### Create the spreadsheet
1. Create a new Google Sheet, e.g. "Expenses".
2. Rename the first tab to **Transactions** with this header row:

   | Timestamp | Expense Type | Category | Amount | Merchant | Notes | Source | Raw Input / Raw OCR Text | Month |
   |---|---|---|---|---|---|---|---|---|

3. Add a tab named **Meta** — used to store the last processed Telegram
   `update_id` for duplicate protection. Put `0` in cell A1.
4. Add a tab named **Pending** — used to temporarily hold receipt data
   between "here's what I found" and you tapping Save. Header row:

   | PendingId | ChatId | Timestamp | DataJSON |
   |---|---|---|---|

5. Copy the Sheet ID out of the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` →
   this is `GOOGLE_SHEET_ID`.

### Connect the bot to the sheet — Apps Script proxy (recommended default)
Many GCP organizations now block downloading service account keys
(`iam.disableServiceAccountKeyCreation`) as a default security policy. Rather
than fight that policy, this project's default `lib/sheets.js` talks to a
small Apps Script Web App instead — it runs under your own Google identity
(no key, nothing to leak) and the bot authenticates to *it* with a shared
secret you invent yourself.

1. In your Google Sheet: Extensions → Apps Script.
2. Delete any starter code, paste in the contents of
   `google-apps-script-proxy/Code.gs` from this repo, save.
3. Project Settings (gear icon, left sidebar) → Script Properties → Add
   property: `SHEETS_PROXY_SECRET` = a random string you invent.
4. Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click Deploy, authorize the requested permissions (this is you granting
   the script access to your own sheet — normal and expected), then copy
   the Web app URL.
6. In your bot's `.env`:
   ```
   SHEETS_PROXY_URL=<the Web app URL>
   SHEETS_PROXY_SECRET=<the same random string from step 3>
   ```

Whenever you edit `Code.gs` later, you need to push a **new deployment
version** (Deploy → Manage deployments → pencil icon → New version) for the
change to take effect — editing the script alone doesn't update the live URL.

### Alternative: direct Sheets API with a service account
If your GCP organization *doesn't* block service account key creation, you
can skip the proxy and call the Sheets API directly instead — slightly less
moving parts, at the cost of managing a key file.
1. Go to [console.cloud.google.com](https://console.cloud.google.com),
   create a project (free, no billing account required for this).
2. Enable the **Google Sheets API** for that project.
3. IAM & Admin → Service Accounts → Create service account (any name is fine).
4. Open it → Keys → Add key → JSON. This downloads a `.json` key file.
5. From that file, copy `client_email` → `GOOGLE_CLIENT_EMAIL` and
   `private_key` → `GOOGLE_PRIVATE_KEY` (keep the `\n` characters, wrap in
   quotes in `.env`), plus your Sheet's ID from its URL → `GOOGLE_SHEET_ID`.
6. **Share the Sheet** with the service account's email address, Editor access.
7. Reinstall `googleapis` (`npm install googleapis`) and swap `lib/sheets.js`
   back to calling the Sheets API directly — the version from earlier in
   this build still works verbatim if you kept a copy, since every other
   file (`handleUpdate.js`, `api/webhook.js`) only depends on the exported
   function names in `sheets.js`, not how they're implemented.

### Monthly summary tab (formulas)
Add a tab named **Summary**. Two easy options:

- **Pivot table (recommended, no formulas to maintain):** Select the
  Transactions data → Insert → Pivot table → new sheet. Rows: `Month`.
  Columns: `Category`. Values: `SUM of Amount`. This gives you a
  category-by-month breakdown that updates itself as new rows are added.
- **Formula-based, if you prefer:**
  ```
  =QUERY(Transactions!A:I, "select I, sum(D) where A is not null group by I label sum(D) 'Total'", 1)
  ```
  for totals per month, or, with a list of category names in column A of
  the Summary tab starting at A2:
  ```
  =SUMIF(Transactions!C:C, A2, Transactions!D:D)
  ```
  for a running total per category.

---

## 6. Folder structure

```
telegram-expense-bot/
├── README.md                    ← this file
├── package.json
├── .env.example                 ← copy to .env and fill in
├── .gitignore
├── api/
│   └── webhook.js               ← Vercel entry point (Telegram → here)
├── lib/
│   ├── categories.js            ← extend this to add new categories
│   ├── parser.js                ← "Grocery 250" → {category, amount}
│   ├── sheets.js                ← all Google Sheets reads/writes
│   ├── telegram.js               ← Telegram Bot API helpers
│   ├── ocr.js                    ← OCR.space call + receipt-field heuristics
│   └── handleUpdate.js           ← orchestration, testable without HTTP
├── scripts/
│   ├── set-webhook.js            ← registers your deployed URL with Telegram
│   ├── delete-webhook.js
│   └── simulate-update.js        ← test locally without ngrok
├── google-apps-script-proxy/
│   └── Code.gs                   ← Sheets read/write proxy (default Sheets auth path)
└── apps-script-fallback/
    └── Code.gs                   ← optional all-in-one, zero-Vercel alternative
```

---

## 7. Environment variables

| Variable | Where it's used | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | telegram.js | From BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | api/webhook.js | Any random string you invent; blocks unauthenticated POSTs to your endpoint |
| `ALLOWED_TELEGRAM_USER_ID` | handleUpdate.js | Your numeric Telegram ID; leave blank to allow anyone |
| `SHEETS_PROXY_URL` | sheets.js | Apps Script Web App deployment URL |
| `SHEETS_PROXY_SECRET` | sheets.js | Random string, must match Script Properties in Apps Script |
| *(alt)* `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_SHEET_ID` | sheets.js | Only if you switched to the direct service-account approach |
| `OCR_SPACE_API_KEY` | ocr.js | Free key from ocr.space/ocrapi/freekey (the shared `helloworld` key is heavily rate-limited) |
| `BASE_URL` | scripts/set-webhook.js | Your deployed Vercel URL, no trailing slash |

---

## 8. Minimal working version (text logging) — already in this repo

`lib/parser.js` + `lib/categories.js` + `lib/sheets.js` +
`lib/handleUpdate.js` + `api/webhook.js` together are the full text-logging
path. Nothing else is required to get `Grocery 250` → a new Sheet row →
a Telegram confirmation working. Test it locally first (Section 10) before
touching deployment.

---

## 9. OCR receipt-processing version — already in this repo

`lib/ocr.js` (extraction) + the `handlePhoto`/`handleCallback` functions in
`lib/handleUpdate.js` (confirmation flow) implement:

1. Photo received → largest resolution file downloaded from Telegram.
2. Sent to OCR.space → raw text back.
3. `parseReceiptText()` guesses merchant / date / total / tax with regex
   heuristics (first line = merchant, "total"/"amount due" keyword search,
   date-shaped substring, "tax"/"vat"/"gst" keyword search).
4. Extracted fields written to a **Pending** row and shown to you with
   inline **Save / Discard** buttons — nothing hits Transactions yet.
5. Tapping **Save** moves that data into Transactions; **Discard** deletes
   the pending row. Either way the temporary row is cleaned up.

**To improve accuracy later**, the only function you need to touch is
`parseReceiptText()` in `lib/ocr.js` — swap the regex heuristics for a call
to an LLM prompt ("extract merchant/date/total/tax as JSON from this
receipt text"), or a purpose-built receipt-parsing API, without touching
Telegram or Sheets code at all.

---

## 10. Local development (Windows)

1. Install [Node.js LTS](https://nodejs.org) (18+).
2. Open PowerShell in the project folder:
   ```powershell
   npm install
   copy .env.example .env
   notepad .env    # fill in every value from sections 4 and 5
   ```
3. Test the logic directly — no ngrok, no deployment, no public URL:
   ```powershell
   npm run simulate -- "Grocery 250"
   ```
   This calls the real Google Sheets API and the real Telegram
   `sendMessage` API, so check both your Sheet and your Telegram chat with
   the bot. Iterate here until parsing/categories/Sheets writes all look
   right.
4. Try the commands too:
   ```powershell
   npm run simulate -- "/last"
   npm run simulate -- "/undo"
   ```
5. (Optional, before your first real deploy) do one true end-to-end check
   with an actual Telegram webhook, using a tunnel:
   ```powershell
   npx vercel dev          # runs your /api functions locally
   ngrok http 3000          # in a second terminal — gives you a public https URL
   ```
   Temporarily set `BASE_URL` in `.env` to the ngrok URL, run
   `npm run set-webhook`, and message your bot for real. Run
   `npm run delete-webhook` when you're done so Telegram stops trying to
   reach your laptop.

---

## 11. Deployment (Vercel free tier)

1. Push this project to a GitHub repo (private is fine).
2. Go to [vercel.com](https://vercel.com) → New Project → import the repo.
   No build configuration needed — Vercel auto-detects the `api/` folder.
3. In the Vercel project's Settings → Environment Variables, add every
   variable from Section 7 (same values as your local `.env`), for the
   Production environment.
4. Deploy. Copy the resulting URL (e.g. `https://telegram-expense-bot.vercel.app`).
5. Locally, set `BASE_URL` in `.env` to that URL, then:
   ```powershell
   npm run set-webhook
   ```
6. Message your bot for real. Every push to your main branch redeploys
   automatically; the webhook URL doesn't change between deploys, so you
   only run `set-webhook` again if the domain itself changes.

---

## 12. Risks, limitations, and how to handle them

- **Google Sheets isn't a real database.** Fine for personal-scale volume
  (tens of entries/day); if you ever need concurrent multi-user writes or
  complex queries, migrate to a real database (e.g. free-tier Postgres on
  Supabase or Neon) and keep the same webhook/parsing layer.
- **OCR accuracy is heuristic, not guaranteed.** Receipts vary wildly in
  layout; the confirm-before-save step exists specifically so a bad
  extraction never silently corrupts your data — you always see it first.
- **OCR.space free tier: ~25,000 requests/month (≈500/day per IP), and a
  file-size limit around 1MB on the free plan.** Personal receipt volume
  won't come close to the monthly cap, but compress/resize large photos if
  you hit the size limit. Get your own free key rather than using the
  shared `helloworld` demo key, which is rate-limited much more tightly.
- **Vercel Hobby plan is for personal, non-commercial use** and has usage
  caps (bandwidth, invocations, function duration) — generous for a
  personal bot, but not something to build a paid product on without
  upgrading.
- **Webhook security:** the `TELEGRAM_WEBHOOK_SECRET` check stops random
  internet traffic from writing fake rows to your sheet; `ALLOWED_TELEGRAM_USER_ID`
  stops anyone but you from using the bot even if they somehow message it.
- **Duplicate protection covers webhook retries**, not you accidentally
  sending the same message twice on purpose — that's what `/undo` is for.
- **Service account key is a secret.** Never commit `.env` (already
  gitignored) — anyone with that key can write to your Sheet.
- **If Telegram's servers can't reach your function** (deploy paused, env
  var typo, etc.), Telegram will retry for a while and then silently give
  up; nothing queues in the background. Check the Vercel function logs if
  messages stop appearing.

---

## 13. Roadmap for future features

- **Better OCR:** swap regex heuristics in `ocr.js` for an LLM-based
  extraction call, or a dedicated receipt-parsing API, once you've seen
  enough real receipts to know where the heuristics fail.
- **Line-item capture:** currently only the total is logged; extend
  `parseReceiptText()` to return an item array and write one row per item.
- **Multi-currency support:** detect a currency symbol/code in text or OCR
  output and store it as its own column.
- **Budgets & alerts:** a scheduled Vercel Cron Job (also free-tier) that
  reads the Summary tab weekly and messages you if a category is trending
  over budget.
- **Voice message logging:** Telegram voice notes → speech-to-text → same
  parser pipeline.
- **Multi-user / household mode:** drop the single `ALLOWED_TELEGRAM_USER_ID`
  restriction, add a `User` column, and give each household member their
  own row attribution.
- **Web dashboard:** a small static page (also free on Vercel) reading
  from the same Sheet via the Sheets API for charts beyond what Sheets'
  own charting offers.
