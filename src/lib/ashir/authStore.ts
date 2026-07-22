/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs/promises";
import path from "path";
import { hashPassword, verifyPassword } from "./authUtils";

const AUTH_FILE = path.join(process.cwd(), "web_admin_auth.json");

interface AdminAuthRecord {
  username: string;
  hash: string;
  salt: string;
}

/**
 * AuthStore — اطلاعات ورود ادمین به پنل وب را نگه می‌دارد.
 *
 * در اولین اجرا، نام‌کاربری/رمزعبور را از متغیرهای محیطی
 * `WEB_ADMIN_USERNAME` / `WEB_ADMIN_PASSWORD` می‌خواند، هش می‌کند و در
 * دیسک ذخیره می‌کند — از آن به بعد فقط همان هش مصرف می‌شود (رمز خام هرگز
 * روی دیسک نگه‌داشته نمی‌شود). اگر این متغیرها ست نشده باشند، مقدار
 * پیش‌فرض `admin` / `admin123` استفاده می‌شود که باید در محیط تولید
 * حتماً از طریق env تغییر کند.
 */
export class AuthStore {
  private record: AdminAuthRecord | null = null;

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(AUTH_FILE, "utf-8");
      this.record = JSON.parse(raw);
    } catch {
      const username = process.env.WEB_ADMIN_USERNAME || "admin";
      const password = process.env.WEB_ADMIN_PASSWORD || "admin123";
      const { hash, salt } = hashPassword(password);
      this.record = { username, hash, salt };
      await this._persist();
      if (!process.env.WEB_ADMIN_PASSWORD) {
        console.warn(
          "[AuthStore] ⚠️ WEB_ADMIN_PASSWORD تنظیم نشده — از رمز پیش‌فرض 'admin123' استفاده شد. لطفاً هرچه سریع‌تر آن را در .env تنظیم و سرور را ری‌استارت کنید."
        );
      }
    }
  }

  private async _persist() {
    const tmp = `${AUTH_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.record, null, 2), "utf-8");
    await fs.rename(tmp, AUTH_FILE);
  }

  verify(username: string, password: string): boolean {
    if (!this.record) return false;
    if (this.record.username.toLowerCase() !== username.trim().toLowerCase()) return false;
    return verifyPassword(password, this.record.hash, this.record.salt);
  }
}

export const authStore = new AuthStore();
