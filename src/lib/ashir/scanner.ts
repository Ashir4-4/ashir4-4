/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { XTClient } from "./xtClient";
import { SignalEngine } from "./signalEngine";
import { RiskManager } from "./riskManager";
import { TelegramReporter } from "./telegramReporter";
import { CorrelationManager } from "./correlationManager";
import { AdaptiveExitEngine } from "./adaptiveExitEngine";
import { PositionGuard } from "./positionGuard";
import { Config, Signal, Position } from "./types";
import { recordDailyPnl, recordDailyTradeResult, getDailyStats } from "./dailyStats";
import { recordHourlyTradeResult, getHourlyBuckets, pickBestHours, tehranHourOf, BestHoursResult } from "./hourlyStats";
import fs from "fs/promises";
import path from "path";
import ccxt from "ccxt";
import { TradeEntryEvent, TradeExitEvent } from "./tradeEvents";
import { classifyTradeOutcome } from "./tradeOutcome";

export class WaterfallScanner {
  private client: XTClient;
  private reporter: TelegramReporter;
  private config: Config;
  private engine = new SignalEngine();
  public rm: RiskManager;

  // 🔗 قلاب‌های رویداد معامله — برای کپی‌تریدینگ چندکاربره (userTradeExecutor.ts).
  // این‌ها فقط callback خام هستند؛ اسکنر هرگز مستقیماً به ماژول اجرای
  // چندکاربره import نمی‌کند تا وابستگی دوطرفه ایجاد نشود. فراخوانی این
  // callback ها هرگز await نمی‌شود و هر خطای داخلشان بی‌سروصدا catch
  // می‌شود، تا کندی یا خطای اجرای یک کاربر هرگز موتور اصلی اسکن را
  // کند یا خراب نکند.
  public onEntrySignal: ((e: TradeEntryEvent) => void) | null = null;
  public onExitSignal: ((e: TradeExitEvent) => void) | null = null;

  private _fireEntry(e: TradeEntryEvent) {
    try {
      this.onEntrySignal?.(e);
    } catch (err) {
      console.error("[WaterfallScanner] onEntrySignal handler threw:", err);
    }
  }
  private _fireExit(e: TradeExitEvent) {
    try {
      this.onExitSignal?.(e);
    } catch (err) {
      console.error("[WaterfallScanner] onExitSignal handler threw:", err);
    }
  }
  private corrMgr = new CorrelationManager();
  private exitEngine!: AdaptiveExitEngine;
  private positionGuard!: PositionGuard;
  public count = 0;
  public btcChange = 0;
  public orders: Position[] = [];
  public closedOrders: Position[] = [];
  public isRunning = false;
  public shouldBeRunning = true; // Tracks user intent (true = should stay active, false = explicitly stopped)
  public lastScanTime: number | null = null;
  public nextScanTime: number | null = null;
  public currentProgress = "";
  public lastError: string | null = null;
  public scanLogs: string[] = [];
  public isStateLoaded = false;
  public welcomeSent = false;
  private lastDailyReportDate = "";
  // 📊 Real (non-fake) performance metrics for the header tickertape:
  // measured from the actual most recent scan cycle.
  public lastScanDurationMs: number | null = null;
  public lastScanAssetCount = 0;
  public lastScanAssetsPerSec: number | null = null;
  private stateFilePath = path.join(process.cwd(), "ashir_state.json");

  // Adaptive Self-Correction & Diagnostics System
  public consecutiveLosses = 0;
  public adaptiveSensitivityOverride: "conservative" | "balanced" | "active" | null = null;
  public leverageMultiplier = 1.0;
  // 🧠 Smart Risk-Reduction Map (replaces the old hard "quarantine" block):
  // instead of fully banning a symbol/group from trading, each entry stores a
  // temporary risk-reduction factor (0..1, applied to position size & leverage)
  // and an extra confidence requirement that decays linearly back to zero by `until`.
  // The symbol stays scannable; the bot can still take an exceptionally strong
  // setup, but with reduced size and a higher bar to clear.
  public riskReductionMap: Record<string, { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }> = {};
  // 🚫 بلاک سخت و کامل (نه فقط کاهش حجم) برای ورود مجدد به یک نماد، بلافاصله
  // بعد از یک ضرر روی همان نماد. برخلاف riskReductionMap که فقط حجم را کم و
  // آستانه اعتماد را زیاد می‌کند (و اجازه‌ی ورود مجدد سریع می‌دهد)، این نقشه
  // برای مدتی کوتاه (پیش‌فرض ۳۰ دقیقه) اسکن ورود روی همان نماد را کاملاً
  // متوقف می‌کند تا از ورود پشت‌سرهم و پیاپی به یک نماد نوسانی/رنج جلوگیری شود
  // (مثل الگویی که در آرشیو ضررها دیده شد: دو ضرر پشت‌سرهم روی HBAR).
  public hardCooldownMap: Record<string, number> = {}; // symbol -> unblockAt (epoch ms)
  public diagnosticLogs: { id: string; time: number; symbol: string; type: string; title: string; message: string; actionTaken: string }[] = [];

  // Private live exchange configuration
  public apiKey = "";
  public secretKey = "";
  public tradingMode: "simulation" | "real" = "simulation";
  public realBalance = 0;
  public ccxtExchange: any = null;
  private _sensitivity: "conservative" | "balanced" | "active" | "auto_cortex" = "auto_cortex";
  public get sensitivity() {
    return this._sensitivity;
  }
  public set sensitivity(val: "conservative" | "balanced" | "active" | "auto_cortex") {
    this._sensitivity = val;
    if (val === "auto_cortex") {
      this.engine.sensitivity = this.calculateCortexDynamicSensitivity();
    } else {
      this.engine.sensitivity = val;
    }
  }
  private _disable9Layers = false;
  public get disable9Layers() {
    return this._disable9Layers;
  }
  public set disable9Layers(val: boolean) {
    this._disable9Layers = val;
    this.engine.disable9Layers = val;
  }
  public rejectedSignals: { symbol: string; action: string; score: number; threshold: number; reason: string; time: number }[] = [];

  // ⏰ Hourly Performance Guard: user can pick between running 24/7 or
  // restricting *new* position entries to only the hours the bot has
  // historically been most profitable in (existing open positions are never
  // force-closed by this — they keep being managed normally either way).
  public tradingHoursMode: "24_7" | "smart" = "24_7";
  public smartHoursCache: BestHoursResult | null = null;
  private smartHoursRefreshing = false;

  private _strategy: "strict_elitescalp" | "active_goldenscalp" | "auto_cortex" | "auto" = "auto_cortex";
  public get strategy() {
    return this._strategy;
  }
  public set strategy(val: "strict_elitescalp" | "active_goldenscalp" | "auto_cortex" | "auto") {
    this._strategy = val;
    if (val === "auto_cortex" || val === "auto") {
      this.engine.strategy = this.calculateCortexDynamicStrategy();
    } else {
      this.engine.strategy = val;
    }
  }

  private formatPrice(v: number): string {
    if (!v) return "0.0000";
    if (v < 0.0001) return v.toFixed(8);
    if (v < 2) return v.toFixed(5);
    if (v < 10) return v.toFixed(4);
    return v.toFixed(2);
  }

  private futuresSymbolSet: Set<string> = new Set();
  private futuresMarketsLoaded = false;

  public initCcxt() {
    if (this.apiKey && this.secretKey) {
      try {
        this.ccxtExchange = new ccxt.xt({
          apiKey: this.apiKey,
          secret: this.secretKey,
          enableRateLimit: true,
          options: { defaultType: "swap" }, // 💥 معاملات فیوچرز واقعی با اهرم — نه اسپات
        });
        this._addLog("سامانه معاملاتی واقعی فیوچرز XT (CCXT) با موفقیت پیاده‌سازی و راه‌اندازی شد.");
        this.updateRealBalance().catch(err => {
          this._addLog(`بخش دریافت دارایی واقعی با خطای اولیه مواجه شد: ${err.message || err}`);
        });
        // 📡 لیست تمام کوین‌هایی که واقعاً روی XT بازار فیوچرز (Swap) دارند را بارگذاری می‌کنیم.
        // بسیاری از کوین‌ها (مثل NOOK، ARG، TRUMP) فقط در بازار اسپات لیست شده‌اند و اصلاً
        // فیوچرز ندارند — قبل از این فیکس، ربات سعی می‌کرد رویشان معامله‌ی واقعی باز کند و
        // XT با خطای "does not have market symbol" رد می‌کرد. حالا این کوین‌ها از همان اول
        // برای معامله‌ی واقعی کنار گذاشته می‌شوند.
        this.ccxtExchange.loadMarkets().then((markets: any) => {
          this.futuresSymbolSet = new Set(
            Object.values(markets)
              .filter((m: any) => m && m.swap && m.quote === "USDT" && m.active !== false)
              .map((m: any) => String(m.base).toUpperCase())
          );
          this.futuresMarketsLoaded = true;
          this._addLog(`✅ لیست ${this.futuresSymbolSet.size} جفت‌ارز واقعیِ دارای بازار فیوچرز روی XT بارگذاری شد.`);
        }).catch((err: any) => {
          this._addLog(`⚠️ بارگذاری لیست بازارهای فیوچرز XT ناموفق بود؛ اعتبارسنجی زودهنگام نماد غیرفعال است: ${err.message || err}`);
        });
      } catch (err: any) {
        this._addLog(`خطا در تنظیم کلاینت واقعی صرافی: ${err.message || err}`);
      }
    } else {
      this.ccxtExchange = null;
    }
  }

  /** آیا این کوین (فقط نام پایه، مثل "NOOK") واقعاً روی XT بازار فیوچرز USDT-M دارد؟
   *  اگر لیست هنوز بارگذاری نشده باشد (مثلاً بلافاصله بعد از استارت)، برای جلوگیری از
   *  رد کاذب سیگنال‌ها، اجازه‌ی عبور داده می‌شود (fail-open) و صرافی خودش تصمیم نهایی را می‌گیرد. */
  private _hasRealFuturesMarket(symbol: string): boolean {
    if (!this.futuresMarketsLoaded) return true;
    const base = symbol.toUpperCase().split("_")[0];
    return this.futuresSymbolSet.has(base);
  }

  /** "BTC_USDT" یا حتی فقط "BTC" → "BTC/USDT:USDT" (نماد یکپارچه‌ی قرارداد دائم USDT-M در ccxt)
   *  اگر symbol فاقد "_" باشد (مثل خروجی pair.clean که فقط نام پایه است)، quote به‌صورت
   *  پیش‌فرض USDT در نظر گرفته می‌شود تا نماد نادرست مثل "ARG/undefined:undefined" ساخته نشود. */
  private _futuresSymbol(symbol: string): string {
    const [base, quote] = symbol.toUpperCase().split("_");
    return `${base}/${quote || "USDT"}:${quote || "USDT"}`;
  }

  /**
   * 📡 قیمت لحظه‌ای واقعی را مستقیماً از بازار فیوچرز/سواپ (همان بازاری که پوزیشن واقعی آنجا
   * باز شده) می‌گیرد — نه از تیکر اسپات. قیمت اسپات و فیوچرز هرچند معمولاً نزدیک‌اند، اختلاف
   * کوچکشان (بیسیس/فاندینگ) وقتی در اهرم (مثلاً ۲۰x) ضرب شود، می‌تواند سود/زیان نمایشی ربات
   * را به‌طرز محسوسی از سود/زیان واقعیِ نمایش‌داده‌شده در صرافی متفاوت کند.
   */
  private async _getRealFuturesPrice(symbol: string): Promise<number | null> {
    if (!this.ccxtExchange) return null;
    try {
      const ticker = await this.ccxtExchange.fetchTicker(this._futuresSymbol(symbol));
      // 🎯 صرافی سود/زیان و لیکوییدیشن را بر اساس Mark Price محاسبه می‌کند (نه آخرین
      // قیمت معامله‌شده)، پس ربات هم باید همان اولویت را رعایت کند تا PnL نمایشی
      // دقیقاً با همان عددی که روی صرافی دیده می‌شود همخوانی داشته باشد. «last» فقط
      // به‌عنوان جایگزین (وقتی mark در دسترس نیست) استفاده می‌شود.
      return ticker?.mark || ticker?.info?.markPrice || ticker?.last || ticker?.close || null;
    } catch (e) {
      return null; // در صورت خطا، صدازننده به قیمت اسپات به‌عنوان جایگزین برمی‌گردد
    }
  }

  /**
   * 🎯 اطلاعات واقعی و قطعیِ پوزیشن باز را مستقیماً از خودِ صرافی می‌خواند (entryPrice,
   * markPrice, unrealizedPnl, percentage) — دقیقاً همان اعدادی که XT خودش در پنل کاربری
   * نمایش می‌دهد. برخلاف محاسبه‌ی دستی PnL از روی entry ذخیره‌شده در ربات و آخرین قیمت
   * تیکر (که به‌خاطر لغزش قیمت ورود یا اختلاف last/mark می‌تواند منحرف شود)، این تابع
   * منبع حقیقت را مستقیماً از صرافی می‌گیرد، پس نتیجه با نمایش صرافی یکسان خواهد بود.
   */
  private async _getRealPositionSnapshot(
    symbol: string,
    positionSide: "LONG" | "SHORT"
  ): Promise<{ entryPrice: number; markPrice: number; unrealizedPnl: number; percentage: number | null } | null> {
    if (!this.ccxtExchange) return null;
    try {
      const futuresSym = this._futuresSymbol(symbol);
      const positions = await this.ccxtExchange.fetchPositions([futuresSym]);
      const wantedSide = positionSide === "LONG" ? "long" : "short";
      const pos = (positions || []).find((p: any) => {
        const sameSymbol = p.symbol === futuresSym;
        const side = (p.side || p.info?.positionSide || "").toString().toLowerCase();
        const hasSize = Math.abs(Number(p.contracts ?? p.info?.positionAmt ?? 0)) > 0;
        return sameSymbol && hasSize && (!side || side === wantedSide || side === "both");
      });
      if (!pos) return null;
      const entryPrice = Number(pos.entryPrice ?? pos.info?.entryPrice ?? pos.info?.avgPrice ?? 0);
      const markPrice = Number(pos.markPrice ?? pos.info?.markPrice ?? 0);
      const unrealizedPnl = Number(pos.unrealizedPnl ?? pos.info?.unrealizedProfit ?? pos.info?.unrealizedPnl ?? 0);
      const percentage = pos.percentage !== undefined && pos.percentage !== null ? Number(pos.percentage) : null;
      if (!entryPrice || entryPrice <= 0) return null;
      return { entryPrice, markPrice, unrealizedPnl, percentage };
    } catch (e) {
      return null; // در صورت خطا، صدازننده به مقادیر محاسبه‌شده‌ی داخلی به‌عنوان جایگزین برمی‌گردد
    }
  }

