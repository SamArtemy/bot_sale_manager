import "dotenv/config";
import { loadBranding, type BotBranding } from "./branding.js";
import path from "node:path";

export interface Config {
  botToken: string;
  branding: BotBranding;
  adminUserIds: number[];
  databasePath: string;
  adminChatId?: number;
  adminMessageThreadId?: number;
  googleSheets?: {
    spreadsheetId: string;
    sheetId: number;
    serviceAccountEmail?: string;
    privateKey?: string;
    keyFile?: string;
  };
  googleTasks?: {
    taskListId: string;
    credentialsFile: string;
  };
}

export function loadConfig(): Config {
  const botToken = process.env.BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("Не задан BOT_TOKEN. Скопируйте .env.example в .env.");
  }

  const adminUserIds = (process.env.ADMIN_USER_IDS?.trim() || "").split(",").filter(Boolean).map(Number);
  if (adminUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("ADMIN_USER_IDS: укажите положительные Telegram ID через запятую");
  }

  const adminRaw = process.env.ADMIN_CHAT_ID?.trim();
  const adminChatId = adminRaw ? Number(adminRaw) : undefined;
  if (adminChatId !== undefined && !Number.isSafeInteger(adminChatId)) {
    throw new Error("ADMIN_CHAT_ID должен быть целым числом");
  }
  const adminThreadRaw = process.env.ADMIN_MESSAGE_THREAD_ID?.trim();
  const adminMessageThreadId = adminThreadRaw ? Number(adminThreadRaw) : undefined;
  if (adminMessageThreadId !== undefined && (!Number.isSafeInteger(adminMessageThreadId) || adminMessageThreadId < 1)) {
    throw new Error("ADMIN_MESSAGE_THREAD_ID должен быть положительным целым числом");
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const sheetIdRaw = process.env.GOOGLE_SHEETS_SHEET_ID?.trim();
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY?.trim();
  const keyFileRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const hasInlineCredentials = Boolean(serviceAccountEmail && privateKeyRaw);
  const hasCredentials = hasInlineCredentials || Boolean(keyFileRaw);
  if ((spreadsheetId || sheetIdRaw || serviceAccountEmail || privateKeyRaw || keyFileRaw) && !(spreadsheetId && sheetIdRaw && hasCredentials)) {
    console.warn("Google Sheets не подключён: заполните все GOOGLE_* переменные в .env");
  }
  const sheetId = sheetIdRaw ? Number(sheetIdRaw) : undefined;
  if (sheetId !== undefined && !Number.isSafeInteger(sheetId)) {
    throw new Error("GOOGLE_SHEETS_SHEET_ID должен быть целым числом");
  }

  const googleTasksListId = process.env.GOOGLE_TASKS_LIST_ID?.trim();
  const googleTasksCredentialsFile = process.env.GOOGLE_TASKS_CREDENTIALS_FILE?.trim();
  if ((googleTasksListId || googleTasksCredentialsFile) && !(googleTasksListId && googleTasksCredentialsFile)) {
    console.warn("Google Tasks не подключён: заполните GOOGLE_TASKS_LIST_ID и GOOGLE_TASKS_CREDENTIALS_FILE");
  }

  return {
    botToken,
    branding: loadBranding(),
    adminUserIds,
    databasePath: path.resolve(process.env.DATABASE_PATH ?? "data/orders.sqlite3"),
    adminChatId,
    adminMessageThreadId,
    googleSheets: spreadsheetId && sheetId !== undefined && hasCredentials ? {
      spreadsheetId: spreadsheetId!,
      sheetId,
      serviceAccountEmail: hasInlineCredentials ? serviceAccountEmail : undefined,
      privateKey: hasInlineCredentials ? privateKeyRaw!.replace(/\\n/g, "\n") : undefined,
      keyFile: keyFileRaw ? path.resolve(keyFileRaw) : undefined,
    } : undefined,
    googleTasks: googleTasksListId && googleTasksCredentialsFile ? {
      taskListId: googleTasksListId,
      credentialsFile: path.resolve(googleTasksCredentialsFile),
    } : undefined,
  };
}
