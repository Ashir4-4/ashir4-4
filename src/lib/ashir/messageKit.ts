/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// ─────────────────────────────────────────────────────────────────
// 🎨 کیت طراحی پیام‌های تلگرام — برای یکدست و حرفه‌ای‌شدن ظاهر تمام
// پیام‌های ربات (چه پیام‌های سیگنال/معاملات، چه پیام‌های پنل شیشه‌ای
// اشتراک/لایسنس).
// ─────────────────────────────────────────────────────────────────

export const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━";
export const DIVIDER_THIN = "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈";

/** هدر استاندارد یک پیام: ایموجی + عنوان درشت + خط جداکننده */
export function msgHeader(emoji: string, title: string): string {
  return `${emoji} <b>${title}</b>\n${DIVIDER}`;
}

/** فوتر برند اشیر ۴.۰ — برای انتهای پیام‌های مهم */
export function brandFooter(): string {
  return `${DIVIDER}\n🐉 <b>ASHIR 4.0</b> · دستیار هوشمند معاملاتی\n👨‍💻 سازنده: <b>صادق محمدی</b>`;
}

/** یک ردیف اطلاعاتی مرتب: برچسب + مقدار */
export function row(label: string, value: string | number): string {
  return `▫️ <b>${label}:</b> ${value}`;
}
