# Telegram Expense Bot — PaisaLog

A Telegram bot that logs expenses to Google Sheets from plain text (`Grocery 250`) or receipt photos — with dedicated, accurate parsing for BigBasket and Swiggy Instamart invoices, and a solid general-purpose parser for ordinary till receipts (grocery stores, small shops, etc). Runs entirely on free-tier services, no always-on server, no paid API required.

---

## What it does

- **Text logging**: `Grocery 250` → parsed into category + amount, written to your Sheet, confirmed in Telegram.
- **Receipt photo logging**: send a photo → OCR extracts merchant, date, total, and (where the receipt format allows) a per-item breakdown with quantity and rate → you confirm before it's saved.
- **Multi-merchant OCR**: automatically detects BigBasket and Instamart's structured tax-invoice formats and parses them with dedicated logic; falls back to a general heuristic (tuned against real KPN/Reliance-style till receipts) for everything else.
- **Manual overrides via photo caption**: caption a receipt photo with a date (`21/07/2026`), a merchant name (`Instamart`), and/or a handling fee (`15.00`) — in any combination — to override or supplement what OCR reads.
- **Month-based Sheet tabs**: each transaction is automatically routed to a tab matching its own date (e.g. `July 2026`), not just "whenever you happened to upload it." Tabs are created automatically the first time they're needed.
- **Date-ordered rows**: within a tab, rows are inserted in date order, not upload order — an earlier-dated receipt uploaded later still lands above a later-dated one already in the sheet.
- **Corrections**: `/last`, `/undo`, `/setcategory <name>` — always operate on whichever row was actually last touched, even across month tabs.
- **Handling fee support**: auto-extracted for Instamart; supply it manually via caption for BigBasket or any other receipt.

---

## Architecture

```
Telegram user
     │  (text, or photo with optional caption)
     ▼
Telegram Bot API  ──webhook──▶  Vercel Serverless Function (/api/webhook.js)
                                        │
                         ┌──────────────┼──────────────┐
                         ▼                              ▼
                 Google Apps Script              OCR.space API
                 Web App ("proxy")              (receipt → text)
                         │
                         ▼
                  Your Google Sheet
        (month tabs, Meta, Pending, RawOCR)
```

No service account key, no paid database, no always-on server. Google Sheets access goes through a small Apps Script Web App instead of a service account — this avoids `iam.disableServiceAccountKeyCreation`, an org policy many GCP accounts now enforce by default that blocks downloading service account keys entirely.

---

## Google Sheet structure

**One tab per month** (e.g. `July 2026`), created automatically. Each has this column layout:

| Col | Field | Notes |
|---|---|---|
| A | Expense Type | e.g. "Food & Dining", "Transport", "Other" |
| B | Category | e.g. "Grocery", "Papaya" |
| C | Merchant | |
| D | Rate | Per-unit price, where available |
| E | Qty | Quantity or package weight |
| F | Amount | This line item's cost |
| G | Date | `DD/MM/YYYY`, the receipt's own date (or today's, for text logs) |
| H | Final Bill | Only on the first row of a multi-item receipt — items total + handling fee if any |
| I | Notes | e.g. "Handling Fee: 12.01" |
| J | Source | `Telegram-Text` or `Telegram-OCR` |
| K | Raw OCR Ref | Short ID — full OCR text lives in the `RawOCR` tab, not duplicated here |
| L | Timestamp | ISO datetime the bot actually processed it |

Plus three fixed (non-monthly) tabs:
- **Meta** — bookkeeping: last processed Telegram `update_id` (A1), name of the most recently written month tab (A2), row number most recently written within it (A3).
- **Pending** — short-lived holding area between "here's what I found" and you tapping Save/Discard.
- **RawOCR** — `ReceiptId | Timestamp | Raw OCR Text`, one row per receipt, referenced from the month tabs by the short ID in column K.

Between logged entries (a whole receipt, or a single text log), the bot leaves one blank row for readability.

---

## Setup — for a friend starting fresh

### 1. Get the code
```bash
git clone https://github.com/srinfinityvlogs/Paisalog.git
cd Paisalog
npm install
cp .env.example .env
```

### 2. Create the Telegram bot
1. Message **@BotFather** on Telegram → `/newbot` → note the token.
2. Message **@userinfobot** → note your own numeric user ID (restricts the bot to just you).

