import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBranding } from "../src/branding.js";

test("public defaults contain no support identity and do not read local environment", () => {
  const branding = loadBranding({});
  assert.equal(branding.shopName, "Магазин");
  assert.equal(branding.supportUsername, undefined);
  assert.equal(branding.timeZone, "UTC");
});

test("branding accepts deployment-specific values and normalizes username", () => {
  const branding = loadBranding({ SHOP_NAME: " Demo Shop ", SUPPORT_TELEGRAM_USERNAME: " @sample_shop ", DELIVERY_TERMS: "По согласованию", CONSENT_TEXT: "Согласие на обработку", TIME_ZONE: "Asia/Tokyo" });
  assert.deepEqual(branding, { shopName: "Demo Shop", supportUsername: "sample_shop", deliveryTerms: "По согласованию", consentText: "Согласие на обработку", timeZone: "Asia/Tokyo" });
});

test("invalid links, oversized messages and invalid timezones are rejected without echoing values", () => {
  assert.throws(() => loadBranding({ SUPPORT_TELEGRAM_USERNAME: "https://example.invalid" }), /SUPPORT_TELEGRAM_USERNAME/);
  assert.throws(() => loadBranding({ TIME_ZONE: "invalid-zone" }), /TIME_ZONE/);
  assert.throws(() => loadBranding({ SHOP_NAME: "x".repeat(121) }), /SHOP_NAME/);
  assert.throws(() => loadBranding({ DELIVERY_TERMS: "x".repeat(601) }), /DELIVERY_TERMS/);
  assert.throws(() => loadBranding({ CONSENT_TEXT: "x".repeat(2001) }), /CONSENT_TEXT/);
});
