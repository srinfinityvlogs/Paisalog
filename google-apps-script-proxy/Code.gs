/**
 * Sheets proxy — lets the Vercel bot read/write your Google Sheet over plain
 * HTTPS, authenticated with a shared secret instead of a service account key.
 * Use this if your GCP organization enforces `iam.disableServiceAccountKeyCreation`
 * (or if you'd simply rather not manage a key file at all).
 *
 * SHEET STRUCTURE:
 * - One tab per month, named e.g. "July 2026", "August 2026" — created
 *   automatically the first time a transaction needs one. Each transaction
 *   is routed to the tab matching its OWN date (the receipt's printed date,
 *   or today's date for plain text logs), not necessarily the tab matching
 *   when you happened to log it. Within a tab, rows are inserted in DATE
 *   ORDER (not upload order) — a 19th-July receipt uploaded after a 21st-July
 *   one is inserted above it, not appended below.
 * - "Meta" — bookkeeping: last processed Telegram update_id (A1), the name
 *   of the most recently written-to month tab (A2), and the row number of
 *   the most recently written row within that tab (A3, since date-ordered
 *   inserts can land in the middle of the sheet, not just at the bottom).
 *   Together these let /last, /undo, and /setcategory always find the right
 *   row, even after it's been sorted into the middle of a past month's tab.
 * - "Pending" — short-lived holding area for receipt confirmations.
 * - "RawOCR" — full OCR text per receipt, written once (not duplicated
 *   across every item row), referenced from Transactions by a short ID.
 *
 * SETUP:
 * 1. Open your Google Sheet > Extensions > Apps Script.
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

const META_TAB = 'Meta';
const PENDING_TAB = 'Pending';
const RAW_OCR_TAB = 'RawOCR';
const TRANSACTION_HEADERS = [
  'Expense Type', 'Category', 'Merchant', 'Rate', 'Qty', 'Amount',
  'Date', 'Final Bill', 'Notes', 'Source', 'Raw OCR Ref', 'Timestamp',
];

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
    case 'appendRawOcr': return appendRawOcr_(payload.receiptId, payload.rawText);
    default: throw new Error('Unknown action: ' + action);
  }
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function defaultCurrentMonthName_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');
}

/** Returns the sheet for a given month tab name, creating it (with headers) if it doesn't exist yet. */
function getOrCreateMonthSheet_(tabName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(TRANSACTION_HEADERS);
    sh.setFrozenRows(1);

    // Explicitly set formats so Sheets can't auto-guess a numeric column as a
    // date (a plain number like a total can otherwise get misread as a date
    // serial number, e.g. showing "31/12/1900"). Applied to a generous number
    // of rows so it still holds as new rows get appended later.
    const numRows = 2000;
    sh.getRange(2, 4, numRows, 1).setNumberFormat('0.00');  // D Rate
    sh.getRange(2, 5, numRows, 1).setNumberFormat('0.00');  // E Qty
    sh.getRange(2, 6, numRows, 1).setNumberFormat('0.00');  // F Amount
    sh.getRange(2, 7, numRows, 1).setNumberFormat('@');     // G Date (plain text, we write pre-formatted DD/MM/YYYY strings)
    sh.getRange(2, 8, numRows, 1).setNumberFormat('0.00');  // H Final Bill
    sh.getRange(2, 12, numRows, 1).setNumberFormat('@');    // L Timestamp (plain text ISO string)
  }
  return sh;
}

function getLastTouchedTab_() {
  const value = sheet_(META_TAB).getRange('A2').getValue();
  return value || defaultCurrentMonthName_();
}

function setLastTouchedTab_(tabName) {
  sheet_(META_TAB).getRange('A2').setValue(tabName);
}

function getLastTouchedRow_() {
  const value = sheet_(META_TAB).getRange('A3').getValue();
  return value ? parseInt(value, 10) : null;
}

function setLastTouchedRow_(rowNumber) {
  sheet_(META_TAB).getRange('A3').setValue(rowNumber);
}

function clearLastTouchedRow_() {
  sheet_(META_TAB).getRange('A3').setValue('');
}

