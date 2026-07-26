const OCR_ENDPOINT = 'https://api.ocr.space/parse/image';

async function extractTextFromImage(imageBuffer) {
  const form = new FormData();
  form.append('apikey', process.env.OCR_SPACE_API_KEY || 'helloworld');
  form.append('OCREngine', '2'); // engine 2 tends to do better on receipts
  form.append('scale', 'true');
  form.append('isTable', 'true'); // asks OCR.space to preserve row/column structure on tabular layouts
  form.append('file', new Blob([imageBuffer]), 'receipt.jpg');

  const res = await fetch(OCR_ENDPOINT, { method: 'POST', body: form });
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    throw new Error(Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(', ') : 'OCR failed');
  }
  return data.ParsedResults?.[0]?.ParsedText || '';
}

/**
 * Cheap heuristic parser over raw OCR text. This is intentionally simple —
 * swap or extend this function later (e.g. call an LLM, or a dedicated
 * receipt-parsing API) without touching anything else in the bot.
 */
function parseReceiptText(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const merchant = lines[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  // Search line-by-line rather than across the whole blob: multi-column
  // receipts (item tables) often come back from OCR with lines in a jumbled
  // order, so a keyword and its number can end up far apart in the raw text
  // even though they're on the same visual line.
  const totalLine = lines.find((l) => /total/i.test(l) && !/sub[\s-]?total/i.test(l));
  const totalFromLine = totalLine ? lastNumberInLine_(totalLine) : null;

  // Fallback when no line contains the word "total" (e.g. it got merged with
  // stamp/watermark text during OCR): totals are almost always the last
  // money-looking number before the footer (bag count, weight, payment mode),
  // so that's a better guess than just the largest number anywhere in the text.
  const footerIndex = lines.findIndex((l) => /(kgs?\s*-|^nos\b|pay mode|tot\.?\s?bags?)/i.test(l));
  const preFooterLines = (footerIndex === -1 ? lines : lines.slice(0, footerIndex)).join('\n');
  const preFooterNumbers = [...preFooterLines.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const total =
    totalFromLine ??
    (preFooterNumbers.length ? preFooterNumbers[preFooterNumbers.length - 1] : null) ??
    (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxLine = lines.find((l) => /(tax|vat|gst)/i.test(l));
  const tax = taxLine ? (lastNumberInLine_(taxLine) ?? '') : '';

  const items = extractLineItems_(lines);

  return {
    merchant,
    date,
    total,
    tax,
    items,
    notes: lines.slice(1, 4).join(' | '),
  };
}

function lastNumberInLine_(line) {
  const matches = [...line.matchAll(/([0-9]+(?:[.,][0-9]{2})?)/g)];
  if (!matches.length) return null;
  return parseFloat(matches[matches.length - 1][1].replace(',', '.'));
}

const NON_ITEM_LINE = /^(item|mrp|rate|qty|amt|hsn|gst|total|counter|tot\.?\s?bags?|kgs?|nos|pay mode)/i;

/**
 * Finds "rate, quantity, amount" triplets — three numbers on a line where
 * two of them multiply out to (approximately) the third — and pairs each
 * with the nearest preceding line that looks like a product name rather
 * than a table header, HSN code, or GST line.
 *
 * This is the piece most worth tuning once you've seen it run against your
 * actual receipts — if it misses items or mismatches names, share a sample
 * of the raw OCR text (stored in the Raw Input / Raw OCR Text column) and
 * we can adjust the pattern matching here.
 */
function extractLineItems_(lines) {
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const numbers = [...lines[i].matchAll(/\d+(?:\.\d{1,3})?/g)].map((m) => parseFloat(m[0]));
    if (numbers.length < 3) continue;

    // Try every (a, b) pairing among the numbers on this line and see which
    // pair multiplies out closest to a third number — that's rate*qty=amount.
    let best = null;
    for (let x = 0; x < numbers.length; x++) {
      for (let y = 0; y < numbers.length; y++) {
        if (x === y) continue;
        for (let z = 0; z < numbers.length; z++) {
          if (z === x || z === y) continue;
          const guess = numbers[x] * numbers[y];
          const err = Math.abs(guess - numbers[z]) / (numbers[z] || 1);
          if (!best || err < best.err) {
            best = { rate: numbers[x], quantity: numbers[y], amount: numbers[z], err };
          }
        }
      }
    }
    if (!best || best.err > 0.08) continue; // arithmetic doesn't line up — likely not an item row

    // Item name: nearest preceding line (within a few lines) with letters
    // that isn't a table header, HSN code, or quantity-summary line.
    let name = '';
    for (let j = i; j >= 0 && j >= i - 3; j--) {
      const candidate = lines[j].replace(/^\d+\s*/, '').replace(/\s*-\s*$/, '').trim();
      if (candidate && /[a-zA-Z]/.test(candidate) && !NON_ITEM_LINE.test(candidate)) {
        name = candidate;
        break;
      }
    }
    if (!name) continue;

    items.push({ name, rate: best.rate, quantity: best.quantity, amount: best.amount });
  }

  return items;
}

module.exports = { extractTextFromImage, parseReceiptText };
