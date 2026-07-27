/**
 * Sheets proxy — lets the Vercel bot read/write your Google Sheet over plain
 * HTTPS, authenticated with a shared secret instead of a service account key.
 * Use this if your GCP organization enforces `iam.disableServiceAccountKeyCreation`
 * (or if you'd simply rather not manage a key file at all).
 *
 * SETUP:
 * 1. Open your Google Sheet (the one with Transactions/Meta/Pending tabs) >
 *    Extensions > Apps Script.
 * 2. Replace any starter content with this file, save as Code.gs.
 * 3. Project Settings (gear icon) > Script Properties > Add property:
 *      SHEETS_PROXY_SECRET = <a random string you invent>
 * 4. Deploy > New deployment > select type "Web app".
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy, authorize when prompted, then copy the Web app URL.
 * 5. In your bot's .env, set:
 *      SHEETS_PROXY_URL = <that Web app URL>
 *      SHEETS_PROXY_SECRET = <the same random string from step 3>
 *
 * Whenever you edit this script, you must create a NEW deployment version
 * (Deploy > Manage deployments > pencil icon > New version) for changes to
 * take effect on the existing URL.
 */

const TRANSACTIONS_TAB = 'Transactions';
const META_TAB = 'Meta';
const PENDING_TAB = 'Pending';

function doGet(e) {
  if (!e || !e.parameter || !e.parameter.action) {
    return ContentService.createTextOutput('Sheets proxy is alive.');
  }
  return handleRequest_(e);
}

// Kept for completeness — the bot uses doGet, but this means a POST with the
// same query-string style still works too if you ever need it.
function doPost(e) {
  return handleRequest_(e);
}

function handleRequest_(e) {
  const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHEETS_PROXY_SECRET');
  if (expectedSecret && e.parameter.secret !== expectedSecret) {
    return json_({ ok: false, error: 'unauthorized' });
  }

  try {
    const payload = e.parameter.payload ? JSON.parse(e.parameter.payload) : {};
    const result = route_(e.parameter.action, payload);
    return json_({ ok: true, result: result });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function route_(action, payload) {
  switch (action) {
    case 'appendTransaction': return appendTransaction_(payload);
    case 'getLastProcessedUpdateId': return getLastProcessedUpdateId_();
    case 'setLastProcessedUpdateId': return setLastProcessedUpdateId_(payload.updateId);
    case 'getLastRow': return getLastRow_();
    case 'deleteLastRow': return deleteLastRow_();
    case 'updateLastRowCategory': return updateLastRowCategory_(payload.category, payload.expenseType);
    case 'createPending': return createPending_(payload.pendingId, payload.chatId, payload.data);
    case 'findAndConsumePending': return findAndConsumePending_(payload.pendingId);
    default: throw new Error('Unknown action: ' + action);
  }
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function appendTransaction_(p) {
  const now = new Date();
  const month = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMMM yyyy');
  sheet_(TRANSACTIONS_TAB).appendRow([
    now.toISOString(), p.expenseType || '', p.category || '', p.amount || 0,
    p.merchant || '', p.notes || '', p.source || '', p.rawInput || '', month,
    p.rate === undefined || p.rate === '' ? '' : p.rate,
    p.quantity === undefined || p.quantity === '' ? '' : p.quantity,
  ]);
  return true;
}

function getLastProcessedUpdateId_() {
  const value = sheet_(META_TAB).getRange('A1').getValue();
  return value ? parseInt(value, 10) : 0;
}

function setLastProcessedUpdateId_(updateId) {
  sheet_(META_TAB).getRange('A1').setValue(updateId);
  return true;
}

function getLastRow_() {
  const sh = sheet_(TRANSACTIONS_TAB);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return null; // header row only
  const values = sh.getRange(lastRow, 1, 1, 9).getValues()[0];
  return { rowNumber: lastRow, values: values };
}

function deleteLastRow_() {
  const last = getLastRow_();
  if (!last) return null;
  sheet_(TRANSACTIONS_TAB).deleteRow(last.rowNumber);
  return last;
}

function updateLastRowCategory_(category, expenseType) {
  const last = getLastRow_();
  if (!last) return null;
  sheet_(TRANSACTIONS_TAB).getRange(last.rowNumber, 2, 1, 2).setValues([[expenseType, category]]);
  return last;
}

function createPending_(pendingId, chatId, data) {
  sheet_(PENDING_TAB).appendRow([pendingId, chatId, new Date().toISOString(), JSON.stringify(data)]);
  return true;
}

function findAndConsumePending_(pendingId) {
  const sh = sheet_(PENDING_TAB);
  const values = sh.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === pendingId) {
      const data = JSON.parse(values[i][3]);
      sh.deleteRow(i + 1);
      return data;
    }
  }
  return null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
