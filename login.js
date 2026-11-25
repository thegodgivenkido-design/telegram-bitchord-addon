
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Missing Telegram API credentials.");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });

const client = new TelegramClient(
  new StringSession(""),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

try {
  await client.start({
    phoneNumber: async () =>
      rl.question("Telegram phone number: "),

    phoneCode: async () =>
      rl.question("Telegram login code: "),

    password: async () =>
      rl.question("Two-step verification password: "),

    onError: error => console.error(error.message)
  });

  console.log("\nYour private session string:");
  console.log(client.session.save());

  console.log("\nKeep this string secret. Never upload it to GitHub or share it in chat.");

} catch (error) {
  console.error("Login failed:", error.message);
} finally {
  rl.close();
  await client.disconnect().catch(() => {});
}
