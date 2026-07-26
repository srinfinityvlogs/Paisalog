require('dotenv').config();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const baseUrl = process.env.BASE_URL;

  if (!token || !baseUrl) {
    console.error('Set TELEGRAM_BOT_TOKEN and BASE_URL in your .env first.');
    process.exit(1);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, drop_pending_updates: true }),
  });
  const data = await res.json();
  console.log(data);
  if (data.ok) console.log(`Webhook set to ${url}`);
}

main();