  /**
   * 🎯 مقدار (quantity) هر سفارش واقعی را با دقت مجاز صرافی (step size / lot size)
   * برای همان نماد گرد می‌کند. بدون این کار، اعدادی مثل نتیجه‌ی محاسبات ممیز شناور
   * جاوااسکریپت (مثلاً 0.19999999999999998 به‌جای 0.2) یا اعداد با تعداد اعشار بیش
   * از حد مجاز، می‌توانند توسط XT با خطای دقت/lot-size رد شوند — این می‌تواند علت
   * پنهانِ شکست خوردن سفارش‌های ورود *و* هر نوع سفارش خروج (قفل سود، خروج هوشمند،
   * کاهش حجم، بستن نهایی) باشد، چون همه از همین مسیر عبور می‌کنند.
   */
  // 🎯 کش «بارگذاری بازارها» برای کلاینت واقعی صرافی (this.ccxtExchange). initCcxt()
  // یک‌بار loadMarkets() را فراخوانی می‌کند ولی بدون await (fire-and-forget)، پس اگر
  // اولین سیگنال معاملاتی خیلی زود بعد از استارت ربات برسد، ممکن است هنوز markets
  // بارگذاری نشده باشد و amountToPrecision() به‌جای دقت/حداقل واقعی هر نماد، یک دقت
  // پیش‌فرض نادرست به کار ببرد (که دقیقاً همان خطای «amount must be greater than
  // minimum amount precision» بعد از ارسال سفارش را به همراه دارد). این متد کمکی
  // تضمین می‌کند که قبل از هر گرد کردنی، بازارها واقعاً بارگذاری شده باشند.
  private _mainMarketsReady: Promise<void> | null = null;
  private async _ensureMainMarketsLoaded(): Promise<void> {
    if (!this.ccxtExchange) return;
    if (!this._mainMarketsReady) {
      this._mainMarketsReady = this.ccxtExchange.loadMarkets().then(
        () => undefined,
        (e: any) => {
          this._mainMarketsReady = null;
          throw e;
        }
      );
    }
    await this._mainMarketsReady;
  }

  /**
   * 🎯 مقدار سفارش را با دقت/حداقل مجاز واقعیِ همان نماد روی صرافی گرد می‌کند — قبل از
   * ارسال به XT. برای نمادهایی که پله‌شان عدد صحیح است (مثل HYPE با پله‌ی ۱)، بدون این
   * تابع، گرد کردن رو-به-پایینِ پیش‌فرض ccxt می‌تواند مقدار را به صفر برساند و صرافی با
   * خطای «amount must be greater than minimum amount precision» سفارش را رد کند. اینجا
   * علاوه بر گرد کردن، اگر نتیجه هنوز کمتر از حداقل مجاز نماد باشد، به همان حداقل ارتقا
   * داده می‌شود تا سفارش از همان ابتدا با قوانین واقعی صرافی هم‌خوان باشد.
   */
  private async _safeAmount(symbol: string, quantity: number, roundUp: boolean = false): Promise<number> {
    if (!this.ccxtExchange) return quantity;
    try {
      await this._ensureMainMarketsLoaded();
    } catch {
      // بارگذاری بازارها شکست خورد؛ fail-open و ادامه با رفتار قبلی (amountToPrecision
      // ممکن است دقت نادرست به کار ببرد، اما دست‌کم جریان معامله کاملاً متوقف نمی‌شود).
    }
    try {
      // 🎯 برای سفارش‌های "بستن" (reduceOnly)، کمی به مقدار خام قبل از گرد کردن اضافه
      // می‌کنیم (۰.۳٪ + یک epsilon ناچیز). چون amountToPrecision معمولاً رو به پایین
      // (truncate) گرد می‌کند، بدون این سرریز کوچک، مقدار می‌تواند کمی کمتر از پوزیشن
      // واقعی باز روی صرافی شود و XT با خطای "insufficient_leveling_quantity" رد کند.
      // چون این سفارش‌ها reduceOnly هستند، خودِ صرافی مقدار مازاد را به‌طور خودکار به
      // سقف پوزیشن باز محدود می‌کند؛ پس این سرریز کوچک کاملاً بی‌خطر است.
      const futuresSym = this._futuresSymbol(symbol);
      const adjusted = roundUp ? quantity * 1.003 + 1e-8 : quantity;
      let n = parseFloat(this.ccxtExchange.amountToPrecision(futuresSym, adjusted));

      // 🛡️ حداقل مقدار واقعی مجاز این نماد را از خودِ market بررسی می‌کنیم. اگر مقدار
      // گرد‌شده هنوز کمتر از آن باشد (مثل truncate شدن به صفر برای نمادی با پله‌ی ۱)،
      // به‌جای اجازه دادن به رد شدن قطعی سفارش توسط صرافی، همینجا به حداقل مجاز ارتقا
      // می‌دهیم.
      const market = this.ccxtExchange.markets?.[futuresSym];
      const minAmount = market?.limits?.amount?.min;
      if (minAmount && n > 0 && n < minAmount) {
        n = parseFloat(this.ccxtExchange.amountToPrecision(futuresSym, minAmount));
      }

      return n > 0 ? n : quantity;
    } catch (e) {
      return quantity;
    }
  }

  /**
   * 🎯 مقدار واقعیِ باز روی صرافی برای این پوزیشن را مستقیماً از XT می‌خواند (نه از
   * ردیابی داخلی ربات). این دقیق‌ترین و «قطعی‌ترین» راه برای بستن است: به‌جای حدس زدن یا
   * گرد کردن سرریزی (که خودش می‌تواند باعث خطای "insufficient_balance" شود چون مقداری
   * بیشتر از پوزیشن واقعی درخواست می‌کند)، دقیقاً همان مقداری که صرافی می‌گوید باز است
   * (یا کسری مشخص از آن) درخواست می‌شود.
   */
  private async _getRealOpenPositionAmount(symbol: string, positionSide: "LONG" | "SHORT"): Promise<number | null> {
    if (!this.ccxtExchange) return null;
    try {
      const futuresSym = this._futuresSymbol(symbol);
      const positions = await this.ccxtExchange.fetchPositions([futuresSym]);
      const wantedSide = positionSide === "LONG" ? "long" : "short";
      const pos = (positions || []).find((p: any) => {
        const sameSymbol = p.symbol === futuresSym;
        const side = (p.side || p.info?.positionSide || "").toString().toLowerCase();
        return sameSymbol && (!side || side === wantedSide || side === "both");
      });
      const raw = pos?.contracts ?? pos?.contractSize ?? parseFloat(pos?.info?.positionAmt ?? pos?.info?.qty ?? pos?.info?.amount ?? "0");
      const amt = Math.abs(Number(raw));
      return amt > 0 ? amt : null;
    } catch (e) {
      return null; // در صورت خطا، صدازننده به مقدار محاسبه‌شده‌ی داخلی به‌عنوان جایگزین برمی‌گردد
    }
  }
  private leverageSetKeys = new Set<string>();
  private appliedLeverage = new Map<string, number>();
  private marginModeSetKeys = new Set<string>();
  /**
   * قبل از هر ورود جدید، اهرم واقعی روی صرافی برای همان جفت‌ارز/جهت تنظیم می‌شود
   * (فقط یک‌بار به ازای هر ترکیب). برخلاف نسخه‌ی قبلی که در صورت شکست فقط یک هشدار
   * لاگ می‌کرد و بی‌خیال ادامه می‌داد (باعث ناهماهنگی «ربات ۲۰x ولی صرافی ۱۰x» می‌شد)،
   * این نسخه **همیشه مقدار اهرمی که واقعاً روی صرافی تایید و اعمال شده را برمی‌گرداند**
   * تا کل بقیه‌ی سیستم (نمایش، محاسبه‌ی حجم سفارش، ذخیره‌سازی پوزیشن) دقیقاً همان عدد
   * واقعی را استفاده کند، نه عددی که فقط *امید* داشتیم اعمال شده باشد.
   */
  private async _ensureLeverage(symbol: string, leverage: number, positionSide: "LONG" | "SHORT"): Promise<number> {
    if (!this.ccxtExchange) return leverage;

    // 🛡️ ایزوله‌سازی مارجین: بدون این تنظیم صریح، XT پوزیشن را با حالت پیش‌فرض حساب (که
    // معمولاً Cross است) باز می‌کند — یعنی کل موجودی حساب فیوچرز به‌عنوان مارجین پشتیبان
    // این یک پوزیشن قرار می‌گیرد و ریسک یک معامله می‌تواند کل حساب را درگیر کند.
    const marginKey = `${symbol}:${positionSide}`;
    if (!this.marginModeSetKeys.has(marginKey)) {
      try {
        await this.ccxtExchange.setMarginMode("isolated", this._futuresSymbol(symbol), { positionSide });
        this.marginModeSetKeys.add(marginKey);
      } catch (e: any) {
        // اگر پوزیشن قبلاً باز است یا صرافی همین حالت را از قبل داشته، معمولاً خطا می‌دهد؛
        // بی‌خطر است و فقط لاگ می‌شود، مانع اجرای معامله نمی‌شود.
        this._addLog(`⚠️ تنظیم حالت مارجین ایزوله برای ${symbol} ناموفق بود (ممکن است از قبل ایزوله باشد): ${e.message || e}`);
      }
    }

    const key = `${symbol}:${positionSide}`;
    if (this.leverageSetKeys.has(key)) {
      return this.appliedLeverage.get(key) ?? leverage;
    }

    try {
      await this.ccxtExchange.setLeverage(leverage, this._futuresSymbol(symbol), { positionSide });
      this.leverageSetKeys.add(key);
      this.appliedLeverage.set(key, leverage);
      return leverage;
    } catch (e: any) {
      // اگر رد شد (معمولاً چون این کوین حداکثر اهرم مجاز کمتری دارد)، حداکثر مجاز را از
      // متادیتای بازار می‌خوانیم و دقیقاً با همان مقدار واقعی دوباره تلاش می‌کنیم.
      try {
        const market = this.ccxtExchange.market(this._futuresSymbol(symbol));
        const maxLev = market?.limits?.leverage?.max;
        if (maxLev && maxLev > 0 && maxLev < leverage) {
          await this.ccxtExchange.setLeverage(maxLev, this._futuresSymbol(symbol), { positionSide });
          this.leverageSetKeys.add(key);
          this.appliedLeverage.set(key, maxLev);
          this._addLog(`⚠️ اهرم ${symbol} چون ${leverage}x بیشتر از حداکثر مجاز صرافی بود، به ${maxLev}x (حداکثر واقعی XT) تنظیم شد.`);
          return maxLev;
        }
      } catch (e2) {
        // نادیده گرفته می‌شود؛ به مسیر خطای اصلی زیر می‌رویم
      }
      // نتوانستیم هیچ مقدار تاییدشده‌ای از صرافی بگیریم — به‌جای باز کردن معامله با یک
      // اهرم فرضی که ممکن است با واقعیت صرافی فرق کند، معامله را کاملاً لغو می‌کنیم.
      this._addLog(`❌ تنظیم اهرم واقعی برای ${symbol} ناموفق بود؛ برای جلوگیری از ناهماهنگی بین ربات و صرافی، این معامله لغو شد: ${e.message || e}`);
      throw new Error(`تنظیم اهرم واقعی روی صرافی برای ${symbol} ناموفق بود: ${e.message || e}`);
    }
  }

  public async updateRealBalance() {
    if (this.tradingMode === "real" && this.ccxtExchange) {
      try {
        const balance = await this.ccxtExchange.fetchBalance();
        this.realBalance = balance?.total?.USDT || balance?.free?.USDT || 0;
        this._addLog(`[حساب واقعی] همگام‌سازی مانده حساب با ثبات: ${this.realBalance.toFixed(2)} USDT`);
      } catch (e: any) {
        console.error("Failed to fetch balance from XT exchange:", e.message || e);
      }
    }
  }

  public async closeActivePosition(orderId: string, currentPrice: number, exitReason: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order || order.status === "closed") return;

    // Remove from active list and set status immediately to prevent any concurrent race conditions
    order.status = "closed";
    this.orders = this.orders.filter(o => o.id !== orderId);
    this.exitEngine.clear(orderId);
    this.positionGuard.clear(orderId);

    let actualExitPrice = currentPrice;
    let isRealExitSuccess = true;

