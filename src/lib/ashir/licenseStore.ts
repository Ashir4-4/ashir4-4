/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs/promises";
import path from "path";
import { LicenseUser } from "./licenseTypes";

const LICENSE_DB_FILE = path.join(process.cwd(), "license_users.json");

/**
 * LicenseStore — لایه‌ی ذخیره‌سازی کاربران/اشتراک‌ها.
 *
 * همانند اسکنر اصلی (scanner.saveState) از یک فایل JSON روی دیسک به‌عنوان
 * پایگاه‌داده‌ی سبک استفاده می‌کند — بدون نیاز به نصب/راه‌اندازی SQLite یا
 * Postgres. برای استقرارهای بزرگ‌تر می‌توان بعداً به‌سادگی این کلاس را با
 * یک آداپتور Postgres جایگزین کرد، چون تمام دسترسی به داده از همین یک
 * کلاس عبور می‌کند (Repository Pattern).
 *
 * تمام نوشتن‌ها به‌صورت اتمیک (نوشتن در فایل موقت + rename) انجام می‌شود
 * تا کرش وسط نوشتن، فایل دیتابیس را خراب نکند.
 */
export class LicenseStore {
  private users = new Map<string, LicenseUser>();
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(LICENSE_DB_FILE, "utf-8");
      const parsed = JSON.parse(raw) as LicenseUser[];
      this.users = new Map(parsed.map((u) => [u.telegramId, u]));
    } catch {
      // فایل هنوز وجود ندارد (اولین اجرا) — شروع با دیتابیس خالی بی‌خطر است.
      this.users = new Map();
    }
    this.loaded = true;
  }

  private async _persist(): Promise<void> {
    // صف‌بندی نوشتن‌ها تا نوشتن‌های هم‌زمان چندگانه، فایل را خراب یا
    // race-condition ایجاد نکنند.
    this.saveQueue = this.saveQueue.then(async () => {
      const tmpFile = `${LICENSE_DB_FILE}.tmp`;
      const data = JSON.stringify(Array.from(this.users.values()), null, 2);
      await fs.writeFile(tmpFile, data, "utf-8");
      await fs.rename(tmpFile, LICENSE_DB_FILE);
    });
    await this.saveQueue;
  }

  get isLoaded() {
    return this.loaded;
  }

  getById(telegramId: string): LicenseUser | undefined {
    return this.users.get(String(telegramId));
  }

  /** جست‌وجوی کاربر بر اساس نام کاربری پنل وب (برای فرم ورود). */
  getByWebUsername(username: string): LicenseUser | undefined {
    const target = String(username).trim().toLowerCase();
    return this.getAll().find((u) => u.webUsername?.toLowerCase() === target);
  }

  getAll(): LicenseUser[] {
    return Array.from(this.users.values());
  }

  async upsert(user: LicenseUser): Promise<void> {
    user.updatedAt = Date.now();
    this.users.set(user.telegramId, user);
    await this._persist();
  }

  async delete(telegramId: string): Promise<void> {
    this.users.delete(String(telegramId));
    await this._persist();
  }

  // ─── کوئری‌های پرکاربرد ────────────────────────────────────────
  getPending(): LicenseUser[] {
    return this.getAll().filter((u) => u.status === "pending");
  }

  getActive(): LicenseUser[] {
    return this.getAll().filter((u) => u.status === "active");
  }

  getExpired(): LicenseUser[] {
    return this.getAll().filter((u) => u.status === "expired");
  }

  /** آمار کلی برای پنل ادمین */
  getStats() {
    const all = this.getAll();
    const active = all.filter((u) => u.status === "active").length;
    const expired = all.filter((u) => u.status === "expired").length;
    const pending = all.filter((u) => u.status === "pending").length;
    const banned = all.filter((u) => u.status === "banned").length;
    const totalRevenue = all.reduce((sum, u) => sum + (u.totalPaidToman || 0), 0);
    return { totalUsers: all.length, active, expired, pending, banned, totalRevenue };
  }
}

export const licenseStore = new LicenseStore();