### 3. Create the Google Sheet
1. New Google Sheet.
2. Create tabs named exactly: **Meta**, **Pending**, **RawOCR** (header row `ReceiptId | Timestamp | Raw OCR Text` on RawOCR — the others don't need headers, the bot manages them).
3. Set `Meta!A1` to `0`.
4. You do **not** need to create a month tab yourself — the bot creates the first one automatically on your first logged expense.

### 4. Deploy the Sheets proxy (Apps Script)
1. In the Sheet: **Extensions → Apps Script**.
2. Delete the starter code, paste in the contents of `google-apps-script-proxy/Code.gs` from this repo.
3. **Project Settings → Script Properties** → add `SHEETS_PROXY_SECRET` = a random string you invent (generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
4. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy, authorize when prompted, copy the URL (ends in `/exec`).
5. Whenever you edit `Code.gs` later, you must push a **new deployment version** (Deploy → Manage deployments → pencil icon → New version) — editing alone doesn't update the live URL.

### 5. Get a free OCR key
Sign up at [ocr.space/ocrapi/freekey](https://ocr.space/ocrapi/freekey) — free, no credit card, ~25,000 requests/month.

### 6. Fill in `.env`
```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_WEBHOOK_SECRET=<a random string you invent>
ALLOWED_TELEGRAM_USER_ID=<your numeric ID from userinfobot>
SHEETS_PROXY_URL=<the Apps Script Web App URL, ending in /exec>
SHEETS_PROXY_SECRET=<same value as Script Properties in step 4>
OCR_SPACE_API_KEY=<from step 5>
BASE_URL=  # fill in after deploying, step 7
```

### 7. Deploy to Vercel
1. Push this repo to your own GitHub account.
2. [vercel.com](https://vercel.com) → New Project → import your repo. No build config needed.
3. In **Settings → Environment Variables**, add every variable from `.env` above.
4. Deploy. Copy the resulting URL into `.env`'s `BASE_URL`.
5. **Settings → Git**, confirm the repo is connected — this makes every future `git push` auto-deploy, no manual `vercel --prod` needed.

### 8. Register the webhook
```bash
npm run set-webhook
```

### 9. Test it
Message your bot: `Grocery 250`. Check the Sheet — a `<Month> <Year>` tab should now exist with your entry in it.

---

## Local development

`npm run simulate -- "Grocery 250"` fakes an incoming Telegram update and calls the real Sheets proxy + Telegram API — no ngrok or public URL needed for iterating on logic. See `scripts/simulate-update.js`.

---

## Using it day to day

- **Text**: `Category Amount`, e.g. `Lunch 120`.
- **Receipt photo**: just send it. Reply with **Save** or **Discard** when the preview comes back.
- **Manual overrides on a photo's caption** (any combination, any order the date-then-rest works out to):
  - `21/07/2026` — set the invoice date
  - `Instamart` — set/force the merchant (also picks that merchant's dedicated parser directly, skipping auto-detection)
  - `21/07/2026 BigBasket 15.00` — date + merchant + handling fee, all at once
- **`/last`** — show the most recently logged entry.
- **`/undo`** — delete it.
- **`/setcategory <name>`** — fix its category.

---

## Extending to a new merchant's receipt format

`lib/ocr.js` has a `RECEIPT_FORMATS` registry — each entry is `{ key, matchNames, detect(rawText), extractFields(rawText, rows) }`. To add a new merchant:
1. Write a `detect()` that fingerprints that merchant's OCR text (look for column headers/keywords unique to it).
2. Write an `extractFields()` that pulls merchant/date/total/items from either the raw text or the coordinate-clustered `rows`, whichever is more reliable for that format (see the BigBasket vs. Instamart implementations for two different approaches — BigBasket uses `rows`, Instamart works off flat text lines since that proved more reliable for its bordered-table screenshots).
3. Add an entry to `RECEIPT_FORMATS` with some `matchNames` so it can also be selected via caption override.

Receipts that don't match any registered format fall through to the general heuristic (`extractReceiptFieldsFromRows_`), which is what currently handles KPN, Reliance, and other plain till receipts.

---

## Known limitations

- **OCR is not deterministic.** The same photo can occasionally return different raw text between calls. Confirm-before-save exists specifically so a bad read never silently corrupts your data.
- **Instamart item names on multi-line-wrapped descriptions** can occasionally pick up a stray word from a neighboring item, since there's no fully reliable way to tell "this text completes the item above" from "this text starts the item below" using flat OCR text alone. Financial data (quantity/rate/amount) is unaffected — only the label. A proper fix would need a coordinate-based row-boundary detector calibrated specifically for bordered tables; deferred as a future improvement.
- **`/undo`/`/last`/`/setcategory`** only ever target the single most-recently-written row — undoing an older entry, or more than one row at a time, isn't supported; edit the Sheet directly for that.
- **No duplicate protection for intentionally resending the same photo** — the built-in dedupe only guards against Telegram silently retrying a delivery, not against you uploading the same receipt twice on purpose.
- **OCR.space free tier**: ~25,000 requests/month. Personal use won't come close, but it exists as a ceiling.

---

## License

MIT — see `LICENSE`.