    if (this.tradingMode === "real") {
      this._addLog(`🚨 [REAL MODE] Triggering REAL FUTURES ${order.action === "buy" ? "SELL" : "BUY"} to close ${order.symbol} position...`);
      try {
        if (!this.ccxtExchange) {
          throw new Error("Private exchange client not initialized.");
        }
        const futuresSym = this._futuresSymbol(order.symbol);
        const closeSide: "buy" | "sell" = order.action === "buy" ? "sell" : "buy";
        const positionSide: "LONG" | "SHORT" = order.action === "buy" ? "LONG" : "SHORT";
        // 🎯 اول سعی می‌کنیم مقدار واقعی باز روی صرافی را مستقیماً بخوانیم (قطعی‌ترین حالت)؛
        // اگر موفق نشدیم، به مقدار محاسبه‌شده‌ی داخلی (با سرریز ایمنی کوچک) برمی‌گردیم.
        const realAmt = await this._getRealOpenPositionAmount(order.symbol, positionSide);
        const closeQtyRaw = realAmt ?? order.quantity;
        const closeQty = realAmt
          ? await this._safeAmount(order.symbol, closeQtyRaw, false) // عدد واقعی صرافی؛ نیازی به سرریز نیست
          : await this._safeAmount(order.symbol, closeQtyRaw, true);  // فقط تخمین داخلی؛ سرریز ایمنی لازم است
        const response = await this.ccxtExchange.createOrder(futuresSym, "market", closeSide, closeQty, undefined, { positionSide, reduceOnly: true });
        if (response && response.id) {
          actualExitPrice = response.average || response.price || currentPrice;
          this._addLog(`✅ XT Real Market Sell filled! Order ID: ${response.id}. Exit Price: ${actualExitPrice}`);
        }
      } catch (err: any) {
        isRealExitSuccess = false;
        order.status = "filled"; // Revert status

        // Re-insert order back into active orders list since exit failed
        if (!this.orders.some(o => o.id === orderId)) {
          this.orders.push(order);
        }

        const msg = `❌ [REAL EXIT FAILED] Failed to exit live order for ${order.symbol}: ${err.message || err}`;
        this._addLog(msg);
        await this.reporter.send(`🚨🚨 <b>توجه! خطا در فروش/بستن پوزیشن واقعی!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nعلت بستن: <code>${exitReason}</code>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ <b>لطفاً پوزیشن فوق را به صورت دستی در پنل صرافی ببندید!</b>`);
        throw err;
      }
    }

    if (isRealExitSuccess) {
      order.exit_price = actualExitPrice;
      order.closed_at = Date.now();

      // 🔗 اطلاع به موتور کپی‌تریدینگ چندکاربره — بستن کامل موقعیت.
      this._fireExit({
        type: "exit",
        sourceOrderId: order.id,
        symbol: order.symbol,
        action: order.action,
        price: actualExitPrice,
        fraction: 1,
        isFinal: true,
        reason: exitReason,
      });

      // Improve exit reason messaging when exit happens at Breakeven/Risk-Free entry price after a successful TP1 hit
      let adjustedReason = exitReason;
      if (order.tp1_hit && exitReason === "Stop Loss (حد ضرر)") {
        adjustedReason = "حد ضرر در نقطه ورود (ریسک فری)";
      }
      order.exit_reason = adjustedReason;

      let finalPnl = 0;
      if (order.action === "buy") {
        finalPnl = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
      } else {
        finalPnl = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
      }

      const tp2_pnl_pct = finalPnl;
      const tp2_pnl_usd = (tp2_pnl_pct / 100) * order.position_value;

      let total_pnl_pct = 0;
      let total_pnl_usd = 0;

      if (order.tp1_hit) {
        total_pnl_usd = (order.tp1_pnl_usd || 0) + tp2_pnl_usd;
        total_pnl_pct = ((order.tp1_pnl_pct || 0) + tp2_pnl_pct) / 2;
      } else {
        total_pnl_usd = tp2_pnl_usd;
        total_pnl_pct = tp2_pnl_pct;
      }

      order.tp2_pnl_pct = tp2_pnl_pct;
      order.tp2_pnl_usd = tp2_pnl_usd;
      order.pnl_pct = total_pnl_pct;
      order.pnl_usd = total_pnl_usd;

      const outcome = classifyTradeOutcome(order);
      order.outcome = outcome;
      const isWin = outcome === "win";
      this.rm.totalTrades += 1;
      if (isWin) this.rm.winTrades += 1;

      try {
        this.engine.recordTrade(order.sub_signals, order.action, isWin ? "win" : "loss");
      } catch (e) {}

      // 📅 ثبت آمار روزانه: تعداد معامله فقط یک‌بار در بستن نهایی شمرده می‌شود،
      // اما مبلغ دلاری/درصدی فقط سهم تارگت۲ (tp2) ثبت می‌شود چون سهم تارگت۱
      // (در صورت وجود) از قبل هنگام رسیدن به تارگت۱ ثبت شده است.
      try {
        await recordDailyTradeResult(isWin);
        const baseCap = this.config.BASE_CAPITAL || 1000;
        await recordDailyPnl(tp2_pnl_usd, (tp2_pnl_usd / baseCap) * 100);
      } catch (e) {}

      // ⏰ ثبت آمار ساعتی: هر معامله فقط یک‌بار، در لحظه‌ی بسته‌شدن نهایی
      // (با سود/ضرر دلاری کل معامله)، تا بعداً بشود بهترین/بدترین ساعت‌های
      // معاملاتی روز را استخراج کرد.
      try {
        await recordHourlyTradeResult(total_pnl_usd, order.closed_at || Date.now(), isWin);
      } catch (e) {}

      if (this.tradingMode === "real") {
        await this.updateRealBalance();
        this.rm.capital = Math.max(0.01, this.realBalance); // 🎯 بدون کف کاذب؛ دقیقاً همان موجودی واقعی صرافی (فقط epsilon برای جلوگیری از تقسیم بر صفر)
      } else {
        // TP1 already added order.tp1_pnl_usd to balance when TP1 was hit.
        // We only add the remaining tp2 portion here!
        this.rm.capital = Math.max(10, this.rm.capital + tp2_pnl_usd);
      }

      this.closedOrders.unshift(order);
      if (this.closedOrders.length > 100) {
        this.closedOrders = this.closedOrders.slice(0, 100);
      }

      this._addLog(`🚨 EXIT COMPLETE: ${order.symbol} closed. PnL: ${total_pnl_pct.toFixed(2)}% ($${total_pnl_usd.toFixed(2)})`);
      
      // Execute the adaptive self-correction & diagnostics routine
      try {
        await this.autoDiagnoseAndAdapt(order, total_pnl_pct, total_pnl_usd);
      } catch (diagErr) {
        console.error("Error in diagnostics adaptation loop:", diagErr);
      }

      await this.saveState();

      let reportMsg = "";
      const exitEmoji = total_pnl_usd >= 0 ? "🟢" : "🔴";

      if (order.tp1_hit) {
        reportMsg = `
${exitEmoji} <b>گزارش تسویه نهایی معامله دو مرحله‌ای (${exitReason})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
🛡️ <b>اهرم اصلی:</b> <code>${order.leverage || 20}x</code>
💰 <b>قیمت ورود اصلی:</b> <code>$${this.formatPrice(order.entry_price)}</code>

📊 <b>مرحله اول (جزئی ۵۰٪ - تارگت ۱):</b>
  ├ 🚪 <b>قیمت خروج اول:</b> <code>$${this.formatPrice(order.tp1_exit_price || order.take_profit_1)}</code>
  ├ 🟢 <b>سود درصد اول:</b> <code>+${(order.tp1_pnl_pct || 0).toFixed(2)}%</code>
  └ 💵 <b>سود دلاری اول:</b> <code>$${(order.tp1_pnl_usd || 0).toFixed(2)}</code>

📊 <b>مرحله دوم (باقیمانده ۵۰٪ - خروج نهایی):</b>
  ├ 🚪 <b>قیمت خروج دوم:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
  ├ 📝 <b>علت خروج نهایی:</b> <code>${exitReason}</code>
  ├ 📈 <b>سود درصد دوم:</b> <code>${tp2_pnl_pct >= 0 ? "+" : ""}${tp2_pnl_pct.toFixed(2)}%</code>
  └ 💵 <b>سود دلاری دوم:</b> <code>$${tp2_pnl_usd >= 0 ? "+" : ""}${tp2_pnl_usd.toFixed(2)}</code>

🏆 <b>برآیند نهایی کل معامله (تجمیع شده):</b>
  ├ 💹 <b>تجمیع سود کل (میانگین دو پله):</b> <b><code>${total_pnl_pct >= 0 ? "+" : ""}${total_pnl_pct.toFixed(2)}%</code></b>
  ├ 💵 <b>برآیند سود دلاری کل:</b> <b><code>${total_pnl_usd >= 0 ? "+" : ""}$${total_pnl_usd.toFixed(2)}</code></b>
  └ 💰 <b>کل دارایی پس از تسویه:</b> <code>$${this.rm.capital.toFixed(2)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim();
      } else {
        reportMsg = `
${exitEmoji} <b>گزارش تسویه معامله تک مرحله‌ای (${exitReason})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
🛡️ <b>اهرم اصلی:</b> <code>${order.leverage || 20}x</code>
💰 <b>قیمت ورود اصلی:</b> <code>$${this.formatPrice(order.entry_price)}</code>
🚪 <b>قیمت خروج نهایی:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
📝 <b>علت خروج:</b> <code>${exitReason}</code>

🏆 <b>برآیند نهایی کل معامله:</b>
  ├ 💹 <b>درصد بازدهی نهایی:</b> <b><code>${total_pnl_pct >= 0 ? "+" : ""}${total_pnl_pct.toFixed(2)}%</code></b>
  ├ 💵 <b>سود/ضرر دلاری:</b> <b><code>${total_pnl_usd >= 0 ? "+" : ""}$${total_pnl_usd.toFixed(2)}</code></b>
  └ 💰 <b>کل موجودی حساب/دارایی:</b> <code>$${this.rm.capital.toFixed(2)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim();
      }

      await this.reporter.send(reportMsg);
    }
  }

  constructor(client: XTClient, reporter: TelegramReporter, config: Config) {
    this.client = client;
    this.reporter = reporter;
    this.config = config;
    this.rm = new RiskManager(config.BASE_CAPITAL, config.KELLY_FRACTION, config.POSITION_SIZE_MAX, config.MAX_DRAWDOWN);
    this.exitEngine = new AdaptiveExitEngine({
      trailingEnabled: config.TRAILING_STOP_ENABLED,
      earlyExitEnabled: config.EARLY_LOSS_EXIT_ENABLED,
      earlyExitMinLossRatio: config.EARLY_EXIT_MIN_LOSS_RATIO,
      momentumZThreshold: config.EARLY_EXIT_MOMENTUM_Z,
      confirmTicks: config.EARLY_EXIT_CONFIRM_TICKS,
    });
    this.positionGuard = new PositionGuard(this.client, this.corrMgr);
    this.engine.sensitivity = this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity;
    this.loadState().catch(console.error);
  }

