require('dotenv').config();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Set TELEGRAM_BOT_TOKEN in your .env first.');
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  console.log(await res.json());
}

main();
