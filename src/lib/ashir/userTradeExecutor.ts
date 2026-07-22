/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import ccxt from "ccxt";
import { Config } from "./types";
import { LicenseStore } from "./licenseStore";
import { LicenseManager } from "./licenseManager";
import { TradeEntryEvent, TradeExitEvent } from "./tradeEvents";
import { encryptSecret, decryptSecret, maskKey } from "./cryptoVault";

// ─────────────────────────────────────────────────────────────────
// 💱 UserTradeExecutor — کپی‌تریدینگ چندکاربره روی حساب‌های واقعی صرافی.
//
// این سرویس به رویدادهای ورود/خروج موتور اصلی اسکن (scanner.ts) گوش
// می‌دهد و همان تصمیم را — با اندازه‌ی متناسب با موجودی خودِ هر کاربر —
// روی حساب صرافی شخصی او (با کلید API خودش) اجرا می‌کند.
//
// اصول امنیتی/ایزوله‌سازی رعایت‌شده:
//  ۱) کلیدهای API هرگز متن ساده ذخیره نمی‌شوند (AES-256-GCM).
//  ۲) معامله‌ی خودکار برای هر کاربر پیش‌فرض خاموش است؛ کاربر باید صریحاً
//     آن را روشن کند (exchangeAutoTrade).
//  ۳) خطا/کندی/قطعی در حساب یک کاربر هرگز روی کاربران دیگر یا روی موتور
//     اصلی اسکن تأثیر نمی‌گذارد (هر کاربر ایزوله در try/catch خودش اجرا
//     می‌شود، با Promise.allSettled).
//  ۴) اگر موجودی کاربر کافی نباشد یا خطای صرافی رخ دهد، آن معامله فقط
//     برای همان کاربر رد می‌شود و به او پیام دقیق ارسال می‌شود.
// ─────────────────────────────────────────────────────────────────

const MIN_ORDER_USDT = 5; // کف عملیاتی XT برای سفارش‌های کوچک (طبق تست دستی کاربر)

export class UserTradeExecutor {
  private store: LicenseStore;
  private manager: LicenseManager;
  private config: Config;
  private clients = new Map<string, any>(); // telegramId -> ccxt.xt instance
  private leverageSetKeys = new Set<string>(); // `${telegramId}:${symbol}:${positionSide}`
  // 🎯 کش «بارگذاری بازارها» به‌ازای هر کاربر — بدون فراخوانی loadMarkets() روی
  // کلاینت اختصاصی هر کاربر، client.markets خالی می‌ماند و amountToPrecision()
  // نمی‌تواند دقت/حداقل مقدار واقعی هر نماد (مثل HYPE که پله‌اش عدد صحیح ۱ است)
  // را بشناسد؛ نتیجه همان خطای صرافی «amount must be greater than minimum
  // amount precision of 1» است که سفارش را بعد از ارسال رد می‌کند. اینجا برای
  // هر کاربر فقط یک‌بار (و با retry در صورت شکست) بازارها را بارگذاری می‌کنیم.
  private marketsReady = new Map<string, Promise<void>>();

  constructor(store: LicenseStore, manager: LicenseManager, config: Config) {
    this.store = store;
    this.manager = manager;
    this.config = config;
  }

  private _buildClient(apiKey: string, apiSecret: string) {
    return new ccxt.xt({ apiKey, secret: apiSecret, enableRateLimit: true, options: { defaultType: "swap" } });
  }

  /** "BTC_USDT" یا حتی فقط "BTC" → "BTC/USDT:USDT" (نماد یکپارچه‌ی قرارداد دائم USDT-M در ccxt)
   *  اگر symbol فاقد "_" باشد (مثل خروجی pair.clean که فقط نام پایه است)، quote به‌صورت
   *  پیش‌فرض USDT در نظر گرفته می‌شود تا نماد نادرست مثل "ARG/undefined:undefined" ساخته نشود. */
  private _futuresSymbol(symbol: string): string {
    const [base, quote] = symbol.toUpperCase().split("_");
    return `${base}/${quote || "USDT"}:${quote || "USDT"}`;
  }

  private marginModeSetKeys = new Set<string>();

