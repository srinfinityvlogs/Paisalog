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
  for (const row of rows) {
    row.words.sort((a, b) => a.left - b.left);
    row.words = mergeSplitDecimals_(row.words);
  }
  return rows;
}

/**
 * OCR sometimes reads a decimal point as its own separate word — e.g. the
 * quantity "0.828" comes back as three tokens: "0", ".", "828" — which makes
 * every downstream number check fail on that value entirely (neither "0" nor
 * "828" is the real quantity). This stitches such sequences back into one
 * proper number token before anything else looks at the row.
 */
function mergeSplitDecimals_(words) {
  const merged = [];
  for (let i = 0; i < words.length; i++) {
    const isDigits = (t) => /^\d+$/.test(t);
    if (
      i + 2 < words.length &&
      isDigits(words[i].text) &&
      /^[.,]$/.test(words[i + 1].text) &&
      isDigits(words[i + 2].text)
    ) {
      merged.push({ ...words[i], text: `${words[i].text}.${words[i + 2].text}` });
      i += 2; // skip the '.' and the fractional-part tokens we just absorbed
    } else {
      merged.push(words[i]);
    }
  }
  return merged;
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
  // Gather each row's candidate numbers once (excluding HSN codes and GST/tax
  // percentages), tracking which ones get "consumed" so the same number on
  // the receipt never gets used for two different items.
  const rowNumbers = rows.map((row) => {
    const nums = [];
    row.words.forEach((w, idx) => {
      if (!isNumberToken_(w.text)) return;
      const nextText = (row.words[idx + 1]?.text || '').trim();
      if (nextText === '%') return;
      nums.push({ idx, value: parseNumberToken_(w.text), consumed: false });
    });
    return nums;
  });

  function nameFromRow_(row, beforeIdx) {
    const slice = row.words.slice(0, beforeIdx);
    const nameWords = [];
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i]?.text;
      if (!t) continue;
      if (/^\d+$/.test(t)) continue; // pure numbers (serial index, HSN digits)
      if (/^(hsn|gst|vat|tax|mrp|rate|qty|amt|cgst|sgst|cest|sast)$/i.test(t)) continue;
      if (/^[:\-%.,]+$/.test(t)) continue;

      // OCR frequently misspells "HSN" (MSN, HSIV, etc.) — catch it by
      // structure instead of exact spelling: a short word immediately
      // followed by ":" and then a long all-digit product code.
      const next = slice[i + 1]?.text || '';
      const afterNext = slice[i + 2]?.text || '';
      if (t.length <= 5 && next === ':' && /^\d{5,}$/.test(afterNext)) continue;

      nameWords.push(t);
    }
    return nameWords.join(' ').replace(/^[-\s]+|[-\s]+$/g, '').trim();
  }

  const items = [];
  const claimedRows = new Set();

  // Pass 1: rows where rate, qty, AND amount all land in the same row (the
  // common case on a well-aligned, flat-shot receipt). Checks every group of
  // 3 consecutive numbers, starting from the rightmost, so a spurious extra
  // number fragment elsewhere in the row (an OCR misread) doesn't block the
  // real triplet from being found.
  rows.forEach((row, rowIdx) => {
    const nums = rowNumbers[rowIdx];
    if (nums.length < 3) return;

    let matched = null;
    for (let start = nums.length - 3; start >= 0; start--) {
      const window = nums.slice(start, start + 3);
      const [rate, qty, amount] = window.map((n) => n.value);
      const err = Math.abs(rate * qty - amount) / (amount || 1);
      if (err <= 0.08) {
        matched = window;
        break;
      }
    }
    if (!matched) return;

    const [rateEntry, qtyEntry, amountEntry] = matched;
    const name = nameFromRow_(row, rateEntry.idx);
    if (!name || NON_ITEM_LINE.test(name)) return;

    matched.forEach((n) => (n.consumed = true));
    claimedRows.add(rowIdx);
    items.push({ name, rate: rateEntry.value, quantity: qtyEntry.value, amount: amountEntry.value });
  });

  // Pass 2: rows with only rate+qty of their own (2 numbers) — the amount
  // column printed at a slightly different row-height and landed elsewhere.
  // Collect ALL plausible (row, candidate) matches first, then assign the
  // globally best ones, rather than letting rows grab a match greedily in
  // top-to-bottom order (which lets an early row steal a number that's
  // actually a better, near-exact match for a different row).
  const candidatePairs = [];
  rows.forEach((row, rowIdx) => {
    if (claimedRows.has(rowIdx)) return;
    const nums = rowNumbers[rowIdx].filter((n) => !n.consumed);
    if (nums.length !== 2) return;

    const [rateEntry, qtyEntry] = nums;
    const expected = rateEntry.value * qtyEntry.value;
    if (!expected) return;

    const name = nameFromRow_(row, rateEntry.idx);
    if (!name || NON_ITEM_LINE.test(name)) return;

    for (const offset of [-1, 1, -2, 2, -3, 3, -4, 4]) {
      const neighborIdx = rowIdx + offset;
      if (neighborIdx < 0 || neighborIdx >= rows.length || claimedRows.has(neighborIdx)) continue;
      for (const candidate of rowNumbers[neighborIdx]) {
        if (candidate.consumed) continue;
        const err = Math.abs(candidate.value - expected) / expected;
        if (err < 0.08) {
          candidatePairs.push({ rowIdx, rateEntry, qtyEntry, candidate, err, name });
        }
      }
    }
  });

  // Assign the globally best (lowest-error) matches first, so a row with only
  // a coincidentally-close candidate doesn't grab it before the row it truly
  // belongs to (which would otherwise have matched with near-zero error).
  candidatePairs.sort((a, b) => a.err - b.err);
  const rescuedRowIdx = new Set();
  const rescuedItems = [];
  for (const pair of candidatePairs) {
    if (rescuedRowIdx.has(pair.rowIdx) || pair.rateEntry.consumed || pair.qtyEntry.consumed || pair.candidate.consumed) continue;
    pair.rateEntry.consumed = true;
    pair.qtyEntry.consumed = true;
    pair.candidate.consumed = true;
    rescuedRowIdx.add(pair.rowIdx);
    rescuedItems.push({ rowIdx: pair.rowIdx, name: pair.name, rate: pair.rateEntry.value, quantity: pair.qtyEntry.value, amount: pair.candidate.value });
  }
  rescuedItems.sort((a, b) => a.rowIdx - b.rowIdx);
  for (const it of rescuedItems) items.push({ name: it.name, rate: it.rate, quantity: it.quantity, amount: it.amount });

  // Pass 3: rows that are pure item name (no numbers at all of their own),
  // paired with a nearby row containing a complete rate/qty/amount triplet.
  // This covers receipts where the name prints entirely on its own line,
  // separate from the row holding all three numbers.
  rows.forEach((row, rowIdx) => {
    if (claimedRows.has(rowIdx) || rescuedRowIdx.has(rowIdx)) return;
    const ownNums = rowNumbers[rowIdx].filter((n) => !n.consumed);
    // A leading small integer (the "Sno" column, e.g. "3" before "Coriander
    // Leaves") isn't real rate/qty/amount data — exclude it so a name row
    // with only a serial number still counts as a "pure name" row here.
    const meaningfulNums = ownNums.filter((n) => !(n.idx === 0 && Number.isInteger(n.value) && n.value < 100));
    if (meaningfulNums.length > 0) return;

    const name = nameFromRow_(row, row.words.length);
    if (!name || NON_ITEM_LINE.test(name)) return;

    for (const offset of [-1, 1, -2, 2]) {
      const neighborIdx = rowIdx + offset;
      if (neighborIdx < 0 || neighborIdx >= rows.length || claimedRows.has(neighborIdx) || rescuedRowIdx.has(neighborIdx)) continue;
      const candidateNums = rowNumbers[neighborIdx].filter((n) => !n.consumed);
      if (candidateNums.length < 3) continue;

      let matched = null;
      for (let start = candidateNums.length - 3; start >= 0; start--) {
        const window = candidateNums.slice(start, start + 3);
        const [rate, qty, amount] = window.map((n) => n.value);
        const err = Math.abs(rate * qty - amount) / (amount || 1);
        if (err <= 0.08) {
          matched = window;
          break;
        }
      }
      if (!matched) continue;

      matched.forEach((n) => (n.consumed = true));
      rescuedRowIdx.add(rowIdx);
      rescuedRowIdx.add(neighborIdx);
      items.push({ name, rate: matched[0].value, quantity: matched[1].value, amount: matched[2].value });
      break;
    }
  });

  return items;
}

