import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OrderStatus = "new" | "processing" | "completed" | "cancelled";

export interface OrderItemInput {
  description: string;
  photoFileId?: string;
  documentFileId?: string;
  documentFileName?: string;
}

export interface NewOrder {
  telegramUserId: number;
  telegramUsername?: string;
  items: OrderItemInput[];
  vehicleInfo?: string;
  fullName: string;
  phone: string;
  city: string;
  consentAt: string;
}

export interface CustomerProfile {
  fullName: string;
  phone: string;
  city: string;
}

export interface OrderListItem {
  id: number;
  status: OrderStatus;
  createdAt: string;
  city: string;
  itemCount: number;
}

export interface ExportOrder {
  id: number;
  telegramUserId: number;
  telegramUsername?: string;
  status: OrderStatus;
  vehicleInfo?: string;
  fullName: string;
  phone: string;
  city: string;
  createdAt: string;
  adminMessageId?: number;
  adminMessageKind?: "text" | "caption";
  items: Array<OrderItemInput & { positionNumber: number }>;
}

export class OrderRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        telegram_username TEXT,
        request_text TEXT NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        city TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        position_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
    this.addColumnIfMissing("orders", "vehicle_info", "TEXT");
    this.addColumnIfMissing("orders", "consent_at", "TEXT");
    this.addColumnIfMissing("orders", "updated_at", "TEXT");
    this.addColumnIfMissing("orders", "admin_message_id", "INTEGER");
    this.addColumnIfMissing("orders", "admin_message_kind", "TEXT");
    this.addColumnIfMissing("order_items", "photo_file_id", "TEXT");
    this.addColumnIfMissing("order_items", "document_file_id", "TEXT");
    this.addColumnIfMissing("order_items", "document_file_name", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(telegram_user_id, created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)");
  }

  private addColumnIfMissing(table: "orders" | "order_items", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  canCreateOrder(telegramUserId: number): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM orders WHERE telegram_user_id = ? AND created_at >= ?")
      .get(telegramUserId, new Date(Date.now() - 3_600_000).toISOString()) as { total: number };
    return row.total < 5;
  }

  create(order: NewOrder): number {
    if (order.items.length < 1 || order.items.length > 10) throw new Error("Допускается от 1 до 10 позиций");
    if (!this.canCreateOrder(order.telegramUserId)) throw new Error("Лимит заказов в час");
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // request_text оставлен как сводное поле для совместимости со старой схемой.
      const requestText = order.items.map((item) => item.description).join("; ");
      const result = this.db.prepare(`
        INSERT INTO orders (
          telegram_user_id, telegram_username, request_text, vehicle_info,
          full_name, phone, city, consent_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        order.telegramUserId,
        order.telegramUsername ?? null,
        requestText,
        order.vehicleInfo ?? null,
        order.fullName,
        order.phone,
        order.city,
        order.consentAt,
        createdAt,
        createdAt,
      );
      const orderId = Number(result.lastInsertRowid);
      const insertItem = this.db.prepare(`
        INSERT INTO order_items (
          order_id, position_number, description, quantity, photo_file_id,
          document_file_id, document_file_name, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      `);
      order.items.forEach((item, index) => {
        insertItem.run(
          orderId,
          index + 1,
          item.description,
          item.photoFileId ?? null,
          item.documentFileId ?? null,
          item.documentFileName ?? null,
          createdAt,
        );
      });
      this.db.exec("COMMIT");
      return orderId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listByUser(telegramUserId: number, limit = 10): OrderListItem[] {
    return this.db.prepare(`
      SELECT o.id, o.status, o.created_at AS createdAt, o.city, COUNT(i.id) AS itemCount
      FROM orders o
      LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.telegram_user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT ?
    `).all(telegramUserId, limit).map((row) => {
      const value = row as Record<string, string | number>;
      return {
        id: Number(value.id),
        status: String(value.status) as OrderStatus,
        createdAt: String(value.createdAt),
        city: String(value.city),
        itemCount: Number(value.itemCount),
      };
    });
  }

  getLatestCustomerProfile(telegramUserId: number): CustomerProfile | undefined {
    const row = this.db.prepare(`
      SELECT full_name, phone, city
      FROM orders
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(telegramUserId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      fullName: String(row.full_name),
      phone: String(row.phone),
      city: String(row.city),
    };
  }

  getLatestVehicleInfo(telegramUserId: number): string | undefined {
    const row = this.db.prepare(`
      SELECT vehicle_info
      FROM orders
      WHERE telegram_user_id = ? AND vehicle_info IS NOT NULL AND TRIM(vehicle_info) <> ''
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(telegramUserId) as { vehicle_info: string } | undefined;
    return row?.vehicle_info ? String(row.vehicle_info) : undefined;
  }

  canAppend(orderId: number, telegramUserId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM orders
      WHERE id = ? AND telegram_user_id = ? AND status IN ('new', 'processing')
    `).get(orderId, telegramUserId);
    return row !== undefined;
  }

  appendItem(orderId: number, telegramUserId: number, item: OrderItemInput): boolean {
    if (!this.canAppend(orderId, telegramUserId)) return false;
    const count = this.db.prepare("SELECT COUNT(*) AS total FROM order_items WHERE order_id = ?").get(orderId) as { total: number };
    if (count.total >= 10) return false;
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const position = this.db.prepare(
        "SELECT COALESCE(MAX(position_number), 0) + 1 AS next FROM order_items WHERE order_id = ?",
      ).get(orderId) as { next: number };
      this.db.prepare(`
        INSERT INTO order_items (
          order_id, position_number, description, quantity, photo_file_id,
          document_file_id, document_file_name, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        orderId,
        position.next,
        item.description,
        item.photoFileId ?? null,
        item.documentFileId ?? null,
        item.documentFileName ?? null,
        createdAt,
      );
      this.db.prepare(`
        UPDATE orders
        SET request_text = request_text || '; ' || ?, updated_at = ?
        WHERE id = ? AND telegram_user_id = ?
      `).run(item.description, createdAt, orderId, telegramUserId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAdminMessage(orderId: number, messageId: number, kind: "text" | "caption"): void {
    this.db.prepare(`
      UPDATE orders SET admin_message_id = ?, admin_message_kind = ? WHERE id = ?
    `).run(messageId, kind, orderId);
  }

  getForExport(orderId: number, telegramUserId: number): ExportOrder | undefined {
    const order = this.db.prepare(`
      SELECT id, telegram_user_id, telegram_username, status, vehicle_info,
             full_name, phone, city, created_at, admin_message_id, admin_message_kind
      FROM orders WHERE id = ? AND telegram_user_id = ?
    `).get(orderId, telegramUserId) as Record<string, string | number | null> | undefined;
    if (!order) return undefined;
    const items = this.db.prepare(`
      SELECT position_number, description, photo_file_id, document_file_id, document_file_name
      FROM order_items WHERE order_id = ? ORDER BY position_number
    `).all(orderId) as Array<Record<string, string | number | null>>;
    return {
      id: Number(order.id),
      telegramUserId: Number(order.telegram_user_id),
      telegramUsername: order.telegram_username ? String(order.telegram_username) : undefined,
      status: String(order.status) as OrderStatus,
      vehicleInfo: order.vehicle_info ? String(order.vehicle_info) : undefined,
      fullName: String(order.full_name),
      phone: String(order.phone),
      city: String(order.city),
      createdAt: String(order.created_at),
      adminMessageId: order.admin_message_id ? Number(order.admin_message_id) : undefined,
      adminMessageKind: order.admin_message_kind === "caption" ? "caption" : order.admin_message_kind === "text" ? "text" : undefined,
      items: items.map((item) => ({
        positionNumber: Number(item.position_number),
        description: String(item.description),
        photoFileId: item.photo_file_id ? String(item.photo_file_id) : undefined,
        documentFileId: item.document_file_id ? String(item.document_file_id) : undefined,
        documentFileName: item.document_file_name ? String(item.document_file_name) : undefined,
      })),
    };
  }

  getForAdmin(orderId: number): ExportOrder | undefined {
    const row = this.db.prepare("SELECT telegram_user_id FROM orders WHERE id = ?").get(orderId) as { telegram_user_id: number } | undefined;
    return row ? this.getForExport(orderId, Number(row.telegram_user_id)) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
