/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import axios from "axios";
import { Config } from "./types";
import { LicenseStore } from "./licenseStore";
import { LicenseUser, SubscriptionType, PackageDefinition, LicenseSummary, AccountStatus } from "./licenseTypes";
import { formatJalali, formatGregorian, formatRemaining } from "./jalali";
import { hashPassword } from "./authUtils";
import { DIVIDER, DIVIDER_THIN, msgHeader, brandFooter, row } from "./messageKit";

// ─────────────────────────────────────────────────────────────────
// 🔑 LicenseManager — قلب سیستم مدیریت لایسنس و اشتراک کاربران.
//
// این کلاس کاملاً مستقل از TelegramBotHandler (پنل ادمین معاملاتی) عمل
// می‌کند و درخواست‌های HTTP خودش را به تلگرام می‌زند (دقیقاً مثل
// TelegramReporter)، تا:
//  1) هرگز با پولینگ/کیبورد ربات معاملاتی تداخل نکند.
//  2) بتوان بعداً به‌سادگی آن را در پروژه‌ی دیگری هم استفاده کرد.
// ─────────────────────────────────────────────────────────────────

const fmtMoney = (n: number) => n.toLocaleString("fa-IR", { useGrouping: true });

// وضعیت مکالمه‌ی چندمرحله‌ای (کاربر در انتظار ارسال رسید / ادمین در انتظار
// ورودی دستی است). نگه‌داری در حافظه کافی است — اگر سرور ری‌استارت شود،
// کاربر فقط باید دوباره دکمه‌ی فعال‌سازی را بزند که هزینه‌ی زیادی ندارد.
interface PendingReceiptState {
  kind: "awaiting_receipt";
  packageType: SubscriptionType;
}
interface PendingAdminState {
  kind: "awaiting_adduser" | "awaiting_manage_lookup";
}
type ConversationState = PendingReceiptState | PendingAdminState;