function lastNumberInText_(text) {
  const matches = [...text.matchAll(/([0-9]+(?:[.,][0-9]{2})?)/g)];
  if (!matches.length) return null;
  return parseFloat(matches[matches.length - 1][1].replace(',', '.'));
}

/**
 * Finds a proper decimal-format (X.XX) amount at or near a given line index.
 * The word "Total" and its actual value aren't always on the same line —
 * e.g. "Counter: 3  Total:Rs" has only the counter number on it, with the
 * real amount printed on an adjacent line. Requiring a decimal point (not
 * just any number) also avoids picking up an unrelated bare integer like
 * that counter value.
 */
function findAmountNearLine_(lines, idx) {
  for (const offset of [0, -1, 1, -2, 2]) {
    const i = idx + offset;
    if (i < 0 || i >= lines.length) continue;
    const matches = [...lines[i].matchAll(/([0-9]+\.[0-9]{2})/g)];
    if (matches.length) return parseFloat(matches[matches.length - 1][1]);
  }
  return null;
}

function extractReceiptFieldsFromRows_(rawText, rows) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const merchant = lines[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  const totalLineIdx = lines.findIndex((l) => /total/i.test(l) && !/sub[\s-]?total/i.test(l));
  const totalFromLine = totalLineIdx !== -1 ? findAmountNearLine_(lines, totalLineIdx) : null;

  const footerIdx = lines.findIndex((l) => /(kgs?\s*-|^nos\b|pay mode|tot\.?\s?bags?)/i.test(l));
  const preFooterText = (footerIdx === -1 ? lines : lines.slice(0, footerIdx)).join('\n');
  const preFooterNumbers = [...preFooterText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));

  const total =
    totalFromLine ??
    (preFooterNumbers.length ? preFooterNumbers[preFooterNumbers.length - 1] : null) ??
    (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxLine = lines.find((l) => /(tax|vat|gst)/i.test(l) && !l.includes('%'));
  const tax = taxLine ? (lastNumberInText_(taxLine) ?? '') : '';

  const items = extractLineItemsFromRows_(rows);

  return {
    merchant,
    date,
    total,
    tax,
    items,
    notes: lines.slice(1, 4).join(' | '),
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

  const totalLineIdx = lines.findIndex((l) => /total/i.test(l) && !/sub[\s-]?total/i.test(l));
  const totalFromLine = totalLineIdx !== -1 ? findAmountNearLine_(lines, totalLineIdx) : null;
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const total = totalFromLine ?? (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxLine = lines.find((l) => /(tax|vat|gst)/i.test(l) && !l.includes('%'));
  const tax = taxLine ? (lastNumberInText_(taxLine) ?? '') : '';

  return { merchant, date, total, tax, items: [], notes: lines.slice(1, 4).join(' | ') };
}

module.exports = { extractTextFromImage, analyzeReceipt, parseReceiptText };