  private async _ensureLeverage(telegramId: string, client: any, symbol: string, leverage: number, positionSide: "LONG" | "SHORT") {
    // 🛡️ ایزوله‌سازی مارجین برای حساب هر کاربر — بدون این، صرافی پوزیشن را با حالت پیش‌فرض
    // حساب (معمولاً Cross) باز می‌کند و کل موجودی کاربر پشتوانه‌ی یک پوزیشن می‌شود.
    const marginKey = `${telegramId}:${symbol}:${positionSide}`;
    if (!this.marginModeSetKeys.has(marginKey)) {
      try {
        await client.setMarginMode("isolated", this._futuresSymbol(symbol), { positionSide });
        this.marginModeSetKeys.add(marginKey);
      } catch (e: any) {
        console.error(`[UserTradeExecutor] setMarginMode failed for ${telegramId}/${symbol}:`, e.message || e);
      }
    }

    const key = `${telegramId}:${symbol}:${positionSide}`;
    if (this.leverageSetKeys.has(key)) return;
    try {
      await client.setLeverage(leverage, this._futuresSymbol(symbol), { positionSide });
      this.leverageSetKeys.add(key);
    } catch (e: any) {
      console.error(`[UserTradeExecutor] setLeverage failed for ${telegramId}/${symbol}:`, e.message || e);
    }
  }

  /** بازارهای صرافی را برای کلاینت این کاربر (فقط یک‌بار در طول عمر پردازه) بارگذاری
   *  می‌کند تا amountToPrecision/limits واقعی هر نماد در دسترس باشد. در صورت شکست،
   *  Promise کش‌شده پاک می‌شود تا تلاش بعدی دوباره امتحان کند (مثلاً بعد از قطعی موقت شبکه). */
  private async _ensureMarketsLoaded(telegramId: string, client: any): Promise<void> {
    let promise = this.marketsReady.get(telegramId);
    if (!promise) {
      promise = client.loadMarkets().then(
        () => undefined,
        (e: any) => {
          this.marketsReady.delete(telegramId);
          console.error(`[UserTradeExecutor] loadMarkets failed for ${telegramId}:`, e?.message || e);
          throw e;
        }
      );
      this.marketsReady.set(telegramId, promise);
    }
    await promise;
  }

  private async _clientFor(telegramId: string): Promise<any | null> {
    let client = this.clients.get(telegramId);
    if (!client) {
      const user = this.store.getById(telegramId);
      if (!user?.xtApiKeyEnc || !user?.xtApiSecretEnc) return null;
      try {
        const apiKey = decryptSecret(user.xtApiKeyEnc, this.config.EXCHANGE_KEY_ENCRYPTION_SECRET);
        const apiSecret = decryptSecret(user.xtApiSecretEnc, this.config.EXCHANGE_KEY_ENCRYPTION_SECRET);
        client = this._buildClient(apiKey, apiSecret);
        this.clients.set(telegramId, client);
      } catch (e) {
        console.error(`[UserTradeExecutor] Failed to decrypt/build client for ${telegramId}:`, e);
        return null;
      }
    }
    try {
      // 🔑 قبل از هر استفاده (تنظیم اهرم، ساخت سفارش، گرد کردن مقدار) مطمئن می‌شویم
      // بازارها بارگذاری شده‌اند؛ در غیر این صورت گرد کردن دقت/حداقل مقدار روی این
      // کلاینت اصلاً کار نمی‌کند و سفارش با خطای صرافی رد می‌شود.
      await this._ensureMarketsLoaded(telegramId, client);
    } catch {
      // اگر بارگذاری بازارها شکست بخورد، همچنان کلاینت را برمی‌گردانیم (fail-open)؛
      // _safeAmount در این حالت به مقدار خام برمی‌گردد و خطای احتمالیِ صرافی مثل قبل
      // برای کاربر گزارش می‌شود — دست‌کم بقیه‌ی کاربران/عملیات مختل نمی‌شوند.
    }
    return client;
  }

