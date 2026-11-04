import assert from "node:assert/strict";
import { test } from "node:test";
import { createBot } from "../src/bot.js";
import { OrderRepository } from "../src/database.js";

test("customer callbacks in groups cannot read saved contacts; private callbacks verify order ownership", async () => {
  const repository = new OrderRepository(":memory:");
  const id = repository.create({ telegramUserId: 101, fullName: "Иван Иванов", phone: "+79991234567", city: "Москва", items: [{ description: "Секретная позиция" }], consentAt: new Date().toISOString() });
  const bot = createBot("123456:test-token", repository);
  bot.botInfo = { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const calls: Array<{ method: string; payload: unknown }> = [];
  bot.api.config.use(async (previous, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: true } as Awaited<ReturnType<typeof previous>>;
  });
  try {
    await bot.handleUpdate({ update_id: 1, callback_query: {
      id: "group", from: { id: 101, is_bot: false, first_name: "User" }, chat_instance: "test", data: "category_auto",
      message: { message_id: 1, date: 1, chat: { id: -100, type: "supergroup", title: "Group" }, text: "Button" },
    } });
    assert.equal(calls.length, 0);
    await bot.handleUpdate({ update_id: 2, callback_query: {
      id: "private", from: { id: 999, is_bot: false, first_name: "Other" }, chat_instance: "test", data: `order_view:${id}`,
      message: { message_id: 2, date: 1, chat: { id: 999, type: "private", first_name: "Other" }, text: "Button" },
    } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "answerCallbackQuery");
    assert.equal(JSON.stringify(calls).includes("Секретная позиция"), false);
    assert.equal(JSON.stringify(calls).includes("Заказ не найден"), true);
  } finally { repository.close(); }
});

test("each bot instance uses its own branding and hides unset support", async () => {
  const { loadBranding } = await import("../src/branding.js");
  const repository = new OrderRepository(":memory:");
  try {
    for (const custom of [true, false]) {
      const branding = loadBranding(custom ? { SHOP_NAME: "Demo Shop", SUPPORT_TELEGRAM_USERNAME: "sample_shop", CONSENT_TEXT: "Custom consent" } : {});
      const bot = createBot("123456:test-token", repository, undefined, undefined, undefined, undefined, [], branding);
      bot.botInfo = { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
      const replies: unknown[] = [];
      bot.api.config.use(async (previous, method, payload) => {
        if (method === "sendMessage") replies.push(payload);
        return { ok: true, result: true } as Awaited<ReturnType<typeof previous>>;
      });
      for (const [i, command] of ["/start", "/new"].entries()) {
        await bot.handleUpdate({ update_id: i + 1, message: { message_id: i + 1, date: 1, from: { id: 101, is_bot: false, first_name: "User" }, chat: { id: 101, type: "private", first_name: "User" }, text: command, entities: [{ type: "bot_command", offset: 0, length: command.length }] } });
      }
      const output = JSON.stringify(replies);
      assert.equal(output.includes("https://t.me/sample_shop"), custom);
      assert.equal(output.includes("Demo Shop"), custom);
      assert.equal(output.includes("Custom consent"), custom);
      if (!custom) assert.equal(output.includes("https://t.me/"), false);
    }
  } finally { repository.close(); }
});
