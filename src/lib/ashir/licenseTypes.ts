/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// ─────────────────────────────────────────────────────────────────
// 🔑 سیستم مدیریت لایسنس و اشتراک کاربران ربات
// ─────────────────────────────────────────────────────────────────

/** ۴ نوع دسترسی قابل تعریف توسط ادمین */
export type SubscriptionType = "trial" | "monthly" | "lifetime" | "admin";

/** وضعیت حساب کاربر در چرخه‌ی عمر اشتراک */
export type AccountStatus =
  | "not_registered" // هنوز هیچ درخواستی نداده
  | "pending"         // منتظر تایید رسید توسط ادمین
  | "active"          // اشتراک فعال و معتبر
  | "expired"         // تاریخ انقضا گذشته
  | "rejected"        // درخواست رد شده توسط ادمین
  | "banned";         // توسط ادمین مسدود شده

export interface LicenseUser {
  telegramId: string;
  username?: string;
  firstName?: string;

  status: AccountStatus;
  subscriptionType?: SubscriptionType;

  /** timestamp (ms) — زمان شروع اشتراک فعلی */
  startDate?: number;
  /** timestamp (ms) — null/undefined یعنی مادام‌العمر (بدون انقضا) */
  expireDate?: number | null;

  /** پکیجی که کاربر درخواست کرده و منتظر تایید است */
  requestedPackage?: SubscriptionType;
  /** متن رسید/کد پیگیری ارسالی کاربر برای درخواست در حال بررسی */
  receiptText?: string;
  /** file_id عکس رسید در تلگرام (در صورت ارسال عکس به‌جای متن) */
  receiptPhotoId?: string;

  /** آیا هشدار ۴۸ ساعت مانده به انقضا قبلاً ارسال شده؟ (جلوگیری از تکرار) */
  expiryWarningSent?: boolean;

  /** مجموع مبلغ پرداخت‌شده توسط این کاربر (برای آمار درآمد کل) */
  totalPaidToman?: number;

  createdAt: number;
  updatedAt: number;

  /** یادداشت داخلی ادمین (مثلاً دلیل بن) */
  adminNote?: string;

  // ─── 🔐 ورود به پنل وب (نام کاربری/رمز عبور که ادمین برای کاربر تعریف می‌کند) ──
  webUsername?: string;
  webPasswordHash?: string;
  webPasswordSalt?: string;

  // ─── 💱 اتصال شخصی کاربر به صرافی XT (برای معامله‌ی خودکار روی حساب خودش) ──
  /** کلید API صرافی، رمزنگاری‌شده (AES-256-GCM) — هرگز متن ساده ذخیره نمی‌شود */
  xtApiKeyEnc?: string;
  /** کلید محرمانه‌ی صرافی، رمزنگاری‌شده */
  xtApiSecretEnc?: string;
  /** آخرین ۴ رقم کلید برای نمایش امن در UI بدون افشای کامل */
  xtApiKeyMasked?: string;
  exchangeConnected?: boolean;
  exchangeConnectedAt?: number;
  /** کپی‌تریدینگ خودکار فقط با روشن‌بودن صریح این پرچم فعال می‌شود (پیش‌فرض خاموش) */
  exchangeAutoTrade?: boolean;
  exchangeLastError?: string;
  /** موقعیت‌های باز مچ‌شده‌ی همین کاربر، به ازای هر سیگنال اصلی */
  exchangePositions?: Record<string, { sourceOrderId: string; symbol: string; action: "buy" | "sell"; quantity: number; entryPrice: number; leverage: number }>;
}

/** ورودی محاسبه‌شده برای نمایش پنل کاربر (زمان باقی‌مانده و ...) */
export interface LicenseSummary {
  user: LicenseUser;
  isActive: boolean;
  isLifetime: boolean;
  remainingMs: number | null; // null = مادام‌العمر یا نامشخص
  remainingLabel: string;
}

/** تعریف هر پکیج قابل‌فروش برای ساخت پیام‌ها و دکمه‌ها */
export interface PackageDefinition {
  type: SubscriptionType;
  title: string; // عنوان فارسی برای دکمه/پیام
  durationDays: number | null; // null = مادام‌العمر
  priceToman: number; // 0 برای تست رایگان
}
