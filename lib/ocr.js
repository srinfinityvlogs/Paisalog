const OCR_ENDPOINT = 'https://api.ocr.space/parse/image';

async function extractTextFromImage(imageBuffer) {
  const form = new FormData();
  form.append('apikey', process.env.OCR_SPACE_API_KEY || 'helloworld');
  form.append('OCREngine', '2'); // engine 2 tends to do better on receipts
  form.append('scale', 'true');
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

  const labeledTotals = [...rawText.matchAll(/(?:total|amount due|grand total)[^\d]{0,10}([0-9]+(?:[.,][0-9]{2})?)/gi)]
    .map((m) => parseFloat(m[1].replace(',', '.')));
  const allDecimalNumbers = [...rawText.matchAll(/([0-9]+\.[0-9]{2})/g)].map((m) => parseFloat(m[1]));
  const total = labeledTotals[0] ?? (allDecimalNumbers.length ? Math.max(...allDecimalNumbers) : 0);

  const taxMatch = rawText.match(/(?:tax|vat|gst)[^\d]{0,10}([0-9]+(?:[.,][0-9]{2})?)/i);
  const tax = taxMatch ? parseFloat(taxMatch[1].replace(',', '.')) : '';

  return {
    merchant,
    date,
    total,
    tax,
    notes: lines.slice(1, 4).join(' | '),
  };
}

module.exports = { extractTextFromImage, parseReceiptText };
