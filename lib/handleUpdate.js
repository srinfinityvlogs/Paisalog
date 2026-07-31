const crypto = require('crypto');
const { parseExpenseMessage } = require('./parser');
const { classify } = require('./categories');
const sheets = require('./sheets');
const telegram = require('./telegram');
const ocr = require('./ocr');

const ALLOWED_USER_ID = process.env.ALLOWED_TELEGRAM_USER_ID;

function isAuthorized(update) {
  if (!ALLOWED_USER_ID) return true; // no restriction configured — anyone can use the bot
  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  return String(userId) === String(ALLOWED_USER_ID);
}

async function handleTelegramUpdate(update) {
  if (!update) return;
  if (!isAuthorized(update)) return;

  // Duplicate protection: Telegram retries webhook deliveries that don't get
  // a fast 200 OK. update_id only ever increases, so anything at/below the
  // last id we recorded has already been handled.
  const lastId = await sheets.getLastProcessedUpdateId();
  if (update.update_id <= lastId) return;

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  } else if (update.message?.photo) {
    await handlePhoto(update.message);
  } else if (update.message?.text) {
    await handleText(update.message);
  }

  await sheets.setLastProcessedUpdateId(update.update_id);
}

async function handleText(message) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return telegram.sendMessage(
      chatId,
      'Send an expense like <b>Grocery 250</b> or a receipt photo.\n' +
        'Tip: caption a photo with <b>21/07/2026 BigBasket</b> to set its date and/or merchant manually.\n\n' +
        'Commands:\n' +
        '/last — show the last entry\n' +
        '/undo — delete the last entry\n' +
        '/setcategory &lt;name&gt; — fix the last entry\'s category'
    );
  }

  if (text.startsWith('/last')) {
    const last = await sheets.getLastRow();
    if (!last) return telegram.sendMessage(chatId, 'No entries yet.');
    const [expenseType, category, merchant, , , amount] = last.values;
    return telegram.sendMessage(
      chatId,
      `Last entry: <b>${category}</b> (${expenseType}) — ${amount}${merchant ? ' @ ' + merchant : ''}`
    );
  }

  if (text.startsWith('/undo')) {
    const removed = await sheets.deleteLastRow();
    if (!removed) return telegram.sendMessage(chatId, 'Nothing to undo.');
    return telegram.sendMessage(chatId, `Removed: ${removed.values[1]} — ${removed.values[5]}`);
  }

  if (text.startsWith('/setcategory')) {
    const newCategoryRaw = text.replace('/setcategory', '').trim();
    if (!newCategoryRaw) return telegram.sendMessage(chatId, 'Usage: /setcategory Groceries');
    const { category, expenseType } = classify(newCategoryRaw);
    const updated = await sheets.updateLastRowCategory(category, expenseType);
    if (!updated) return telegram.sendMessage(chatId, 'Nothing to update yet.');
    return telegram.sendMessage(chatId, `Updated last entry's category to <b>${category}</b> (${expenseType}).`);
  }

  const parsed = parseExpenseMessage(text);
  if (!parsed) {
    return telegram.sendMessage(
      chatId,
      "Sorry, I couldn't read that. Try the format <b>Category Amount</b>, e.g. <b>Lunch 120</b>."
    );
  }

  await sheets.appendTransaction({
    expenseType: parsed.expenseType,
    category: parsed.category,
    amount: parsed.amount,
    source: 'Telegram-Text',
    rawInput: parsed.rawInput,
    monthTab: ocr.monthTabName(),
    isLastItemOfReceipt: true,
  });

  return telegram.sendMessage(chatId, `✅ Logged <b>${parsed.category}</b> — ${parsed.amount} (${parsed.expenseType})`);
}

async function handlePhoto(message) {
  const chatId = message.chat.id;
  await telegram.sendMessage(chatId, '📷 Got your receipt, reading it…');

  try {
    const largestPhoto = message.photo[message.photo.length - 1];
    const fileUrl = await telegram.getFileUrl(largestPhoto.file_id);
    const imageBuffer = await telegram.downloadFile(fileUrl);

    // A caption on the photo lets you manually pin the invoice date and/or
    // merchant — useful when OCR misreads them, a receipt doesn't show them
    // clearly, or you want to skip auto-detection and use a specific
    // merchant's known format directly. E.g. "21/07/2026 Instamart",
    // "21/07/2026", or "Instamart".
    const overrides = ocr.parseCaptionOverrides(message.caption);
    const { rawText, extracted } = await ocr.analyzeReceipt(imageBuffer, overrides.merchant);

    if (overrides.date) extracted.date = overrides.date;
    if (overrides.merchant) extracted.merchant = overrides.merchant;
    if (overrides.handlingFee !== '') extracted.handlingFee = overrides.handlingFee; // manual override, e.g. for BigBasket which doesn't show one on the receipt itself

    const pendingId = crypto.randomBytes(6).toString('hex');
    await sheets.createPending(pendingId, chatId, { ...extracted, rawText });

    const preview = buildReceiptPreview_(extracted);
    await telegram.sendMessage(chatId, preview, telegram.confirmKeyboard(pendingId));
  } catch (err) {
    console.error('OCR pipeline failed:', err);
    await telegram.sendMessage(chatId, "I couldn't read that receipt. You can log it manually, e.g. Grocery 250.");
  }
}

