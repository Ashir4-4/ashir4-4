/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Signal Engine v5 — SuperTrend + Price Action + Elliott Wave (Pure Rule-Based)
 * ===============================================================================
 * تمام لایه‌های استراتژی قبلی (Vol Regime، Liquidity، Funding، Correlation،
 * Time Sniper، Micro Scalp، Advanced Confluence Scalper) و لایه یادگیری
 * ماشین Cortex/MLOptimizer حذف شده‌اند. تصمیم نهایی (action/score/confidence)
 * اکنون فقط از یک استراتژی واحد و کاملاً شفاف می‌آید:
 *
 *     SuperTrend  →  Price Action (BOS/CHoCH + کندل)  →  Elliott Wave (فیلتر کمکی)
 *
 * سایر ماژول‌ها (GARCH، اردربوک، آیس‌برگ، واگرایی، حجم) صرفاً به‌عنوان
 * داده‌ی نمایشی/ریسک‌سایزینگ نگه داشته شده‌اند و در تصمیم ورود دخالتی ندارند.
 */

import { GARCH11, VolumeAnalyzer, OrderFlowAnalyzer, ATR, RSI } from "./indicators";
import { ShadowHunter, PainPointDetector, DivergenceSniffer } from "./advancedStrategies";
import { SuperTrendPriceActionElliottStrategy } from "./superTrendStrategy";
import { Klines, OrderBook, Signal } from "./types";

export class SignalEngine {
  private garch = new GARCH11();
  private orderflow = new OrderFlowAnalyzer();
  private shadowHunter = new ShadowHunter();
  private painDetector = new PainPointDetector();
  private divergenceSniffer = new DivergenceSniffer();
  private strategyEngine = new SuperTrendPriceActionElliottStrategy(10, 2.0, 5);

  public sensitivity: "conservative" | "balanced" | "active" = "conservative";
  // فیلد سازگاری با پنل/سرور قدیمی — دیگر هیچ تاثیری روی تصمیم ورود ندارد.
  // ورود همیشه فقط بر اساس یک استراتژی (SuperTrend+PriceAction+ElliottWave)
  // و با تایید کامل انجام می‌شود، بدون هیچ سوییچ دورزدن تاییدیه.
  public disable9Layers = false;
  // فیلد سازگاری با پنل/سرور قدیمی - دیگر بین چند استراتژی سوییچ نمی‌کند؛
  // فقط برای نمایش در UI نگه داشته شده.
  public strategy: string = "auto";

  public minScore = 0.6;

  // 🧠 کاهش ریسک هوشمند (غیر یادگیری‌محور): بعد از یک ضرر اخیر، اسکنر
  // موقتاً حدنصاب اطمینان لازم برای ورود را بالا می‌برد. این یک قانون ثابت
  // است، نه وزن آموخته‌شده.
  public extraMinConfidence = 0;

  private getDynamicThreshold(regime: string): number {
    const base = this.sensitivity === "conservative" ? 0.68
      : this.sensitivity === "active" ? 0.55
      : 0.62; // balanced
    const bump = regime === "extreme" ? 0.06 : regime === "high" ? 0.03 : 0;
    return Math.min(0.92, base + bump + this.extraMinConfidence);
  }

