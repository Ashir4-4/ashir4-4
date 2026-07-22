/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from "./types";
import { LicenseStore } from "./licenseStore";
import { LicenseManager } from "./licenseManager";

const WARNING_WINDOW_MS = 48 * 60 * 60 * 1000; // ۴۸ ساعت مانده به انقضا

/**
 * LicenseScheduler — معادل Celery Beat / APScheduler پروژه‌های پایتونی،
 * پیاده‌سازی‌شده با setInterval ساده چون کل استک پروژه Node/TypeScript
 * است. هر تیک:
 *   ۱) کاربران فعالِ غیرِمادام‌العمر را که کمتر از ۴۸ ساعت تا انقضا دارند
 *      و هنوز هشدار نگرفته‌اند، مطلع می‌کند (یک‌بار، با فلگ expiryWarningSent).
 *   ۲) کاربرانی که تاریخ انقضایشان گذشته را status=expired می‌کند و پیام
 *      «اکانت شما منقضی شد» می‌فرستد — یعنی دسترسی آن‌ها فوراً قطع می‌شود
 *      (hasActiveAccess دیگر true برنمی‌گرداند).
 */
export class LicenseScheduler {
  private store: LicenseStore;
  private manager: LicenseManager;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: LicenseStore, manager: LicenseManager, config: Config) {
    this.store = store;
    this.manager = manager;
    this.intervalMs = config.LICENSE_CHECK_INTERVAL_MS;
  }

  start() {
    if (this.timer) return;
    // اجرای فوری یک تیک در لحظه‌ی بوت، سپس هر intervalMs
    this._tick().catch((e) => console.error("[LicenseScheduler] initial tick failed:", e));
    this.timer = setInterval(() => {
      this._tick().catch((e) => console.error("[LicenseScheduler] tick failed:", e));
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async _tick() {
    if (!this.store.isLoaded) return;
    const now = Date.now();

    for (const user of this.store.getAll()) {
      if (user.status !== "active") continue;
      if (user.subscriptionType === "lifetime" || user.subscriptionType === "admin") continue;
      if (!user.expireDate) continue;

      const remaining = user.expireDate - now;

      if (remaining <= 0) {
        // ⏰ به محض اتمام تاریخ انقضا، دسترسی قطع می‌شود.
        user.status = "expired";
        await this.store.upsert(user);
        await this.manager.sendExpiredNotice(user);
        continue;
      }

      if (remaining <= WARNING_WINDOW_MS && !user.expiryWarningSent) {
        user.expiryWarningSent = true;
        await this.store.upsert(user);
        await this.manager.sendExpiryWarning(user);
      }
    }
  }
}
