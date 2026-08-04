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
  if (!/^[0-9]+([.,:][0-9]+)?$/.test(t)) return false;
  // HSN/product codes are long all-digit strings (commonly 6-8 digits) with
  // no decimal point — exclude those so they don't get mistaken for a
  // rate/qty/amount value or pollute the item name.
  const digitsOnly = t.replace(/[.,:]/g, '');
  if (!t.includes('.') && !t.includes(',') && !t.includes(':') && digitsOnly.length > 5) return false;
  return true;
}

function parseNumberToken_(text) {
  return parseFloat(text.replace(/[,:]/, '.'));
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
      if (nameWords.length === 0 && t.length === 1 && !/^[A-Za-z]$/.test(t)) continue; // stray serial-index char (e.g. OCR misreading "3" as "З") — but not a real single-letter word like "L" in "L Finger"
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

    // Fallback: rate and qty are two CONSECUTIVE numbers early in the row,
    // and amount is the row's last number, with some padding column in
    // between (e.g. a Discount/Tax column that's always 0) that isn't part
    // of the triplet. Tries each possible starting pair, in case a leading
    // serial number is also present. Only tried if the consecutive-window
    // check above found nothing, and only for rows with 4+ numbers (for
    // exactly 3, this is the same as the window check).
    if (!matched && nums.length >= 4) {
      const amountEntry = nums[nums.length - 1];
      for (let start = 0; start <= nums.length - 3; start++) {
        const rateEntry = nums[start];
        const qtyEntry = nums[start + 1];
        if (qtyEntry === amountEntry) continue;
        const err = Math.abs(rateEntry.value * qtyEntry.value - amountEntry.value) / (amountEntry.value || 1);
        if (err <= 0.08) {
          matched = [rateEntry, qtyEntry, amountEntry];
          break;
        }
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

  // Pass 1.5: rows with exactly 2 numbers where the two are equal — a
  // strong, narrow signal that OCR simply dropped the quantity entirely
  // (rate * 1 = amount, so an identical rate/amount pair is a natural
  // fingerprint of exactly this gap, e.g. a single-unit item like "1 EA").
  rows.forEach((row, rowIdx) => {
    if (claimedRows.has(rowIdx)) return;
    const nums = rowNumbers[rowIdx].filter((n) => !n.consumed);
    if (nums.length !== 2) return;
    const [a, b] = nums;
    if (!b.value || Math.abs(a.value - b.value) / b.value > 0.01) return; // not equal enough to be confident

    const name = nameFromRow_(row, a.idx);
    if (!name || NON_ITEM_LINE.test(name)) return;

    a.consumed = true;
    b.consumed = true;
    claimedRows.add(rowIdx);
    items.push({ name, rate: a.value, quantity: 1, amount: b.value });
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
      if (!matched && candidateNums.length >= 4) {
        const amountEntry = candidateNums[candidateNums.length - 1];
        for (let start = 0; start <= candidateNums.length - 3; start++) {
          const rateEntry = candidateNums[start];
          const qtyEntry = candidateNums[start + 1];
          if (qtyEntry === amountEntry) continue;
          const err = Math.abs(rateEntry.value * qtyEntry.value - amountEntry.value) / (amountEntry.value || 1);
          if (err <= 0.08) {
            matched = [rateEntry, qtyEntry, amountEntry];
            break;
          }
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
    if (/qty/i.test(lines[i])) continue; // e.g. "Tot Qty: 4.130" is never a monetary total
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
async function analyzeReceipt(imageBuffer, merchantHint) {
  const { rawText, overlayLines } = await callOcrSpace(imageBuffer);
  const rows = groupWordsIntoRows_(overlayLines);

  const format = pickReceiptFormat_(rawText, merchantHint);
  if (format) {
    const extracted = format.extractFields(rawText, rows);
    return { rawText, extracted };
  }

  const extracted = rows.length ? extractReceiptFieldsFromRows_(rawText, rows) : parseReceiptText(rawText);
  return { rawText, extracted };
}

function isNumericOrPercentToken_(text) {
  const stripped = (text || '').trim().replace(/%$/, '');
  return isNumberToken_(stripped);
}

function parseNumericOrPercentToken_(text) {
  return parseNumberToken_((text || '').trim().replace(/%$/, ''));
}

// --- Per-merchant receipt format registry ---
//
// Different merchants' structured tax invoices have genuinely different
// column layouts (not just different labels) — trying to force them through
// one shared heuristic causes exactly the kind of corruption we saw with
// Instamart's "1 NOS" Quantity column being mistaken for BigBasket's
// name-embedded weight descriptors. Each format gets its own dedicated
// detect() + extractFields(), so adding a new merchant later never risks
// breaking an existing one.
//
// If the person names a merchant explicitly (e.g. a photo caption like
// "Instamart"), that's used directly instead of auto-detecting — the
// person's own statement is more reliable than any keyword sniffing.
const RECEIPT_FORMATS = [
  {
    key: 'bigbasket',
    matchNames: ['bigbasket', 'big basket'],
    detect: looksLikeBigBasketFormat_,
    extractFields: extractBigBasketFields_,
  },
  {
    key: 'instamart',
    matchNames: ['instamart', 'swiggy instamart', 'swiggy'],
    detect: looksLikeInstamartFormat_,
    extractFields: extractInstamartFields_,
  },
];

function pickReceiptFormat_(rawText, merchantHint) {
  if (merchantHint) {
    const hint = merchantHint.toLowerCase();
    const explicit = RECEIPT_FORMATS.find((f) => f.matchNames.some((n) => hint.includes(n)));
    if (explicit) return explicit;
  }
  return RECEIPT_FORMATS.find((f) => f.detect(rawText)) || null;
}

// --- BigBasket: Quantity, Unit Price, Unit Taxable Value, Gross Value,
// Discount/Margin, Other Charges, Taxable Value, CGST Rate/Amount,
// SGST/UTGST Rate/Amount, CESS Amount, TOTAL Value — 13 numbers per item,
// always in that order, with TOTAL Value always the rightmost column, and
// package weight (e.g. "500 g") sometimes embedded in the item name. ---

function looksLikeBigBasketFormat_(rawText) {
  const t = rawText.toLowerCase();
  const hasHsn = /\bhsn\b/.test(t);
  const hasGstColumn = /\bcgst\b/.test(t) || /\bsgst\b/.test(t) || /\butgst\b/.test(t);
  const hasTaxable = /tax.ble/.test(t); // tolerates OCR misspellings like "Taxeble"
  const hasUnitPrice = /unit\s*price/.test(t); // distinguishes from Instamart, which has no per-unit price column
  return hasHsn && hasGstColumn && hasTaxable && hasUnitPrice;
}

function extractBigBasketItems_(rows) {
  const items = [];
  for (const row of rows) {
    let numberEntries = [];
    let gramWeight = null;
    let gramWeightIdx = null;

    row.words.forEach((w, idx) => {
      if (!isNumericOrPercentToken_(w.text)) return;
      const nextText = (row.words[idx + 1]?.text || '').trim().toLowerCase();
      if (/^(g|gm|gms|grams?|kgs?|ml|ltr?|l|pcs?|pieces?|nos?|pkt|pack)$/.test(nextText)) {
        // A unit descriptor embedded in the item name (e.g. "Local Tomato
        // 500 g", "Mop 1 pc") — not a real invoice data column. Remember it
        // separately as a more useful Qty than the invoice's own
        // purchase-count Quantity column, but exclude it (and its unit word)
        // from the numeric sequence/name so it doesn't throw off which
        // number lands in Rate/Total, or clutter the item name.
        if (gramWeight === null) {
          gramWeight = parseNumericOrPercentToken_(w.text);
          gramWeightIdx = idx;
        }
        return;
      }
      numberEntries.push({ idx, value: parseNumericOrPercentToken_(w.text) });
    });

    // Drop a leading serial/SI-No number (small integer, no decimal, no %)
    // before the real Quantity/Price/.../Total sequence starts.
    if (numberEntries.length) {
      const first = numberEntries[0];
      const firstText = row.words[first.idx].text;
      if (Number.isInteger(first.value) && first.value < 100 && !firstText.includes('.') && !firstText.includes('%')) {
        numberEntries = numberEntries.slice(1);
      }
    }

    if (numberEntries.length < 6) continue; // too few numbers to plausibly be an item row

    const invoiceQuantity = numberEntries[0].value;
    const rate = numberEntries[1].value; // Unit Price
    const totalValue = numberEntries[numberEntries.length - 1].value; // TOTAL Value is always the rightmost column
    const quantity = gramWeight !== null ? gramWeight : invoiceQuantity; // prefer package weight (grams) over purchase count when available

    const firstNumberIdx = numberEntries[0].idx;
    const nameWords = row.words
      .slice(0, firstNumberIdx)
      .map((w, i) => ({ text: w.text, idx: i }))
      .filter(({ idx }) => idx !== gramWeightIdx && idx !== gramWeightIdx + 1)
      .map(({ text }) => text)
      .filter((t) => t && !/^\d+$/.test(t) && !/^[:\-%.,]+$/.test(t));
    const name = nameWords.join(' ').replace(/\s+/g, ' ').trim();
    if (!name) continue; // e.g. the table's own summary/total row, which has no item name

    items.push({ name, rate, quantity, amount: totalValue });
  }
  return items;
}

function extractBigBasketFields_(rawText, rows) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const merchant = lines[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  const items = extractBigBasketItems_(rows);
  // Sum the items' own Total Value rather than hunting for a labeled grand
  // total line — more reliable here, since it's just arithmetic rather than
  // depending on OCR correctly reading a "Total" label near its value.
  const total = items.length ? Math.round(items.reduce((sum, it) => sum + it.amount, 0) * 100) / 100 : 0;

  return { merchant, date, total, tax: '', items, notes: lines.slice(1, 4).join(' | ') };
}

// --- Instamart: Quantity, UQC (unit code, e.g. "NOS"), HSN/SAC Code,
// Taxable Value, Discount, Net Taxable Value, CGST%, CGST, SGST%, SGST,
// Cess%, Cess, Additional Cess, Total Amount. No per-unit "Rate" column at
// all — Quantity+UQC is real data here, unlike BigBasket's embedded weight
// descriptors, so it must NOT be stripped the way BigBasket's is. Item
// names sometimes wrap onto their own separate row from the numbers. ---

function looksLikeInstamartFormat_(rawText) {
  const t = rawText.toLowerCase();
  const hasUqc = /\buqc\b/.test(t); // Instamart-specific column, absent from BigBasket
  const hasGstColumn = /\bcgst\b/.test(t) || /\bsgst\b/.test(t);
  return hasUqc && hasGstColumn;
}

const INSTAMART_NON_ITEM_LINE = /^(date of invoice|category|sr\s*no|sr\s+taxable|description of goods|hsn|invoice value|handling fee|net taxable|discount|taxable value|code|taxes|value|cess|^no\b)/i;

function instamartLineNumbers_(line) {
  const tokens = line.split(/\s+/).filter(Boolean);
  const entries = [];
  tokens.forEach((tok, idx) => {
    if (isNumericOrPercentToken_(tok)) entries.push({ idx, value: parseNumericOrPercentToken_(tok) });
  });
  return { tokens, entries };
}

/**
 * Works directly off the flat OCR text, line by line, rather than
 * coordinate-clustered rows. Instamart's clean, structured invoices tend to
 * come back from OCR in fairly reliable line order — clustering by pixel
 * position was actually causing problems here (a wrapped, multi-line table
 * header landing on top of item 1's data due to a bordered table's uniform
 * row height), which simple line-order parsing avoids entirely.
 *
 * Item names that wrap onto their own line BEFORE the data line are
 * captured reliably. Names that continue on a line AFTER the data line
 * (e.g. "(Raw Peanut)" on its own line) are intentionally NOT appended —
 * there's no reliable way to tell "this completes the item above" from
 * "this starts the item below" from flat text alone, and gluing on the
 * wrong neighbor's text is worse than an occasionally-incomplete name.
 */
function extractInstamartItemsFromText_(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  let pendingNameLines = [];

  for (const line of lines) {
    const { tokens, entries } = instamartLineNumbers_(line);

    if (entries.length < 5) {
      // Not a data line — a name-continuation, a header/footer, or noise.
      if (!INSTAMART_NON_ITEM_LINE.test(line)) pendingNameLines.push(line);
      continue;
    }

    // A real item data line. Sr No (e.g. "3.") sits before Quantity but
    // won't match as a number itself (trailing period, no digit after it).
    const firstNumIdx = entries[0].idx;
    const inlineName = tokens
      .slice(0, firstNumIdx)
      .filter((t) => !/^\d+\.?$/.test(t))
      .join(' ');
    const fullName = [...pendingNameLines, inlineName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    pendingNameLines = [];

    if (!fullName) continue;

    items.push({
      name: fullName,
      quantity: entries[0].value, // Quantity is real data here — never stripped
      rate: entries.length > 1 ? entries[1].value : 0, // no true per-unit Rate column; Taxable Value stands in
      amount: entries[entries.length - 1].value, // Total Amount is always the rightmost column
    });
  }

  return items;
}

function extractInstamartFields_(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const merchant = lines[0] || 'Unknown';

  const dateMatch = rawText.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  const date = dateMatch ? dateMatch[1] : '';

  const items = extractInstamartItemsFromText_(rawText);
  const total = items.length ? Math.round(items.reduce((sum, it) => sum + it.amount, 0) * 100) / 100 : 0;

  const handlingFeeMatch = rawText.match(/handling\s*fee[^\d]{0,20}(\d+\.?\d*)/i);
  const handlingFee = handlingFeeMatch ? parseFloat(handlingFeeMatch[1]) : '';

  return { merchant, date, total, tax: '', items, handlingFee, notes: lines.slice(1, 4).join(' | ') };
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

/**
 * Converts the raw date extracted from a receipt (e.g. "09-06-26", using
 * whatever separator OCR happened to read) into a clean DD/MM/YYYY string,
 * assuming day-month-year order (the convention on Indian receipts) and a
 * 2-digit year meaning 20XX. Returns '' if the input doesn't look like a date.
 */
function formatReceiptDate(rawDate) {
  if (!rawDate) return '';
  const m = rawDate.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return '';
  let [, dd, mm, yyyy] = m;
  dd = dd.padStart(2, '0');
  mm = mm.padStart(2, '0');
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Computes the month-tab name ("July 2026") a transaction should be routed
 * to, from a DD/MM/YYYY date string (as produced by formatReceiptDate).
 * Falls back to today's date if no valid date is given.
 */
function monthTabName(ddmmyyyy) {
  let d;
  const m = (ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (!d || isNaN(d.getTime())) d = new Date();
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Parses a photo caption for an optional date override, merchant override,
 * and handling fee, e.g.:
 *   "21/07/2026"                    -> date only
 *   "21/07/2026 BigBasket"          -> date + merchant
 *   "21/07/2026 BigBasket 15.00"    -> date + merchant + handling fee
 *   "BigBasket 15.00"               -> merchant + handling fee, no date
 *   "BigBasket"                      -> merchant only
 * The date must be DD/MM/YYYY-style (see formatReceiptDate). A trailing
 * decimal number (e.g. "15.00") is treated as a manually-supplied handling
 * fee — useful for merchants like BigBasket whose receipts don't show a
 * handling fee anywhere for auto-detection to find. Everything remaining
 * after removing the date and fee becomes the merchant override.
 */
function parseCaptionOverrides(caption) {
  if (!caption) return { date: '', merchant: '', handlingFee: '' };

  const dateMatch = caption.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
  const date = dateMatch ? formatReceiptDate(dateMatch[1]) : '';
  let remaining = dateMatch ? caption.replace(dateMatch[1], '') : caption;

  const feeMatch = remaining.match(/(\d+\.\d{1,2})\s*$/);
  let handlingFee = '';
  if (feeMatch) {
    handlingFee = parseFloat(feeMatch[1]);
    remaining = remaining.slice(0, feeMatch.index);
  }

  const merchant = remaining.trim();
  return { date, merchant, handlingFee };
}

module.exports = { extractTextFromImage, analyzeReceipt, parseReceiptText, formatReceiptDate, monthTabName, parseCaptionOverrides };