  async analyze(symbol: string, klines: Klines, orderbook: OrderBook | null, change24h = 0, btcChange = 0, livePrice = 0): Promise<Signal | null> {
    const closes = klines.close;
    const highs = klines.high;
    const lows = klines.low;
    const opens = klines.open;
    const volumes = klines.volume;

    if (closes.length < 50) return null;

    const currentPrice = livePrice > 0 ? livePrice : closes[closes.length - 1];

    // ==========================================
    // 📊 ماژول‌های نمایشی/ریسک‌سایزینگ (بدون دخالت در تصمیم ورود)
    // ==========================================
    const rsiVal = RSI.calculate(closes, 14);

    const trailingVolumeMA = volumes.slice(-24).reduce((sum, v) => sum + v, 0) / 24;
    const latestVolume = volumes[volumes.length - 1];
    const volumeSurgeRatio = trailingVolumeMA > 0 ? latestVolume / trailingVolumeMA : 1.0;

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    this.garch.fit(returns);
    const volMetrics = this.garch.getMetrics();
    const volSurgeResult = VolumeAnalyzer.detectVolumeSurge(volumes);

    let orderflowScore = 0.5;
    let orderflowSignal = "neutral";
    let imbalance = 0;
    if (orderbook) {
      const ofResult = this.orderflow.analyze(orderbook.bids, orderbook.asks, currentPrice);
      orderflowScore = ofResult.score;
      orderflowSignal = ofResult.signal;
      imbalance = ofResult.imbalance;
    }

    let icebergResult = { iceberg_detected: false, direction: "none", strength: 0, message: "" };
    if (orderbook) {
      icebergResult = this.shadowHunter.detectIceberg(orderbook.bids, orderbook.asks);
    }
    const icebergScore = icebergResult.direction === "accumulation" ? 0.85 : icebergResult.direction === "distribution" ? 0.15 : 0.5;

    const yesterdayHigh = highs[highs.length - 2];
    const yesterdayLow = lows[lows.length - 2];
    const weeklyOpen = opens.length >= 7 ? opens[opens.length - 7] : opens[0];

    const painResult = this.painDetector.detect(
      currentPrice, yesterdayHigh, yesterdayLow, weeklyOpen,
      orderbook?.bids || [], orderbook?.asks || []
    );
    const painScore = painResult.active && painResult.distance_pct < 0.35 ? (currentPrice > painResult.target_price ? 0.20 : 0.80) : 0.5;

    const divergenceResult = this.divergenceSniffer.sniff(closes, volumes);
    const divergenceScore = divergenceResult.type === "bullish" ? 0.85 : divergenceResult.type === "bearish" ? 0.15 : 0.5;

    const atr = ATR.calculate(highs, lows, closes, 14);
    const relativeATR = atr / currentPrice;

    // ==========================================
    // 🎯 تصمیم ورود — فقط SuperTrend + Price Action + Elliott Wave
    // ==========================================
    const strat = this.strategyEngine.analyze(opens, highs, lows, closes);

    let action: "buy" | "sell" | "stay_out" = strat.action;
    let finalScore = strat.score;
    let confidence = strat.confidence;
    let vetoReason = strat.reason;

    const dynamicThreshold = this.getDynamicThreshold(volMetrics.regime);

    if (action !== "stay_out" && confidence < dynamicThreshold) {
      vetoReason = `اعتماد سیگنال (${(confidence * 100).toFixed(1)}٪) کمتر از آستانه پویای فعلی (${(dynamicThreshold * 100).toFixed(1)}٪) است. ربات از ورود صرف‌نظر کرد. [${strat.reason}]`;
      action = "stay_out";
      confidence = 0.5;
      finalScore = 0.5;
    }

    // فیلتر نوسان: از ورود در نوسان بیش‌ازحد راکد یا بیش‌ازحد شدید جلوگیری می‌کند
    if (action !== "stay_out" && (relativeATR < 0.003 || relativeATR > 0.06)) {
      vetoReason = `نسبت نوسان ATR (${(relativeATR * 100).toFixed(2)}%) خارج از بازه‌ی معاملاتی سالم است. ربات از ورود صرف‌نظر کرد.`;
      action = "stay_out";
      confidence = 0.5;
      finalScore = 0.5;
    }

    // محاسبه استاپ‌لاس/تارگت تطبیقی بر اساس ATR
    const rawStopLossPct = Math.max(1.4 * relativeATR, 0.012);
    const stopLossPct = Math.min(rawStopLossPct, 0.035);

    let dynamicRR1 = 1.35;
    let dynamicRR2 = 2.50;
    const rsiNoise = (rsiVal % 1) * 0.12 - 0.06;
    dynamicRR1 = Math.max(1.10, Math.min(1.80, dynamicRR1 + rsiNoise));
    dynamicRR2 = Math.max(2.10, Math.min(3.80, dynamicRR2 + rsiNoise * 2.0));

    const takeProfit1Pct = stopLossPct * dynamicRR1;
    const takeProfit2Pct = stopLossPct * dynamicRR2;

    let stopLoss = currentPrice;
    let takeProfit = currentPrice;
    let takeProfit2 = currentPrice;

    if (action === "buy") {
      stopLoss = currentPrice * (1 - stopLossPct);
      takeProfit = currentPrice * (1 + takeProfit1Pct);
      takeProfit2 = currentPrice * (1 + takeProfit2Pct);
    } else if (action === "sell") {
      stopLoss = currentPrice * (1 + stopLossPct);
      takeProfit = currentPrice * (1 - takeProfit1Pct);
      takeProfit2 = currentPrice * (1 - takeProfit2Pct);
    }

    // ⚡ اهرم تطبیقی (۱۰x تا ۵۰x) — مستقیماً بر اساس اعتماد قانون‌محور سیگنال
    let leverageSelection = 10;
    if (action !== "stay_out") {
      const span = Math.max(0.0001, 0.95 - dynamicThreshold);
      const normalizedConfidence = Math.max(0, Math.min(1, (confidence - dynamicThreshold) / span));
      const volRiskDampener = Math.max(0.3, Math.min(1.0, 0.012 / Math.max(relativeATR, 0.0001)));
      const rawLeverage = 10 + normalizedConfidence * 40;
      leverageSelection = Math.round(rawLeverage * volRiskDampener);
      leverageSelection = Math.max(10, Math.min(50, leverageSelection));
    }

    // ==========================================
    // 🧾 اجزای همان یک استراتژی (بدون هیچ لایه مصنوعی/ساختگی)
    // ==========================================
    const subSignalsObj: Record<string, { score: number; signal?: string; reason?: string; message?: string }> = {
      supertrend: {
        score: strat.superTrendDir === 1 ? 0.85 : 0.15,
        signal: strat.superTrendDir === 1 ? "buy" : "sell",
        reason: strat.superTrendDir === 1 ? "روند سوپرترند صعودی است." : "روند سوپرترند نزولی است.",
      },
      price_action: {
        score: (strat.bosUp || strat.candlestickBull) ? 0.85 : (strat.bosDown || strat.candlestickBear) ? 0.15 : 0.5,
        reason: [
          strat.bosUp ? "BOS صعودی" : strat.bosDown ? "BOS نزولی" : null,
          strat.chochBull ? "CHoCH صعودی" : strat.chochBear ? "CHoCH نزولی" : null,
          strat.candlestickBull || strat.candlestickBear ? "الگوی کندلی کلیدی" : null,
        ].filter(Boolean).join(" + ") || "بدون تایید پرایس‌اکشن تازه",
      },
      elliott_wave: {
        score: strat.waveRiskyZone ? 0.30 : 0.70,
        reason: `موج تقریبی فعلی: ${strat.waveLabel}${strat.waveRiskyZone ? " (ناحیه پرریسک احتمالی)" : ""}`,
      },
    };

    // وزن‌های ثابت و شفاف (نه آموخته‌شده) — صرفاً برای نمایش در پنل
    const staticWeights: Record<string, number> = {
      supertrend: 0.35,
      price_action: 0.35,
      elliott_wave: 0.30,
    };

    return {
      symbol,
      action,
      score: finalScore,
      confidence: Math.min(confidence, 1.0),
      price: currentPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      take_profit_2: takeProfit2,
      leverage: leverageSelection,
      daily_vol: volMetrics.daily_vol,
      regime: volMetrics.regime,
      vol_surge: volSurgeResult.surge || volumeSurgeRatio >= 1.4,
      vol_surge_msg: volSurgeResult.message || `جهش حجم معاملات (×${volumeSurgeRatio.toFixed(1)})`,
      imbalance,
      iceberg: icebergResult,
      pain_point: painResult,
      divergence: divergenceResult,
      dynamic_threshold: dynamicThreshold,
      ml_weights: staticWeights,
      sub_signals: subSignalsObj,
      veto_reason: vetoReason !== "" ? vetoReason : undefined,
    };
  }

  /**
   * سازگاری با اسکنر: قبلاً این متد نتیجه معامله را به MLOptimizer می‌داد
   * تا وزن‌ها را تطبیق دهد. حالا استراتژی کاملاً قانون‌محور و ثابت است، پس
   * این متد صرفاً برای سازگاری با فراخوانی‌های موجود نگه داشته شده و هیچ
   * وزن یا آستانه‌ای را بر اساس نتیجه معاملات گذشته تغییر نمی‌دهد.
   */
  recordTrade(_subSignals: any, _action: string, _result: string) {
    // no-op — بدون یادگیری تطبیقی
  }
}
