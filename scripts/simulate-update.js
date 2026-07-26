require('dotenv').config();
const { handleTelegramUpdate } = require('../lib/handleUpdate');

// Simulates a Telegram text message locally — no ngrok, no deployment needed.
// This calls the REAL Google Sheets API and REAL Telegram sendMessage API,
// so make sure your .env is filled in first.
//
// Usage (PowerShell / cmd / bash — all the same):
//   node scripts/simulate-update.js "Grocery 250"
//   node scripts/simulate-update.js "/last"
//   node scripts/simulate-update.js "/undo"

const text = process.argv.slice(2).join(' ') || 'Grocery 250';
const chatId = process.env.ALLOWED_TELEGRAM_USER_ID || 111111111;

const fakeUpdate = {
  update_id: Date.now(), // always increasing, so it won't collide with the dedupe check
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId },
    from: { id: chatId },
    text,
  },
};

handleTelegramUpdate(fakeUpdate)
  .then(() => console.log('Done — check your Google Sheet and your Telegram chat.'))
  .catch((err) => console.error('Simulation failed:', err));
