/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { format } from "date-fns";
import { Config } from "./types";
import { WaterfallScanner } from "./scanner";
import { computeLedgerStats } from "./ledgerStats";
import { ASHIR_MAIN_KEYBOARD } from "./telegramReporter";
import { getDailyStats, getRecentDailyStats, formatDailyStatsMessage } from "./dailyStats";
import { getHourlyBuckets, pickBestHours, formatHourlyReportMessage } from "./hourlyStats";
import { LicenseManager } from "./licenseManager";

const PENDING_EDITS_FILE = path.join(process.cwd(), "pending_message_edits.json");
const KEYBOARD_ANCHOR_FILE = path.join(process.cwd(), "telegram_keyboard_anchor.json");
const EXPIRE_TEXT = "⏳ این گزارش منقضی شد. برای آمار به‌روز، دوباره از دکمه‌های پایین استفاده کن.";

/**
 * TelegramBotHandler — long-polls Telegram's getUpdates endpoint and answers the
 * "glass keyboard" (ReplyKeyboardMarkup) buttons shown under the chat input with
 * live, accurate data straight from the scanner (same numbers as the dashboard).
 *
 * Design goals (per user request: دقیق، بدون باگ، بدون هنگ کردن):
 *  - Never throws out of the polling loop: every iteration is wrapped in try/catch,
 *    so one bad network call or one malformed update can never kill/hang the bot.
 *  - Never blocks the scanner: this runs as its own independent async loop.
 *  - Uses the single shared `computeLedgerStats` helper — the exact same function
 *    used by /api/bot/status — so Telegram and the web dashboard can never disagree.
 */
export class TelegramBotHandler {
  private token: string;
  private chatId: string;
  private config: Config;
  private scanner: WaterfallScanner;
  private offset = 0;
  private running = false;
  private consecutiveErrors = 0;
  private licenseManager?: LicenseManager;
  private anchorMessageId: number | null = null;

  constructor(scanner: WaterfallScanner, config: Config, licenseManager?: LicenseManager) {
    this.scanner = scanner;
    this.config = config;
    this.token = config.TELEGRAM_TOKEN;
    this.chatId = String(config.TELEGRAM_CHAT_ID || "");
    this.licenseManager = licenseManager;
  }

  get enabled() {
    return !!(this.token && this.chatId);
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    // 🩹 Critical fix: if a webhook was EVER registered for this bot token (even
    // once, from an old deployment, a test curl command, or BotFather), Telegram
    // permanently blocks getUpdates() with a silent 409 "Conflict" error until the
    // webhook is explicitly deleted. sendMessage() keeps working fine either way —
    // which is exactly why signals/reports still arrive but button presses never
    // trigger a reply. We must clear it before the very first poll.
    this._recoverPendingEdits().catch((err) => {
      console.error("[TelegramBot] Failed to recover pending edits:", err);
    });
    this._ensureKeyboardAnchor().catch((err) => {
      console.error("[TelegramBot] Failed to ensure keyboard anchor:", err);
    });
    this._clearWebhookThenPoll();
  }

