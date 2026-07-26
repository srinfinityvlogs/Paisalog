// Extend this list any time you want the bot to recognize a new category.
// No other code changes needed — parser.js and handleUpdate.js both use classify().
const CATEGORY_MAP = [
  { keywords: ['grocery', 'groceries', 'supermarket', 'vegetables', 'veggies'], category: 'Grocery', expenseType: 'Food & Dining' },
  { keywords: ['lunch', 'dinner', 'breakfast', 'snack', 'coffee', 'restaurant', 'food', 'zomato', 'swiggy'], category: 'Food', expenseType: 'Food & Dining' },
  { keywords: ['fuel', 'petrol', 'diesel', 'gas station'], category: 'Fuel', expenseType: 'Transport' },
  { keywords: ['taxi', 'uber', 'ola', 'cab', 'bus', 'train', 'metro', 'parking'], category: 'Transit', expenseType: 'Transport' },
  { keywords: ['rent'], category: 'Rent', expenseType: 'Housing' },
  { keywords: ['electricity', 'water bill', 'internet', 'wifi', 'phone bill', 'mobile bill', 'utility', 'utilities'], category: 'Utilities', expenseType: 'Housing' },
  { keywords: ['medicine', 'doctor', 'pharmacy', 'hospital', 'health'], category: 'Health', expenseType: 'Health' },
  { keywords: ['movie', 'entertainment', 'games', 'netflix', 'subscription'], category: 'Entertainment', expenseType: 'Lifestyle' },
  { keywords: ['shopping', 'clothes', 'amazon', 'flipkart'], category: 'Shopping', expenseType: 'Lifestyle' },
];

/**
 * Classify free-text category input into a normalized {category, expenseType} pair.
 * Falls back to a title-cased version of whatever the user typed, tagged "Other",
 * so nothing is ever silently dropped.
 */
function classify(rawCategoryText) {
  const text = (rawCategoryText || '').trim().toLowerCase();
  for (const rule of CATEGORY_MAP) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return { category: rule.category, expenseType: rule.expenseType };
    }
  }
  const titleCased = (rawCategoryText || 'Other').trim().replace(/\b\w/g, (c) => c.toUpperCase());
  return { category: titleCased || 'Other', expenseType: 'Other' };
}

module.exports = { classify, CATEGORY_MAP };
