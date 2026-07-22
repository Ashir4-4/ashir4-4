/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// رویدادهایی که موتور اصلی اسکن هنگام باز/بسته‌کردن یک موقعیت منتشر می‌کند
// (چه در حالت شبیه‌سازی و چه واقعی) — سرویس کپی‌تریدینگ چندکاربره
// (userTradeExecutor.ts) به این رویدادها گوش می‌دهد تا همان تصمیم را،
// با اندازه‌ی متناسب با موجودی خودِ هر کاربر، روی حساب واقعی او تکرار کند.

export interface TradeEntryEvent {
  type: "entry";
  sourceOrderId: string;
  symbol: string; // e.g. "BTC_USDT"
  action: "buy" | "sell";
  price: number;
  /** سهم این معامله از کل سرمایه‌ی اصلی (۰ تا ۱) — مبنای اندازه‌گیری سهمی برای هر کاربر */
  fractionOfCapital: number;
  /** اهرم واقعی مورد استفاده در معامله‌ی اصلی — همان مقدار برای هر کاربر روی حساب خودش تنظیم می‌شود */
  leverage: number;
}

export interface TradeExitEvent {
  type: "exit";
  sourceOrderId: string;
  symbol: string;
  action: "buy" | "sell"; // جهت معامله‌ی اصلی (ورودی)
  price: number;
  /** چه سهمی از موقعیت باقیمانده‌ی فعلی اکنون بسته می‌شود (۰ تا ۱) */
  fraction: number;
  /** true یعنی موقعیت به‌طور کامل بسته شد (دیگر رهگیری نشود) */
  isFinal: boolean;
  reason: string;
}