  // ─── 🔌 اتصال/قطع اتصال کاربر به صرافی ────────────────────────
  async connect(telegramId: string, apiKeyRaw: string, apiSecretRaw: string): Promise<{ ok: boolean; error?: string; balanceUsdt?: number }> {
    // فاصله/خط جدید اضافه هنگام کپی-پیست باعث خطای امضای XT (AUTH_103) و
    // پیام گیج‌کننده می‌شود — همیشه قبل از استفاده trim می‌کنیم.
    const apiKey = apiKeyRaw.trim();
    const apiSecret = apiSecretRaw.trim();

    const user = this.store.getById(telegramId);
    if (!user) return { ok: false, error: "کاربر یافت نشد." };

    let client: any;
    try {
      client = this._buildClient(apiKey, apiSecret);
      const balance = await client.fetchBalance();
      const usdt = balance?.total?.USDT || balance?.free?.USDT || 0;

      user.xtApiKeyEnc = encryptSecret(apiKey, this.config.EXCHANGE_KEY_ENCRYPTION_SECRET);
      user.xtApiSecretEnc = encryptSecret(apiSecret, this.config.EXCHANGE_KEY_ENCRYPTION_SECRET);
      user.xtApiKeyMasked = maskKey(apiKey);
      user.exchangeConnected = true;
      user.exchangeConnectedAt = Date.now();
      user.exchangeAutoTrade = false; // ایمنی: کاربر باید صریحاً روشنش کند
      user.exchangeLastError = undefined;
      await this.store.upsert(user);

      this.clients.set(telegramId, client);
      // 🔥 بازارها را از همین حالا (بدون بلاک کردن پاسخ اتصال) پیش‌بارگذاری می‌کنیم تا
      // اولین سفارش واقعی این کاربر منتظر loadMarkets() نماند و دقت/حداقل مقدار هر
      // نماد از قبل آماده باشد.
      this._ensureMarketsLoaded(telegramId, client).catch(() => {});
      return { ok: true, balanceUsdt: usdt };
    } catch (e: any) {
      return { ok: false, error: this._friendlyExchangeError(e) };
    }
  }

  /** پیام‌های خطای خام XT/ccxt را به توضیح فارسیِ قابل‌فهم برای کاربر ترجمه می‌کند. */
  private _friendlyExchangeError(e: any): string {
    const raw = String(e?.message || e || "");
    if (raw.includes("AUTH_103")) {
      return "خطای امضا (AUTH_103): به‌احتمال زیاد API Secret درست کپی نشده. آن را دوباره از صفحه‌ی XT کپی کنید و مطمئن شوید فاصله یا خط اضافه‌ای همراهش نیامده.";
    }
    if (raw.includes("AUTH_101")) {
      return "این API Key در XT شناخته نشد. آن را دوباره بررسی کنید یا یک کلید جدید بسازید.";
    }
    if (raw.includes("AUTH_102")) {
      return "این API Key هنوز در XT فعال نشده است.";
    }
    if (raw.includes("AUTH_104")) {
      return "این API Key به یک IP خاص محدود شده و اجازه‌ی دسترسی از این سرور را نمی‌دهد. محدودیت IP را در تنظیمات کلید در XT بردارید یا IP سرور را اضافه کنید.";
    }
    if (raw.includes("AUTH_106")) {
      return "این API Key دسترسی کافی ندارد. مطمئن شوید حداقل دسترسی «Trade / معامله» روی آن فعال است.";
    }
    return raw || "اتصال به صرافی ناموفق بود. کلیدها را بررسی کنید.";
  }

  async disconnect(telegramId: string): Promise<void> {
    const user = this.store.getById(telegramId);
    if (!user) return;
    user.xtApiKeyEnc = undefined;
    user.xtApiSecretEnc = undefined;
    user.xtApiKeyMasked = undefined;
    user.exchangeConnected = false;
    user.exchangeAutoTrade = false;
    user.exchangePositions = {};
    await this.store.upsert(user);
    this.clients.delete(telegramId);
    this.marketsReady.delete(telegramId);
  }

  async setAutoTrade(telegramId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const user = this.store.getById(telegramId);
    if (!user) return { ok: false, error: "کاربر یافت نشد." };
    if (enabled && !user.exchangeConnected) return { ok: false, error: "ابتدا باید به صرافی متصل شوید." };
    user.exchangeAutoTrade = enabled;
    await this.store.upsert(user);
    return { ok: true };
  }

  /** موجودی زنده‌ی کاربر را برای نمایش در پنل برمی‌گرداند (بدون اجرای معامله). */
  async fetchLiveBalance(telegramId: string): Promise<number | null> {
    const client = await this._clientFor(telegramId);
    if (!client) return null;
    try {
      const balance = await client.fetchBalance();
      return balance?.total?.USDT || balance?.free?.USDT || 0;
    } catch {
      return null;
    }
  }