  /**
   * 📌 پیام «لنگر» کیبورد شیشه‌ای.
   *
   * تلگرام کیبورد شیشه‌ای (ReplyKeyboardMarkup) را، بعد از اولین ارسال،
   * تا وقتی که یک reply_markup جدید جایگزینش نکند، برای کاربر نمایش
   * می‌دهد — نیازی نیست هر پیام آن را حمل کند. پس فقط یک پیام کوچک و
   * ثابت («لنگر») را یک‌بار با کیبورد می‌فرستیم و هرگز آن را حذف یا
   * ویرایش نمی‌کنیم؛ تمام پیام‌های محتوایی بعدی بدون reply_markup
   * فرستاده می‌شوند و می‌توانند آزادانه بعد از ۱ دقیقه حذف شوند — بدون
   * این‌که هیچ‌وقت به لنگر (و در نتیجه به خودِ پنل شیشه‌ای) آسیبی برسد.
   */
  private async _ensureKeyboardAnchor() {
    if (!this.chatId) return;
    try {
      const raw = await fs.readFile(KEYBOARD_ANCHOR_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.[this.chatId]) {
        this.anchorMessageId = parsed[this.chatId];
        return; // لنگر از قبل وجود دارد؛ نیازی به ارسال دوباره نیست
      }
    } catch {
      // فایل هنوز وجود ندارد — اولین اجراست
    }

    try {
      const res = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: this.chatId,
          text: "🔘 <b>پنل کنترل اشیر ۴.۰ فعال است</b>\nاین پیام را نادیده بگیرید — فقط برای نگه‌داشتن دکمه‌های پایین صفحه است.",
          parse_mode: "HTML",
          reply_markup: ASHIR_MAIN_KEYBOARD,
        },
        { timeout: 15000 }
      );
      const messageId = res.data?.result?.message_id;
      if (messageId) {
        this.anchorMessageId = messageId;
        await fs.writeFile(KEYBOARD_ANCHOR_FILE, JSON.stringify({ [this.chatId]: messageId }), "utf-8");
      }
    } catch (e: any) {
      console.error("[TelegramBot] Failed to send keyboard anchor:", e.message || e);
    }
  }

  private async _clearWebhookThenPoll() {
    try {
      await axios.get(`https://api.telegram.org/bot${this.token}/deleteWebhook`, {
        params: { drop_pending_updates: false },
        timeout: 15000,
      });
    } catch (err: any) {
      console.error("[TelegramBot] deleteWebhook failed (continuing anyway):", err.message || err);
    }
    this._loop().catch((err) => {
      console.error("[TelegramBot] Polling loop crashed unexpectedly:", err);
      this.running = false;
    });
  }

  stop() {
    this.running = false;
  }

  private fmt(v: number) {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private formatPrice(v: number): string {
    if (!v) return "0.0000";
    if (v < 0.0001) return v.toFixed(8);
    if (v < 2) return v.toFixed(5);
    if (v < 10) return v.toFixed(4);
    return v.toFixed(2);
  }

  private async _loop() {
    while (this.running) {
      try {
        const res = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates`, {
          params: {
            offset: this.offset,
            timeout: 25,
            allowed_updates: JSON.stringify(["message", "callback_query"]),
          },
          timeout: 35000,
        });

        this.consecutiveErrors = 0;
        const updates = res.data?.result || [];
        for (const upd of updates) {
          // Always advance the offset even if a single update fails to process,
          // otherwise a single bad message would make the bot loop forever on it.
          this.offset = upd.update_id + 1;
          try {
            await this._handleUpdate(upd);
          } catch (handlerErr) {
            console.error("[TelegramBot] Failed to handle update:", handlerErr);
          }
        }
      } catch (err: any) {
        this.consecutiveErrors++;
        const backoff = Math.min(30000, 2000 * this.consecutiveErrors);
        const tgError = err?.response?.data?.description || err.message || err;
        console.error(`[TelegramBot] Poll error (retrying in ${backoff}ms): ${tgError}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private async _handleUpdate(upd: any) {
    // 🔑 دکمه‌های شیشه‌ای (Inline) سیستم لایسنس — تایید/رد ادمین، انتخاب
    // پکیج و غیره. این‌ها همیشه callback_query هستند، نه message.
    if (upd.callback_query) {
      if (this.licenseManager) {
        try {
          await this.licenseManager.handleCallbackQuery(upd.callback_query);
        } catch (err) {
          console.error("[TelegramBot] License callback handling failed:", err);
        }
      }
      return;
    }

    const msg = upd.message;
    const hasText = !!msg && typeof msg.text === "string";
    const hasPhoto = !!msg && Array.isArray(msg.photo) && msg.photo.length > 0;
    if (!msg || (!hasText && !hasPhoto)) return;

    const chatId = String(msg.chat?.id ?? "");

    // 🔑 هر پیام (متنی یا عکس) ابتدا به سیستم لایسنس/اشتراک پیشنهاد می‌شود
    // (عکس لازم است چون رسید پرداخت معمولاً یک تصویر است، نه متن):
    //  - از هر کاربری غیر از ادمین، همیشه توسط سیستم لایسنس مدیریت می‌شود
    //    (ثبت‌نام، فعال‌سازی، پنل حساب) و هرگز به پنل کنترل معاملاتی
    //    (که فقط باید در اختیار مالک ربات باشد) نشت نمی‌کند.
    //  - از چت ادمین، فقط دستورات مخصوص لایسنس (مثل «مدیریت اشتراک‌ها»)
    //    اینجا مصرف می‌شوند؛ در غیر این‌صورت کنترل به پنل معاملاتی زیر می‌رسد.
    if (this.licenseManager) {
      try {
        const handled = await this.licenseManager.handleMessage(msg);
        if (handled) return;
      } catch (err) {
        console.error("[TelegramBot] License message handling failed:", err);
      }
    }

    // پنل کنترل معاملاتی فقط دستورات متنی می‌فهمد — یک عکس بی‌ربط که توسط
    // سیستم لایسنس مدیریت نشده را بی‌صدا نادیده می‌گیرد.
    if (!hasText) return;

    // Only ever respond in the configured chat — never leak bot data to strangers
    // who happen to discover the bot's username.
    if (this.chatId && chatId !== this.chatId) return;

    const text = msg.text.trim();

    // 🧹 دستوری که کاربر از پنل شیشه‌ای می‌فرستد (مثلاً «پوزیشن‌های باز») هم
    // باید بعد از ۱ دقیقه پاک شود، نه فقط جواب ربات. برخلاف پیام‌های خود
    // ربات، پیام کاربر هیچ کیبورد شیشه‌ای‌ای را حمل نمی‌کند، پس اینجا حذف
    // واقعی (deleteMessage) کاملاً بی‌خطر است و مشکل جمع‌شدن کیبورد را ندارد.
    if (msg.message_id) {
      this._scheduleCleanup(chatId, msg.message_id, Date.now() + 60_000, "delete").catch(() => {});
    }

    await this._route(chatId, text);
  }

  private async _reply(chatId: string, text: string) {
    try {
      const res = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: chatId,
          text: text.slice(0, 4000),
          parse_mode: "HTML",
          // 🔘 عمداً reply_markup اینجا فرستاده نمی‌شود — کیبورد شیشه‌ای از
          // قبل توسط پیام «لنگر» (_ensureKeyboardAnchor) نمایش داده شده و
          // نیازی به تکرارش در هر پیام نیست. همین یعنی این پیام آزادانه و
          // بدون هیچ خطری برای کیبورد، بعد از ۱ دقیقه حذف می‌شود.
        },
        { timeout: 15000 }
      );

      // 🧹 هم دستور کاربر (در _handleUpdate) و هم همین جواب ربات، بعد از
      // ۱ دقیقه به‌طور کامل حذف می‌شوند. چون هیچ‌کدام reply_markup حمل
      // نمی‌کنند، حذفشان تأثیری روی پنل شیشه‌ای (که به پیام لنگر وصل است) ندارد.
      const messageId = res.data?.result?.message_id;
      if (messageId) {
        await this._scheduleCleanup(chatId, messageId, Date.now() + 60_000, "delete");
      }
    } catch (e: any) {
      console.error("[TelegramBot] Failed to send reply:", e.message || e);
    }
  }

  private async _loadPendingEdits(): Promise<{ chatId: string; messageId: number; dueAt: number; action: "edit" | "delete" }[]> {
    try {
      const raw = await fs.readFile(PENDING_EDITS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // سازگاری با فایل‌های قدیمی‌تر که فیلد action نداشتند (پیش‌فرض edit)
      return parsed.map((x: any) => ({ ...x, action: x.action === "delete" ? "delete" : "edit" }));
    } catch {
      return [];
    }
  }

  private async _savePendingEdits(list: { chatId: string; messageId: number; dueAt: number; action: "edit" | "delete" }[]): Promise<void> {
    try {
      await fs.writeFile(PENDING_EDITS_FILE, JSON.stringify(list));
    } catch (e) {
      console.error("[TelegramBot] Failed to persist pending edits:", e);
    }
  }

  private async _scheduleCleanup(chatId: string, messageId: number, dueAt: number, action: "edit" | "delete") {
    setTimeout(() => this._cleanupMessage(chatId, messageId, action), Math.max(0, dueAt - Date.now()));

    const list = await this._loadPendingEdits();
    list.push({ chatId, messageId, dueAt, action });
    await this._savePendingEdits(list);
  }

  private async _cleanupMessage(chatId: string, messageId: number, action: "edit" | "delete") {
    try {
      if (action === "delete") {
        // پیام دستور کاربر یا جواب ربات — حذف کامل، بی‌خطر است چون هیچ‌کدام
        // دیگر کیبورد شیشه‌ای را حمل نمی‌کنند (کیبورد فقط روی پیام لنگرِ
        // جداگانه است که هرگز لمس نمی‌شود).
        await axios.post(
          `https://api.telegram.org/bot${this.token}/deleteMessage`,
          { chat_id: chatId, message_id: messageId },
          { timeout: 10000 }
        );
      } else {
        // پیام خود ربات — فقط ویرایش متن، نه حذف، تا کیبورد شیشه‌ای جمع نشود.
        await axios.post(
          `https://api.telegram.org/bot${this.token}/editMessageText`,
          { chat_id: chatId, message_id: messageId, text: EXPIRE_TEXT },
          { timeout: 10000 }
        );
      }
    } catch (e) {
      // پیام ممکن است قبلاً توسط کاربر حذف شده باشد یا قدیمی‌تر از حد مجاز
      // تلگرام (۴۸ ساعت) باشد — در هر دو حالت بی‌ضرر است.
    }
    const list = await this._loadPendingEdits();
    const filtered = list.filter(x => !(x.chatId === chatId && x.messageId === messageId));
    await this._savePendingEdits(filtered);
  }

  /** هنگام روشن‌شدن ربات، هر پیام معلق (مثلاً به‌خاطر ری‌استارت سرور) را
   * دوباره زمان‌بندی می‌کند — عقب‌افتاده‌ها فوراً و بقیه در زمان باقی‌مانده. */
  private async _recoverPendingEdits() {
    const list = await this._loadPendingEdits();
    for (const item of list) {
      const delay = Math.max(0, item.dueAt - Date.now());
      setTimeout(() => this._cleanupMessage(item.chatId, item.messageId, item.action), delay);
    }
  }

  private async _route(chatId: string, text: string) {
    const s = this.scanner;

    // 📡 قبل از پاسخ به هر دکمه‌ای، قیمت زنده پوزیشن‌های باز را تازه می‌کنیم
    // تا سود/ضرر نمایش داده‌شده دقیقاً همان لحظه‌ی درخواست باشد، نه آخرین
    // مقدار کش‌شده از چرخه‌ی قبلی اسکن.
    try {
      await s.refreshOpenPositionsLive();
    } catch (e) {}

    if (text === "/start" || text === "/menu") {
      await this._reply(chatId, "🔘 <b>منوی اصلی اشیر ۴.۰</b>\n\nیکی از دکمه‌های پایین را انتخاب کن:");
      return;
    }

    if (text.includes("وضعیت کلی")) {
      await this._reply(chatId, this._buildOverallStatus());
      return;
    }
    if (text.includes("پوزیشن‌های باز") || text.includes("پوزیشن های باز")) {
      await this._reply(chatId, this._buildOpenPositions());
      return;
    }
    if (text.includes("آخرین معاملات")) {
      await this._reply(chatId, this._buildLastTrades());
      return;
    }
    if (text.includes("سود/ضرر") || text.includes("سود / ضرر")) {
      await this._reply(chatId, this._buildProfitLossSummary());
      return;
    }
    if (text.includes("ریسک و قفل سود") || text.includes("ریسک")) {
      await this._reply(chatId, this._buildRiskAndTrailing());
      return;
    }
    if (text.includes("چرا معامله باز نشد")) {
      await this._reply(chatId, this._buildRejectedSignals());
      return;
    }
    if (text.includes("گزارش تحلیل عملکرد") || text.includes("تحلیل عملکرد")) {
      await this._reply(chatId, this._buildPerformanceReport());
      return;
    }
    if (text.includes("آمار امروز")) {
      const entry = await getDailyStats();
      await this._reply(chatId, formatDailyStatsMessage(entry, "📅 آمار امروز"));
      return;
    }
    if (text.includes("آمار") && text.includes("روز")) {
      const days = await getRecentDailyStats(7);
      await this._reply(chatId, this._buildWeeklyStats(days));
      return;
    }
    if (text.includes("عملکرد ساعتی") || text.includes("ساعت‌های طلایی") || text.includes("ساعات طلایی")) {
      await this._reply(chatId, await this._buildHourlyPerformanceReport());
      return;
    }
    if (text.includes("حالت ساعات معاملاتی") || text.includes("حالت ساعت")) {
      await this._reply(chatId, await this._toggleTradingHoursMode());
      return;
    }

    // Unknown text: gently nudge back to the menu instead of staying silent
    await this._reply(chatId, "متوجه نشدم 🤔 لطفاً از دکمه‌های شیشه‌ای پایین صفحه استفاده کن.");
  }

  // ─── 📊 وضعیت کلی ──────────────────────────────────────────────
  private _buildOverallStatus(): string {
    const s = this.scanner;
    const activeEmoji = s.isRunning ? "🟢" : "🔴";
    const modeText = s.tradingMode === "real" ? "واقعی (Real)" : "شبیه‌سازی (Demo)";
    const balance = s.tradingMode === "real" ? s.realBalance : s.rm.capital;
    const openCount = s.orders.length;
    const committed = s.orders.reduce((sum, o) => sum + (o.position_value || 0), 0);
    const floatingPnl = s.orders.reduce((sum, o) => sum + (typeof o.pnl_usd === "number" ? o.pnl_usd : 0), 0);
    const liveEquity = balance + floatingPnl;
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);

    return `
📊 <b>وضعیت کلی ربات</b>
━━━━━━━━━━━━━━━━━━
اسکنر فعال است ${activeEmoji}
🏦 <b>حالت معاملاتی:</b> ${modeText}
💰 <b>موجودی ثبت‌شده:</b> $${this.fmt(balance)}
${floatingPnl !== 0 ? `${floatingPnl >= 0 ? "🟢" : "🔴"} <b>سود/ضرر شناور باز:</b> ${floatingPnl >= 0 ? "+" : ""}$${this.fmt(floatingPnl)}\n` : ""}💎 <b>دارایی کل لحظه‌ای:</b> $${this.fmt(liveEquity)}
📈 <b>پوزیشن‌های باز:</b> ${openCount}
💼 <b>درگیری سرمایه:</b> $${this.fmt(committed)}
🎯 <b>کل معاملات:</b> ${stats.totalClosed} | برد: ${stats.wins} (${stats.winRate.toFixed(1)}٪)
━━━━━━━━━━━━━━━━━━
🐉 اشیر ۴.۰ | ${format(new Date(), "HH:mm:ss")}
`.trim();
  }

  // ─── 📈 پوزیشن‌های باز ─────────────────────────────────────────
  private _buildOpenPositions(): string {
    const s = this.scanner;
    if (!s.orders || s.orders.length === 0) {
      return "📈 <b>پوزیشن‌های باز</b>\n━━━━━━━━━━━━━━━━━━\nهیچ معامله باز فعالی وجود ندارد.";
    }
    let out = `📈 <b>پوزیشن‌های باز (${s.orders.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const o of s.orders) {
      const pnlPct = typeof o.pnl_pct === "number" ? o.pnl_pct : 0;
      const pnlUsd = typeof o.pnl_usd === "number" ? o.pnl_usd : 0;
      const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
      const dirText = o.action === "buy" ? "LONG" : "SHORT";
      out += `${emoji} <b>${o.symbol}</b> (${dirText}${o.tp1_hit ? " | TP1 ✅" : ""})\n`;
      out += `   ورود: $${this.formatPrice(o.entry_price)} | فعلی: $${this.formatPrice(o.current_price || o.entry_price)}\n`;
      out += `   سود/ضرر: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}٪ ($${this.fmt(pnlUsd)})\n\n`;
    }
    return out.trim();
  }

  // ─── 🗂 آخرین معاملات ──────────────────────────────────────────
  private _buildLastTrades(): string {
    const s = this.scanner;
    const recent = (s.closedOrders || []).slice(0, 8);
    if (recent.length === 0) {
      return "🗂 <b>آخرین معاملات</b>\n━━━━━━━━━━━━━━━━━━\nهنوز هیچ معامله‌ای بسته نشده است.";
    }
    let out = `🗂 <b>${recent.length} معامله آخر بسته‌شده</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const o of recent) {
      const pnlPct = typeof o.pnl_pct === "number" ? o.pnl_pct : 0;
      const pnlUsd = typeof o.pnl_usd === "number" ? o.pnl_usd : 0;
      const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
      out += `${emoji} <b>${o.symbol}:</b> ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}٪ ($${pnlUsd >= 0 ? "+" : ""}${this.fmt(pnlUsd)}) — ${o.exit_reason || "نامشخص"}\n`;
    }
    return out.trim();
  }

  // ─── 💰 سود/ضرر کل ─────────────────────────────────────────────
  private _buildProfitLossSummary(): string {
    const s = this.scanner;
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);
    const isNet = stats.netUsd >= 0;

    let out = `💰 <b>سود/ضرر کل (Ledger)</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `✅ <b>موفقیت معاملات (Win Rate):</b> ${stats.winRate.toFixed(1)}٪ (${stats.wins} سود / ${stats.losses} ضرر از ${stats.totalClosed} معامله بسته‌شده)\n`;
    if (stats.defensiveSaves > 0) {
      out += `🛡 <b>خروج‌های اضطراری (نه برد، نه باخت):</b> ${stats.defensiveSaves} معامله (${stats.defensiveSavedUsd >= 0 ? "+" : ""}$${this.fmt(stats.defensiveSavedUsd)}) — جلوگیری از ضرر بزرگ‌تر، جزو وین‌ریت حساب نشده\n`;
    }
    out += `${isNet ? "🟢" : "🔴"} <b>عایدی خالص کل:</b> ${isNet ? "+" : ""}$${this.fmt(stats.netUsd)}\n`;
    out += `📈 <b>بازده تجمعی (ROI):</b> ${isNet ? "+" : ""}${stats.netPct.toFixed(2)}٪ (نسبت به سرمایه اولیه $${this.fmt(stats.baseCapital)})\n`;
    out += `⚖️ <b>فاکتور سود (Profit Factor):</b> ${stats.profitFactorLabel}\n`;
    if (stats.bestTrade) {
      out += `🏆 <b>بهترین معامله:</b> ${stats.bestTrade.symbol}: +$${stats.bestTrade.pnl_usd.toFixed(1)} (+${stats.bestTrade.pnl_pct.toFixed(1)}٪)\n`;
    }
    if (stats.worstTrade && stats.worstTrade.pnl_usd < 0) {
      out += `📉 <b>بدترین معامله:</b> ${stats.worstTrade.symbol}: $${stats.worstTrade.pnl_usd.toFixed(1)} (${stats.worstTrade.pnl_pct.toFixed(1)}٪)\n`;
    }
    out += `💵 <b>میانگین سود / ضرر:</b> +$${stats.avgWinUsd.toFixed(1)} / -$${stats.avgLossUsd.toFixed(1)}`;
    return out.trim();
  }

  // ─── 🛡️ ریسک و قفل سود ────────────────────────────────────────
  private _buildRiskAndTrailing(): string {
    const s = this.scanner;
    const cfg = this.config;
    const peak = s.rm.peak || cfg.BASE_CAPITAL;
    const capital = s.rm.capital;
    const drawdownPct = peak > 0 ? Math.max(0, (peak - capital) / peak) * 100 : 0;
    const maxDrawdownPct = cfg.MAX_DRAWDOWN * 100;

    let out = `🛡️ <b>ریسک و قفل سود</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `📉 <b>افت سرمایه فعلی:</b> ${drawdownPct.toFixed(2)}٪ (سقف مجاز: ${maxDrawdownPct.toFixed(0)}٪)\n`;
    out += `🔻 <b>باخت‌های متوالی:</b> ${s.consecutiveLosses}\n`;
    out += `⚡ <b>ضریب اهرم فعلی:</b> ${s.leverageMultiplier.toFixed(2)}x\n`;
    out += `🧭 <b>حساسیت تطبیقی:</b> ${s.adaptiveSensitivityOverride || "خودکار (Auto)"}\n`;
    out += `🔒 <b>قفل سود متحرک (Trailing Stop):</b> ${cfg.TRAILING_STOP_ENABLED ? "فعال ✅" : "غیرفعال ❌"}\n`;
    out += `🧠 <b>خروج هوشمند زودهنگام:</b> ${cfg.EARLY_LOSS_EXIT_ENABLED ? "فعال ✅" : "غیرفعال ❌"}\n`;

    const riskEntries = Object.entries(s.riskReductionMap || {});
    if (riskEntries.length > 0) {
      out += `\n⚠️ <b>نمادهای تحت محدودیت ریسک هوشمند (${riskEntries.length}):</b>\n`;
      for (const [symbol, info] of riskEntries.slice(0, 8)) {
        const remainMin = Math.max(0, Math.round((info.until - Date.now()) / 60000));
        out += `   • ${symbol}: ظرفیت ${(info.sizeFactor * 100).toFixed(0)}٪ | ${remainMin} دقیقه باقی‌مانده\n`;
      }
    } else {
      out += `\n✅ در حال حاضر هیچ نمادی تحت محدودیت ریسک نیست.`;
    }
    return out.trim();
  }

  // ─── 🔍 چرا معامله باز نشد؟ ────────────────────────────────────
  private _buildRejectedSignals(): string {
    const s = this.scanner;
    const recent = (s.rejectedSignals || []).slice(0, 8);
    if (recent.length === 0) {
      return "🔍 <b>چرا معامله باز نشد؟</b>\n━━━━━━━━━━━━━━━━━━\nهنوز هیچ سیگنالی رد نشده است (یا اطلاعاتی ثبت نشده).";
    }
    let out = `🔍 <b>آخرین سیگنال‌های رد شده (${recent.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const r of recent) {
      const t = r.time ? format(new Date(r.time), "HH:mm:ss") : "-";
      out += `❌ <b>${r.symbol}</b> (${r.action === "buy" ? "خرید" : "فروش"}) — امتیاز ${r.score.toFixed(2)} / آستانه ${r.threshold.toFixed(2)}\n   📝 ${r.reason} | ⏰ ${t}\n`;
    }
    return out.trim();
  }

  // ─── 🧾 گزارش تحلیل عملکرد ─────────────────────────────────────
  private _buildPerformanceReport(): string {
    const s = this.scanner;
    const logs = (s.diagnosticLogs || []).slice(0, 8);
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);

    let out = `🧾 <b>گزارش تحلیل عملکرد</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `📌 <b>راهبرد فعال:</b> ${s.strategy}\n`;
    out += `📌 <b>حساسیت فعال:</b> ${s.sensitivity}\n`;
    out += `🎯 <b>نرخ برد کلی:</b> ${stats.winRate.toFixed(1)}٪ از ${stats.totalClosed} معامله\n\n`;

    if (logs.length === 0) {
      out += "هنوز هیچ رویداد خودتشخیصی/تطبیقی ثبت نشده است.";
    } else {
      out += `🧠 <b>آخرین رویدادهای خودتطبیقی سیستم (${logs.length}):</b>\n`;
      for (const l of logs) {
        const t = l.time ? format(new Date(l.time), "HH:mm:ss") : "-";
        out += `• <b>${l.symbol}</b> [${l.type}] ${l.title} — ${l.actionTaken} | ⏰ ${t}\n`;
      }
    }
    return out.trim();
  }

  // ─── 🗓 آمار ۷ روز اخیر ────────────────────────────────────────
  private _buildWeeklyStats(days: { date: string; trades: number; wins: number; losses: number; profitUsd: number; lossUsd: number; profitPct: number; lossPct: number }[]): string {
    let out = `🗓 <b>آمار ۷ روز اخیر</b>\n━━━━━━━━━━━━━━━━━━\n`;
    let weekNet = 0;
    let weekTrades = 0;
    let weekWins = 0;
    for (const d of days) {
      const net = d.profitUsd - d.lossUsd;
      weekNet += net;
      weekTrades += d.trades;
      weekWins += d.wins;
      const dateLabel = new Date(d.date + "T12:00:00").toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran", month: "short", day: "numeric" });
      const emoji = net > 0 ? "🟢" : net < 0 ? "🔴" : "⚪";
      out += `${emoji} <b>${dateLabel}:</b> ${d.trades} معامله (${d.wins}✅/${d.losses}❌) — ${net >= 0 ? "+" : ""}$${net.toFixed(2)}\n`;
    }
    const weekWinRate = weekTrades > 0 ? (weekWins / weekTrades) * 100 : 0;
    out += `━━━━━━━━━━━━━━━━━━\n`;
    out += `📦 <b>جمع هفته:</b> ${weekTrades} معامله | وین‌ریت ${weekWinRate.toFixed(1)}٪ | ${weekNet >= 0 ? "🟢 +" : "🔴 "}$${weekNet.toFixed(2)}`;
    return out.trim();
  }

  // ─── ⏰ عملکرد ساعتی + ساعات طلایی پیشنهادی ─────────────────────
  private async _buildHourlyPerformanceReport(): Promise<string> {
    const buckets = await getHourlyBuckets();
    const best = pickBestHours(buckets);
    // کش اسکنر را هم تازه نگه می‌داریم تا گیت ورود معامله‌ی جدید همیشه از
    // جدیدترین محاسبه استفاده کند — دقیقاً همان چیزی که همین‌جا نمایش داده می‌شود.
    this.scanner.smartHoursCache = best;
    await this.scanner.saveState().catch(() => {});
    return formatHourlyReportMessage(buckets, best, this.scanner.tradingHoursMode);
  }

  // ─── 🎛 تغییر حالت: ۲۴/۷ یا فقط ساعات طلایی هوشمند ────────────────
  private async _toggleTradingHoursMode(): Promise<string> {
    const s = this.scanner;
    const newMode: "24_7" | "smart" = s.tradingHoursMode === "24_7" ? "smart" : "24_7";
    s.tradingHoursMode = newMode;

    let out = "";
    if (newMode === "24_7") {
      await s.saveState();
      out = `🌍 <b>حالت ۲۴/۷ فعال شد</b>\n━━━━━━━━━━━━━━━━━━\nربات از این پس در همه‌ی ساعات شبانه‌روز به دنبال سیگنال ورود جدید می‌گردد (بدون محدودیت ساعتی).\n\nℹ️ پوزیشن‌های باز فعلی طبق روال معمول مدیریت می‌شوند و این تغییر روی آن‌ها اثری ندارد.`;
    } else {
      const best = await s.refreshSmartHours();
      if (!best.sufficientData) {
        out = `🎯 <b>حالت «ساعات طلایی هوشمند» فعال شد</b>\n━━━━━━━━━━━━━━━━━━\n⚠️ ${best.reason}\n\nتا رسیدن به این حد نصاب، ربات موقتاً همچنان در همه‌ی ساعات معامله می‌کند تا داده‌ی کافی جمع شود؛ به‌محض کافی‌شدن نمونه، خودش محدودیت ساعتی را اعمال می‌کند.`;
      } else {
        const hourLabels = best.bestHours.map((h) => `${String(h).padStart(2, "0")}:00-${String((h + 1) % 24).padStart(2, "0")}:00`).join("، ");
        out = `🎯 <b>حالت «ساعات طلایی هوشمند» فعال شد</b>\n━━━━━━━━━━━━━━━━━━\nربات از این پس فقط در این ${best.bestHours.length} ساعت (به وقت تهران) پوزیشن جدید باز می‌کند:\n\n${hourLabels}\n\nℹ️ پوزیشن‌های باز فعلی طبق روال معمول مدیریت می‌شوند و این تغییر روی آن‌ها اثری ندارد. این محدوده هر ۲۴ ساعت خودکار بازمحاسبه می‌شود؛ برای آمار کامل از دکمه‌ی «⏰ عملکرد ساعتی» استفاده کن.`;
      }
    }
    return out;
  }
}
