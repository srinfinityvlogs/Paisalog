const OCR_ENDPOINT = 'https://api.ocr.space/parse/image';

async function callOcrSpace(imageBuffer) {
  const form = new FormData();
  form.append('apikey', process.env.OCR_SPACE_API_KEY || 'helloworld');
  form.append('OCREngine', '2'); // engine 2 tends to do better on receipts
  form.append('scale', 'true');
  form.append('isTable', 'true'); // asks OCR.space to preserve row/column structure
  form.append('isOverlayRequired', 'true'); // gives per-word pixel positions (free, same API key)
  form.append('file', new Blob([imageBuffer]), 'receipt.jpg');

  const res = await fetch(OCR_ENDPOINT, { method: 'POST', body: form });
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    throw new Error(Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(', ') : 'OCR failed');
  }
  const parsedResult = data.ParsedResults?.[0];
  return {
    rawText: parsedResult?.ParsedText || '',
    overlayLines: parsedResult?.TextOverlay?.Lines || [],
  };
}

// Kept for anything that just wants plain OCR text (e.g. storing in the
// Raw Input / Raw OCR Text sheet column).
async function extractTextFromImage(imageBuffer) {
  const { rawText } = await callOcrSpace(imageBuffer);
  return rawText;
}

/**
 * Rebuilds table rows from OCR.space's per-word pixel positions instead of
 * trusting OCR's own "line" grouping. This matters because a wide gap
 * between an item's name (left-aligned) and its rate/qty/amount (far right)
 * often gets split into separate "lines" in OCR's text output, even though
 * they're the same visual row on the physical receipt. Clustering words by
 * vertical (Top) position fixes that, independent of how OCR grouped them.
 */
function groupWordsIntoRows_(overlayLines) {
  const words = [];
  for (const line of overlayLines) {
    for (const w of line.Words || []) {
      words.push({ text: w.WordText, left: w.Left, top: w.Top, height: w.Height || 10 });
    }
  }
  if (!words.length) return [];

  words.sort((a, b) => a.top - b.top);
  const avgHeight = words.reduce((s, w) => s + w.height, 0) / words.length;
  const tolerance = Math.max(avgHeight * 0.6, 5);

  const rows = [];
  for (const word of words) {
    let row = rows.find((r) => Math.abs(r.top - word.top) <= tolerance);
    if (!row) {
      row = { top: word.top, words: [] };
      rows.push(row);
    }
    row.words.push(word);
    // Recompute the row's representative top as a running average so rows
    // don't slowly drift as more words get added to them.
    row.top = row.words.reduce((s, w) => s + w.top, 0) / row.words.length;
  }

  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) row.words.sort((a, b) => a.left - b.left);
  return rows;
}

const NON_ITEM_LINE = /^(item|mrp|rate|qty|amt|hsn|gst|total|counter|tot\.?\s?bags?|kgs?|nos|pay mode)/i;

function isNumberToken_(text) {
  const t = (text || '').trim();
  if (!/^[0-9]+([.,][0-9]+)?$/.test(t)) return false;
  // HSN/product codes are long all-digit strings (commonly 6-8 digits) with
  // no decimal point — exclude those so they don't get mistaken for a
  // rate/qty/amount value or pollute the item name.
  const digitsOnly = t.replace(/[.,]/g, '');
  if (!t.includes('.') && !t.includes(',') && digitsOnly.length > 5) return false;
  return true;
}

function parseNumberToken_(text) {
  return parseFloat(text.replace(',', '.'));
}

function rowText_(row) {
  return row.words.map((w) => w.text).join(' ');
}

/**
 * For each reconstructed row, looks at the rightmost 3 numbers (rate, qty,
 * amount, in that left-to-right order on a typical receipt) and checks that
 * rate * qty ≈ amount before trusting it as a real item row. Everything to
 * the left of those 3 numbers, minus table-header/HSN/GST noise, becomes
 * the item name.
 */