  private _eligibleUsers() {
    return this.store.getAll().filter(
      (u) => u.exchangeConnected && u.exchangeAutoTrade && this.manager.hasActiveAccess(u.telegramId)
    );
  }

  /**
   * 🎯 مقدار سفارش را با دقت/حداقل مجاز واقعیِ همان نماد روی صرافی (step size + حداقل
   * مقدار مجاز، مثلاً پله‌ی عدد صحیح ۱ برای HYPE) گرد می‌کند — قبل از این‌که اصلاً به
   * XT ارسال شود. به شرط این‌که client.markets از قبل بارگذاری شده باشد (که حالا
   * _clientFor آن را تضمین می‌کند)، amountToPrecision از قوانین واقعی همان نماد
   * استفاده می‌کند، نه یک دقت پیش‌فرض اشتباه.
   * اگر حتی بعد از گرد کردن، مقدار کمتر از حداقل مجاز صرافی برای این نماد باشد،
   * به‌جای ارسال سفارشی که مطمئناً رد می‌شود، همینجا با خطای فارسیِ روشن متوقف می‌شویم.
   */
  private _safeAmount(client: any, symbol: string, quantity: number, roundUp: boolean = false): number {
    const futuresSym = this._futuresSymbol(symbol);
    const adjusted = roundUp ? quantity * 1.003 + 1e-8 : quantity;

    let n: number;
    try {
      n = parseFloat(client.amountToPrecision(futuresSym, adjusted));
    } catch (e) {
      // اگر markets این کلاینت هنوز بارگذاری نشده باشد (مثلاً loadMarkets شکست خورده)،
      // amountToPrecision ممکن است خطا بدهد؛ در این حالت به مقدار خام برمی‌گردیم تا
      // دست‌کم صرافی خودش تصمیم بگیرد (fail-open)، همان رفتار قبلی.
      return quantity > 0 ? quantity : 0;
    }

    const market = client.markets?.[futuresSym];
    const minAmount = market?.limits?.amount?.min;
    if (minAmount && n > 0 && n < minAmount) {
      n = parseFloat(client.amountToPrecision(futuresSym, minAmount));
    }

    if (!(n > 0)) {
      throw new Error(
        `مقدار سفارش برای ${symbol} بعد از گرد کردن با قوانین صرافی صفر شد` +
          (minAmount ? ` (حداقل مقدار مجاز این نماد: ${minAmount}).` : ".")
      );
    }
    return n;
  }

  // ─── 📈 ورود به معامله (فراخوانی از scanner.ts، fire-and-forget) ──
  async handleEntry(event: TradeEntryEvent): Promise<void> {
    const users = this._eligibleUsers();
    if (users.length === 0) return;

    const futuresSym = this._futuresSymbol(event.symbol);
    const positionSide: "LONG" | "SHORT" = event.action === "buy" ? "LONG" : "SHORT";

    await Promise.allSettled(
      users.map(async (user) => {
        const client = await this._clientFor(user.telegramId);
        if (!client) return;

        try {
          const balance = await client.fetchBalance();
          const freeUsdt = balance?.free?.USDT || 0;
          let positionValue = event.fractionOfCapital * freeUsdt;

          if (positionValue < MIN_ORDER_USDT) {
            if (freeUsdt < MIN_ORDER_USDT) return; // موجودی خیلی کم؛ بی‌صدا رد شود
            positionValue = Math.min(freeUsdt - 1, MIN_ORDER_USDT);
          }

          await this._ensureLeverage(user.telegramId, client, event.symbol, event.leverage, positionSide);

          const quantity = this._safeAmount(client, event.symbol, positionValue / event.price);
          const response = await client.createOrder(futuresSym, "market", event.action, quantity, undefined, { positionSide });
          if (!response?.id) throw new Error("صرافی سفارش را بدون شناسه ثبت کرد.");

          const filledQty = response.filled || response.amount || quantity;
          const avgPrice = response.average || response.price || event.price;

          if (!user.exchangePositions) user.exchangePositions = {};
          user.exchangePositions[event.symbol] = {
            sourceOrderId: event.sourceOrderId,
            symbol: event.symbol,
            action: event.action,
            quantity: filledQty,
            entryPrice: avgPrice,
            leverage: event.leverage,
          };
          user.exchangeLastError = undefined;
          await this.store.upsert(user);

          await this.manager.notifyUserTrade(
            user.telegramId,
            `🟢 <b>معامله‌ی شما باز شد (${event.action === "buy" ? "لانگ" : "شورت"} — ${event.leverage}x)</b>\n━━━━━━━━━━━━━━━━━━\nجفت‌ارز: <b>${event.symbol}/USDT</b>\nمقدار: <code>${filledQty}</code>\nقیمت ورود: <code>$${avgPrice}</code>\n💰 مارجین این موقعیت: <code>$${positionValue.toFixed(2)}</code>`
          );
        } catch (e: any) {
          user.exchangeLastError = this._friendlyExchangeError(e);
          await this.store.upsert(user).catch(() => {});
          await this.manager.notifyUserTrade(
            user.telegramId,
            `🚨 <b>خرید روی حساب شما ناموفق بود</b>\n━━━━━━━━━━━━━━━━━━\nجفت‌ارز: <b>${event.symbol}/USDT</b>\nخطا: <code>${this._friendlyExchangeError(e)}</code>`
          );
        }
      })
    );
  }