/** Parses a DD/MM/YYYY string into a comparable timestamp, or null if unparseable. */
function parseDdMmYyyy_(str) {
  const m = String(str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

/**
 * Inserts a row in date order (column G, the Date column) rather than always
 * appending at the bottom, so the sheet stays chronologically sorted by
 * invoice date regardless of the order receipts happen to get uploaded in.
 * Rows sharing the same date land after existing same-date rows, so a
 * multi-item receipt's rows stay grouped together. Returns the row number
 * the data actually landed on.
 */
function insertRowInDateOrder_(sh, dateStr, rowValues) {
  const newMs = parseDdMmYyyy_(dateStr);
  const lastRow = sh.getLastRow();

  if (newMs === null || lastRow <= 1) {
    sh.appendRow(rowValues);
    return sh.getLastRow();
  }

  const dateColumn = sh.getRange(2, 7, lastRow - 1, 1).getValues(); // column G = Date
  let insertAt = lastRow + 1; // default: append after the last row
  for (let i = 0; i < dateColumn.length; i++) {
    const existingMs = parseDdMmYyyy_(dateColumn[i][0]);
    if (existingMs !== null && existingMs > newMs) {
      insertAt = i + 2; // +2: data starts at row 2, i is 0-indexed
      break;
    }
  }

  if (insertAt > lastRow) {
    sh.appendRow(rowValues);
    return sh.getLastRow();
  }
  sh.insertRowBefore(insertAt);
  sh.getRange(insertAt, 1, 1, rowValues.length).setValues([rowValues]);
  return insertAt;
}

function appendTransaction_(p) {
  const now = new Date();
  const todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const dateStr = p.receiptDate ? p.receiptDate : todayStr; // prefer the receipt's own printed date when OCR found one
  const tabName = p.monthTab || defaultCurrentMonthName_();
  const sh = getOrCreateMonthSheet_(tabName);

  const rowValues = [
    p.expenseType || '',                                                      // A Expense Type
    p.category || '',                                                         // B Category
    p.merchant || '',                                                         // C Merchant
    p.rate === undefined || p.rate === '' ? '' : p.rate,                      // D Rate
    p.quantity === undefined || p.quantity === '' ? '' : p.quantity,          // E Qty
    p.amount || 0,                                                            // F Amount
    dateStr,                                                                  // G Date
    p.finalBill === undefined || p.finalBill === '' ? '' : p.finalBill,       // H Final Bill
    p.notes || '',                                                            // I Notes
    p.source || '',                                                           // J Source
    p.rawInput || '',                                                         // K Raw OCR Ref (short ID, see RawOCR tab)
    now.toISOString(),                                                        // L Timestamp
  ];

  const rowNumber = insertRowInDateOrder_(sh, dateStr, rowValues);

  if (p.isLastItemOfReceipt) {
    sh.insertRowAfter(rowNumber); // blank spacer row so each logged bill/entry has a visible gap after it
  }

  setLastTouchedTab_(sh.getName());
  setLastTouchedRow_(rowNumber); // track the data row itself, not the blank spacer, so /undo etc. still target the right row
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
  const sh = sheet_(getLastTouchedTab_());
  const trackedRow = getLastTouchedRow_();
  const lastPhysicalRow = sh.getLastRow();
  // Prefer the specifically-tracked row (since date-ordered inserts can land
  // in the middle of the sheet, not just at the bottom); fall back to the
  // physically last row if nothing's tracked yet or it's gone stale.
  const rowNumber = trackedRow && trackedRow >= 2 && trackedRow <= lastPhysicalRow ? trackedRow : lastPhysicalRow;
  if (rowNumber <= 1) return null; // header row only
  const values = sh.getRange(rowNumber, 1, 1, 12).getValues()[0];
  return { rowNumber: rowNumber, values: values };
}

function deleteLastRow_() {
  const last = getLastRow_();
  if (!last) return null;
  sheet_(getLastTouchedTab_()).deleteRow(last.rowNumber);
  clearLastTouchedRow_(); // the tracked position is now gone/shifted — don't let a second /undo use a stale row number
  return last;
}

function updateLastRowCategory_(category, expenseType) {
  const last = getLastRow_();
  if (!last) return null;
  sheet_(getLastTouchedTab_()).getRange(last.rowNumber, 1, 1, 2).setValues([[expenseType, category]]);
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

function appendRawOcr_(receiptId, rawText) {
  sheet_(RAW_OCR_TAB).appendRow([receiptId, new Date().toISOString(), rawText || '']);
  return true;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
