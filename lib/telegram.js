const TELEGRAM_API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function callTelegram(method, payload) {
  const res = await fetch(`${TELEGRAM_API()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API error on ${method}:`, data);
  }
  return data;
}

function sendMessage(chatId, text, extra = {}) {
  return callTelegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function answerCallbackQuery(callbackQueryId, text) {
  return callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

async function getFileUrl(fileId) {
  const data = await callTelegram('getFile', { file_id: fileId });
  if (!data.ok) throw new Error('Could not resolve Telegram file path');
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

async function downloadFile(fileUrl) {
  const res = await fetch(fileUrl);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function confirmKeyboard(pendingId) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Save', callback_data: `confirm:${pendingId}` },
        { text: '❌ Discard', callback_data: `cancel:${pendingId}` },
      ]],
    },
  };
}

module.exports = { sendMessage, answerCallbackQuery, getFileUrl, downloadFile, confirmKeyboard };
