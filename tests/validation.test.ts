import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, normalizePhone, validCity, validName, validRequest, validVehicleInfo } from "../src/validation.js";

test("cleanText схлопывает пробелы", () => {
  assert.equal(cleanText("  колодки\n Kia  "), "колодки Kia");
});

test("normalizePhone нормализует и проверяет телефон", () => {
  assert.equal(normalizePhone("+7 (999) 123-45-67"), "+79991234567");
  assert.equal(normalizePhone("123"), undefined);
});

test("валидаторы принимают корректные поля", () => {
  assert.equal(validRequest("55110-4L000"), true);
  assert.equal(validName("Иванов Иван"), true);
  assert.equal(validCity("Ростов-на-Дону"), true);
  assert.equal(validVehicleInfo("Toyota Camry, VIN JTNB11HK7K3001234"), true);
  assert.equal(validVehicleInfo("Toyota Camry без VIN"), false);
  assert.equal(validVehicleInfo("VIN JTNB11HK7K300I234"), false);
});