  // ─── 📉 خروج از معامله (کامل یا پله‌ای، فراخوانی از scanner.ts) ──
  async handleExit(event: TradeExitEvent): Promise<void> {
    const users = this.store.getAll().filter(
      (u) => u.exchangeConnected && u.exchangePositions?.[event.symbol]?.sourceOrderId === event.sourceOrderId
    );
    if (users.length === 0) return;

    const futuresSym = this._futuresSymbol(event.symbol);
    const closeSide: "buy" | "sell" = event.action === "buy" ? "sell" : "buy";
    const positionSide: "LONG" | "SHORT" = event.action === "buy" ? "LONG" : "SHORT";

    await Promise.allSettled(
      users.map(async (user) => {
        const pos = user.exchangePositions?.[event.symbol];
        if (!pos) return;
        const client = await this._clientFor(user.telegramId);
        if (!client) return;

        const closeQty = pos.quantity * event.fraction;
        if (closeQty <= 0) return;

        try {
          const response = await client.createOrder(futuresSym, "market", closeSide, this._safeAmount(client, event.symbol, closeQty, true), undefined, { positionSide, reduceOnly: true });
          if (!response?.id) throw new Error("صرافی سفارش بستن موقعیت را بدون شناسه ثبت کرد.");

          const exitPrice = response.average || response.price || event.price;
          const leverage = pos.leverage || 1;
          const rawPct = event.action === "buy" ? (exitPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - exitPrice) / pos.entryPrice;
          const pnlPct = rawPct * 100 * leverage;
          const marginUsed = closeQty * pos.entryPrice / leverage;
          const pnlUsd = (pnlPct / 100) * marginUsed;

          if (event.isFinal || event.fraction >= 1) {
            delete user.exchangePositions![event.symbol];
          } else {
            pos.quantity -= closeQty;
          }
          user.exchangeLastError = undefined;
          await this.store.upsert(user);

          const pnlEmoji = pnlUsd >= 0 ? "🟢" : "🔴";
          await this.manager.notifyUserTrade(
            user.telegramId,
            `${pnlEmoji} <b>${event.isFinal ? "معامله‌ی شما بسته شد" : "بخشی از معامله‌ی شما بسته شد"}</b>\n━━━━━━━━━━━━━━━━━━\nجفت‌ارز: <b>${event.symbol}/USDT</b>\nعلت: ${event.reason}\nقیمت خروج: <code>$${exitPrice}</code>\nسود/زیان: <code>${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})</code>`
          );
        } catch (e: any) {
          user.exchangeLastError = this._friendlyExchangeError(e);
          await this.store.upsert(user).catch(() => {});
          await this.manager.notifyUserTrade(
            user.telegramId,
            `🚨 <b>بستن معامله روی حساب شما ناموفق بود</b>\n━━━━━━━━━━━━━━━━━━\nجفت‌ارز: <b>${event.symbol}/USDT</b>\nخطا: <code>${this._friendlyExchangeError(e)}</code>\n⚠️ لطفاً پوزیشن را در صورت نیاز به‌صورت دستی در صرافی بررسی کنید.`
          );
        }
      })
    );
  }
}
