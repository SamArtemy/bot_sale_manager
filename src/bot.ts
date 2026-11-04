import { loadBranding, type BotBranding } from "./branding.js";
import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import type { ExportOrder, OrderItemInput, OrderRepository, OrderStatus } from "./database.js";
import type { GoogleSheetsOrderSink } from "./googleSheets.js";
import type { GoogleTasksOrderSink } from "./googleTasks.js";
import { cleanText, normalizePhone, validCity, validName, validRequest, validVehicleInfo } from "./validation.js";

import { ExpiringMap, RateLimiter, isAdmin, logFailure } from "./security.js";

type NewOrderStep = "consent" | "category" | "vehicleChoice" | "request" | "moreItems" | "vehicle" | "contactChoice" | "name" | "phone" | "city" | "confirmation";
interface NewOrderDraft {
  kind: "new";
  step: NewOrderStep;
  items: OrderItemInput[];
  vehicleInfo?: string;
  fullName?: string;
  phone?: string;
  city?: string;
  consentAt?: string;
}
interface AppendDraft {
  kind: "append";
  step: "orderId" | "item";
  orderId?: number;
}
type Draft = NewOrderDraft | AppendDraft;

export function createBot(
  token: string,
  repository: OrderRepository,
  adminChatId?: number,
  adminMessageThreadId?: number,
  sheetsSink?: GoogleSheetsOrderSink,
  tasksSink?: GoogleTasksOrderSink,
  adminUserIds: readonly number[] = [],
  branding: BotBranding = loadBranding({}),
): Bot {
  const drafts = new ExpiringMap<Draft>(30 * 60_000);
  const mainKeyboard = new InlineKeyboard()
    .text("🆕 Новый заказ", "new_order").text("📋 Мои заказы", "my_orders").row()
    .text("➕ Дополнить заказ", "append_order").text("ℹ️ Помощь", "help");
  if (branding.supportUsername) mainKeyboard.row().url("💬 Обратная связь", `https://t.me/${branding.supportUsername}`);
  const supportText = branding.supportUsername ? `Поддержка: @${branding.supportUsername}` : "";
  const consentKeyboard = new InlineKeyboard().text("✅ Согласен", "consent_yes").text("❌ Отмена", "consent_cancel");
  const categoryKeyboard = new InlineKeyboard().text("🚗 Автозапчасть", "category_auto").text("🛍 Другой товар", "category_other");
  const savedVehicleKeyboard = new InlineKeyboard().text("✅ Использовать этот автомобиль", "vehicle_saved").row().text("✏️ Ввести другой VIN и автомобиль", "vehicle_new");
  const savedContactKeyboard = new InlineKeyboard().text("✅ Использовать мои данные", "contact_saved").row().text("✏️ Ввести заново", "contact_new");
  const confirmKeyboard = new InlineKeyboard().text("✅ Подтвердить", "order_confirm").text("🔄 Заполнить заново", "order_restart");
  const moreItemsKeyboard = new InlineKeyboard().text("➕ Добавить позицию", "item_add").text("➡️ Продолжить", "items_continue");

  const statusLabels: Record<OrderStatus, string> = {
    new: "Новый",
    processing: "В работе",
    completed: "Завершён",
    cancelled: "Отменён",
  };

  function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: branding.timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function extractItem(ctx: Context): OrderItemInput | undefined {
    const message = ctx.message;
    if (!message) return undefined;
    const description = cleanText(message.text ?? message.caption);
    if (!validRequest(description)) return undefined;
    const photoFileId = message.photo?.at(-1)?.file_id;
    const documentFileId = message.document?.file_id;
    const documentFileName = message.document?.file_name;
    return { description, photoFileId, documentFileId, documentFileName };
  }

  function summary(draft: NewOrderDraft): string {
    const positions = draft.items
      .map((item, index) => `${index + 1}. <b>${escapeHtml(item.description)}</b>${item.photoFileId ? " 📷" : ""}${item.documentFileId ? ` 📎 ${escapeHtml(item.documentFileName ?? "файл")}` : ""}`)
      .join("\n");
    return [
      "Проверьте заявку:",
      "",
      "Позиции:",
      positions,
      draft.vehicleInfo ? `Автомобиль и VIN: <b>${escapeHtml(draft.vehicleInfo)}</b>` : "Автомобиль и VIN: <i>не требуется</i>",
      `ФИО: <b>${escapeHtml(draft.fullName!)}</b>`,
      `Телефон: <b>${escapeHtml(draft.phone!)}</b>`,
      `Город: <b>${escapeHtml(draft.city!)}</b>`,
      "",
      escapeHtml(branding.deliveryTerms),
    ].join("\n");
  }

  function orderDetails(order: ExportOrder, includeContacts = false): string {
    const positions = order.items
      .map((item) => `${item.positionNumber}. <b>${escapeHtml(item.description)}</b>${item.photoFileId ? " 📷" : ""}${item.documentFileId ? ` 📎 ${escapeHtml(item.documentFileName ?? "файл")}` : ""}`)
      .join("\n");
    const lines = [
      `<b>Заказ №${order.id}</b> · ${statusLabels[order.status]}`,
      `Дата: ${formatDate(order.createdAt)}`,
      "",
      "<b>Позиции:</b>",
      positions,
      order.vehicleInfo ? `Автомобиль и VIN: <b>${escapeHtml(order.vehicleInfo)}</b>` : "Автомобиль и VIN: <i>не требуется</i>",
    ];
    if (includeContacts) {
      const telegram = order.telegramUsername ? `@${escapeHtml(order.telegramUsername)}` : "<i>username не указан</i>";
      lines.push(
        `Telegram: <b>${telegram}</b>`,
        `ФИО: <b>${escapeHtml(order.fullName)}</b>`,
        `Телефон: <b>${escapeHtml(order.phone)}</b>`,
        `Город: <b>${escapeHtml(order.city)}</b>`,
      );
    }
    return lines.join("\n");
  }

  // Split complete rendered text; never cut an HTML tag or Telegram entity.
  function plainChunks(html: string): string[] {
    const plain = html.replace(/<\/?(?:b|i)>/g, "")
      .replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
    const chars = Array.from(plain);
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += 1700) chunks.push(chars.slice(i, i + 1700).join(""));
    return chunks;
  }

  async function replyDetails(ctx: Context, html: string, keyboard: InlineKeyboard): Promise<void> {
    const chunks = plainChunks(html);
    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(chunks[i]!, i === chunks.length - 1 ? { reply_markup: keyboard } : {});
    }
  }

  async function showMenu(ctx: Context): Promise<void> {
    await ctx.reply(
      `Здравствуйте! 👋 Это бот магазина «${branding.shopName}».\n\nПомогу оформить заказ на автозапчасти и другие товары. Выберите нужное действие ниже.${supportText ? `\n\n${supportText}` : ""}`,
      { reply_markup: mainKeyboard },
    );
  }

  async function beginOrder(ctx: Context): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    drafts.set(ctx.from.id, { kind: "new", step: "consent", items: [] });
    await ctx.reply(
      branding.consentText,
      { reply_markup: consentKeyboard },
    );
  }

  async function showOrders(ctx: Context, repository: OrderRepository): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    const orders = repository.listByUser(ctx.from.id);
    if (orders.length === 0) {
      await ctx.reply("У вас пока нет оформленных заказов.", { reply_markup: mainKeyboard });
      return;
    }
    const lines = orders.map((order) =>
      `№${order.id} · ${statusLabels[order.status]} · ${order.itemCount} поз. · ${escapeHtml(order.city)} · ${formatDate(order.createdAt)}`,
    );
    const keyboard = new InlineKeyboard();
    orders.forEach((order) => keyboard.text(`📦 Посмотреть заказ №${order.id}`, `order_view:${order.id}`).row());
    keyboard.text("⬅️ Главное меню", "menu");
    await ctx.reply(`<b>Ваши последние заказы:</b>\n\n${lines.join("\n")}\n\nНажмите на заказ, чтобы увидеть его содержимое.`, { parse_mode: "HTML", reply_markup: keyboard });
  }

  async function beginAppend(ctx: Context): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    drafts.set(ctx.from.id, { kind: "append", step: "orderId" });
    await ctx.reply("Введите номер заказа, который хотите дополнить. Дополнять можно заказы со статусом «Новый» или «В работе». Чтобы выйти, нажмите /cancel.", { reply_markup: { remove_keyboard: true } });
  }

  async function showHelp(ctx: Context): Promise<void> {
    await ctx.reply(`Для автозапчастей подготовьте VIN (обязательно), марку и модель автомобиля, партномер, фото или файл. Для других товаров — например, шлема или очков — VIN не требуется. В один заказ можно добавить несколько позиций.\n\n/start — главное меню\n/new — новый заказ\n/orders — мои заказы\n/cancel — отмена${supportText ? `\n\n${supportText}` : ""}`, { reply_markup: mainKeyboard });
  }

  const bot = new Bot(token);
  const limiter = new RateLimiter();
  bot.use(async (ctx, next) => {
    if (!ctx.from || !limiter.allow(ctx.from.id)) return;
    // Customer callbacks must never reveal saved profiles in a group.
    if (ctx.chat?.type !== "private") {
      const command = ctx.message?.text?.split(/\s/)[0]?.split("@")[0];
      if (command !== "/chatid" && command !== "/bindorder") return;
    }
    await next();
  });

  const adminOrderText = (order: ExportOrder): string => `${orderDetails(order, true)}\n\n${escapeHtml(branding.deliveryTerms)}`;

  const sendAdminOrder = async (ctx: Context, order: ExportOrder): Promise<void> => {
    if (!adminChatId) return;
    const chunks = plainChunks(adminOrderText(order));
    let firstMessageId: number | undefined;
    for (const text of chunks) {
      const sent = await ctx.api.sendMessage(adminChatId, text, { message_thread_id: adminMessageThreadId });
      firstMessageId ??= sent.message_id;
    }
    repository.setAdminMessage(order.id, firstMessageId!, "text");
    for (const item of order.items) {
      const caption = `Заказ №${order.id} · позиция ${item.positionNumber}`;
      if (item.photoFileId) await ctx.api.sendPhoto(adminChatId, item.photoFileId, { caption, message_thread_id: adminMessageThreadId });
      if (item.documentFileId) await ctx.api.sendDocument(adminChatId, item.documentFileId, { caption, message_thread_id: adminMessageThreadId });
    }
  };

  const refreshAdminOrder = async (ctx: Context, order: ExportOrder, appendedItem: OrderItemInput): Promise<void> => {
    if (!adminChatId) return;
    if (!order.adminMessageId || order.adminMessageKind !== "text") {
      await sendAdminOrder(ctx, order);
      return;
    }
    const chunks = plainChunks(adminOrderText(order));
    await ctx.api.editMessageText(adminChatId, order.adminMessageId, chunks[0]!);
    for (const text of chunks.slice(1)) await ctx.api.sendMessage(adminChatId, text, { message_thread_id: adminMessageThreadId });
    const caption = `Заказ №${order.id} · новая позиция ${order.items.length}`;
    if (appendedItem.photoFileId) await ctx.api.sendPhoto(adminChatId, appendedItem.photoFileId, { caption, message_thread_id: adminMessageThreadId });
    if (appendedItem.documentFileId) await ctx.api.sendDocument(adminChatId, appendedItem.documentFileId, { caption, message_thread_id: adminMessageThreadId });
  };

  const continueAfterItems = async (ctx: Context, draft: NewOrderDraft): Promise<void> => {
    const userId = ctx.from!.id;
    const savedProfile = repository.getLatestCustomerProfile(userId);
    if (savedProfile) {
      draft.fullName = savedProfile.fullName;
      draft.phone = savedProfile.phone;
      draft.city = savedProfile.city;
      draft.step = "contactChoice";
      await ctx.reply(
        `Использовать данные из прошлого заказа?\n\nФИО: ${savedProfile.fullName}\nТелефон: ${savedProfile.phone}\nГород: ${savedProfile.city}`,
        { reply_markup: savedContactKeyboard },
      );
    } else {
      draft.step = "name";
      await ctx.reply("Укажите ваши ФИО.", { reply_markup: { remove_keyboard: true } });
    }
  };

  const completeOrder = async (ctx: Context, draft: NewOrderDraft): Promise<void> => {
    const userId = ctx.from!.id;
    if (!repository.canCreateOrder(userId)) {
      await ctx.reply("Лимит: не более 5 заказов в час. Попробуйте позже или свяжитесь с менеджером.");
      return;
    }
    drafts.delete(userId);
    const orderId = repository.create({
      telegramUserId: userId,
      telegramUsername: ctx.from!.username,
      items: draft.items,
      vehicleInfo: draft.vehicleInfo,
      fullName: draft.fullName!,
      phone: draft.phone!,
      city: draft.city!,
      consentAt: draft.consentAt!,
    });
    await ctx.reply(
      `Спасибо! Заказ №${orderId} принят. Менеджер свяжется с вами.\n\n${branding.deliveryTerms}`,
      { reply_markup: mainKeyboard },
    );
    const exportOrder = repository.getForExport(orderId, userId);
    if (sheetsSink && exportOrder) {
      await sheetsSink.appendOrder(exportOrder).catch((error: unknown) => {
        logFailure("Не удалось записать заказ в Google Sheets:");
      });
    }
    if (tasksSink && exportOrder) {
      await tasksSink.createOrder(exportOrder).catch((error: unknown) => {
        logFailure("Не удалось создать карточку Google Tasks:");
      });
    }
    if (exportOrder) await sendAdminOrder(ctx, exportOrder);
  };

  bot.command("start", async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    drafts.delete(ctx.from.id);
    await showMenu(ctx);
  });
  bot.command("new", beginOrder);
  bot.command("orders", (ctx) => showOrders(ctx, repository));
  bot.command("myid", async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`);
  });
  bot.command("chatid", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    await ctx.reply(
      threadId === undefined
        ? `ID этого чата: ${ctx.chat.id}\nID темы: не определён (команда отправлена не внутри темы)`
        : `ID этого чата: ${ctx.chat.id}\nID этой темы: ${threadId}`,
    );
  });
  bot.command("bindorder", async (ctx) => {
    if (!adminChatId || !isAdmin(ctx.from?.id, ctx.chat.id, adminChatId, adminUserIds)) return;
    const orderId = Number(ctx.match.trim());
    const target = ctx.message?.reply_to_message;
    const order = Number.isSafeInteger(orderId) && orderId > 0 ? repository.getForAdmin(orderId) : undefined;
    if (!target || !order) {
      await ctx.reply("Ответьте этой командой на исходную карточку: /bindorder 29", { message_thread_id: adminMessageThreadId });
      return;
    }
    if (target.from?.id !== ctx.me.id) return;
    const kind: "text" | "caption" = "caption" in target ? "caption" : "text";
    const chunks = plainChunks(adminOrderText(order));
    if (kind === "caption" && chunks.join("").length > 900) {
      await sendAdminOrder(ctx, order);
    } else {
      if (kind === "caption") {
        await ctx.api.editMessageCaption(adminChatId, target.message_id, { caption: chunks[0]! });
      } else {
        await ctx.api.editMessageText(adminChatId, target.message_id, chunks[0]!);
        for (const text of chunks.slice(1)) await ctx.api.sendMessage(adminChatId, text, { message_thread_id: adminMessageThreadId });
      }
      repository.setAdminMessage(orderId, target.message_id, kind);
    }
    await ctx.deleteMessage().catch(() => undefined);
  });
  bot.command("cancel", async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    drafts.delete(ctx.from.id);
    await ctx.reply("Текущее действие отменено.", { reply_markup: mainKeyboard });
  });

  bot.callbackQuery("new_order", async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginOrder(ctx);
  });
  bot.callbackQuery("my_orders", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showOrders(ctx, repository);
  });
  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMenu(ctx);
  });
  bot.callbackQuery(/^order_view:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const order = repository.getForExport(orderId, ctx.from.id);
    if (!order) return ctx.answerCallbackQuery({ text: "Заказ не найден" });
    await ctx.answerCallbackQuery();
    await replyDetails(ctx, orderDetails(order), new InlineKeyboard().text("📋 Все заказы", "my_orders").text("⬅️ Главное меню", "menu"));
  });
  bot.callbackQuery("append_order", async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginAppend(ctx);
  });
  bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
  });
  bot.callbackQuery("consent_yes", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "consent") return ctx.answerCallbackQuery({ text: "Начните новый заказ через меню" });
    await ctx.answerCallbackQuery();
    draft.consentAt = new Date().toISOString();
    draft.step = "category";
    await ctx.reply("Что вы хотите заказать?", { reply_markup: categoryKeyboard });
  });
  bot.callbackQuery("consent_cancel", async (ctx) => {
    drafts.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply("Оформление отменено.", { reply_markup: mainKeyboard });
  });
  bot.callbackQuery("category_auto", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "category") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    const savedVehicle = repository.getLatestVehicleInfo(ctx.from.id);
    if (savedVehicle) {
      draft.vehicleInfo = savedVehicle;
      draft.step = "vehicleChoice";
      await ctx.reply(`Использовать автомобиль из прошлого заказа?\n\n<b>${escapeHtml(savedVehicle)}</b>`, { parse_mode: "HTML", reply_markup: savedVehicleKeyboard });
    } else {
      draft.step = "vehicle";
      await ctx.reply("Для точного подбора подготовьте:\n\n✅ VIN автомобиля — обязательно (17 символов)\n✅ Марку и модель автомобиля\n✅ Партномер детали — если известен\n✅ Фото или файл — желательно\n\nСначала отправьте VIN, марку и модель автомобиля одним сообщением.");
    }
  });
  bot.callbackQuery("vehicle_saved", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "vehicleChoice" || !draft.vehicleInfo) return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.step = "request";
    await ctx.reply("Автомобиль выбран. Теперь опишите деталь, укажите партномер, если известен, или отправьте фото/файл с описанием.");
  });
  bot.callbackQuery("vehicle_new", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "vehicleChoice") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.vehicleInfo = undefined;
    draft.step = "vehicle";
    await ctx.reply("Отправьте новый VIN, марку и модель автомобиля одним сообщением. VIN обязателен и должен содержать 17 символов.");
  });
  bot.callbackQuery("category_other", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "category") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.vehicleInfo = undefined;
    draft.step = "request";
    await ctx.reply("Опишите товар, который хотите заказать. Можно отправить фото или файл с описанием в подписи.");
  });
  bot.callbackQuery("item_add", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "moreItems") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.step = "request";
    await ctx.reply("Опишите следующую позицию, пришлите партномер, фото или файл с подписью.");
  });
  bot.callbackQuery("items_continue", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "moreItems") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    await continueAfterItems(ctx, draft);
  });
  bot.callbackQuery("contact_saved", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "contactChoice") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.step = "confirmation";
    await replyDetails(ctx, summary(draft), confirmKeyboard);
  });
  bot.callbackQuery("contact_new", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "contactChoice") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    draft.fullName = undefined;
    draft.phone = undefined;
    draft.city = undefined;
    draft.step = "name";
    await ctx.reply("Укажите ваши ФИО.");
  });
  bot.callbackQuery("order_restart", async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginOrder(ctx);
  });
  bot.callbackQuery("order_confirm", async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.kind !== "new" || draft.step !== "confirmation") return ctx.answerCallbackQuery({ text: "Кнопка уже неактуальна" });
    await ctx.answerCallbackQuery();
    await completeOrder(ctx, draft);
  });

  bot.on("message", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const userId = ctx.from.id;
    const text = cleanText(ctx.message.text);
    let draft = drafts.get(userId);

    if (!draft) {
      if (text === "🆕 Новый заказ") return beginOrder(ctx);
      if (text === "📋 Мои заказы") return showOrders(ctx, repository);
      if (text === "➕ Дополнить заказ") return beginAppend(ctx);
      if (text === "ℹ️ Помощь") return showHelp(ctx);
      await showMenu(ctx);
      return;
    }

    if (draft.kind === "append") {
      if (draft.step === "orderId") {
        const orderId = Number(text.replace(/^№/, ""));
        if (!Number.isSafeInteger(orderId) || orderId < 1 || !repository.canAppend(orderId, userId)) {
          await ctx.reply("Не нашёл доступный заказ с таким номером. Проверьте номер через /orders и попробуйте ещё раз.");
          return;
        }
        draft.orderId = orderId;
        draft.step = "item";
        await ctx.reply("Опишите дополнительную позицию или отправьте фото/файл с описанием в подписи.");
        return;
      }
      const item = extractItem(ctx);
      if (!item) {
        await ctx.reply("Пришлите описание от 3 до 1000 символов. Для фото или файла добавьте подпись с названием детали или партномером.");
        return;
      }
      const added = repository.appendItem(draft.orderId!, userId, item);
      drafts.delete(userId);
      if (!added) {
        await ctx.reply(`Заказ уже нельзя дополнить. Оформите новый заказ.${supportText ? ` ${supportText}` : ""}`, { reply_markup: mainKeyboard });
        return;
      }
      await ctx.reply(`Позиция добавлена в заказ №${draft.orderId}. Менеджер увидит дополнение.`, { reply_markup: mainKeyboard });
      const exportOrder = repository.getForExport(draft.orderId!, userId);
      const appendedPosition = exportOrder?.items.at(-1)?.positionNumber;
      if (sheetsSink && exportOrder && appendedPosition) {
        await sheetsSink.appendOrder(exportOrder, appendedPosition).catch((error: unknown) => {
          logFailure("Не удалось записать дополнение в Google Sheets:");
        });
      }
      if (exportOrder) {
        await refreshAdminOrder(ctx, exportOrder, item).catch((error: unknown) => {
          logFailure("Не удалось обновить заказ в Telegram:");
        });
      }
      return;
    }

    if (draft.step === "consent") {
      if (text === "❌ Отмена") {
        drafts.delete(userId);
        await ctx.reply("Оформление отменено.", { reply_markup: mainKeyboard });
        return;
      }
      if (text !== "✅ Согласен") {
        await ctx.reply("Для продолжения нажмите «Согласен» или «Отмена».");
        return;
      }
      draft.consentAt = new Date().toISOString();
      draft.step = "category";
      await ctx.reply("Что вы хотите заказать?", { reply_markup: categoryKeyboard });
      return;
    }

    if (draft.step === "vehicleChoice") {
      await ctx.reply("Выберите кнопкой: использовать сохранённый автомобиль или ввести другой.", { reply_markup: savedVehicleKeyboard });
      return;
    }

    if (draft.step === "category") {
      if (text === "🚗 Автозапчасть") {
        draft.step = "vehicle";
        await ctx.reply(
          "Для точного подбора подготовьте:\n\n✅ VIN автомобиля — обязательно (17 символов)\n✅ Марку и модель автомобиля\n✅ Партномер детали — если известен\n✅ Фото или файл — желательно\n\nСначала отправьте VIN, марку и модель автомобиля одним сообщением.",
          { reply_markup: { remove_keyboard: true } },
        );
        return;
      }
      if (text === "🛍 Другой товар") {
        draft.vehicleInfo = undefined;
        draft.step = "request";
        await ctx.reply("Опишите товар, который хотите заказать. Можно отправить фото или файл с описанием в подписи.", { reply_markup: { remove_keyboard: true } });
        return;
      }
      await ctx.reply("Выберите «Автозапчасть» или «Другой товар» с помощью кнопок.");
      return;
    }

    if (draft.step === "vehicle") {
      if (!validVehicleInfo(text)) {
        await ctx.reply("VIN обязателен. Отправьте VIN из 17 латинских букв и цифр вместе с маркой и моделью автомобиля. Буквы I, O и Q в VIN не используются.");
        return;
      }
      draft.vehicleInfo = text;
      draft.step = "request";
      await ctx.reply("Теперь опишите первую деталь: укажите партномер, если он известен, и название. Можно отправить фото или файл с описанием в подписи.");
      return;
    }

    if (draft.step === "request") {
      const item = extractItem(ctx);
      if (!item) {
        await ctx.reply("Опишите запрос подробнее (от 3 до 1000 символов). Для фото или файла обязательно добавьте подпись.");
        return;
      }
      if (draft.items.length >= 10) {
        await ctx.reply("В одной заявке допускается до 10 позиций. Нажмите «Продолжить».", { reply_markup: moreItemsKeyboard });
        draft.step = "moreItems";
        return;
      }
      draft.items.push(item);
      draft.step = "moreItems";
      await ctx.reply("Позиция добавлена. Нужно добавить что-нибудь ещё?", { reply_markup: moreItemsKeyboard });
      return;
    }

    if (draft.step === "moreItems") {
      if (text === "➕ Добавить позицию") {
        draft.step = "request";
        await ctx.reply("Опишите следующую позицию, пришлите партномер, фото или файл с подписью.", { reply_markup: { remove_keyboard: true } });
        return;
      }
      if (text !== "➡️ Продолжить") {
        await ctx.reply("Нажмите «Добавить позицию» или «Продолжить».");
        return;
      }
      const savedProfile = repository.getLatestCustomerProfile(userId);
      if (savedProfile) {
        draft.fullName = savedProfile.fullName;
        draft.phone = savedProfile.phone;
        draft.city = savedProfile.city;
        draft.step = "contactChoice";
        await ctx.reply(
          `Использовать данные из прошлого заказа?\n\nФИО: ${savedProfile.fullName}\nТелефон: ${savedProfile.phone}\nГород: ${savedProfile.city}`,
          { reply_markup: savedContactKeyboard },
        );
      } else {
        draft.step = "name";
        await ctx.reply("Укажите ваши ФИО.", { reply_markup: { remove_keyboard: true } });
      }
      return;
    }

    if (draft.step === "contactChoice") {
      if (text === "✅ Использовать мои данные") {
        draft.step = "confirmation";
        await replyDetails(ctx, summary(draft), confirmKeyboard);
        return;
      }
      if (text === "✏️ Ввести заново") {
        draft.fullName = undefined;
        draft.phone = undefined;
        draft.city = undefined;
        draft.step = "name";
        await ctx.reply("Укажите ваши ФИО.", { reply_markup: { remove_keyboard: true } });
        return;
      }
      await ctx.reply("Нажмите «Использовать мои данные» или «Ввести заново».");
      return;
    }

    if (draft.step === "name") {
      if (!validName(text)) {
        await ctx.reply("Пожалуйста, укажите корректные ФИО.");
        return;
      }
      draft.fullName = text;
      draft.step = "phone";
      await ctx.reply("Введите номер телефона или отправьте его кнопкой ниже.", {
        reply_markup: new Keyboard().requestContact("Отправить мой номер").resized().oneTime(),
      });
      return;
    }

    if (draft.step === "phone") {
      const contact = ctx.message.contact;
      if (contact?.user_id !== undefined && contact.user_id !== userId) {
        await ctx.reply("Пожалуйста, отправьте именно свой контакт.");
        return;
      }
      const phone = normalizePhone(contact?.phone_number ?? text);
      if (!phone) {
        await ctx.reply("Введите телефон из 10–15 цифр, например +79991234567.");
        return;
      }
      draft.phone = phone;
      draft.step = "city";
      await ctx.reply("В какой город нужна отправка?", { reply_markup: { remove_keyboard: true } });
      return;
    }

    if (draft.step === "city") {
      if (!validCity(text)) {
        await ctx.reply("Укажите корректное название города.");
        return;
      }
      draft.city = text;
      draft.step = "confirmation";
      await replyDetails(ctx, summary(draft), confirmKeyboard);
      return;
    }

    if (text === "🔄 Заполнить заново") return beginOrder(ctx);
    if (text !== "✅ Подтвердить") {
      await ctx.reply("Нажмите «Подтвердить» или «Заполнить заново».");
      return;
    }

    await completeOrder(ctx, draft);
    return;
  });

  bot.catch(() => logFailure("Ошибка обработки Telegram update"));
  return bot;
}
