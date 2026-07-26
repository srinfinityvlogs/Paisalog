/**
 * MINIMAL FALLBACK VERSION — text logging only, no dedupe, no corrections, no OCR.
 * Use this only if you don't want to touch Vercel/Node at all and are fine with
 * a much simpler feature set. The main project (../lib, ../api) is the
 * recommended, full-featured version.
 *
 * SETUP:
 * 1. Create a new Google Sheet with a "Transactions" tab (see SHEETS_SETUP in the README).
 * 2. Extensions > Apps Script, paste this file in as Code.gs.
 * 3. Project Settings > Script Properties, add:
 *      TELEGRAM_BOT_TOKEN = <your bot token>
 *      GOOGLE_SHEET_ID    = <this spreadsheet's ID>
 *      TELEGRAM_WEBHOOK_SECRET = <a random string you choose>
 * 4. Deploy > New deployment > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the deployment URL.
 * 5. Register the webhook (run once, from any machine with curl):
 *      curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEB_APP_URL>?secret=<SECRET>"
 *    (Apps Script web apps can't read custom headers, so the secret travels
 *    as a query parameter here instead of Telegram's secret_token header.)
 */

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const sheetId = props.getProperty('GOOGLE_SHEET_ID');
  const secret = props.getProperty('TELEGRAM_WEBHOOK_SECRET');

  if (secret && e.parameter.secret !== secret) {
    return ContentService.createTextOutput('unauthorized');
  }

  const update = JSON.parse(e.postData.contents);
  const msg = update.message;
  if (msg && msg.text) {
    handleText_(msg, token, sheetId);
  }
  return ContentService.createTextOutput('ok');
}

function handleText_(msg, token, sheetId) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const match = text.match(/^(.+?)\s+([0-9]+(?:\.[0-9]{1,2})?)\s*$/);
  if (!match) {
    sendMessage_(token, chatId, 'Try the format: Category Amount, e.g. Lunch 120');
    return;
  }

  const category = match[1].trim();
  const amount = parseFloat(match[2]);
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName('Transactions');
  const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');

  sheet.appendRow([new Date(), 'Other', category, amount, '', '', 'Telegram-Text', text, month]);
  sendMessage_(token, chatId, '✅ Logged ' + category + ' — ' + amount);
}

function sendMessage_(token, chatId, text) {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text }),
  });
}
