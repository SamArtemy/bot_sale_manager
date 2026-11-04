import { google, sheets_v4 } from "googleapis";
import type { ExportOrder } from "./database.js";

const HEADERS = [
  "",
  "ID",
  "Дата",
  "Дней с заказа",
  "Клиент",
  "Товар",
  "Цена клиенту, ₽",
  "Клиент заплатил, ₽",
  "Остаток, ₽",
  "Трек посылки",
  "Комментарий",
  "Себестоимость, ₽",
  "Логистика КНР→РФ, ₽",
  "Логистика РФ→клиент, ₽",
  "Полная себестоимость, ₽",
  "Маржа, %",
  "Прибыль, ₽",
  "Ссылка",
];

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetId: number;
  serviceAccountEmail?: string;
  privateKey?: string;
  keyFile?: string;
}

export class GoogleSheetsOrderSink {
  private readonly client: sheets_v4.Sheets;
  private sheetTitle?: string;

  constructor(private readonly config: GoogleSheetsConfig, private readonly timeZone = "UTC") {
    const auth = new google.auth.GoogleAuth({
      ...(config.keyFile ? { keyFile: config.keyFile } : {
        credentials: {
          client_email: config.serviceAccountEmail,
          private_key: config.privateKey,
        },
      }),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.client = google.sheets({ version: "v4", auth });
  }

  private async resolveSheetTitle(): Promise<string> {
    if (this.sheetTitle) return this.sheetTitle;
    const response = await this.client.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = response.data.sheets?.find((item) => item.properties?.sheetId === this.config.sheetId);
    const title = sheet?.properties?.title;
    if (!title) throw new Error(`В таблице не найден лист с gid=${this.config.sheetId}`);
    this.sheetTitle = title;
    return title;
  }

  private async ensureHeaders(title: string): Promise<void> {
    const escapedTitle = title.replaceAll("'", "''");
    const range = `'${escapedTitle}'!A1:R1`;
    const response = await this.client.spreadsheets.values.get({ spreadsheetId: this.config.spreadsheetId, range });
    const current = response.data.values?.[0]?.map(String) ?? [];
    if (current.length === 0) {
      await this.client.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
      return;
    }
    if (HEADERS.some((header, index) => current[index] !== header)) {
      throw new Error("Заголовки выбранного листа не совпадают с форматом бота; запись отменена во избежание порчи таблицы");
    }
  }

  async appendOrder(order: ExportOrder, onlyPositionNumber?: number): Promise<void> {
    const title = await this.resolveSheetTitle();
    await this.ensureHeaders(title);
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const items = onlyPositionNumber
      ? order.items.filter((item) => item.positionNumber === onlyPositionNumber)
      : order.items;
    const client = [
      order.fullName,
      order.telegramUsername ? `@${order.telegramUsername}` : undefined,
      order.phone,
      order.city,
    ].filter(Boolean).join(" · ");
    if (items.length === 0) return;
    const escapedTitle = title.replaceAll("'", "''");
    const existing = await this.client.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `'${escapedTitle}'!A2:F`,
    });
    let lastDataRow = 1;
    (existing.data.values ?? []).forEach((row, index) => {
      // D содержит формулы счётчика, поэтому при поиске последней заявки её игнорируем.
      if ([row[0], row[1], row[2], row[4], row[5]].some((value) => String(value ?? "").trim() !== "")) {
        lastDataRow = index + 2;
      }
    });
    const firstRow = lastDataRow + 1;
    const lastRow = firstRow + items.length - 1;
    const dates = items.map(() => ["Запрос", order.id, formatter.format(new Date(order.createdAt))]);
    const days = items.map((_, index) => {
      const row = firstRow + index;
      return [`=IF(C${row}="";"";TODAY()-INT(C${row}))`];
    });
    const products = items.map((item) => [client, item.description]);
    const comments = items.map(() => [order.vehicleInfo ?? ""]);
    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: `'${escapedTitle}'!A${firstRow}:C${lastRow}`, values: dates },
          { range: `'${escapedTitle}'!D${firstRow}:D${lastRow}`, values: days },

        ],
      },
    });
    // Untrusted customer text must not be interpreted as spreadsheet formulas.
    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `'${escapedTitle}'!E${firstRow}:F${lastRow}`, values: products },
          { range: `'${escapedTitle}'!K${firstRow}:K${lastRow}`, values: comments },
        ],
      },
    });
  }
}
