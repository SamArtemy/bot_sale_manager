import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { OrderRepository } from "./database.js";
import { GoogleSheetsOrderSink } from "./googleSheets.js";
import { GoogleTasksOrderSink } from "./googleTasks.js";

process.umask(0o077);
const config = loadConfig();
const repository = new OrderRepository(config.databasePath);
const sheetsSink = config.googleSheets ? new GoogleSheetsOrderSink(config.googleSheets, config.branding.timeZone) : undefined;
const tasksSink = config.googleTasks ? new GoogleTasksOrderSink(config.googleTasks, config.branding.timeZone) : undefined;
const bot = createBot(config.botToken, repository, config.adminChatId, config.adminMessageThreadId, sheetsSink, tasksSink, config.adminUserIds, config.branding);

const shutdown = (): void => {
  if (bot.isRunning()) void bot.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Бот запущен. Google Sheets: ${sheetsSink ? "подключён" : "не настроен"}. Google Tasks: ${tasksSink ? "подключён" : "не настроен"}`);
try {
  await bot.start({ drop_pending_updates: false, allowed_updates: ["message", "callback_query"] });
} catch {
  console.error("Бот остановлен из-за ошибки запуска или Telegram API. Проверьте конфигурацию и соединение.");
  process.exitCode = 1;
} finally {
  repository.close();
}
