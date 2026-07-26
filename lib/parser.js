const { classify } = require('./categories');

// Matches "<category text> <amount>", e.g. "Grocery 250", "Fuel 1800.50", "Late night snack 90"
// The amount is always the trailing number; everything before it is the category text.
const EXPENSE_PATTERN = /^(.+?)\s+[₹$]?([0-9]+(?:\.[0-9]{1,2})?)\s*$/;

function parseExpenseMessage(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(EXPENSE_PATTERN);
  if (!match) return null;

  const [, rawCategory, rawAmount] = match;
  const amount = parseFloat(rawAmount);
  if (Number.isNaN(amount) || amount <= 0) return null;

  const { category, expenseType } = classify(rawCategory);

  return { category, expenseType, amount, rawInput: trimmed };
}

module.exports = { parseExpenseMessage };
