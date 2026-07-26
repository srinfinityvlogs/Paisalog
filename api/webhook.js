const { handleTelegramUpdate } = require('../lib/handleUpdate');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Telegram expense bot webhook is alive.');
  }

  // Reject anything that doesn't carry the secret we set via setWebhook.
  // This stops randoms on the internet from POSTing fake "expenses" to your sheet.
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    await handleTelegramUpdate(req.body);
  } catch (err) {
    // Log and still return 200 — if we return an error, Telegram will retry
    // the same update repeatedly, which just spams retries without fixing anything.
    console.error('Failed to handle update:', err);
  }

  res.status(200).json({ ok: true });
};
