export interface BotBranding {
  shopName: string;
  supportUsername?: string;
  deliveryTerms: string;
  consentText: string;
  timeZone: string;
}

/** Public defaults must never identify a particular deployment or its owner. */
export function loadBranding(env: NodeJS.ProcessEnv = process.env): BotBranding {
  const text = (key: string, fallback: string, max: number): string => {
    const value = env[key]?.trim() || fallback;
    if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error(`${key}: недопустимая длина или управляющие символы`);
    }
    return value;
  };
  const supportUsername = env.SUPPORT_TELEGRAM_USERNAME?.trim().replace(/^@/, "") || undefined;
  if (supportUsername && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(supportUsername)) {
    throw new Error("SUPPORT_TELEGRAM_USERNAME: укажите Telegram username без URL");
  }
  const timeZone = env.TIME_ZONE?.trim() || "UTC";
  try { new Intl.DateTimeFormat("ru-RU", { timeZone }); }
  catch { throw new Error("TIME_ZONE: укажите корректный часовой пояс IANA"); }
  return {
    shopName: text("SHOP_NAME", "Магазин", 120),
    supportUsername,
    deliveryTerms: text("DELIVERY_TERMS", "Условия и сроки доставки уточнит менеджер.", 600),
    consentText: text("CONSENT_TEXT", "Для оформления заявки бот сохранит ваше ФИО, телефон, город, Telegram ID и сведения о заказе. Данные используются для обработки заказа и связи с вами. Вы согласны на их обработку?", 2000),
    timeZone,
  };
}