function extractLineItemsFromRows_(rows) {
  const items = [];
  for (const row of rows) {
    const numberEntries = [];
    row.words.forEach((w, idx) => {
      if (!isNumberToken_(w.text)) return;
      const nextText = (row.words[idx + 1]?.text || '').trim();
      if (nextText === '%') return; // GST/tax percentage, not a rate/qty/amount
      numberEntries.push({ idx, value: parseNumberToken_(w.text) });
    });
    if (numberEntries.length < 3) continue;

    const last3 = numberEntries.slice(-3);
    const [rate, qty, amount] = last3.map((n) => n.value);
    const err = Math.abs(rate * qty - amount) / (amount || 1);
    if (err > 0.08) continue; // arithmetic doesn't line up — likely not an item row

    const firstNumberIdx = last3[0].idx;
    const nameWords = row.words
      .slice(0, firstNumberIdx)
      .map((w) => w.text)
      .filter(
        (t) =>
          t &&
          !/^\d+$/.test(t) &&
          !/^(hsn|gst|vat|tax|mrp|rate|qty|amt)$/i.test(t) &&
          !/^[:\-%.,]+$/.test(t)
      );
    const name = nameWords.join(' ').replace(/^[-\s]+|[-\s]+$/g, '').trim();
    if (!name || NON_ITEM_LINE.test(name)) continue;

    items.push({ name, rate, quantity: qty, amount });
  }
  return items;
}

function lastNumberInText_(text) {
  const matches = [...text.matchAll(/([0-9]+(?:[.,][0-9]{2})?)/g)];
  if (!matches.length) return null;
  return parseFloat(matches[matches.length - 1][1].replace(',', '.'));
}

function extractReceiptFieldsFromRows_(rawText, rows) {
  const rowTexts = rows.map(rowText_);
  const nonEmptyRowTexts = rowTexts.filter((t) => t.trim());

  const merchant = nonEmptyRowTexts[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  const totalRowText = rowTexts.find((t) => /total/i.test(t) && !/sub[\s-]?total/i.test(t));
  const totalFromRow = totalRowText ? lastNumberInText_(totalRowText) : null;

  const footerIdx = rowTexts.findIndex((t) => /(kgs?\s*-|^nos\b|pay mode|tot\.?\s?bags?)/i.test(t));
  const preFooterText = (footerIdx === -1 ? rowTexts : rowTexts.slice(0, footerIdx)).join('\n');
  const preFooterNumbers = [...preFooterText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));

  const total =
    totalFromRow ??
    (preFooterNumbers.length ? preFooterNumbers[preFooterNumbers.length - 1] : null) ??
    (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxRowText = rowTexts.find((t) => /(tax|vat|gst)/i.test(t));
  const tax = taxRowText ? (lastNumberInText_(taxRowText) ?? '') : '';

  const items = extractLineItemsFromRows_(rows);

  return {
    merchant,
    date,
    total,
    tax,
    items,
    notes: nonEmptyRowTexts.slice(1, 4).join(' | '),
  };
}

/**
 * Main entry point used by handleUpdate.js. Runs OCR once (with per-word
 * position data), reconstructs table rows by pixel position, and extracts
 * merchant/date/total/tax/items from those rows. Falls back to the plain
 * regex heuristics (no coordinates) if overlay data isn't available.
 */
async function analyzeReceipt(imageBuffer) {
  const { rawText, overlayLines } = await callOcrSpace(imageBuffer);
  const rows = groupWordsIntoRows_(overlayLines);
  const extracted = rows.length ? extractReceiptFieldsFromRows_(rawText, rows) : parseReceiptText(rawText);
  return { rawText, extracted };
}

// --- Plain-text fallback (used if overlay data is missing for some reason) ---
function parseReceiptText(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const merchant = lines[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  const totalLine = lines.find((l) => /total/i.test(l) && !/sub[\s-]?total/i.test(l));
  const totalFromLine = totalLine ? lastNumberInText_(totalLine) : null;
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const total = totalFromLine ?? (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxLine = lines.find((l) => /(tax|vat|gst)/i.test(l));
  const tax = taxLine ? (lastNumberInText_(taxLine) ?? '') : '';

  return { merchant, date, total, tax, items: [], notes: lines.slice(1, 4).join(' | ') };
}

module.exports = { extractTextFromImage, analyzeReceipt, parseReceiptText };