function buildReceiptPreview_(extracted) {
  const hasHandlingFee = extracted.handlingFee !== undefined && extracted.handlingFee !== '';
  const grandTotal = hasHandlingFee
    ? Math.round((Number(extracted.total || 0) + Number(extracted.handlingFee)) * 100) / 100
    : null;

  const header =
    `🏪 Merchant: ${extracted.merchant}\n` +
    `📅 Date: ${extracted.date || 'unknown'}\n` +
    `💰 Items Total: ${extracted.total || 'unknown'}\n` +
    (hasHandlingFee ? `🚚 Handling Fee: ${extracted.handlingFee}\n💵 Final Bill: ${grandTotal}\n` : '') +
    `🧾 Tax: ${extracted.tax || '—'}`;

  if (!extracted.items || extracted.items.length === 0) {
    return `Here's what I found — tap Save to log it:\n\n${header}`;
  }

  const itemLines = extracted.items
    .map((it) => `• ${it.name} — ${it.quantity} @ ${it.rate} = ${it.amount}`)
    .join('\n');

  return (
    `Found ${extracted.items.length} item(s) — tap Save to log each one separately:\n\n` +
    `${itemLines}\n\n${header}`
  );
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const [action, pendingId] = callbackQuery.data.split(':');

  if (action === 'cancel') {
    await sheets.findAndConsumePending(pendingId);
    await telegram.answerCallbackQuery(callbackQuery.id, 'Discarded');
    return telegram.sendMessage(chatId, 'Discarded.');
  }

  if (action === 'confirm') {
    const data = await sheets.findAndConsumePending(pendingId);
    if (!data) {
      await telegram.answerCallbackQuery(callbackQuery.id, 'Already handled');
      return;
    }

    if (data.items && data.items.length > 0) {
      const receiptDate = ocr.formatReceiptDate(data.date);
      const monthTab = ocr.monthTabName(receiptDate);
      await sheets.appendRawOcr(pendingId, data.rawText || '');

      const hasHandlingFee = data.handlingFee !== undefined && data.handlingFee !== '';
      const finalBillTotal = hasHandlingFee
        ? Math.round((Number(data.total || 0) + Number(data.handlingFee)) * 100) / 100
        : data.total || '';

      for (let index = 0; index < data.items.length; index++) {
        const item = data.items[index];
        const { category, expenseType } = classify(item.name);
        await sheets.appendTransaction({
          expenseType,
          category,
          amount: item.amount,
          merchant: data.merchant,
          notes: index === 0 && hasHandlingFee ? `Handling Fee: ${data.handlingFee}` : '',
          source: 'Telegram-OCR',
          rawInput: pendingId, // short reference into the RawOCR tab, avoids duplicating the full text on every item row
          rate: item.rate,
          quantity: item.quantity,
          finalBill: index === 0 ? finalBillTotal : '', // only the first row of a receipt carries the overall total
          receiptDate,
          monthTab,
          isLastItemOfReceipt: index === data.items.length - 1, // adds a blank spacer row after the whole receipt
        });
      }
      await telegram.answerCallbackQuery(callbackQuery.id, 'Saved!');
      return telegram.sendMessage(chatId, `✅ Saved ${data.items.length} item(s) from ${data.merchant}`);
    }

    {
      const receiptDate = ocr.formatReceiptDate(data.date);
      const monthTab = ocr.monthTabName(receiptDate);
      await sheets.appendRawOcr(pendingId, data.rawText || '');

      const hasHandlingFee = data.handlingFee !== undefined && data.handlingFee !== '';
      const finalBillTotal = hasHandlingFee
        ? Math.round((Number(data.total || 0) + Number(data.handlingFee)) * 100) / 100
        : data.total || '';

      await sheets.appendTransaction({
        expenseType: 'Uncategorized (OCR)',
        category: 'Receipt',
        amount: data.total || 0,
        merchant: data.merchant,
        notes: hasHandlingFee ? `Handling Fee: ${data.handlingFee}` : `Date: ${data.date || ''}; Tax: ${data.tax || ''}`,
        source: 'Telegram-OCR',
        rawInput: pendingId,
        finalBill: finalBillTotal,
        receiptDate,
        monthTab,
        isLastItemOfReceipt: true,
      });
    }
    await telegram.answerCallbackQuery(callbackQuery.id, 'Saved!');
    return telegram.sendMessage(chatId, `✅ Saved ${data.total} from ${data.merchant}`);
  }
}

module.exports = { handleTelegramUpdate };