  public async saveState() {
    if (!this.isStateLoaded) {
      console.warn("Skipping saveState: State is still loading from disk...");
      return;
    }
    try {
      const state = {
        count: this.count,
        orders: this.orders,
        closedOrders: this.closedOrders,
        scanLogs: this.scanLogs.slice(0, 50),
        apiKey: this.apiKey,
        secretKey: this.secretKey,
        tradingMode: this.tradingMode,
        sensitivity: this.sensitivity,
        disable9Layers: this.disable9Layers,
        rejectedSignals: this.rejectedSignals,
        demoCapital: this.rm.capital,
        totalTrades: this.rm.totalTrades,
        winTrades: this.rm.winTrades,
        consecutiveLosses: this.consecutiveLosses,
        adaptiveSensitivityOverride: this.adaptiveSensitivityOverride,
        leverageMultiplier: this.leverageMultiplier,
        riskReductionMap: this.riskReductionMap,
        hardCooldownMap: this.hardCooldownMap,
        diagnosticLogs: this.diagnosticLogs,
        strategy: this._strategy,
        welcomeSent: this.welcomeSent,
        lastDailyReportDate: this.lastDailyReportDate,
        tradingHoursMode: this.tradingHoursMode,
        smartHoursCache: this.smartHoursCache,
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("Failed to save state:", e);
    }
  }

  private async loadState() {
    try {
      const data = await fs.readFile(this.stateFilePath, "utf-8");
      const state = JSON.parse(data);
      this.count = state.count || 0;
      this.orders = state.orders || [];
      this.closedOrders = state.closedOrders || [];
      this.scanLogs = state.scanLogs || [];
      this.apiKey = state.apiKey || "";
      this.secretKey = state.secretKey || "";
      this.tradingMode = state.tradingMode || "simulation";
      this.sensitivity = state.sensitivity || "auto_cortex";
      this.disable9Layers = !!state.disable9Layers;
      this.rejectedSignals = state.rejectedSignals || [];
      this.consecutiveLosses = state.consecutiveLosses || 0;
      this.adaptiveSensitivityOverride = state.adaptiveSensitivityOverride || null;
      this.leverageMultiplier = state.leverageMultiplier !== undefined ? state.leverageMultiplier : 1.0;
      this.riskReductionMap = state.riskReductionMap || {};
      this.hardCooldownMap = state.hardCooldownMap || {};
      this.diagnosticLogs = state.diagnosticLogs || [];
      this.strategy = state.strategy && (state.strategy === "strict_elitescalp" || state.strategy === "active_goldenscalp" || state.strategy === "auto_cortex" || state.strategy === "auto") ? state.strategy : "auto";
      this.welcomeSent = !!state.welcomeSent;
      this.lastDailyReportDate = state.lastDailyReportDate || "";
      this.tradingHoursMode = state.tradingHoursMode === "smart" ? "smart" : "24_7";
      this.smartHoursCache = state.smartHoursCache || null;
      
      // Restore Risk Manager Capital and stats
      this.rm.capital = state.demoCapital !== undefined ? state.demoCapital : this.config.BASE_CAPITAL;
      this.rm.totalTrades = state.totalTrades || 0;
      this.rm.winTrades = state.winTrades || 0;

      this.initCcxt();
      this.isStateLoaded = true;
      this._addLog(`System state restored. Sensitivity set to: ${this.sensitivity}`);
    } catch (e) {
      this.sensitivity = "auto_cortex";
      this.strategy = "auto";
      this.disable9Layers = false;
      this.isStateLoaded = true;
      this._addLog("Fresh system initialization. No previous state found.");
    }
  }

  // ⏰ Hourly Performance Guard ────────────────────────────────────────────
  /**
   * از روی لاگ کامل معاملات بسته‌شده (به تفکیک ساعت تهران)، بهترین ساعت‌های
   * معاملاتی را دوباره محاسبه و در حافظه/دیسک کش می‌کند. هم از داشبورد و هم
   * از ربات تلگرام (و هم به‌صورت خودکار یک‌بار در روز از داخل اسکنر) صدا زده
   * می‌شود، بنابراین همیشه یک منبع واحد و مشترک از حقیقت است.
   */
  public async refreshSmartHours(): Promise<BestHoursResult> {
    if (this.smartHoursRefreshing) {
      return this.smartHoursCache || pickBestHours(await getHourlyBuckets());
    }
    this.smartHoursRefreshing = true;
    try {
      const buckets = await getHourlyBuckets();
      const result = pickBestHours(buckets);
      this.smartHoursCache = result;
      await this.saveState();
      return result;
    } finally {
      this.smartHoursRefreshing = false;
    }
  }

  /**
   * آیا در همین لحظه (به وقت تهران) اجازه‌ی باز کردن پوزیشن جدید داریم؟
   * توجه: این تابع فقط ورود معامله‌ی *جدید* را کنترل می‌کند — پوزیشن‌های از
   * قبل باز، صرف‌نظر از این تنظیم، طبق منطق مدیریت ریسک/خروج خودشان مدیریت
   * و بسته می‌شوند و هرگز به‌خاطر این قابلیت به‌زور بسته نمی‌شوند.
   */
  public isCurrentHourAllowed(): boolean {
    if (this.tradingHoursMode === "24_7") return true;

    // اگر هنوز هیچ محاسبه‌ای انجام نشده، اسکنر آن را در پس‌زمینه شروع می‌کند
    // اما تا وقتی آماده شود، به‌صورت ایمن اجازه‌ی معامله را می‌دهد (fail-open)
    // تا هرگز به دلیل نبود کش، معامله‌ی معتبر از دست نرود.
    if (!this.smartHoursCache) {
      this.refreshSmartHours().catch(() => {});
      return true;
    }

    // هر ۲۴ ساعت یک‌بار به‌صورت خودکار در پس‌زمینه تازه‌سازی می‌شود
    if (Date.now() - this.smartHoursCache.computedAt > 24 * 60 * 60 * 1000 && !this.smartHoursRefreshing) {
      this.refreshSmartHours().catch(() => {});
    }

    // اگر داده‌ی کافی برای تصمیم‌گیری آماری معتبر وجود نداشته باشد، محدود
    // نمی‌کنیم (fail-open) — بهتر است تا جمع‌شدن نمونه‌ی کافی، ۲۴/۷ رفتار کند.
    if (!this.smartHoursCache.sufficientData) return true;

    const hourNow = tehranHourOf();
    return this.smartHoursCache.bestHours.includes(hourNow);
  }

  public calculateCortexDynamicSensitivity(): "conservative" | "balanced" | "active" {
    // 1. Strict Risk control lock if there are multiple consecutive losses
    if (this.consecutiveLosses >= 2) {
      return "conservative";
    }

    // 2. Control volatility lock (such as large BTC fluctuations dragging everything)
    if (this.btcChange > 0.035 || this.btcChange < -0.035) {
      return "conservative";
    }

    // 3. Performance-based adaptive feedback (examine last 6 trades)
    const recentTrades = this.closedOrders.slice(0, 6);
    if (recentTrades.length < 2) {
      return "balanced"; // Boot-up / Standard baseline
    }

    const wins = recentTrades.filter(o => {
      // Calculate win based on positive realized PnL
      const pnlUsd = o.pnl_usd !== undefined ? o.pnl_usd : (o.tp1_pnl_usd || 0) + (o.tp2_pnl_usd || 0);
      return pnlUsd >= 0;
    }).length;
    
    const winRate = wins / recentTrades.length;

    if (winRate >= 0.60) {
      // The current market regime correlates highly with our models -> Be aggressive (active) to capture the edge is winning
      return "active";
    } else if (winRate < 0.40) {
      // Drawdown detected -> Be defensive (conservative)
      return "conservative";
    }

    // Balanced range between 40% and 60% win rate
    return "balanced";
  }

  public calculateCortexDynamicStrategy(): "strict_elitescalp" | "active_goldenscalp" {
    // 1. Pivot immediately to strict_elitescalp if we are facing consecutive losses
    if (this.consecutiveLosses >= 1) {
      return "strict_elitescalp";
    }

    // 2. Control volatility lock (large BTC fluctuations)
    if (this.btcChange > 0.03 || this.btcChange < -0.03) {
      return "strict_elitescalp";
    }

    // 3. Performance-based adaptive strategy selecting (examine last 6 trades)
    const recentTrades = this.closedOrders.slice(0, 6);
    if (recentTrades.length < 2) {
      return "active_goldenscalp"; // Start with the highly active golden scalp
    }

    const wins = recentTrades.filter(o => {
      const pnlUsd = o.pnl_usd !== undefined ? o.pnl_usd : (o.tp1_pnl_usd || 0) + (o.tp2_pnl_usd || 0);
      return pnlUsd >= 0;
    }).length;
    
    const winRate = wins / recentTrades.length;

    if (winRate >= 0.50) {
      // Market regime correlates highly with our models - be active!
      return "active_goldenscalp";
    }

    // Otherwise, be conservative and defensive
    return "strict_elitescalp";
  }

  private _getCoinDetails(symbol: string) {
    return {
      market_link: `https://www.xt.com/en/trade/${symbol.toLowerCase()}_usdt`,
      tradingview_link: `https://www.tradingview.com/symbols/${symbol}USDT`,
      search_link: `https://www.google.com/search?q=${symbol}+USDT+coin`,
    };
  }

  private _addLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.scanLogs.unshift(`[${timestamp}] ${msg}`);
    if (this.scanLogs.length > 50) this.scanLogs.pop();
    console.log(msg);
  }

  /**
   * 🧠 Smart Risk-Reduction Lookup (replaces hard quarantine blocking)
   *
   * Returns the currently-active risk-reduction adjustments for a given symbol
   * (and optionally its correlation group), with linear decay over time:
   *  - sizeFactor: multiplier applied to position size (1 = no reduction)
   *  - extraConfidence: extra win-probability the engine must clear before entry
   *
   * The symbol/group is NEVER fully blocked — only made smaller and harder to
   * trigger for a while after a loss, recovering smoothly back to normal.
   */
  private _getRiskReduction(symbol: string, group?: string | null): { sizeFactor: number; extraConfidence: number; active: boolean } {
    const now = Date.now();
    const entries: { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }[] = [];

    const symEntry = this.riskReductionMap[symbol];
    if (symEntry && symEntry.until > now) entries.push(symEntry);

    if (group) {
      const groupEntry = this.riskReductionMap[group];
      if (groupEntry && groupEntry.until > now) entries.push(groupEntry);
    }

    if (entries.length === 0) return { sizeFactor: 1, extraConfidence: 0, active: false };

    // Combine multiple active reductions (symbol + group) by taking the strictest values,
    // each scaled by how much of its decay window remains.
    let sizeFactor = 1;
    let extraConfidence = 0;
    for (const e of entries) {
      const totalSpan = Math.max(1, e.until - e.startedAt);
      const remaining = Math.max(0, e.until - now);
      const progress = Math.max(0, Math.min(1, remaining / totalSpan)); // 1 -> just started, 0 -> fully decayed

      const currentSizeFactor = 1 - (1 - e.sizeFactor) * progress;
      const currentExtraConfidence = e.extraConfidence * progress;

      sizeFactor = Math.min(sizeFactor, currentSizeFactor);
      extraConfidence = Math.max(extraConfidence, currentExtraConfidence);
    }

    return { sizeFactor, extraConfidence, active: true };
  }

  /**
   * Apply a temporary, decaying risk-reduction to a symbol (and optionally its
   * correlation group) instead of fully quarantining it.
   */
  private _applyRiskReduction(key: string, durationMs: number, sizeFactor: number, extraConfidence: number) {
    const now = Date.now();
    this.riskReductionMap[key] = {
      startedAt: now,
      until: now + durationMs,
      sizeFactor,
      extraConfidence,
    };
  }

