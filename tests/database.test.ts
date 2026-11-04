import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OrderRepository } from "../src/database.js";

test("заказ сохраняется, отображается и дополняется только владельцем", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ae-parts-test-"));
  const repository = new OrderRepository(path.join(directory, "orders.sqlite3"));
  try {
    const orderId = repository.create({
      telegramUserId: 101,
      items: [{ description: "Фара 123-ABC" }, { description: "Крепление", photoFileId: "photo-1" }],
      vehicleInfo: "Toyota Camry 2020",
      fullName: "Иванов Иван",
      phone: "+79991234567",
      city: "Москва",
      consentAt: new Date().toISOString(),
    });

    assert.deepEqual(repository.listByUser(101).map(({ id, status, itemCount }) => ({ id, status, itemCount })), [
      { id: orderId, status: "new", itemCount: 2 },
    ]);
    assert.deepEqual(repository.getLatestCustomerProfile(101), {
      fullName: "Иванов Иван",
      phone: "+79991234567",
      city: "Москва",
    });
    assert.equal(repository.getLatestVehicleInfo(101), "Toyota Camry 2020");
    assert.equal(repository.getLatestVehicleInfo(999), undefined);
    assert.equal(repository.getLatestCustomerProfile(999), undefined);
    assert.equal(repository.appendItem(orderId, 999, { description: "Чужая позиция" }), false);
    assert.equal(repository.appendItem(orderId, 101, { description: "Дополнительная позиция" }), true);
    assert.equal(repository.listByUser(101)[0]?.itemCount, 3);
    repository.setAdminMessage(orderId, 777, "text");
    const exported = repository.getForExport(orderId, 101);
    assert.equal(exported?.adminMessageId, 777);
    assert.equal(exported?.adminMessageKind, "text");
    assert.equal(repository.getForAdmin(orderId)?.id, orderId);
    assert.deepEqual(exported?.items.map((item) => item.description), [
      "Фара 123-ABC",
      "Крепление",
      "Дополнительная позиция",
    ]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("чужие заказы недоступны для чтения, лимиты действуют и после открытия базы", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sale-limits-"));
  const databasePath = path.join(directory, "orders.sqlite3");
  let repository = new OrderRepository(databasePath);
  const order = {
    telegramUserId: 101,
    items: [{ description: "Позиция" }],
    fullName: "Иван Иванов", phone: "+79991234567", city: "Москва",
    consentAt: new Date().toISOString(),
  };
  try {
    const id = repository.create(order);
    assert.equal(repository.getForExport(id, 999), undefined);
    assert.deepEqual(repository.listByUser(999), []);
    for (let i = 0; i < 9; i++) assert.equal(repository.appendItem(id, 101, { description: "Позиция" }), true);
    assert.equal(repository.appendItem(id, 101, { description: "Лишняя" }), false);
    for (let i = 0; i < 4; i++) repository.create(order);
    repository.close();
    repository = new OrderRepository(databasePath);
    assert.equal(repository.canCreateOrder(101), false);
    assert.throws(() => repository.create(order), /Лимит/);
    assert.equal(repository.canCreateOrder(999), true);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
