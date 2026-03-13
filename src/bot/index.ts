import path from "node:path";
import { config as loadEnv } from "dotenv";
import { parseIstTimeConfig } from "./time";
import { TelegramTradeBot } from "./telegramTradeBot";

loadEnv({ path: ".env.local" });
loadEnv();

function parseChatIds(rawValue: string | undefined): number[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value));
}

function parsePollInterval(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    return 20_000;
  }
  return parsed;
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment.");
  }

  const summaryTime = parseIstTimeConfig(process.env.TRADE_BOT_SUMMARY_TIME_IST, {
    hour: 15,
    minute: 15
  });

  const allowedIds = parseChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const summaryChatIds = parseChatIds(process.env.TELEGRAM_SUMMARY_CHAT_IDS);

  const statePath = process.env.TRADE_BOT_STATE_PATH
    ? path.resolve(process.cwd(), process.env.TRADE_BOT_STATE_PATH)
    : path.resolve(process.cwd(), "data/telegram-trade-bot/state.json");

  const bot = new TelegramTradeBot({
    token,
    statePath,
    pollIntervalMs: parsePollInterval(process.env.TRADE_BOT_POLL_INTERVAL_MS),
    summaryHour: summaryTime.hour,
    summaryMinute: summaryTime.minute,
    allowedChatIds: allowedIds.length > 0 ? new Set(allowedIds) : null,
    summaryChatIds
  });

  await bot.start();
  await bot.sendStartupMessage();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Trade bot startup failed: ${message}`);
  process.exit(1);
});
