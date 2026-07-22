/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from "./types";

export const config: Config = {
  // Telegram Info
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  
  // XT Exchange Info
  XT_API_KEY: process.env.XT_API_KEY || "",
  XT_BASE_URL: "https://sapi.xt.com",
  
  // Risk Management
  BASE_CAPITAL: 1000,
  MAX_POSITIONS: 5,
  POSITION_SIZE_MAX: 0.10,
  MAX_DRAWDOWN: 0.20,
  KELLY_FRACTION: 0.25,
  
  // Scanner Settings
  SCAN_INTERVAL: 20,
  TOP_TICKER_FILTER: 300,
  ORDERBOOK_FILTER: 80,
  DEEP_ANALYSIS: 40,
  MIN_FINAL_SCORE: 0.80,
  REQUEST_DELAY: 0.08,

  // Adaptive Exit Engine
  // TRAILING_STOP_ENABLED: once a trade is in profit, the stop-loss ratchets up (buy)
  // / down (sell) behind the best price reached, tightening as profit grows — locking
  // in gains instead of giving them back on a reversal.
  TRAILING_STOP_ENABLED: true,
  // EARLY_LOSS_EXIT_ENABLED: while a trade is underwater, watch short-term momentum;
  // if the loss is already a meaningful fraction of the distance to the hard stop AND
  // momentum keeps confirming further adverse movement, exit early instead of waiting
  // for the full stop-loss to be hit.
  EARLY_LOSS_EXIT_ENABLED: true,
  EARLY_EXIT_MIN_LOSS_RATIO: 0.38, // must already be 38%+ of the way to the stop-loss
  EARLY_EXIT_MOMENTUM_Z: 0.9,      // required strength of adverse momentum (z-score)
  EARLY_EXIT_CONFIRM_TICKS: 3,     // consecutive confirming ticks required (debounce)

  // ─── 🔑 سیستم مدیریت لایسنس و اشتراک کاربران ──────────────────
  // LICENSE_ADMIN_IDS: لیست آیدی عددی تلگرام ادمین‌ها، جدا شده با کاما در .env
  // (مثال: LICENSE_ADMIN_IDS=111111111,222222222). اگر خالی باشد، به‌صورت
  // پیش‌فرض همان TELEGRAM_CHAT_ID به‌عنوان تنها ادمین در نظر گرفته می‌شود.
  LICENSE_ADMIN_IDS: (process.env.LICENSE_ADMIN_IDS || process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  LICENSE_CARD_NUMBER: process.env.LICENSE_CARD_NUMBER || "0000-0000-0000-0000",
  LICENSE_CARD_HOLDER: process.env.LICENSE_CARD_HOLDER || "نام صاحب حساب",
  LICENSE_TRIAL_DAYS: 7,
  LICENSE_MONTHLY_DAYS: 30,
  LICENSE_PRICE_MONTHLY: Number(process.env.LICENSE_PRICE_MONTHLY) || 500_000,
  LICENSE_PRICE_LIFETIME: Number(process.env.LICENSE_PRICE_LIFETIME) || 4_000_000,
  LICENSE_CHECK_INTERVAL_MS: 10 * 60 * 1000, // هر ۱۰ دقیقه چک انقضا (کرون‌جاب هوشمند)

  // رمز امضای توکن ورود پنل وب — در تولید حتماً از طریق .env مقداردهی شود.
  WEB_AUTH_SECRET: process.env.WEB_AUTH_SECRET || "ashir-dev-secret-change-me",

  // رمز اصلی رمزنگاری کلیدهای API صرافی کاربران — در تولید حتماً یک مقدار
  // تصادفی و طولانی در .env تنظیم شود، وگرنه با ری‌استارت سرور کلیدهای
  // رمزنگاری‌شده‌ی قبلی دیگر قابل بازیابی نخواهند بود.
  EXCHANGE_KEY_ENCRYPTION_SECRET: process.env.EXCHANGE_KEY_ENCRYPTION_SECRET || "ashir-dev-vault-secret-change-me",
};
