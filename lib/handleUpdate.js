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
      'Send an expense like <b>Grocery 250</b> or a receipt photo.\n\n' +
        'Commands:\n' +
        '/last — show the last entry\n' +
        '/undo — delete the last entry\n' +
        '/setcategory &lt;name&gt; — fix the last entry\'s category'
    );
  }

  if (text.startsWith('/last')) {
    const last = await sheets.getLastRow();
    if (!last) return telegram.sendMessage(chatId, 'No entries yet.');
    const [, expenseType, category, amount, merchant] = last.values;
    return telegram.sendMessage(
      chatId,
      `Last entry: <b>${category}</b> (${expenseType}) — ${amount}${merchant ? ' @ ' + merchant : ''}`
    );
  }

  if (text.startsWith('/undo')) {
    const removed = await sheets.deleteLastRow();
    if (!removed) return telegram.sendMessage(chatId, 'Nothing to undo.');
    return telegram.sendMessage(chatId, `Removed: ${removed.values[2]} — ${removed.values[3]}`);
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
    const rawText = await ocr.extractTextFromImage(imageBuffer);
    const extracted = ocr.parseReceiptText(rawText);

    const pendingId = crypto.randomBytes(6).toString('hex');
    await sheets.createPending(pendingId, chatId, { ...extracted, rawText });

    const preview =
      "Here's what I found — tap Save to log it:\n\n" +
      `🏪 Merchant: ${extracted.merchant}\n` +
      `📅 Date: ${extracted.date || 'unknown'}\n` +
      `💰 Total: ${extracted.total || 'unknown'}\n` +
      `🧾 Tax: ${extracted.tax || '—'}`;

    await telegram.sendMessage(chatId, preview, telegram.confirmKeyboard(pendingId));
  } catch (err) {
    console.error('OCR pipeline failed:', err);
    await telegram.sendMessage(chatId, "I couldn't read that receipt. You can log it manually, e.g. Grocery 250.");
  }
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
    await sheets.appendTransaction({
      expenseType: 'Uncategorized (OCR)',
      category: 'Receipt',
      amount: data.total || 0,
      merchant: data.merchant,
      notes: `Date: ${data.date || ''}; Tax: ${data.tax || ''}`,
      source: 'Telegram-OCR',
      rawInput: (data.rawText || '').slice(0, 500),
    });
    await telegram.answerCallbackQuery(callbackQuery.id, 'Saved!');
    return telegram.sendMessage(chatId, `✅ Saved ${data.total} from ${data.merchant}`);
  }
}

module.exports = { handleTelegramUpdate };
