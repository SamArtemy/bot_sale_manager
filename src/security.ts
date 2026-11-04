/** Bounded idle-expiring storage: no background timers or unbounded user maps. */
export class ExpiringMap<T> {
  private readonly values = new Map<number, { value: T; expires: number }>();
  constructor(private readonly ttl: number, private readonly capacity = 10_000) {}
  get(key: number, now = Date.now()): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.values.delete(key);
      return undefined;
    }
    entry.expires = now + this.ttl;
    return entry.value;
  }
  set(key: number, value: T, now = Date.now()): void {
    if (!this.values.has(key) && this.values.size >= this.capacity) {
      for (const [id, entry] of this.values) if (entry.expires <= now) this.values.delete(id);
      if (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
    }
    this.values.set(key, { value, expires: now + this.ttl });
  }
  delete(key: number): void { this.values.delete(key); }
}

export class RateLimiter {
  private readonly buckets = new ExpiringMap<{ start: number; count: number }>(60_000);
  private global = { start: 0, count: 0 };
  allow(userId: number, now = Date.now()): boolean {
    if (now - this.global.start >= 60_000) this.global = { start: now, count: 0 };
    if (this.global.count >= 600) return false;
    this.global.count++;
    let bucket = this.buckets.get(userId, now);
    if (!bucket || now - bucket.start >= 60_000) {
      bucket = { start: now, count: 0 };
      this.buckets.set(userId, bucket, now);
    }
    return ++bucket.count <= 30;
  }
}

export function isAdmin(userId: number | undefined, chatId: number | undefined, adminChatId: number | undefined, adminUserIds: readonly number[]): boolean {
  return userId !== undefined && adminChatId !== undefined && chatId === adminChatId && adminUserIds.includes(userId);
}

/** Never log API error objects: they can contain tokens and customer payloads. */
export function logFailure(operation: string): void {
  console.error(`${operation}: сбой внешнего API или обработки данных; подробности скрыты для защиты секретов.`);
}
