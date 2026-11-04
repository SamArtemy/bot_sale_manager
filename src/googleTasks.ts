import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import type { ExportOrder } from "./database.js";

export interface GoogleTasksConfig {
  taskListId: string;
  credentialsFile: string;
}

export class GoogleTasksOrderSink {
  constructor(private readonly config: GoogleTasksConfig, private readonly timeZone = "UTC") {}

  async createOrder(order: ExportOrder): Promise<void> {
    const credentials = JSON.parse(await readFile(this.config.credentialsFile, "utf8")) as {
      client_id: string;
      client_secret: string;
      refresh_token: string;
    };
    const auth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret);
    auth.setCredentials({ refresh_token: credentials.refresh_token });
    const tasks = google.tasks({ version: "v1", auth });
    const telegram = order.telegramUsername ? `@${order.telegramUsername}` : "не указан";
    const firstItem = order.items[0]?.description ?? "Новый заказ";
    const shortItem = firstItem.length > 70 ? `${firstItem.slice(0, 67)}…` : firstItem;
    const positions = order.items.map((item) => {
      const attachments = [
        item.photoFileId ? "фото приложено в Telegram" : undefined,
        item.documentFileId ? `файл: ${item.documentFileName ?? "приложен в Telegram"}` : undefined,
      ].filter(Boolean);
      return `${item.positionNumber}. ${item.description}${attachments.length ? ` (${attachments.join(", ")})` : ""}`;
    });
    const notes = [
      `Заказ №${order.id}`,
      `Telegram: ${telegram}`,
      `ФИО: ${order.fullName}`,
      `Телефон: ${order.phone}`,
      `Город: ${order.city}`,
      order.vehicleInfo ? `VIN / автомобиль: ${order.vehicleInfo}` : undefined,
      `Дата заказа: ${new Date(order.createdAt).toLocaleString("ru-RU", { timeZone: this.timeZone })}`,
      "",
      "Позиции:",
      ...positions,
    ].filter((line): line is string => line !== undefined).join("\n");

    await tasks.tasks.insert({
      tasklist: this.config.taskListId,
      requestBody: {
        title: `Заказ №${order.id} — ${shortItem} — ${telegram}`,
        notes,
        status: "needsAction",
      },
    });
  }
}
