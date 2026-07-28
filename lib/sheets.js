// Talks to the Google Apps Script proxy (google-apps-script-proxy/Code.gs)
// instead of the Sheets API directly. This avoids needing a service account
// key at all, which matters if your GCP org enforces
// iam.disableServiceAccountKeyCreation (a common default policy).
//
// If your org DOESN'T block service account keys and you'd rather call the
// Sheets API directly with the `googleapis` package, that's a valid
// alternative — this file is the only one you'd need to swap back.

const PROXY_URL = process.env.SHEETS_PROXY_URL;
const PROXY_SECRET = process.env.SHEETS_PROXY_SECRET;

async function callProxy(action, payload = {}) {
  if (!PROXY_URL) throw new Error('SHEETS_PROXY_URL is not set');

  const params = new URLSearchParams({
    secret: PROXY_SECRET || '',
    action,
    payload: JSON.stringify(payload),
  });
  const res = await fetch(`${PROXY_URL}?${params.toString()}`, { method: 'GET' });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // Surface exactly what came back instead of a bare JSON parse error,
    // so we can tell an auth wall apart from a script error apart from a 404.
    throw new Error(`Sheets proxy returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!data.ok) throw new Error(data.error || `Sheets proxy error on ${action}`);
  return data.result;
}

async function appendTransaction({ expenseType, category, amount, merchant = '', notes = '', source, rawInput = '', rate = '', quantity = '', finalBill = '', receiptDate = '' }) {
  return callProxy('appendTransaction', { expenseType, category, amount, merchant, notes, source, rawInput, rate, quantity, finalBill, receiptDate });
}

async function getLastProcessedUpdateId() {
  return callProxy('getLastProcessedUpdateId');
}

async function setLastProcessedUpdateId(updateId) {
  return callProxy('setLastProcessedUpdateId', { updateId });
}

async function getLastRow() {
  return callProxy('getLastRow');
}

async function deleteLastRow() {
  return callProxy('deleteLastRow');
}

async function updateLastRowCategory(category, expenseType) {
  return callProxy('updateLastRowCategory', { category, expenseType });
}

async function createPending(pendingId, chatId, data) {
  return callProxy('createPending', { pendingId, chatId, data });
}

async function findAndConsumePending(pendingId) {
  return callProxy('findAndConsumePending', { pendingId });
}

module.exports = {
  appendTransaction,
  getLastProcessedUpdateId,
  setLastProcessedUpdateId,
  getLastRow,
  deleteLastRow,
  updateLastRowCategory,
  createPending,
  findAndConsumePending,
};