  async scan() {
    const scanStartedAt = Date.now();
    this.count++;
    this._addLog(`Scan #${this.count} starting...`);
    this.currentProgress = "در حال دریافت داده بازار...";
    try {
      const allPairs = await this.client.getAllUsdtPairs(true);
      if (!allPairs.length) {
        this._addLog("No pairs found on XT.");
        return [];
      }

      const btcPair = allPairs.find((p) => p.clean === "BTC");
      this.btcChange = btcPair ? btcPair.change_24h : 0;

      // Real-time Live Position Price & PnL Tracker (exits are fully evaluated by the dedicated high-frequency tracker)
      const activePositions = this.orders.filter(o => o.status === "filled");
      if (activePositions.length > 0) {
        this._addLog(`Updating prices for ${activePositions.length} active positions...`);
        for (const order of this.orders) {
          if (order.status === "filled") {
            // 🎯 برای معاملات واقعی، قیمت را از بازار فیوچرز واقعی می‌گیریم (همان بازاری که
            // پوزیشن واقعاً آنجا باز شده)، نه از تیکر اسپات — چون اختلاف قیمت اسپات/فیوچرز
            // با ضرب‌شدن در اهرم، سود/زیان نمایشی ربات را از سود/زیان واقعی صرافی متفاوت می‌کند.
            let currentPrice = 0;
            if (this.tradingMode === "real") {
              currentPrice = (await this._getRealFuturesPrice(order.symbol)) || 0;
            }
            if (!currentPrice) {
              const liveTicker = allPairs.find(p => p.symbol.toLowerCase() === order.symbol.toLowerCase() || p.clean.toLowerCase() === order.symbol.toLowerCase());
              currentPrice = liveTicker ? liveTicker.price : 0;
            }
            if (currentPrice > 0) {
              order.current_price = currentPrice;
              
              // Calculate live tracking PnL%
              let pnlPct = 0;
              if (order.action === "buy") {
                pnlPct = ((currentPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
              } else {
                pnlPct = ((order.entry_price - currentPrice) / order.entry_price) * 100 * (order.leverage || 1);
              }
              order.pnl_pct = pnlPct;
              order.pnl_usd = (pnlPct / 100) * order.position_value;
            }
          }
        }
        await this.saveState();
      }

      const topVolume = allPairs.slice(0, this.config.TOP_TICKER_FILTER);
      const obCandidates: any[] = [];

      this._addLog(`Parallel Filtering: Checking top ${this.config.ORDERBOOK_FILTER} pairs...`);
      
      // Parallel Orderbook Check with concurrency control (limit of 10 at once)
      const batchSize = 10;
      for (let i = 0; i < Math.min(topVolume.length, this.config.ORDERBOOK_FILTER); i += batchSize) {
        const batch = topVolume.slice(i, i + batchSize);
        this.currentProgress = `تحلیل اردربوک: دسته ${Math.floor(i/batchSize) + 1} (${i + 1}-${Math.min(i + batchSize, this.config.ORDERBOOK_FILTER)})`;
        
        const results = await Promise.all(batch.map(async (pair) => {
          try {
            const ob = await this.client.getOrderbook(pair.symbol, 50);
            if (ob && ob.bids.length && ob.asks.length) {
              const bv = ob.bids.slice(0, 20).reduce((s, b) => s + b[1], 0);
              const av = ob.asks.slice(0, 20).reduce((s, a) => s + a[1], 0);
              const total = bv + av;
              if (total > 0 && Math.abs(bv - av) / total > 0.02) {
                return { pair, ob };
              }
            }
          } catch (e) {}
          return null;
        }));
        
        obCandidates.push(...results.filter((r): r is any => r !== null));
      }

      this._addLog(`Deep Deep Intel: Processing ${obCandidates.length} high-potential pools...`);
      const signals: Position[] = [];
      
      // Parallel Deep Analysis (Batch of 5)
      for (let i = 0; i < Math.min(obCandidates.length, this.config.DEEP_ANALYSIS); i += 5) {
        const batch = obCandidates.slice(i, i + 5);
        this.currentProgress = `تحلیل عمیق سیگنال: دارایی ${i + 1} تا ${Math.min(i + 5, obCandidates.length)}`;
        
        await Promise.all(batch.map(async ({ pair, ob }) => {
          try {
            const baseSensitivity = this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity;
            this.engine.sensitivity = this.adaptiveSensitivityOverride || baseSensitivity;

            const baseStrategy = this.strategy === "auto_cortex" ? this.calculateCortexDynamicStrategy() : this.strategy;
            this.engine.strategy = baseStrategy;

            // Guard against scanning symbols that already have an active/live tracking order open
            const hasActivePos = this.orders.some(o => o.symbol === pair.clean && o.status === "filled");
            if (hasActivePos) {
              this._addLog(`🛡️ [Active Position Guard] Skipping candidate ${pair.clean} from scanning because it already has an active open trade.`);
              return;
            }

            // 🚫 [Hard Cooldown Guard] بعد از یک ضرر روی همین نماد، برای مدتی کوتاه
            // (۳۰ تا ۱۲۰ دقیقه بسته به تعداد باخت‌های پیاپی) ورود مجدد به این نماد
            // کاملاً مسدود است — نه فقط با حجم کمتر، بلکه اسکن ورودش اصلاً رد می‌شود.
            // این از الگوی ورود پشت‌سرهم به یک نماد رنج/نوسانی (که باعث چند ضرر
            // کوچک پیاپی می‌شود) جلوگیری می‌کند.
            const cooldownUntil = this.hardCooldownMap[pair.clean];
            if (cooldownUntil && cooldownUntil > Date.now()) {
              const remainingMin = Math.ceil((cooldownUntil - Date.now()) / 60000);
              this._addLog(`🚫 [Hard Cooldown Guard] Skipping ${pair.clean}: blocked for ${remainingMin} more minute(s) after a recent loss on this symbol.`);
              return;
            } else if (cooldownUntil) {
              delete this.hardCooldownMap[pair.clean];
            }

            // 🧠 Smart Risk-Reduction (replaces old hard quarantine block):
            // the symbol is always scanned; if it recently lost, we apply a temporary
            // reduced position size and require extra confidence to enter, both of
            // which decay smoothly back to normal over a few hours.
            const group = this.corrMgr.getGroupDescription(pair.clean);
            const riskReduction = this._getRiskReduction(pair.clean, group);
            this.engine.extraMinConfidence = riskReduction.extraConfidence;
            if (riskReduction.active) {
              this._addLog(`🛡️ [Smart Risk Guard] ${pair.clean}${group ? ` (group "${group}")` : ""}: کاهش حجم به ${(riskReduction.sizeFactor * 100).toFixed(0)}٪ و افزایش حدنصاب اعتماد +${(riskReduction.extraConfidence * 100).toFixed(1)}٪ به دلیل زیان اخیر.`);
            }


            const klines = await this.client.getKlines(pair.symbol, "5m", 100);
            if (!klines || klines.close.length < 30) return;

            const sig = await this.engine.analyze(pair.clean, klines, ob, pair.change_24h, this.btcChange, pair.price);
            if (sig) {
              if (sig.action !== "stay_out") {
                // ⏰ Hourly Performance Guard: در حالت «ساعات طلایی هوشمند»، اگر
                // ساعت فعلی (تهران) جزو بهترین ساعت‌های تاریخی شناسایی‌شده
                // نباشد، از باز کردن معامله‌ی *جدید* صرف‌نظر می‌کنیم — پوزیشن‌های
                // از قبل باز، بی‌تأثیر از این تنظیم، به کار خود ادامه می‌دهند.
                if (!this.isCurrentHourAllowed()) {
                  const hourNow = tehranHourOf();
                  this._addLog(`⏰ [Hourly Guard] Signal for ${sig.symbol} skipped — hour ${hourNow}:00 is outside the smart golden-hours window.`);
                  if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                    this.rejectedSignals.push({
                      symbol: sig.symbol,
                      action: sig.action,
                      score: sig.score,
                      threshold: sig.dynamic_threshold,
                      reason: `ساعت ${hourNow}:00 خارج از بازه‌ی ساعات طلایی هوشمند است (حالت فعال: ساعات هوشمند)`,
                      time: Date.now()
                    });
                    if (this.rejectedSignals.length > 100) this.rejectedSignals.shift();
                  }
                  return;
                }

                const activeCount = this.orders.filter(o => o.status === "filled").length;
                if (activeCount >= 5) {
                  this._addLog(`⚠️ [Limit Exceeded] Signal for ${sig.symbol} skipped because max open positions limit (5) has been reached.`);
                  if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                    this.rejectedSignals.push({
                      symbol: sig.symbol,
                      action: sig.action,
                      score: sig.score,
                      threshold: sig.dynamic_threshold,
                      reason: "حداکثر ظرفیت ۵ معامله فعال تکمیل است",
                      time: Date.now()
                    });
                    if (this.rejectedSignals.length > 100) {
                      this.rejectedSignals.shift();
                    }
                  }
                  return;
                }

                const details = this._getCoinDetails(sig.symbol);
                Object.assign(sig, details);

                // 🛡️ اگر در حالت واقعی هستیم و این کوین اصلاً بازار فیوچرز روی XT ندارد
                // (فقط اسپات دارد)، همین‌جا و بدون هیچ تلاش بی‌فایده‌ای صرف‌نظر می‌کنیم —
                // وگرنه معامله تا مرحله‌ی سفارش می‌رفت و آنجا با خطای "does not have
                // market symbol" از طرف صرافی رد می‌شد.
                if (this.tradingMode === "real" && !this._hasRealFuturesMarket(sig.symbol)) {
                  this._addLog(`⛔ [No Futures Market] ${sig.symbol} روی XT فقط اسپات دارد، فیوچرز ندارد — سیگنال نادیده گرفته شد.`);
                  if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                    this.rejectedSignals.push({
                      symbol: sig.symbol,
                      action: sig.action,
                      score: sig.score,
                      threshold: sig.dynamic_threshold,
                      reason: "این کوین روی XT بازار فیوچرز (Swap) ندارد؛ فقط اسپات معامله می‌شود",
                      time: Date.now()
                    });
                    if (this.rejectedSignals.length > 100) this.rejectedSignals.shift();
                  }
                  return;
                }

                // RE-FETCH FRESH LIVE PRICE RIGHT BEFORE SIGNAL ISSUANCE TO ELIMINATE ANY LAG
                const freshPrice = await this.client.getLivePrice(sig.symbol);
              if (freshPrice && freshPrice > 0) {
                const ratio = freshPrice / sig.price;
                sig.price = freshPrice;
                sig.stop_loss = sig.stop_loss * ratio;
                sig.take_profit = sig.take_profit * ratio;
                sig.take_profit_2 = sig.take_profit_2 * ratio;
              }

              if (this.orders.filter(o => o.status === "filled").length >= 5) {
                this._addLog(`⚠️ [Limit Exceeded] Skip order execution for ${sig.symbol} because max limit (5) has been reached.`);
                return;
              }

              // Apply adaptive self-correction leverage scaling (global) +
              // per-symbol smart risk-reduction (local, decaying)
              const rawLeverage = sig.leverage || 20;
              sig.leverage = Math.max(2, Math.round(rawLeverage * this.leverageMultiplier * riskReduction.sizeFactor));

              const risk = this.rm.calculatePosition(sig.score, sig.price, sig.daily_vol);
              
              // Scale position size using global leverageMultiplier and the
              // symbol-specific smart risk-reduction factor (1 = no reduction)
              risk.position_size = risk.position_size * this.leverageMultiplier * riskReduction.sizeFactor;
              risk.quantity = risk.position_size / sig.price;

              const corrCheck = this.corrMgr.checkCorrelationLimit(sig.symbol, this.orders, risk.position_size, this.rm.capital);

              if (corrCheck.allowed && corrCheck.adjusted_size > 0) {
                risk.position_size = corrCheck.adjusted_size;
                risk.quantity = risk.position_size / sig.price;
                sig.correlation_group = this.corrMgr.getGroupDescription(sig.symbol);
                sig.correlation_warning = corrCheck.warning;

                let isRealOrderSuccess = true;
                let realQuantity = risk.quantity;
                let realEntryPrice = sig.price;
                let realOrderId = `o${Date.now()}-${sig.symbol}`;

                if (this.tradingMode === "real") {
                  this._addLog(`🚀 [REAL MODE] Dispatching REAL FUTURES ${sig.action.toUpperCase()} order on XT for ${sig.symbol} @ ${sig.leverage}x...`);
                  try {
                    if (!this.ccxtExchange) {
                      throw new Error("تنظیمات یا کلیدهای امنیتی Private API صرافی جهت اجرای معامله واقعی یافت نشد.");
                    }

                    const futuresSym = this._futuresSymbol(sig.symbol);
                    const positionSide: "LONG" | "SHORT" = sig.action === "buy" ? "LONG" : "SHORT";

                    // Check balance and scale order to fit wallet (کیف پول فیوچرز، نه اسپات)
                    const balance = await this.ccxtExchange.fetchBalance();
                    const freeUsdt = balance?.free?.USDT || 0;
                    this._addLog(`💳 موجودی زنده واقعی (فیوچرز): ${freeUsdt.toFixed(2)} USDT. ارزش موقعیت (مارجین) محاسبه شده: ${risk.position_size.toFixed(2)} USDT.`);

                    if (freeUsdt < risk.position_size) {
                      if (freeUsdt > 5) {
                        risk.position_size = freeUsdt - 1;
                        this._addLog(`⚠️ کسر بودجه: ارزش موقعیت به ${risk.position_size.toFixed(2)} USDT کاهش یافت تا با موجودی همگام شود.`);
                      } else {
                        throw new Error(`موجودی تتر کافی نیست (${freeUsdt.toFixed(2)} USDT). حداقل ۵ تتر مورد نیاز است.`);
                      }
                    }

                    // 🎚️ تنظیم اهرم واقعی روی صرافی قبل از باز کردن موقعیت — مقدار برگشتی
                    // همان اهرمی است که XT واقعاً تایید کرده (ممکن است کمتر از درخواستی
                    // باشد اگر این کوین سقف اهرم پایین‌تری داشته باشد). از این به بعد
                    // sig.leverage دقیقاً همین عدد واقعی است، نه عدد فرضی/درخواستی.
                    sig.leverage = await this._ensureLeverage(sig.symbol, sig.leverage || 20, positionSide);

                    // 🎯 مقدار سفارش = مارجین × اهرم واقعی ÷ قیمت (یعنی ارزش کامل پوزیشن/Notional)
                    // نه فقط مارجین ÷ قیمت — قبلاً این ضرب در اهرم اصلاً انجام نمی‌شد، یعنی
                    // سفارش واقعی فقط معادل ۱/اهرم از حجم مورد نظر روی صرافی باز می‌شد
                    // (مثلاً با مارجین ۵ دلار و اهرم ۲۰x، ربات ادعای پوزیشن ۵ دلاری می‌کرد ولی
                    // در عمل فقط ۰٫۲۵ دلار حجم واقعی سفارش می‌داد).
                    let executionQty = await this._safeAmount(sig.symbol, (risk.position_size * sig.leverage) / sig.price);

                    this._addLog(`در حال ارسال سفارش ${sig.action === "buy" ? "خرید" : "فروش (شورت)"} مارکت فیوچرز به صرافی: ${futuresSym} به مقدار ${executionQty} (اهرم واقعی تاییدشده: ${sig.leverage}x)`);
                    const response = await this.ccxtExchange.createOrder(futuresSym, "market", sig.action, executionQty, undefined, { positionSide });

                    if (response && response.id) {
                      realOrderId = response.id;
                      realQuantity = response.filled || response.amount || executionQty;
                      // این فقط یک تخمین اولیه است؛ پاسخ سفارش مارکت اغلب `average` را هنوز
                      // ندارد (چون موتور مچینگ صرافی گزارش نهایی fill را با کمی تاخیر می‌دهد)
                      // و در آن صورت به‌جای قیمت واقعی fill شده، به اشتباه قیمت لحظه‌ی سیگنال
                      // (sig.price) ثبت می‌شد که می‌تواند با اهرم بالا اختلاف چشمگیری بسازد.
                      realEntryPrice = response.average || response.price || sig.price;

                      // 🎯 تایید نهایی و قطعی: به‌جای یک صبر ثابت و کند (که وقت تلف می‌کرد)،
                      // بلافاصله و بدون هیچ تاخیری اولین تلاش را می‌زنیم؛ اگر موتور مچینگ صرافی
                      // هنوز پوزیشن را ثبت نکرده باشد (معمولاً طی چند ده میلی‌ثانیه انجام می‌شود)،
                      // با فاصله‌های بسیار کوتاه (۱۵۰ میلی‌ثانیه) دوباره تلاش می‌کنیم — حداکثر ۵
                      // بار (یعنی سقف واقعی زمان انتظار حدود ۶۰۰ میلی‌ثانیه، ولی در عمل چون از
                      // همان تلاش اول یا دوم جواب می‌گیرد، معمولاً خیلی سریع‌تر تمام می‌شود).
                      // این دقیقاً همان entryPrice ایست که در پنل صرافی نمایش داده می‌شود، پس
                      // هرگونه اختلاف بین ربات و صرافی در قیمت ورود از بین می‌رود.
                      let confirmedSnapshot: Awaited<ReturnType<typeof this._getRealPositionSnapshot>> = null;
                      for (let attempt = 0; attempt < 5 && !confirmedSnapshot; attempt++) {
                        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 150));
                        confirmedSnapshot = await this._getRealPositionSnapshot(sig.symbol, positionSide);
                      }
                      if (confirmedSnapshot && confirmedSnapshot.entryPrice > 0) {
                        if (Math.abs(confirmedSnapshot.entryPrice - realEntryPrice) / realEntryPrice > 0.0005) {
                          this._addLog(`🎯 اصلاح قیمت ورود بر اساس پوزیشن واقعی صرافی: ${realEntryPrice} → ${confirmedSnapshot.entryPrice}`);
                        }
                        realEntryPrice = confirmedSnapshot.entryPrice;
                      }

                      this._addLog(`✅ سفارش واقعی فیوچرز با موفقیت پر شد! شناسه سفارش: ${realOrderId}. مقدار: ${realQuantity}، قیمت میانگین (تاییدشده از صرافی): ${realEntryPrice}`);
                    } else {
                      throw new Error("صرافی سفارش مارکت را بدون شناسه دریافت ثبت کرد.");
                    }
                  } catch (orderErr: any) {
                    isRealOrderSuccess = false;
                    const msg = `❌ [REAL ORDER FAILED] خطا در ثبت معامله واقعی فیوچرز برای ${sig.symbol}: ${orderErr.message || orderErr}`;
                    this._addLog(msg);
                    await this.reporter.send(`🚨 <b>عملیات ${sig.action === "buy" ? "خرید" : "فروش"} واقعی شکست خورد!</b>\n\nجفت‌ارز: <b>${sig.symbol}/USDT</b>\nخطا: <code>${orderErr.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\nسیستم این موقعیت را برای حفظ سرمایه شما رد کرد.`);
                  }
                }

                if (isRealOrderSuccess) {
                  const order: Position = {
                    id: realOrderId,
                    symbol: sig.symbol,
                    action: sig.action as "buy" | "sell",
                    quantity: realQuantity,
                    entry_price: realEntryPrice,
                    stop_loss: sig.stop_loss,
                    take_profit_1: sig.take_profit,
                    take_profit_2: sig.take_profit_2,
                    position_value: risk.position_size,
                    status: "filled",
                    mode: this.tradingMode,
                    score: sig.score,
                    confidence: sig.confidence,
                    daily_vol: sig.daily_vol,
                    regime: sig.regime,
                    vol_surge: sig.vol_surge,
                    vol_surge_msg: sig.vol_surge_msg,
                    imbalance: sig.imbalance,
                    iceberg: sig.iceberg,
                    pain_point: sig.pain_point,
                    divergence: sig.divergence,
                    ml_weights: sig.ml_weights,
                    dynamic_threshold: sig.dynamic_threshold,
                    sub_signals: sig.sub_signals,
                    leverage: sig.leverage,
                    created_at: Date.now(),
                    current_price: sig.price,
                    pnl_pct: 0,
                    pnl_usd: 0,
                    tp1_hit: false,
                    initial_position_value: risk.position_size,
                    initial_quantity: realQuantity,
                    tp1_pnl_usd: 0,
                    tp1_pnl_pct: 0,
                    tp2_pnl_usd: 0,
                    tp2_pnl_pct: 0,
                  };

                  // Prevent duplicates
                  if (!this.orders.find(o => o.symbol === order.symbol)) {
                    this.orders.push(order);
                    if (this.orders.length > 30) this.orders.shift();
                    await this.reporter.sendSignal(sig, risk);
                    signals.push(order);
                    this._addLog(`🎯 RAID SUCCESS: SIGNAL FOR ${order.symbol} DISPATCHED`);
                    await this.saveState();

                    // 🔗 اطلاع به موتور کپی‌تریدینگ چندکاربره — هر کاربری که صرافی
                    // خودش را وصل و معامله‌ی خودکار را روشن کرده، همین ورود را با
                    // اندازه‌ی متناسب با موجودی خودش روی حساب واقعی خودش تکرار می‌کند.
                    this._fireEntry({
                      type: "entry",
                      sourceOrderId: order.id,
                      symbol: order.symbol,
                      action: order.action,
                      price: order.entry_price,
                      fractionOfCapital: risk.position_size / Math.max(1, this.rm.capital),
                      leverage: order.leverage || sig.leverage || 20,
                    });
                  }
                }
              }
            } else {
              const isBuyAttempt = sig.score >= 0.52;
              const isSellAttempt = sig.score <= 0.48;
              if (isBuyAttempt || isSellAttempt) {
                const trackingReason = sig.veto_reason || `امتیاز ${sig.score.toFixed(2)} کمتر از آستانه پویای ${sig.dynamic_threshold.toFixed(2)} است`;
                
                if (sig.veto_reason && sig.veto_reason.includes("Cortex Predictive Setup Reject")) {
                  this._addLog(`🧠 [Cortex Self-Optimization] Vetoed candidate trade for ${pair.clean}: ${sig.veto_reason}`);
                  
                  // 🧠 Smart Risk-Reduction (short & gentle): rather than a hard 2-hour
                  // ban, slightly raise this symbol's confidence bar for 20 minutes.
                  // This decays back to normal automatically and never fully blocks the symbol.
                  const vetoRiskWindow = 20 * 60 * 1000; // 20 minutes
                  this._applyRiskReduction(pair.clean, vetoRiskWindow, 0.85, 0.02);
                  this._addLog(`🛡️ [Smart Risk Guard] ${pair.clean}: افزایش موقت و کوتاه‌مدت (۲۰ دقیقه) حدنصاب اعتماد به دلیل وتوی کورتکس، بدون توقف کامل اسکن.`);
                  
                  // Avoid flooding duplicates for same token in recent logs (30 mins)
                  const alreadyLogged = this.diagnosticLogs.some(
                    l => l.symbol === pair.clean && l.type === "self_correction" && (Date.now() - l.time < 30 * 60 * 1000)
                  );
                  
                  if (!alreadyLogged) {
                    this.diagnosticLogs.unshift({
                      id: `veto-${Date.now()}-${pair.clean}`,
                      time: Date.now(),
                      symbol: pair.clean,
                      type: "self_correction",
                      title: `خودبهینه‌سازی و وتوی معامله ${pair.clean}`,
                      message: sig.veto_reason,
                      actionTaken: "جلوگیری خودکار از ورود به موقعیت به دلیل شباهت بالا به ساختارهای منتهی به زیان تاریخی ربات."
                    });
                    if (this.diagnosticLogs.length > 50) {
                      this.diagnosticLogs = this.diagnosticLogs.slice(0, 50);
                    }
                  }
                  await this.saveState();
                }

                // Prevent duplicating the exact same pair within 15 minutes
                if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                  this.rejectedSignals.push({
                    symbol: sig.symbol,
                    action: isBuyAttempt ? "buy" : "sell",
                    score: sig.score,
                    threshold: sig.dynamic_threshold,
                    reason: trackingReason,
                    time: Date.now()
                  });
                  if (this.rejectedSignals.length > 100) {
                    this.rejectedSignals.shift();
                  }
                }
              }
            }
          }
          } catch (e: any) {
            this.lastError = `Deep Log Error: ${pair.symbol} - ${e.message}`;
          }
        }));
      }

      const scannedAssetCount = Math.min(topVolume.length, this.config.ORDERBOOK_FILTER);
      const scanDurationMs = Date.now() - scanStartedAt;
      this.lastScanDurationMs = scanDurationMs;
      this.lastScanAssetCount = scannedAssetCount;
      this.lastScanAssetsPerSec = scanDurationMs > 0 ? (scannedAssetCount / (scanDurationMs / 1000)) : null;

      this.lastScanTime = Date.now();
      this.currentProgress = "اسکن کامل شد - در حالت استراحت تا چرخه بعدی.";
      this._addLog(`Scan #${this.count} complete. Signals generated: ${signals.length}`);
      await this.saveState();
      return signals;
    } catch (e: any) {
      this.lastError = `Scan Global Error: ${e.message}`;
      this._addLog(`Critical Error: ${e.message}`);
      return [];
    }
  }

  // Live tracking & high frequency price target evaluator (runs every 2 seconds for active positions)
  private async runHighFrequencyLiveTracker() {
    this._addLog("سامانه رهگیری لحظه‌ای و پرسرعت موقعیت‌های فعال فعال‌سازی شد (تناوب ۲ ثانیه).");
    while (this.isRunning) {
      try {
        const activePositions = this.orders.filter(o => o.status === "filled");
        if (activePositions.length > 0) {
          let hasChange = false;

          for (const order of this.orders) {
            if (order.status === "filled") {
              // Direct un-cached live price retrieval based on real-time orderbook depth
              // (در حالت واقعی، قیمت از بازار فیوچرز واقعی گرفته می‌شود؛ نه اسپات)
              const livePrice = this.tradingMode === "real"
                ? (await this._getRealFuturesPrice(order.symbol)) || (await this.client.getLivePrice(order.symbol))
                : await this.client.getLivePrice(order.symbol);
              
              if (livePrice && livePrice > 0 && livePrice !== order.current_price) {
                order.current_price = livePrice;
                hasChange = true;

                // Calculate accurate live PnL%
                let pnlPct = 0;
                if (order.action === "buy") {
                  pnlPct = ((livePrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
                } else {
                  pnlPct = ((order.entry_price - livePrice) / order.entry_price) * 100 * (order.leverage || 1);
                }
                order.pnl_pct = pnlPct;
                order.pnl_usd = (pnlPct / 100) * order.position_value;

                // 🛡️ Gather market-pressure context: volatility regime (ATR%), sector/correlation
                // stress (are correlated positions losing together?), and whether the original
                // signal thesis still holds. These combine into ONE decision below, not four
                // separate independent checks.
                const [atrPct, invalidation] = await Promise.all([
                  this.positionGuard.getAtrPct(order.symbol),
                  this.positionGuard.checkSignalInvalidated(order),
                ]);
                const correlationStress = this.positionGuard.getCorrelationStress(order, this.orders);

                // 🧠 Adaptive Exit Engine: profit-lock trailing stop + smart early-loss exit,
                // now market-pressure aware (ATR-scaled sensitivity, correlation stress,
                // signal invalidation, and partial de-risking).
                // Runs before the fixed SL/TP check so a tightened stop or an early-exit
                // signal takes effect on this same tick.
                const exitDecision = this.exitEngine.evaluate(order, livePrice, pnlPct, {
                  atrPct: atrPct ?? undefined,
                  correlationStress,
                  signalInvalidated: invalidation.invalidated,
                  invalidationReason: invalidation.reason,
                });

                if (exitDecision.shouldPartialCut && !exitDecision.shouldEarlyExit) {
                  const cutSucceeded = await this.handlePartialLossCut(order, livePrice, exitDecision.partialCutFraction || 0.4, exitDecision.partialCutReason || "");
                  if (!cutSucceeded) {
                    // شکست واقعی روی صرافی؛ اجازه‌ی تلاش مجدد در تیک بعدی داده می‌شود
                    this.exitEngine.resetPartialCut(order.id);
                  }
                }

                if (exitDecision.newStopLoss !== undefined) {
                  if (!order.original_stop_loss) order.original_stop_loss = order.stop_loss;
                  order.stop_loss = exitDecision.newStopLoss;
                  order.trailing_active = true;
                  if (exitDecision.trailTierChanged) {
                    this._addLog(`🔒 [${order.symbol}] قفل سود فعال شد/تنگ‌تر شد — حد ضرر جدید: ${this.formatPrice(order.stop_loss)} (سود جاری: ${pnlPct.toFixed(2)}%)`);
                    await this.reporter.send(`
🔒 <b>قفل سود فعال شد (Trailing Stop)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📈 <b>قیمت فعلی:</b> <code>$${this.formatPrice(livePrice)}</code>
🟢 <b>سود جاری:</b> <code>+${pnlPct.toFixed(2)}%</code>
🛡️ <b>حد ضرر جدید (قفل‌شده):</b> <code>$${this.formatPrice(order.stop_loss)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
                    `.trim());
                  }
                }

                let shouldExit = false;
                let exitReason = "";
                let exitPrice = livePrice;

                if (exitDecision.shouldEarlyExit) {
                  shouldExit = true;
                  exitReason = "خروج هوشمند زودهنگام (Smart Early-Loss Exit)";
                  exitPrice = livePrice;
                  this._addLog(`🧠 [${order.symbol}] ${exitDecision.earlyExitReason} — بستن پوزیشن قبل از رسیدن به حد ضرر کامل.`);
                  await this.reporter.send(`
🧠 <b>خروج هوشمند زودهنگام شناسایی شد — در حال اجرای بستن واقعی...</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📉 <b>قیمت فعلی:</b> <code>$${this.formatPrice(livePrice)}</code>
🔴 <b>زیان جاری:</b> <code>${pnlPct.toFixed(2)}%</code>
📝 <b>علت:</b> <code>${exitDecision.earlyExitReason}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ گزارش نهایی (تایید واقعی صرافی) در پیام بعدی ارسال می‌شود.
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
                  `.trim());
                } else if (order.action === "buy") {
                  if (livePrice <= order.stop_loss) {
                    shouldExit = true;
                    exitReason = order.trailing_active ? "قفل سود متحرک (Trailing Stop)" : "Stop Loss (حد ضرر)";
                    exitPrice = order.stop_loss;
                  } else if (livePrice >= order.take_profit_2) {
                    shouldExit = true;
                    exitReason = "Take Profit 2 (حد سود کامل)";
                    exitPrice = order.take_profit_2;
                  } else if (livePrice >= order.take_profit_1 && !order.tp1_hit) {
                    await this.handleTakeProfit1(order, livePrice);
                  }
                } else {
                  if (livePrice >= order.stop_loss) {
                    shouldExit = true;
                    exitReason = order.trailing_active ? "قفل سود متحرک (Trailing Stop)" : "Stop Loss (حد ضرر)";
                    exitPrice = order.stop_loss;
                  } else if (livePrice <= order.take_profit_2) {
                    shouldExit = true;
                    exitReason = "Take Profit 2 (حد سود کامل)";
                    exitPrice = order.take_profit_2;
                  } else if (livePrice <= order.take_profit_1 && !order.tp1_hit) {
                    await this.handleTakeProfit1(order, livePrice);
                  }
                }

                if (shouldExit) {
                  await this.closeActivePosition(order.id, exitPrice, exitReason);
                }
              }
            }
          }

          const closed = this.orders.filter(o => o.status === "closed");
          if (closed.length > 0) {
            this.closedOrders.unshift(...closed);
            if (this.closedOrders.length > 100) {
              this.closedOrders = this.closedOrders.slice(0, 100);
            }
            this.orders = this.orders.filter(o => o.status !== "closed");
            hasChange = true;
          }

          if (hasChange) {
            await this.saveState();
          }
        }
      } catch (err) {
        console.error("Error in high frequency scanner update:", err);
      }
      // Reduced to sub-second polling interval (750ms) to guarantee split-second tracking execution and exchange sync
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  // 🎯 Unified High-Reliability 50% Partial Target Closer & CCXT Broker Integrator
  private async handleTakeProfit1(order: any, currentPrice: number) {
    if (order.tp1_hit) return;
    order.tp1_hit = true;
    const _originalStopLoss = order.stop_loss;
    order.stop_loss = order.entry_price; // 🛡️ Shift Stop-Loss to Breakeven (Risk-Free)

    let actualExitPrice = currentPrice;
    let isRealExitSuccess = true;
    const positionSideTp1: "LONG" | "SHORT" = order.action === "buy" ? "LONG" : "SHORT";
    // 🎯 مقدار ۵۰٪ را ترجیحاً از روی مقدار واقعی باز روی صرافی حساب می‌کنیم (نه فقط از
    // ردیابی داخلی order.quantity که ممکن است کمی با واقعیت فرق داشته باشد).
    const realAmtTp1 = this.tradingMode === "real" ? await this._getRealOpenPositionAmount(order.symbol, positionSideTp1) : null;
    const partialQty = (realAmtTp1 ?? order.quantity) * 0.5;

    if (this.tradingMode === "real" && this.ccxtExchange) {
      if (order.action === "buy") {
        this._addLog(`🎯 [REAL MODE] TARGET 1 HIT: Triggering 50% REAL MARKET SELL for ${order.symbol}...`);
        try {
          const futuresSym = this._futuresSymbol(order.symbol);
          const safeQtyTp1Sell = await this._safeAmount(order.symbol, partialQty, !realAmtTp1);
          const response = await this.ccxtExchange.createOrder(futuresSym, "market", "sell", safeQtyTp1Sell, undefined, { positionSide: "LONG", reduceOnly: true });
          if (response && response.id) {
            actualExitPrice = response.average || response.price || currentPrice;
            this._addLog(`✅ XT Real Partial Sell (50%) filled! Order ID: ${response.id}. Price: ${actualExitPrice}`);
          }
        } catch (err: any) {
          isRealExitSuccess = false;
          this._addLog(`❌ [REAL PARTIAL SELL FAILED] ${err.message || err}`);
          await this.reporter.send(`🚨🚨 <b>خطا در فروش ۵۰ درصد پوزیشن واقعی در تارگت اول!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم به طور خودکار فاز مدیریت ریسک بدون ضرر را ادامه می‌دهد.`);
        }
      } else {
        this._addLog(`🎯 [REAL MODE] TARGET 1 HIT: Triggering 50% REAL MARKET COVER/BUY for ${order.symbol}...`);
        try {
          const futuresSym = this._futuresSymbol(order.symbol);
          const safeQtyTp1Buy = await this._safeAmount(order.symbol, partialQty, !realAmtTp1);
          const response = await this.ccxtExchange.createOrder(futuresSym, "market", "buy", safeQtyTp1Buy, undefined, { positionSide: "SHORT", reduceOnly: true });
          if (response && response.id) {
            actualExitPrice = response.average || response.price || currentPrice;
            this._addLog(`✅ XT Real Partial Cover (50%) filled! Order ID: ${response.id}. Price: ${actualExitPrice}`);
          }
        } catch (err: any) {
          isRealExitSuccess = false;
          this._addLog(`❌ [REAL PARTIAL COVER FAILED] ${err.message || err}`);
          await this.reporter.send(`🚨🚨 <b>خطا در خرید پوششی ۵۰ درصد پوزیشن واقعی در تارگت اول!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم به طور خودکار فاز مدیریت ریسک بدون ضرر را ادامه می‌دهد.`);
        }
      }
    }

    // 🛡️ اگر در حالت واقعی، سفارش کاهش ۵۰٪ روی صرافی واقعاً شکست خورده باشد، مطلقاً نباید
    // ادامه بدهیم: نه quantity/position_value داخلی نصف شود، نه پیام «موفقیت» تلگرام ارسال
    // شود — وگرنه ربات داخلی فکر می‌کند نصف پوزیشن بسته شده، ولی روی صرافی هنوز کامل باز
    // است؛ در نتیجه بستن نهایی بعدی فقط نصف مقدار واقعی را می‌فرستد و نیمه‌ی دیگر باز
    // می‌ماند (دقیقاً همان چیزی که باید دستی می‌بستید). به‌جایش tp1_hit را ریست می‌کنیم تا
    // در تیک بعدی (۷۵۰ میلی‌ثانیه‌ای) دوباره تلاش شود.
    if (this.tradingMode === "real" && !isRealExitSuccess) {
      order.tp1_hit = false;
      order.stop_loss = _originalStopLoss; // بازگرداندن حد ضرر، چون کاهش واقعی انجام نشد
      return;
    }

    // Realize PnL of this 50% part
    let realizedPnlPct = 0;
    if (order.action === "buy") {
      realizedPnlPct = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
    } else {
      realizedPnlPct = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
    }
    const halfValue = order.position_value * 0.5;
    const realizedPnlUsd = (realizedPnlPct / 100) * halfValue;

    if (!order.initial_position_value) {
      order.initial_position_value = order.position_value;
    }
    if (!order.initial_quantity) {
      order.initial_quantity = order.quantity;
    }

    order.tp1_hit = true;
    order.tp1_exit_price = actualExitPrice;
    order.tp1_pnl_pct = realizedPnlPct;
    order.tp1_pnl_usd = realizedPnlUsd;

    // 🔗 اطلاع به موتور کپی‌تریدینگ چندکاربره — بستن ۵۰٪ در تارگت اول.
    this._fireExit({
      type: "exit",
      sourceOrderId: order.id,
      symbol: order.symbol,
      action: order.action,
      price: actualExitPrice,
      fraction: 0.5,
      isFinal: false,
      reason: "Take Profit 1 (۵۰٪)",
    });

    try {
      const baseCap = this.config.BASE_CAPITAL || 1000;
      await recordDailyPnl(realizedPnlUsd, (realizedPnlUsd / baseCap) * 100);
    } catch (e) {}

    if (this.tradingMode === "real") {
      await this.updateRealBalance();
      this.rm.capital = Math.max(0.01, this.realBalance); // 🎯 بدون کف کاذب؛ دقیقاً همان موجودی واقعی صرافی (فقط epsilon برای جلوگیری از تقسیم بر صفر)
    } else {
      this.rm.capital = Math.max(10, this.rm.capital + realizedPnlUsd);
    }

    // Shrink the current active position size by half to reflect partial exit
    order.quantity = order.quantity * 0.5;
    order.position_value = order.position_value * 0.5;

    this._addLog(`🎯 TARGET 1 HIT (50% CLOSED): ${order.symbol} closed 50% of trade at $${actualExitPrice}. Realized PnL: ${realizedPnlPct.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)}). Remaining position resized to $${order.position_value.toFixed(2)}. Stop Loss shifted to Entry Price ($${order.entry_price}).`);
    
    // Send a beautifully designed, highly professional compact Persian Telegram confirmation
    await this.reporter.send(`
🎯 <b>سیگنال به تارگت اول رسید و ۵۰٪ معامله بسته شد!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
🎯 <b>قیمت تارگت ۱:</b> <code>$${this.formatPrice(order.take_profit_1)}</code>
✨ <b>قیمت انجام معامله:</b> <code>$${this.formatPrice(actualExitPrice)}</code>

📊 <b>گزارش بازدهی بستن ۵۰ درصد معامله:</b>
🟢 <b>سود خالص درصد:</b> <code>+${realizedPnlPct.toFixed(2)}%</code>
💵 <b>سود خالص دلاری:</b> <code>$${realizedPnlUsd.toFixed(2)}</code>
📦 <b>ارزش باقیمانده معامله:</b> <code>$${order.position_value.toFixed(2)}</code>

🛡️ <b>مدیریت ریسک بدون ضرر (Breakeven):</b> حد ضررِ ۵۰ درصد مابقی معامله بر روی <b>قیمت ورود ($${this.formatPrice(order.entry_price)})</b> تنظیم شد. اکنون معامله کاملاً بدون ریسک (Risk-Free) به سمت تارگت دوم حرکت می‌کند.
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت ریسک اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim());

    await this.saveState();
  }

  // 🩹 Partial De-risking: cuts a fraction of the remaining size while a position is under
  // loss pressure but before the full early-exit condition is confirmed — reduces risk
  // without fully giving up on a potential reversal. Fires at most once per trade.
  private async handlePartialLossCut(order: any, currentPrice: number, fraction: number, reason: string): Promise<boolean> {
    const positionSidePlc: "LONG" | "SHORT" = order.action === "buy" ? "LONG" : "SHORT";
    const realAmtPlc = this.tradingMode === "real" ? await this._getRealOpenPositionAmount(order.symbol, positionSidePlc) : null;
    const cutQty = (realAmtPlc ?? order.quantity) * fraction;
    const cutValue = order.position_value * fraction;

    let actualExitPrice = currentPrice;

    if (this.tradingMode === "real" && this.ccxtExchange) {
      const futuresSym = this._futuresSymbol(order.symbol);
      try {
        if (order.action === "buy") {
          this._addLog(`🩹 [REAL MODE] PARTIAL LOSS-CUT: Selling ${(fraction * 100).toFixed(0)}% of ${order.symbol}...`);
          const safeQtyPlcSell = await this._safeAmount(order.symbol, cutQty, !realAmtPlc);
          const response = await this.ccxtExchange.createOrder(futuresSym, "market", "sell", safeQtyPlcSell, undefined, { positionSide: "LONG", reduceOnly: true });
          if (response && response.id) actualExitPrice = response.average || response.price || currentPrice;
        } else {
          this._addLog(`🩹 [REAL MODE] PARTIAL LOSS-CUT: Covering ${(fraction * 100).toFixed(0)}% of ${order.symbol}...`);
          const safeQtyPlcBuy = await this._safeAmount(order.symbol, cutQty, !realAmtPlc);
          const response = await this.ccxtExchange.createOrder(futuresSym, "market", "buy", safeQtyPlcBuy, undefined, { positionSide: "SHORT", reduceOnly: true });
          if (response && response.id) actualExitPrice = response.average || response.price || currentPrice;
        }
      } catch (err: any) {
        this._addLog(`❌ [PARTIAL LOSS-CUT FAILED] ${order.symbol}: ${err.message || err}`);
        await this.reporter.send(`🚨 <b>خطا در کاهش حجم پله‌ای پوزیشن واقعی!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم مدیریت ریسک در تیک بعدی دوباره تلاش می‌کند.`);
        return false;
      }
    }

    let realizedPnlPct = 0;
    if (order.action === "buy") {
      realizedPnlPct = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
    } else {
      realizedPnlPct = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
    }
    const realizedPnlUsd = (realizedPnlPct / 100) * cutValue;

    if (!order.initial_position_value) order.initial_position_value = order.position_value;
    if (!order.initial_quantity) order.initial_quantity = order.quantity;

    order.quantity = order.quantity - cutQty;
    order.position_value = order.position_value - cutValue;

    // 🔗 اطلاع به موتور کپی‌تریدینگ چندکاربره — کاهش حجم پله‌ای.
    this._fireExit({
      type: "exit",
      sourceOrderId: order.id,
      symbol: order.symbol,
      action: order.action,
      price: actualExitPrice,
      fraction,
      isFinal: false,
      reason,
    });

    if (this.tradingMode === "real") {
      await this.updateRealBalance();
      this.rm.capital = Math.max(0.01, this.realBalance); // 🎯 بدون کف کاذب؛ دقیقاً همان موجودی واقعی صرافی (فقط epsilon برای جلوگیری از تقسیم بر صفر)
    } else {
      this.rm.capital = Math.max(10, this.rm.capital + realizedPnlUsd);
    }

    this._addLog(`🩹 PARTIAL LOSS-CUT (${(fraction * 100).toFixed(0)}% CLOSED): ${order.symbol} at $${actualExitPrice}. Realized: ${realizedPnlPct.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)}). Remaining: $${order.position_value.toFixed(2)}. Reason: ${reason}`);

    await this.reporter.send(`
🩹 <b>کاهش حجم پله‌ای (Partial De-risking)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📉 <b>قیمت فعلی:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
✂️ <b>درصد بسته‌شده:</b> <code>${(fraction * 100).toFixed(0)}٪</code>
🔴 <b>زیان شناسایی‌شده این بخش:</b> <code>${realizedPnlPct.toFixed(2)}%</code> (<code>$${realizedPnlUsd.toFixed(2)}</code>)
📦 <b>ارزش باقیمانده معامله:</b> <code>$${order.position_value.toFixed(2)}</code>
📝 <b>علت:</b> ${reason}
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت ریسک اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim());

    await this.saveState();
    return true;
  }

  // 🧠 Core Cortex Self-Correction, Diagnostics, & Auto-Correction Engine
  public async autoDiagnoseAndAdapt(order: Position, finalPnl: number, finalPnlUsd: number) {
    if (finalPnl >= 0) {
      // WIN/PROFIT: Restore/heal adaptive parameters slowly!
      const previousLosses = this.consecutiveLosses;
      this.consecutiveLosses = 0;
      this.leverageMultiplier = 1.0;
      this.adaptiveSensitivityOverride = null;
      
      if (previousLosses > 0) {
        // Send recovery notification to Telegram
        await this.reporter.send(`
🟢 <b>سامانه بازیابی انطباقی کورتکس (Cortex Autorecovery Log)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز احیا کننده:</b> <code>${order.symbol}/USDT</code>
📈 <b>عملکرد تسویه:</b> سود خالص <code>+${finalPnl.toFixed(2)}%</code>

🔍 <b>وضعیت سیستم:</b> با کسب برآیند مثبت در این موقعیت، معیارهای ریسک ربات به حالت استاندارد بازنشانی شدند.
🛠️ <b>تنظیمات اعمال شده:</b>
  ✅ ضریب تصحیح اهرم: <code>1.0x</code> (اهرم استاندارد صرافی)
  ✅ آستانه حساسیت: <b>پویا (بازنشانی به حالت پیش‌فرض کاربر - ${this.sensitivity})</b>
  ✅ محدودیت حجم ورود (Position Size Limit): لغو شد (رعایت آستانه خام مدیریت سرمایه)
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه هوشمند اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim());
      }
      return;
    }

    // LOSS: Trigger Core Self-Correction & Diagnostics Routine!
    this.consecutiveLosses += 1;
    
    // 1. Diagnose root causes
    let reasonShortEn = "";
    let reasonShortFa = "";
    let reasonDetailFa = "";
    
    const correlationGroup = this.corrMgr.getGroupDescription(order.symbol);

    if (this.btcChange > 0.03 || this.btcChange < -0.03) {
      reasonShortEn = "heavy_btc_drag";
      reasonShortFa = "ریزش جفت ارزها همسو با طوفان قیمتی همبستگی بیت‌کوین (BTC Correlation Drag)";
      reasonDetailFa = `بیت کوین نوسان نسبی شدیدی داشت (تغییرات: ${(this.btcChange * 100).toFixed(1)}٪). در چنین شرایطی واگرایی‌های کوین‌های فرعی لغو و حد ضرر فعال می‌گردد.`;
    } else if (order.daily_vol && order.daily_vol > 0.15) {
      reasonShortEn = "extreme_volatility_whipsaw";
      reasonShortFa = "نوسانات هانتینگ سنگین سایه شمع‌ها (High Volatility Whipsaw)";
      reasonDetailFa = `کوین ${order.symbol} دارای نوسانات روزانه بسیار زیاد (${(order.daily_vol * 100).toFixed(1)}٪) بود که باعث فشرده شدن حد ضرر به دلیل شدت اصلاح شد.`;
    } else if (order.imbalance && Math.abs(order.imbalance) > 0.25) {
      reasonShortEn = "order_book_spread_liquidation";
      reasonShortFa = "برداشت نقدینگی ناگهانی از اوردربوک صرافی (Orderbook Spread Slippage)";
      reasonDetailFa = `برقراری ناپایداری شدید در اوردربوک به نفع فروشندگان مخفی (عدم تطابق ارزش تا ${(order.imbalance * 100).toFixed(1)}٪) که منتهی به ورود اسلیپیج و هارد استاپ شد.`;
    } else {
      reasonShortEn = "support_breakout_reversal";
      reasonShortFa = "شکست کاذب سطح تقاضای خریداران SMC و تغییر در لایه جریان پول هوشمند";
      reasonDetailFa = `تغییر جهت پین بارها به سمت کانال نزولی و شکار حد ضررهای خریداران در کف معتبر SMC قبل از حرکت برگشتی.`;
    }

    // 2. Adaptive Parameter Self-Correction
    const oldSensitivity = this.adaptiveSensitivityOverride || (this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity);
    let newSensitivity: "conservative" | "balanced" | "active" = "conservative";
    
    if (this.consecutiveLosses >= 2) {
      newSensitivity = "conservative"; // strict risk clamp
    } else if (oldSensitivity === "active") {
      newSensitivity = "balanced";
    } else {
      newSensitivity = "conservative";
    }
    this.adaptiveSensitivityOverride = newSensitivity;

    // Scale down leverage
    this.leverageMultiplier = Math.max(0.40, 1.0 - (this.consecutiveLosses * 0.15));

    // 🧠 Smart Risk-Reduction (replaces the old 4-hour hard quarantine):
    // the symbol & its correlation group remain fully scannable and tradeable,
    // but for the next 90 minutes their position size is reduced and the
    // win-probability bar is raised — both decaying smoothly back to normal.
    // Stronger reductions follow longer loss streaks.
    const riskWindow = 90 * 60 * 1000; // 90 minutes, linear decay back to normal
    const reductionStrength = Math.min(0.7, 0.3 + this.consecutiveLosses * 0.1); // how much smaller position sizes get at the start
    const sizeFactor = 1 - reductionStrength; // e.g. 0.5 = half-size at the start of the window
    const extraConfidence = Math.min(0.10, 0.03 + this.consecutiveLosses * 0.015); // up to +10% required win-probability at the start

    this._applyRiskReduction(order.symbol, riskWindow, sizeFactor, extraConfidence);
    if (correlationGroup) {
      this._applyRiskReduction(correlationGroup, riskWindow, sizeFactor, extraConfidence);
    }

    // 🚫 بلاک سخت کوتاه‌مدت روی همان نماد: برخلاف کاهش حجم/افزایش آستانه بالا که
    // اجازه‌ی ورود مجدد سریع (فقط با اعتماد بالاتر) می‌دهد، اینجا برای مدت کوتاهی
    // (که با تعداد باخت‌های پیاپی طولانی‌تر می‌شود) اسکن ورود روی همین نماد را
    // کاملاً متوقف می‌کنیم تا از ورود پشت‌سرهم به یک نماد نوسانی/رنج جلوگیری شود.
    const hardCooldownMs = Math.min(120 * 60 * 1000, (20 + this.consecutiveLosses * 10) * 60 * 1000); // 30..120 دقیقه
    this.hardCooldownMap[order.symbol] = Date.now() + hardCooldownMs;

    // Add log entry to diagnostics ledger
    const diagnosticLog = {
      id: `diag-${Date.now()}-${order.symbol}`,
      time: Date.now(),
      symbol: order.symbol,
      type: "loss_diagnostics",
      title: `عیب‌یابی خودکار موقعیت ${order.symbol}`,
      message: `موقعیت معاملاتی ${order.symbol} با زیان ${Math.abs(finalPnl).toFixed(2)}٪ بسته شد. دلیل شناسایی شده: ${reasonShortFa}. ${reasonDetailFa}`,
      actionTaken: `فعال‌سازی کاهش ریسک هوشمند و رو به کاهش (۹۰ دقیقه) برای ${order.symbol} و گروه ${correlationGroup || "انفرادی"}: حجم معاملات جدید این نماد از ${(sizeFactor * 100).toFixed(0)}٪ شروع و به‌تدریج به ۱۰۰٪ بازمی‌گردد، و حدنصاب اعتماد ورود موقتاً ${(extraConfidence * 100).toFixed(1)}٪ افزایش یافت. فشرده‌سازی آستانه حساسیت سیستم به سطح "${newSensitivity.toUpperCase()}" جهت جلوگیری از نویز کاذب. ضریب اهرم سراسری ربات نیز به میزان ${(this.leverageMultiplier * 100).toFixed(0)}٪ اندازه استاندارد تنظیم شد.`
    };
    this.diagnosticLogs.unshift(diagnosticLog);
    if (this.diagnosticLogs.length > 50) {
      this.diagnosticLogs = this.diagnosticLogs.slice(0, 50);
    }

    // 3. Inform Telegram with beautifully structured Persian content
    const msg = `
🚨 <b>تحلیل خودمراقبتی و عیب‌یابی خودکار کورتکس (Cortex Adaptive Diagnostics)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز زیان‌ده:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
📉 <b>درصد زیان نهایی:</b> <code>${finalPnl.toFixed(2)}%</code> ($${Math.abs(finalPnlUsd).toFixed(2)})
💔 <b>توالی زیان‌های اخیر:</b> <code>${this.consecutiveLosses} معامله منفی پیاپی</code>

🔍 <b>علت زیان ریشه‌یابی شده:</b>
  ├ <b>عنوان عیب:</b> ${reasonShortFa}
  └ <b>شرح فنی:</b> ${reasonDetailFa}

🛠️ <b>اقدامات اصلاحی اتوماسیون ربات (Applied Auto-Corrections):</b>
  ├ 🛡️ <b>کاهش ریسک هوشمند (نه توقف کامل):</b> نماد <b>${order.symbol}</b> و کوین‌های همبسته گروه <b>${correlationGroup || "عمومی"}</b> به مدت <code>۹۰ دقیقه</code> با حجم کاهش‌یافته (${(sizeFactor * 100).toFixed(0)}٪) و حدنصاب اعتماد بالاتر (+${(extraConfidence * 100).toFixed(1)}٪) معامله می‌شوند؛ این کاهش به‌تدریج و به‌صورت خطی به حالت عادی برمی‌گردد و سیگنال‌های فوق‌العاده قوی همچنان قابل اجرا هستند.
  ├ 📈 <b>فشرده‌سازی حساسیت:</b> ارتقای اتوماتیک سطح حساسیت موتور به <b>"${newSensitivity.toUpperCase()}"</b> برای رد شدن فقط خالص‌ترین سیگنال‌های واگرایی.
  ├ ⚖️ <b>کاهش ضربه ریسک سراسری (Leverage Cut):</b> اعمال ضریب تصحیح <code>${this.leverageMultiplier.toFixed(2)}x</code> بر روی اهرم‌ها و پوزیشن سایز کل ربات (پیشگیری از وقوع مارجین کال یا پمپاژ مجدد ضرر).
  └ 📊 <b>سیستم محافظت ضد خودتخریبی پیاپی:</b> کاهش خودکار و موقت حجم معاملات بعدی این نماد به مقدار ریسک کمتر تا بازگشت به حالت عادی.
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه خودمراقبتی کورتکس اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim();

    await this.reporter.send(msg);
    await this.saveState();
  }

  /**
   * 📅 هر شب حوالی ساعت ۲۳:۵۵ به وقت تهران، آمار همان روز را به‌صورت خودکار
   * و یک‌بار به تلگرام ارسال می‌کند (این پیام دائمی است و حذف خودکار نمی‌شود).
   */
  private async _checkAndSendDailyReport() {
    try {
      const now = new Date();
      const tehranParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(now);
      const get = (t: string) => tehranParts.find(p => p.type === t)?.value || "";
      const todayKey = `${get("year")}-${get("month")}-${get("day")}`;
      const hour = parseInt(get("hour"), 10);
      const minute = parseInt(get("minute"), 10);

      if (hour === 23 && minute >= 55 && this.lastDailyReportDate !== todayKey) {
        const entry = await getDailyStats(todayKey);
        await this.reporter.sendDailyReport(entry, "📊 گزارش پایان روز");
        this.lastDailyReportDate = todayKey;
        await this.saveState();
      }
    } catch (e) {
      console.error("Failed to send automatic daily report:", e);
    }
  }

  /**
   * 📡 واکشی فوری قیمت زنده برای همه پوزیشن‌های باز و به‌روزرسانی سود/ضرر آن‌ها.
   * این متد مستقل از چرخه‌ی اسکن اصلی است و مخصوص دکمه‌های شیشه‌ای تلگرام
   * ساخته شده تا آمار نمایش داده‌شده همیشه دقیقاً همان لحظه‌ی درخواست باشد،
   * نه آخرین مقدار کش‌شده از چرخه‌ی قبلی اسکن.
   */
  public async refreshOpenPositionsLive(): Promise<void> {
    if (!this.orders || this.orders.length === 0) return;
    await Promise.all(this.orders.map(async (order) => {
      try {
        const livePrice = this.tradingMode === "real"
          ? (await this._getRealFuturesPrice(order.symbol)) || (await this.client.getLivePrice(order.symbol))
          : await this.client.getLivePrice(order.symbol);
        if (!livePrice || livePrice <= 0) return;
        order.current_price = livePrice;
        let pnlPct: number;
        if (order.action === "buy") {
          pnlPct = ((livePrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
        } else {
          pnlPct = ((order.entry_price - livePrice) / order.entry_price) * 100 * (order.leverage || 1);
        }
        order.pnl_pct = pnlPct;
        order.pnl_usd = (pnlPct / 100) * order.position_value;
      } catch (e) {
        // اگر واکشی قیمت زنده برای یک نماد شکست خورد، آخرین مقدار معتبر آن حفظ
        // می‌شود و سایر پوزیشن‌ها تحت تاثیر قرار نمی‌گیرند.
      }
    }));
  }

  async start() {
    this.shouldBeRunning = true;
    if (this.isRunning) return;
    this.isRunning = true;
    
    // Non-blocking IIFE background loop for smooth server boot
    (async () => {
      if (!this.welcomeSent) {
        try {
          await this.reporter.sendWelcome();
          this.welcomeSent = true;
          await this.saveState();
        } catch (err) {
          console.error("Failed to send welcome message:", err);
        }
      }

      // Start high-frequency direct tracking loop for active positions simultaneously!
      this.runHighFrequencyLiveTracker().catch((err) => {
        console.error("Fatal in High Frequency Live Tracker background loop:", err);
      });

      while (this.isRunning) {
        try {
          await this.scan();
          if (!this.isRunning) break;
          await this._checkAndSendDailyReport();
          const intervalMs = this.config.SCAN_INTERVAL * 1000;
          this.nextScanTime = Date.now() + intervalMs;
          
          const stepMs = 500;
          let elapsed = 0;
          while (elapsed < intervalMs && this.isRunning) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            elapsed += stepMs;
          }
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          this.lastError = `Unhandled Loop Error: ${errMsg}`;
          this._addLog(`Unhandled Loop Error: ${errMsg}`);
          if (!this.isRunning) break;
          this.nextScanTime = Date.now() + 60000;
          const stepMs = 500;
          let elapsed = 0;
          while (elapsed < 60000 && this.isRunning) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            elapsed += stepMs;
          }
        }
      }
      this.nextScanTime = null;
    })().catch((err) => {
      this.lastError = `Scanner background loop fatal error: ${err?.message || err}`;
      console.error("Scanner background loop fatal error:", err);
    });
  }

  stop() {
    this.shouldBeRunning = false;
    this.isRunning = false;
    this.nextScanTime = null;
    this.currentProgress = "سامانه در حالت آماده‌باش.";
    this.welcomeSent = false;
    this.saveState().catch(console.error);
  }
}