export const SUBSCRIBER_KEYBOARD = {
  keyboard: [
    [{ text: "🔑 فعال‌سازی / تمدید اشتراک" }],
    [{ text: "📊 حساب من" }, { text: "ℹ️ راهنما" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const ADMIN_LICENSE_BUTTON = { text: "🛠 مدیریت اشتراک‌ها" };

export class LicenseManager {
  private token: string;
  private config: Config;
  private store: LicenseStore;
  private conversations = new Map<string, ConversationState>();

  constructor(token: string, config: Config, store: LicenseStore) {
    this.token = token;
    this.config = config;
    this.store = store;
  }

  get packages(): PackageDefinition[] {
    return [
      { type: "trial", title: "🎁 اشتراک تست (۱ هفته رایگان)", durationDays: this.config.LICENSE_TRIAL_DAYS, priceToman: 0 },
      { type: "monthly", title: "📅 اشتراک ماهانه (۳۰ روزه)", durationDays: this.config.LICENSE_MONTHLY_DAYS, priceToman: this.config.LICENSE_PRICE_MONTHLY },
      { type: "lifetime", title: "💎 اشتراک مادام‌العمر", durationDays: null, priceToman: this.config.LICENSE_PRICE_LIFETIME },
    ];
  }

  isAdmin(telegramId: string): boolean {
    return this.config.LICENSE_ADMIN_IDS.includes(String(telegramId));
  }

  /** کیبورد رِپلای مناسب هر کاربر — ادمین یک دکمه‌ی اضافه‌ی مدیریت می‌بیند. */
  keyboardFor(telegramId: string) {
    if (this.isAdmin(telegramId)) {
      return {
        keyboard: [...SUBSCRIBER_KEYBOARD.keyboard, [ADMIN_LICENSE_BUTTON]],
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    return SUBSCRIBER_KEYBOARD;
  }

  // ─── ⛓️ زیرساخت ارسال به تلگرام ──────────────────────────────
  private async _send(chatId: string, text: string, replyMarkup?: any) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        { chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", reply_markup: replyMarkup },
        { timeout: 15000 }
      );
    } catch (e: any) {
      console.error("[LicenseManager] sendMessage failed:", e.message || e);
    }
  }

  private async _edit(chatId: string, messageId: number, text: string, replyMarkup?: any) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/editMessageText`,
        { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), parse_mode: "HTML", reply_markup: replyMarkup },
        { timeout: 15000 }
      );
    } catch (e: any) {
      console.error("[LicenseManager] editMessageText failed:", e.message || e);
    }
  }

  private async _sendPhoto(chatId: string, fileId: string, caption: string, replyMarkup?: any) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendPhoto`,
        { chat_id: chatId, photo: fileId, caption: caption.slice(0, 1024), parse_mode: "HTML", reply_markup: replyMarkup },
        { timeout: 15000 }
      );
    } catch (e: any) {
      console.error("[LicenseManager] sendPhoto failed:", e.message || e);
    }
  }

  private async _answerCallback(callbackQueryId: string, text?: string) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
        { callback_query_id: callbackQueryId, text, show_alert: false },
        { timeout: 10000 }
      );
    } catch {
      // بی‌اهمیت — فقط یک لودینگ کوچک روی دکمه است
    }
  }

  // ─── 📐 محاسبات وضعیت اشتراک ──────────────────────────────────
  summarize(user: LicenseUser): LicenseSummary {
    const isLifetime = user.subscriptionType === "lifetime" || user.subscriptionType === "admin";
    const now = Date.now();
    let remainingMs: number | null = null;
    let isActive = user.status === "active";

    if (isActive && !isLifetime && user.expireDate) {
      remainingMs = user.expireDate - now;
      if (remainingMs <= 0) {
        isActive = false;
        remainingMs = 0;
      }
    }

    const remainingLabel = isLifetime
      ? "نامحدود (مادام‌العمر) ♾️"
      : remainingMs != null
      ? formatRemaining(remainingMs)
      : "—";

    return { user, isActive, isLifetime, remainingMs, remainingLabel };
  }

  /** آیا این کاربر در حال حاضر اجازه‌ی استفاده از امکانات ربات معامله‌گر را دارد؟ */
  hasActiveAccess(telegramId: string): boolean {
    const user = this.store.getById(telegramId);
    if (!user) return false;
    if (user.status === "banned" || user.status === "rejected") return false;
    if (user.subscriptionType === "admin") return true;
    return this.summarize(user).isActive;
  }

  // ─── 👤 ثبت‌نام اولیه ──────────────────────────────────────────
  private async _ensureUser(telegramId: string, username?: string, firstName?: string): Promise<LicenseUser> {
    let user = this.store.getById(telegramId);
    if (!user) {
      user = {
        telegramId,
        username,
        firstName,
        status: "not_registered",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.store.upsert(user);
    } else if (username !== user.username || firstName !== user.firstName) {
      user.username = username;
      user.firstName = firstName;
      await this.store.upsert(user);
    }
    return user;
  }

  // ─── 📩 ورودی اصلی: پیام‌های متنی و عکس ───────────────────────
  /** true یعنی این پیام توسط سیستم لایسنس مدیریت شد. */
  async handleMessage(msg: any): Promise<boolean> {
    const chatId = String(msg.chat?.id ?? "");
    const hasText = typeof msg.text === "string";
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    if (!chatId || (!hasText && !hasPhoto)) return false;
    const text = hasText ? msg.text.trim() : "";
    const isAdminChat = this.isAdmin(chatId);
    const username = msg.chat?.username || msg.from?.username;
    const firstName = msg.chat?.first_name || msg.from?.first_name;

    const user = await this._ensureUser(chatId, username, firstName);

    // ── ۱) مکالمه‌ی چندمرحله‌ای در جریان (رسید پرداخت یا ورودی ادمین) ──
    const convo = this.conversations.get(chatId);
    if (convo?.kind === "awaiting_receipt") {
      this.conversations.delete(chatId);
      if (hasPhoto) {
        // بزرگ‌ترین سایز عکس (آخرین آیتم آرایه‌ی photo در تلگرام)
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await this._submitReceipt(user, convo.packageType, msg.caption?.trim() || "(عکس رسید پرداخت ارسال شد)", fileId);
      } else {
        await this._submitReceipt(user, convo.packageType, text);
      }
      return true;
    }
    if (isAdminChat && convo?.kind === "awaiting_adduser") {
      this.conversations.delete(chatId);
      await this._handleManualAddInput(chatId, text);
      return true;
    }
    if (isAdminChat && convo?.kind === "awaiting_manage_lookup") {
      this.conversations.delete(chatId);
      await this._handleManageLookup(chatId, text);
      return true;
    }

    // ── ۲) دکمه‌های ثابت مشترک (کاربر عادی و ادمین) ──
    if (text === "/start" && !isAdminChat) {
      await this._sendWelcome(chatId, user);
      return true;
    }
    if (text.includes("فعال‌سازی") && text.includes("اشتراک")) {
      await this._sendPackageChooser(chatId);
      return true;
    }
    if (text.includes("حساب من")) {
      await this._sendUserDashboard(chatId, user);
      return true;
    }
    if (text.includes("راهنما") && !isAdminChat) {
      await this._send(
        chatId,
        `${msgHeader("ℹ️", "راهنمای استفاده از ربات")}\n` +
          `برای استفاده از سیگنال‌ها و معاملات خودکار، ابتدا باید یک پکیج فعال داشته باشید:\n\n` +
          `${row("۱️⃣ فعال‌سازی", "پکیج موردنظر را از دکمه‌ی «🔑 فعال‌سازی» انتخاب کنید")}\n` +
          `${row("۲️⃣ پرداخت", "برای پکیج‌های پولی، شماره کارت نمایش داده می‌شود")}\n` +
          `${row("۳️⃣ ارسال رسید", "بعد از واریز، عکس رسید یا کد پیگیری را همین‌جا بفرستید")}\n` +
          `${row("۴️⃣ تایید ادمین", "پس از تایید، اشتراک شما بلافاصله فعال می‌شود")}\n` +
          `${row("📊 وضعیت من", "همیشه از دکمه‌ی «حساب من» قابل مشاهده است")}\n\n` +
          brandFooter(),
        this.keyboardFor(chatId)
      );
      return true;
    }

    // ── ۳) پنل مدیریت (فقط ادمین) ──
    if (isAdminChat && text.includes("مدیریت اشتراک")) {
      await this._sendAdminDashboard(chatId);
      return true;
    }

    // ── ۴) اگر ادمین باشد و متن با هیچ‌کدام از موارد بالا مطابقت نداشت،
    // اجازه بده کنترل به پنل معاملاتی اصلی (telegramBot.ts) برسد. ──
    if (isAdminChat) return false;

    // ── ۵) هر متن دیگری از یک کاربر عادی/غریبه: هدایت به منو ──
    await this._sendWelcome(chatId, user);
    return true;
  }

  // ─── 🖱️ ورودی اصلی: دکمه‌های شیشه‌ای (Inline / callback_query) ──
  async handleCallbackQuery(cq: any): Promise<boolean> {
    const data: string = cq.data || "";
    if (!data.startsWith("lic:")) return false;

    const chatId = String(cq.message?.chat?.id ?? "");
    const messageId = cq.message?.message_id;
    const parts = data.split(":"); // lic:<scope>:<action>:<args...>

    try {
      if (parts[1] === "pkg") {
        // lic:pkg:<type>  — کاربر یک پکیج را انتخاب کرد
        await this._answerCallback(cq.id);
        if (parts[2] === "__renew_info") {
          await this._sendPackageChooser(chatId);
          return true;
        }
        await this._startPurchase(chatId, parts[2] as SubscriptionType, messageId);
        return true;
      }

      if (parts[1] === "adm") {
        if (!this.isAdmin(chatId)) {
          await this._answerCallback(cq.id, "⛔️ شما دسترسی ادمین ندارید.");
          return true;
        }
        await this._answerCallback(cq.id);
        await this._handleAdminCallback(chatId, messageId, parts.slice(2));
        return true;
      }
    } catch (e) {
      console.error("[LicenseManager] callback handling failed:", e);
    }
    return true;
  }

  // ─── 👋 خوش‌آمدگویی / منوی اصلی کاربر ─────────────────────────
  private async _sendWelcome(chatId: string, user: LicenseUser) {
    const summary = this.summarize(user);
    let statusBadge: string;
    if (summary.isActive) {
      statusBadge = `🟢 اشتراک <b>فعال</b> — ${summary.remainingLabel} باقی‌مانده`;
    } else if (user.status === "pending") {
      statusBadge = "🟡 درخواست شما در انتظار تایید ادمین است";
    } else {
      statusBadge = "⚪️ هنوز اشتراکی فعال نکرده‌اید";
    }

    const msg =
      `╭─❉ ˖°𓂂 ˖ ❉─╮\n` +
      `   🐉 <b>ASHIR 4.0</b>\n` +
      `╰─❉ ˖°𓂂 ˖ ❉─╯\n` +
      `<i>دستیار هوشمند معاملاتی روی صرافی XT</i>\n` +
      `${DIVIDER}\n\n` +
      `سلام${user.username ? ` <b>${user.username}@</b>` : ""} 👋\n` +
      `به <b>اشیر ۴.۰</b> خوش آمدید — موتوری که سیگنال‌های ورود و خروج را با ترکیب <b>سوپرترند</b>، <b>پرایس‌اکشن</b> و <b>امواج الیوت</b> می‌سازد و می‌تواند مستقیماً روی حساب فیوچرز خودِ شما در XT، با اهرم هوشمندی که خودِ استراتژی بر اساس اطمینان سیگنال انتخاب می‌کند، معامله کند.\n\n` +
      `${statusBadge}\n\n` +
      `${DIVIDER}\n` +
      `✨ <b>امکانات پلتفرم</b>\n` +
      `${row("📡 سیگنال زنده", "تحلیل سه‌لایه‌ی بازار، ۲۴ ساعته")}\n` +
      `${row("💱 معامله‌ی خودکار", "روی حساب واقعی فیوچرز شما")}\n` +
      `${row("🛡 مدیریت ریسک", "خروج هوشمند + کاهش حجم پله‌ای")}\n` +
      `${row("📊 گزارش‌گیری", "آمار روزانه، هفتگی و سود/زیان دقیق")}\n\n` +
      `${DIVIDER}\n` +
      `⚠️ <b>نکات امنیتی — قبل از اتصال به صرافی حتماً بخوانید</b>\n` +
      `🔸 کلید API را فقط با دسترسی «<b>Trade Only</b>» بسازید.\n` +
      `🔸 دسترسی «<b>Withdraw / برداشت</b>» را هرگز فعال نکنید.\n` +
      `🔸 در صورت امکان، کلید را به IP سرور محدود کنید.\n` +
      `🔸 رمز API را هرگز در چت نفرستید — فقط از فرم امن پنل وب.\n` +
      `🔸 این ربات با <b>پول واقعی</b> معامله می‌کند؛ اول با مبلغ کم تست کنید.\n\n` +
      `👇 از دکمه‌های پایین برای شروع استفاده کنید\n\n` +
      brandFooter();

    await this._send(chatId, msg, this.keyboardFor(chatId));
  }

  // ─── 📊 پنل شیشه‌ای کاربر ──────────────────────────────────────
  private async _sendUserDashboard(chatId: string, user: LicenseUser) {
    const summary = this.summarize(user);
    const typeLabel: Record<SubscriptionType, string> = {
      trial: "🎁 تست",
      monthly: "📅 ماهانه",
      lifetime: "💎 مادام‌العمر",
      admin: "👑 دسترسی ویژه ادمین",
    };

    let out = `${msgHeader("👤", "پنل حساب کاربری")}\n`;
    out += `${row("🆔 شناسه تلگرام", `<code>${user.telegramId}</code>`)}\n`;
    out += `${row("👤 نام کاربری", user.username ? "@" + user.username : "—")}\n`;

    if (!user.subscriptionType || user.status === "not_registered") {
      out += `\n🔒 هیچ اشتراکی ثبت نشده است.\n💡 برای شروع، از دکمه‌ی «🔑 فعال‌سازی» استفاده کنید.\n\n${brandFooter()}`;
      await this._send(chatId, out, this.keyboardFor(chatId));
      return;
    }

    const statusEmoji: Record<AccountStatus, string> = {
      not_registered: "⚪",
      pending: "🟡",
      active: "🟢",
      expired: "🔴",
      rejected: "🔴",
      banned: "⛔️",
    };
    const statusLabel: Record<AccountStatus, string> = {
      not_registered: "ثبت‌نشده",
      pending: "در انتظار تایید ادمین",
      active: "فعال",
      expired: "منقضی شده",
      rejected: "رد شده",
      banned: "مسدود شده",
    };

    out += `${DIVIDER_THIN}\n`;
    out += `${row("💎 نوع اکانت", typeLabel[user.subscriptionType])}\n`;
    out += `${row(`${statusEmoji[user.status]} وضعیت`, statusLabel[user.status])}\n`;

    if (user.startDate) {
      out += `${row("📅 تاریخ شروع", `${formatJalali(new Date(user.startDate))} <i>(${formatGregorian(new Date(user.startDate))})</i>`)}\n`;
    }
    if (summary.isLifetime) {
      out += `${row("♾️ تاریخ انقضا", "ندارد (مادام‌العمر)")}\n`;
    } else if (user.expireDate) {
      out += `${row("📅 تاریخ انقضا", `${formatJalali(new Date(user.expireDate))} <i>(${formatGregorian(new Date(user.expireDate))})</i>`)}\n`;
    }
    if (summary.remainingMs != null || summary.isLifetime) {
      out += `${row("⏳ زمان باقی‌مانده", `<b>${summary.remainingLabel}</b>`)}\n`;
    }

    out += `\n${brandFooter()}`;
    await this._send(chatId, out.trim(), this.keyboardFor(chatId));
  }

  // ─── 🛒 انتخاب پکیج ────────────────────────────────────────────
  private async _sendPackageChooser(chatId: string) {
    const user = this.store.getById(chatId);
    const usedTrial = !!user && !!user.subscriptionType;

    const rows = this.packages
      .filter((p) => p.type !== "trial" || !usedTrial)
      .map((p) => [{
        text: p.priceToman > 0 ? `${p.title} — ${fmtMoney(p.priceToman)} تومان` : p.title,
        callback_data: `lic:pkg:${p.type}`,
      }]);

    await this._send(
      chatId,
      `${msgHeader("🛒", "انتخاب پکیج اشتراک")}\n✨ یکی از پکیج‌های زیر را انتخاب کنید تا سیگنال‌ها و امکانات معاملاتی برایتان فعال شود 👇`,
      { inline_keyboard: rows }
    );
  }

  private async _startPurchase(chatId: string, packageType: SubscriptionType, messageId?: number) {
    const pkg = this.packages.find((p) => p.type === packageType);
    if (!pkg) return;

    if (pkg.priceToman === 0) {
      // 🎁 تست رایگان — بدون نیاز به رسید، بلافاصله فعال می‌شود.
      const user = await this._ensureUser(chatId);
      const usedTrialBefore = !!user.subscriptionType; // قبلاً هر نوع اشتراکی گرفته
      if (usedTrialBefore) {
        await this._send(chatId, "⚠️ شما قبلاً از یک پکیج استفاده کرده‌اید؛ اشتراک تست رایگان فقط یک‌بار قابل استفاده است.", this.keyboardFor(chatId));
        return;
      }
      await this._activate(user, "trial", pkg, 0);
      await this._send(
        chatId,
        `${msgHeader("🎉", "اشتراک تست شما فعال شد!")}\n${row("⏳ مدت اعتبار", `${pkg.durationDays} روز`)}\n\n💡 برای مشاهده‌ی جزئیات از «📊 حساب من» استفاده کنید.\n\n${brandFooter()}`,
        this.keyboardFor(chatId)
      );
      return;
    }

    // پکیج پولی — نمایش شماره کارت و ثبت انتظار برای دریافت رسید
    this.conversations.set(chatId, { kind: "awaiting_receipt", packageType });
    const text =
      `${msgHeader("💳", `اطلاعات پرداخت — ${pkg.title}`)}\n` +
      `${row("💰 مبلغ قابل پرداخت", `<b>${fmtMoney(pkg.priceToman)} تومان</b>`)}\n` +
      `${row("💳 شماره کارت", `<code>${this.config.LICENSE_CARD_NUMBER}</code>`)}\n` +
      `${row("👤 به نام", this.config.LICENSE_CARD_HOLDER)}\n\n` +
      `${DIVIDER_THIN}\n` +
      `📝 پس از واریز، <b>عکس رسید پرداخت یا کد پیگیری</b> را همین‌جا ارسال کنید تا برای بررسی و تایید نزد ادمین ارسال شود.\n\n` +
      `⏳ معمولاً تایید در کمترین زمان ممکن انجام می‌شود.`;

    if (messageId) {
      await this._edit(chatId, messageId, text);
    } else {
      await this._send(chatId, text);
    }
  }

  private async _submitReceipt(user: LicenseUser, packageType: SubscriptionType, receiptText: string, photoFileId?: string) {
    user.status = "pending";
    user.requestedPackage = packageType;
    user.receiptText = receiptText;
    if (photoFileId) user.receiptPhotoId = photoFileId;
    await this.store.upsert(user);

    await this._send(
      user.telegramId,
      `${msgHeader("✅", "پرداخت انجام شد و منتظر تایید باشید")}\nرسید شما دریافت شد و برای بررسی نزد ادمین ارسال شد.\n⏳ به‌محض تایید، اشتراک شما بلافاصله فعال خواهد شد و پیام تایید دریافت می‌کنید.\n\n${brandFooter()}`,
      this.keyboardFor(user.telegramId)
    );

    const pkg = this.packages.find((p) => p.type === packageType);
    const adminText =
      `${msgHeader("🆕", "درخواست فعال‌سازی جدید")}\n` +
      `${row("👤 کاربر", `${user.username ? "@" + user.username : user.firstName || "—"} <code>${user.telegramId}</code>`)}\n` +
      `${row("📦 پکیج درخواستی", pkg?.title || packageType)}\n\n` +
      (photoFileId ? `🧾 <b>توضیح کاربر:</b>\n<code>${receiptText.slice(0, 500)}</code>\n\n📷 عکس رسید پیوست شد.` : `🧾 <b>رسید/کد پیگیری:</b>\n<code>${receiptText.slice(0, 500)}</code>`);

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ تایید", callback_data: `lic:adm:approve:${user.telegramId}` },
          { text: "❌ رد", callback_data: `lic:adm:reject:${user.telegramId}` },
        ],
      ],
    };

    for (const adminId of this.config.LICENSE_ADMIN_IDS) {
      if (photoFileId) {
        await this._sendPhoto(adminId, photoFileId, adminText, keyboard);
      } else {
        await this._send(adminId, adminText, keyboard);
      }
    }
  }

  // ─── ✅ فعال‌سازی نهایی (تایید ادمین یا افزودن دستی/تمدید) ──────
  private async _activate(user: LicenseUser, type: SubscriptionType, pkg: PackageDefinition, priceToman: number) {
    const now = Date.now();
    // اگر اشتراک فعلی هنوز فعال است، تمدید از تاریخ انقضای فعلی محاسبه
    // می‌شود؛ در غیر این‌صورت از همین لحظه.
    const currentlyActive = user.status === "active" && user.expireDate && user.expireDate > now;
    const base = currentlyActive ? user.expireDate! : now;

    user.status = "active";
    user.subscriptionType = type;
    user.startDate = user.startDate && currentlyActive ? user.startDate : now;
    user.expireDate = pkg.durationDays == null ? null : base + pkg.durationDays * 24 * 60 * 60 * 1000;
    user.expiryWarningSent = false;
    user.totalPaidToman = (user.totalPaidToman || 0) + priceToman;
    await this.store.upsert(user);
  }

  // ─── 🛠 پنل مدیریت ادمین ──────────────────────────────────────
  private async _sendAdminDashboard(chatId: string) {
    const stats = this.store.getStats();
    const text =
      `${msgHeader("🛠", "پنل مدیریت اشتراک‌ها")}\n` +
      `${row("👥 کل کاربران", stats.totalUsers)}\n` +
      `${row("🟢 فعال", stats.active)} · ${row("🔴 منقضی", stats.expired)}\n` +
      `${row("🟡 در انتظار", stats.pending)} · ${row("⛔️ مسدود", stats.banned)}\n` +
      `${DIVIDER_THIN}\n` +
      `${row("💰 درآمد ثبت‌شده", `<b>${fmtMoney(stats.totalRevenue)} تومان</b>`)}`;

    const keyboard = {
      inline_keyboard: [
        [{ text: `📋 لیست در انتظار تایید (${stats.pending})`, callback_data: "lic:adm:menu:pending" }],
        [{ text: "➕ افزودن کاربر دستی", callback_data: "lic:adm:menu:adduser" }],
        [{ text: "🚫 بن / تمدید دستی کاربر", callback_data: "lic:adm:menu:manage" }],
        [{ text: "📊 آمار کل", callback_data: "lic:adm:menu:stats" }],
      ],
    };

    await this._send(chatId, text, keyboard);
  }

  private async _handleAdminCallback(adminChatId: string, messageId: number | undefined, args: string[]) {
    const [action, ...rest] = args;

    switch (action) {
      case "menu": {
        const sub = rest[0];
        if (sub === "pending") return this._showPendingList(adminChatId, messageId);
        if (sub === "stats") return this._showStats(adminChatId, messageId);
        if (sub === "adduser") {
          this.conversations.set(adminChatId, { kind: "awaiting_adduser" });
          return this._send(adminChatId, "➕ <b>افزودن کاربر دستی</b>\n━━━━━━━━━━━━━━━━━━\nآیدی عددی تلگرام و نوع پکیج را با فاصله ارسال کنید.\nمثال: <code>123456789 monthly</code>\n\nمقادیر مجاز پکیج: <code>trial</code> / <code>monthly</code> / <code>lifetime</code> / <code>admin</code>");
        }
        if (sub === "manage") {
          this.conversations.set(adminChatId, { kind: "awaiting_manage_lookup" });
          return this._send(adminChatId, "🔎 آیدی عددی تلگرام کاربر موردنظر برای بن/تمدید را ارسال کنید.");
        }
        return;
      }
      case "approve": {
        const telegramId = rest[0];
        return this._showApprovePackagePicker(adminChatId, messageId, telegramId);
      }
      case "approve_pkg": {
        const [telegramId, packageType] = rest;
        return this._finalizeApproval(adminChatId, messageId, telegramId, packageType as SubscriptionType);
      }
      case "reject": {
        const telegramId = rest[0];
        return this._rejectUser(adminChatId, messageId, telegramId);
      }
      case "ban": {
        const telegramId = rest[0];
        return this._banUser(adminChatId, telegramId);
      }
      case "unban": {
        const telegramId = rest[0];
        return this._unbanUser(adminChatId, telegramId);
      }
      case "renew_pkg": {
        const [telegramId, packageType] = rest;
        return this._renewUser(adminChatId, telegramId, packageType as SubscriptionType);
      }
      default:
        return;
    }
  }

  private async _showPendingList(adminChatId: string, messageId?: number) {
    const pending = this.store.getPending();
    if (pending.length === 0) {
      const text = "📋 <b>لیست در انتظار تایید</b>\n━━━━━━━━━━━━━━━━━━\nدر حال حاضر هیچ درخواست در انتظاری وجود ندارد.";
      if (messageId) await this._edit(adminChatId, messageId, text);
      else await this._send(adminChatId, text);
      return;
    }
    for (const u of pending.slice(0, 15)) {
      const pkg = this.packages.find((p) => p.type === u.requestedPackage);
      const text =
        `👤 ${u.username ? "@" + u.username : u.firstName || "—"} (<code>${u.telegramId}</code>)\n` +
        `📦 پکیج: ${pkg?.title || u.requestedPackage}\n` +
        `🧾 رسید: <code>${(u.receiptText || "—").slice(0, 300)}</code>`;
      await this._send(adminChatId, text, {
        inline_keyboard: [[
          { text: "✅ تایید", callback_data: `lic:adm:approve:${u.telegramId}` },
          { text: "❌ رد", callback_data: `lic:adm:reject:${u.telegramId}` },
        ]],
      });
    }
  }

  private async _showStats(adminChatId: string, messageId?: number) {
    const stats = this.store.getStats();
    const text =
      `📊 <b>آمار کل سیستم</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👥 کل کاربران ثبت‌شده: ${stats.totalUsers}\n` +
      `🟢 اشتراک‌های فعال: ${stats.active}\n` +
      `🔴 منقضی‌شده: ${stats.expired}\n` +
      `🟡 در انتظار تایید: ${stats.pending}\n` +
      `⛔️ مسدود شده: ${stats.banned}\n` +
      `💰 کل درآمد ثبت‌شده: ${fmtMoney(stats.totalRevenue)} تومان`;
    if (messageId) await this._edit(adminChatId, messageId, text);
    else await this._send(adminChatId, text);
  }

  private async _showApprovePackagePicker(adminChatId: string, messageId: number | undefined, telegramId: string) {
    const user = this.store.getById(telegramId);
    if (!user) return this._send(adminChatId, "⚠️ کاربر یافت نشد.");
    const text = `📦 نوع پکیجی که می‌خواهید برای این کاربر فعال کنید را انتخاب کنید:\n👤 <code>${telegramId}</code>`;
    const keyboard = {
      inline_keyboard: this.packages.map((p) => [{ text: p.title, callback_data: `lic:adm:approve_pkg:${telegramId}:${p.type}` }]),
    };
    if (messageId) await this._edit(adminChatId, messageId, text, keyboard);
    else await this._send(adminChatId, text, keyboard);
  }

  private async _finalizeApproval(adminChatId: string, messageId: number | undefined, telegramId: string, packageType: SubscriptionType) {
    const user = this.store.getById(telegramId);
    const pkg = this.packages.find((p) => p.type === packageType);
    if (!user || !pkg) return this._send(adminChatId, "⚠️ کاربر یا پکیج یافت نشد.");

    await this._activate(user, packageType, pkg, pkg.priceToman);

    const doneText = `✅ اشتراک «${pkg.title}» برای کاربر <code>${telegramId}</code> فعال شد.`;
    if (messageId) await this._edit(adminChatId, messageId, doneText);
    else await this._send(adminChatId, doneText);

    await this._send(
      telegramId,
      `${msgHeader("🎉", "اشتراک شما تایید و فعال شد!")}\n${row("📦 پکیج", pkg.title)}\n\n💡 برای مشاهده‌ی جزئیات از «📊 حساب من» استفاده کنید.\n\n${brandFooter()}`,
      this.keyboardFor(telegramId)
    );
  }

  private async _rejectUser(adminChatId: string, messageId: number | undefined, telegramId: string) {
    const user = this.store.getById(telegramId);
    if (!user) return this._send(adminChatId, "⚠️ کاربر یافت نشد.");
    user.status = "rejected";
    await this.store.upsert(user);

    const doneText = `❌ درخواست کاربر <code>${telegramId}</code> رد شد.`;
    if (messageId) await this._edit(adminChatId, messageId, doneText);
    else await this._send(adminChatId, doneText);

    await this._send(
      telegramId,
      `${msgHeader("❌", "درخواست شما رد شد")}\nدر صورت داشتن سوال با ادمین در تماس باشید یا دوباره تلاش کنید.\n\n${brandFooter()}`,
      this.keyboardFor(telegramId)
    );
  }

  private async _handleManualAddInput(adminChatId: string, text: string) {
    const [telegramId, rawType] = text.trim().split(/\s+/);
    const packageType = rawType as SubscriptionType;
    const pkg =
      this.packages.find((p) => p.type === packageType) ||
      (packageType === "admin" ? ({ type: "admin", title: "👑 دسترسی ویژه ادمین", durationDays: null, priceToman: 0 } as PackageDefinition) : undefined);

    if (!telegramId || !/^\d+$/.test(telegramId) || !pkg) {
      await this._send(adminChatId, "⚠️ فرمت نامعتبر است. مثال صحیح: <code>123456789 monthly</code>");
      return;
    }

    let user = this.store.getById(telegramId);
    if (!user) {
      user = { telegramId, status: "not_registered", createdAt: Date.now(), updatedAt: Date.now() };
    }
    await this._activate(user, pkg.type, pkg, 0);

    await this._send(adminChatId, `✅ کاربر <code>${telegramId}</code> با پکیج «${pkg.title}» فعال شد.`);
    await this._send(telegramId, `🎉 <b>اشتراک شما توسط ادمین فعال شد!</b>\n📦 پکیج: ${pkg.title}`, this.keyboardFor(telegramId));
  }

  private async _handleManageLookup(adminChatId: string, text: string) {
    const telegramId = text.trim();
    const user = this.store.getById(telegramId);
    if (!user || !/^\d+$/.test(telegramId)) {
      await this._send(adminChatId, "⚠️ کاربری با این آیدی یافت نشد.");
      return;
    }
    const summary = this.summarize(user);
    const infoText =
      `👤 <code>${telegramId}</code> ${user.username ? "(@" + user.username + ")" : ""}\n` +
      `💎 پکیج: ${user.subscriptionType || "—"} | وضعیت: ${user.status}\n` +
      `⏳ باقی‌مانده: ${summary.remainingLabel}`;

    const keyboard = {
      inline_keyboard: [
        user.status === "banned"
          ? [{ text: "✅ رفع بن", callback_data: `lic:adm:unban:${telegramId}` }]
          : [{ text: "🚫 بن کردن", callback_data: `lic:adm:ban:${telegramId}` }],
        ...this.packages.map((p) => [{ text: `🔄 تمدید با «${p.title}»`, callback_data: `lic:adm:renew_pkg:${telegramId}:${p.type}` }]),
      ],
    };
    await this._send(adminChatId, infoText, keyboard);
  }

  private async _banUser(adminChatId: string, telegramId: string) {
    const user = this.store.getById(telegramId);
    if (!user) return this._send(adminChatId, "⚠️ کاربر یافت نشد.");
    user.status = "banned";
    await this.store.upsert(user);
    await this._send(adminChatId, `⛔️ کاربر <code>${telegramId}</code> مسدود شد.`);
    await this._send(telegramId, "⛔️ دسترسی شما به ربات توسط ادمین مسدود شد.");
  }

  private async _unbanUser(adminChatId: string, telegramId: string) {
    const user = this.store.getById(telegramId);
    if (!user) return this._send(adminChatId, "⚠️ کاربر یافت نشد.");
    // رفع بن فقط قفل را برمی‌دارد؛ وضعیت اشتراک بر اساس تاریخ انقضا دوباره محاسبه می‌شود.
    const stillValid = user.expireDate == null || user.expireDate > Date.now() || user.subscriptionType === "lifetime" || user.subscriptionType === "admin";
    user.status = stillValid && user.subscriptionType ? "active" : "expired";
    await this.store.upsert(user);
    await this._send(adminChatId, `✅ کاربر <code>${telegramId}</code> رفع بن شد.`);
    await this._send(telegramId, "✅ دسترسی شما توسط ادمین بازگردانده شد.", this.keyboardFor(telegramId));
  }

  private async _renewUser(adminChatId: string, telegramId: string, packageType: SubscriptionType) {
    const user = this.store.getById(telegramId);
    const pkg = this.packages.find((p) => p.type === packageType);
    if (!user || !pkg) return this._send(adminChatId, "⚠️ کاربر یا پکیج یافت نشد.");
    await this._activate(user, packageType, pkg, 0);
    await this._send(adminChatId, `🔄 اشتراک کاربر <code>${telegramId}</code> با پکیج «${pkg.title}» تمدید شد.`);
    await this._send(telegramId, `🔄 <b>اشتراک شما توسط ادمین تمدید شد!</b>\n📦 پکیج: ${pkg.title}`, this.keyboardFor(telegramId));
  }

  // ─── 🌐 استفاده‌ی مشترک با پنل وب (REST API) ──────────────────
  // این متدها همان منطق تایید/رد/بن/تمدید تلگرام را دوباره استفاده می‌کنند
  // تا پنل وب و ربات تلگرام همیشه یک منبع حقیقت واحد داشته باشند؛ کاربر
  // مستقل از این‌که از کجا اقدام انجام شده، پیام تلگرامی متناظر را هم
  // دریافت می‌کند.
  async webApprove(telegramId: string, packageType: SubscriptionType) {
    return this._finalizeApproval(this._noAdminChat(), undefined, telegramId, packageType);
  }
  async webReject(telegramId: string) {
    return this._rejectUser(this._noAdminChat(), undefined, telegramId);
  }
  async webBan(telegramId: string) {
    return this._banUser(this._noAdminChat(), telegramId);
  }
  async webUnban(telegramId: string) {
    return this._unbanUser(this._noAdminChat(), telegramId);
  }
  async webRenew(telegramId: string, packageType: SubscriptionType) {
    return this._renewUser(this._noAdminChat(), telegramId, packageType);
  }
  async webManualAdd(telegramId: string, packageType: SubscriptionType) {
    return this._handleManualAddInput(this._noAdminChat(), `${telegramId} ${packageType}`);
  }

  /** ادمین(های) تلگرامی را هم از اقدامات انجام‌شده در پنل وب مطلع می‌کند. */
  private _noAdminChat(): string {
    return this.config.LICENSE_ADMIN_IDS[0] || "";
  }

  getAllUsers(): LicenseUser[] {
    return this.store.getAll();
  }

  getStats() {
    return this.store.getStats();
  }

  /** تعیین/تغییر نام‌کاربری و رمز عبور ورود کاربر به پنل وب (توسط ادمین). */
  async setWebCredentials(telegramId: string, username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const user = this.store.getById(telegramId);
    if (!user) return { ok: false, error: "کاربر یافت نشد." };
    const clean = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(clean)) {
      return { ok: false, error: "نام کاربری باید ۳ تا ۳۲ کاراکتر انگلیسی/عدد باشد." };
    }
    if (password.length < 6) {
      return { ok: false, error: "رمز عبور باید حداقل ۶ کاراکتر باشد." };
    }
    const existing = this.store.getByWebUsername(clean);
    if (existing && existing.telegramId !== telegramId) {
      return { ok: false, error: "این نام کاربری قبلاً استفاده شده است." };
    }
    const { hash, salt } = hashPassword(password);
    user.webUsername = clean;
    user.webPasswordHash = hash;
    user.webPasswordSalt = salt;
    await this.store.upsert(user);
    return { ok: true };
  }

  findByWebUsername(username: string) {
    return this.store.getByWebUsername(username);
  }

  /** استفاده‌ی userTradeExecutor برای اطلاع‌رسانی نتیجه‌ی معاملات شخصی کاربر. */
  async notifyUserTrade(telegramId: string, message: string) {
    await this._send(telegramId, message);
  }

  // ─── ⏰ استفاده‌ی موتور هشدار/انقضا (فراخوانی از licenseScheduler) ──
  async sendExpiryWarning(user: LicenseUser) {
    await this._send(
      user.telegramId,
      `${msgHeader("⏳", "هشدار انقضای اشتراک")}\nکمتر از <b>۴۸ ساعت</b> به پایان اشتراک شما باقی مانده است.\n💡 برای جلوگیری از قطع دسترسی، همین حالا تمدید کنید.\n\n${brandFooter()}`,
      { inline_keyboard: [[{ text: "🔄 توضیحات تمدید", callback_data: "lic:pkg:__renew_info" }]] }
    );
  }

  async sendExpiredNotice(user: LicenseUser) {
    await this._send(
      user.telegramId,
      `${msgHeader("🔴", "اکانت شما منقضی شد")}\nدسترسی شما به امکانات ربات معامله‌گر قطع شد.\n🔑 برای ادامه، از دکمه‌ی «فعال‌سازی» تمدید کنید.\n\n${brandFooter()}`,
      this.keyboardFor(user.telegramId)
    );
  }
}
