/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SuperTrend + Price Action + Elliott Wave — یگانه استراتژی معاملاتی
 * =====================================================================
 * این ماژول جایگزین کل لایه‌های استراتژی قبلی (Confluence Scalper، Micro
 * Scalp، Vol Regime، Liquidity، Funding، Correlation، Time Sniper) و لایه
 * یادگیری ماشین (Cortex MLOptimizer) شده است. هیچ وزن یا آستانه‌ای در این
 * فایل با دیدن نتیجه معاملات گذشته تغییر نمی‌کند — همه چیز قانون‌محور و
 * شفاف است، دقیقاً مطابق نسخه پایتون و Pine Script پروژه.
 *
 * سه لایه‌ی تصمیم‌گیری:
 *   1) SuperTrend  → تشخیص جهت روند / محرک ورود (فقط در لحظه‌ی چرخش روند)
 *   2) Price Action → تایید با شکست ساختار (BOS/CHoCH) یا الگوی کندلی کلیدی
 *   3) Elliott Wave → فیلتر کمکی برای پرهیز از ورود در نواحی احتمالی
 *                     اتمام موج ۵ یا موج B (نواحی پرریسک بازگشتی)
 */

export interface SuperTrendPAElliottResult {
  action: "buy" | "sell" | "stay_out";
  score: number;        // 0.05..0.95 — بالاتر از ۰.۵ یعنی گرایش صعودی
  confidence: number;   // 0.5..0.95 — قدرت اطمینان سیگنال صادرشده
  reason: string;
  superTrendDir: 1 | -1;
  superTrendFlipBull: boolean;
  superTrendFlipBear: boolean;
  bosUp: boolean;
  bosDown: boolean;
  chochBull: boolean;
  chochBear: boolean;
  candlestickBull: boolean;
  candlestickBear: boolean;
  waveLabel: string;
  waveRiskyZone: boolean;
  atr: number;
  adx: number | null;
}

function trueRangeSeries(highs: number[], lows: number[], closes: number[]): number[] {
  const n = highs.length;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  tr[0] = highs[0] - lows[0];
  return tr;
}

function rollingMean(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Standard ratchet-lock SuperTrend (ATR-based), fully causal. */
function computeSuperTrend(
  highs: number[], lows: number[], closes: number[],
  period = 10, multiplier = 2.0
): { direction: number[]; value: number[] } {
  const n = closes.length;
  const tr = trueRangeSeries(highs, lows, closes);
  const atr = rollingMean(tr, period);
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);

  const upperBand = new Array(n).fill(NaN);
  const lowerBand = new Array(n).fill(NaN);
  const direction = new Array(n).fill(1);
  const supertrend = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (isNaN(atr[i])) continue;
    const currUpper = hl2[i] + multiplier * atr[i];
    const currLower = hl2[i] - multiplier * atr[i];

    const prevUpper = upperBand[i - 1];
    const prevLower = lowerBand[i - 1];
    const prevClose = i > 0 ? closes[i - 1] : closes[i];

    if (isNaN(prevUpper)) {
      upperBand[i] = currUpper;
    } else if (currUpper < prevUpper || prevClose > prevUpper) {
      upperBand[i] = currUpper;
    } else {
      upperBand[i] = prevUpper;
    }

    if (isNaN(prevLower)) {
      lowerBand[i] = currLower;
    } else if (currLower > prevLower || prevClose < prevLower) {
      lowerBand[i] = currLower;
    } else {
      lowerBand[i] = prevLower;
    }

    const prevDir = i > 0 ? direction[i - 1] : 1;
    if (prevDir === -1 && closes[i] > upperBand[i]) {
      direction[i] = 1;
    } else if (prevDir === 1 && closes[i] < lowerBand[i]) {
      direction[i] = -1;
    } else {
      direction[i] = prevDir;
    }

    supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
  }

  return { direction, value: supertrend };
}

/** Swing pivot detection (symmetric window, same lag behavior as a live chart's pivot markers). */
function computeSwingPoints(highs: number[], lows: number[], swingLen: number) {
  const n = highs.length;
  const isSwingHigh = new Array(n).fill(false);
  const isSwingLow = new Array(n).fill(false);

  for (let i = swingLen; i < n - swingLen; i++) {
    let high = true, low = true;
    for (let j = i - swingLen; j <= i + swingLen; j++) {
      if (j === i) continue;
      if (highs[j] > highs[i]) high = false;
      if (lows[j] < lows[i]) low = false;
    }
    isSwingHigh[i] = high;
    isSwingLow[i] = low;
  }
  return { isSwingHigh, isSwingLow };
}

/** Professional price action: Break of Structure / Change of Character. */
function computeMarketStructure(highs: number[], lows: number[], closes: number[], swingLen: number) {
  const n = closes.length;
  const { isSwingHigh, isSwingLow } = computeSwingPoints(highs, lows, swingLen);

  const bosUp = new Array(n).fill(false);
  const bosDown = new Array(n).fill(false);
  const chochBull = new Array(n).fill(false);
  const chochBear = new Array(n).fill(false);
  const bias = new Array(n).fill("neutral");

  let lastSwingHigh = NaN;
  let lastSwingLow = NaN;
  let currentBias = "neutral";

  for (let i = 0; i < n; i++) {
    if (!isNaN(lastSwingHigh) && closes[i] > lastSwingHigh) {
      bosUp[i] = true;
      if (currentBias === "bearish") chochBull[i] = true;
      currentBias = "bullish";
    }
    if (!isNaN(lastSwingLow) && closes[i] < lastSwingLow) {
      bosDown[i] = true;
      if (currentBias === "bullish") chochBear[i] = true;
      currentBias = "bearish";
    }
    bias[i] = currentBias;

    if (isSwingHigh[i]) lastSwingHigh = highs[i];
    if (isSwingLow[i]) lastSwingLow = lows[i];
  }

  return { bosUp, bosDown, chochBull, chochBear, bias, isSwingHigh, isSwingLow };
}

/** Candlestick confirmation on the most recently closed bar. */
function detectCandlestick(opens: number[], highs: number[], lows: number[], closes: number[]) {
  const n = closes.length;
  const o = opens[n - 1], c = closes[n - 1], h = highs[n - 1], l = lows[n - 1];
  const po = opens[n - 2], pc = closes[n - 2];
  const body = Math.abs(c - o);
  const range = h - l;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const bullEngulf = c > o && pc < po && c > po && o < pc;
  const bearEngulf = c < o && pc > po && c < po && o > pc;
  const bullPin = range > 0 && lowerWick > body * 2 && upperWick < body * 0.6;
  const bearPin = range > 0 && upperWick > body * 2 && lowerWick < body * 0.6;

  return {
    bullish: bullEngulf || bullPin,
    bearish: bearEngulf || bearPin,
    label: bullEngulf ? "Engulfing صعودی" : bearEngulf ? "Engulfing نزولی" : bullPin ? "Pin Bar صعودی" : bearPin ? "Pin Bar نزولی" : "",
  };
}

/**
 * امواج الیوت ساده‌شده (کمکی، نه قطعی)
 * بر پایه‌ی همان پیوت‌های سوئینگ، شماره موج تقریبی به هر پیوت نسبت داده
 * می‌شود (چرخه‌ی ۱-۲-۳-۴-۵-A-B-C). این صرفاً یک راهنمای بصری/فیلتر کمکی
 * است، نه یک قانون قطعی — حتی تحلیل‌گران حرفه‌ای هم روی شمارش دقیق امواج
 * توافق کامل ندارند.
 */
function computeElliottWave(isSwingHigh: boolean[], isSwingLow: boolean[]): { waveLabel: string; waveRiskyZone: boolean } {
  const sequence = ["1", "2", "3", "4", "5", "A", "B", "C"];
  let pivotCount = 0;
  let lastDir: "H" | "L" | null = null;

  for (let i = 0; i < isSwingHigh.length; i++) {
    if (isSwingHigh[i] && lastDir !== "H") {
      pivotCount++;
      lastDir = "H";
    } else if (isSwingLow[i] && lastDir !== "L") {
      pivotCount++;
      lastDir = "L";
    }
  }

  if (pivotCount === 0) return { waveLabel: "-", waveRiskyZone: false };
  const label = sequence[(pivotCount - 1) % 8];
  const waveRiskyZone = label === "5" || label === "B";
  return { waveLabel: label, waveRiskyZone };
}

/**
 * ADX (Average Directional Index) — استاندارد Wilder، کاملاً علّی (causal).
 * برای رد کردن ورود در بازارهای رنج/بدون‌روند استفاده می‌شود: SuperTrend روی
 * بازار رنج مستعد شکار مکرر حد ضرر (whipsaw) است چون مدام بین دو باند بالا و
 * پایین نوسان می‌کند بدون این‌که روند واقعی شکل بگیرد. ADX پایین (زیر ~۲۰)
 * نشانه‌ی همین وضعیت رنج بودن بازار است.
 */
function computeADX(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = highs.length;
  const tr = trueRangeSeries(highs, lows, closes);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const wilderSmooth = (values: number[]): number[] => {
    const out = new Array(n).fill(NaN);
    if (period >= n) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += values[i];
    out[period] = sum;
    for (let i = period + 1; i < n; i++) {
      out[i] = out[i - 1] - out[i - 1] / period + values[i];
    }
    return out;
  };

  const smoothedTR = wilderSmooth(tr);
  const smoothedPlusDM = wilderSmooth(plusDM);
  const smoothedMinusDM = wilderSmooth(minusDM);

  const plusDI = new Array(n).fill(NaN);
  const minusDI = new Array(n).fill(NaN);
  const dx = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (isNaN(smoothedTR[i]) || smoothedTR[i] === 0) continue;
    plusDI[i] = 100 * (smoothedPlusDM[i] / smoothedTR[i]);
    minusDI[i] = 100 * (smoothedMinusDM[i] / smoothedTR[i]);
    const diSum = plusDI[i] + minusDI[i];
    dx[i] = diSum > 0 ? (100 * Math.abs(plusDI[i] - minusDI[i])) / diSum : 0;
  }

  const adx = new Array(n).fill(NaN);
  let firstDxIdx = -1;
  for (let i = 0; i < n; i++) {
    if (!isNaN(dx[i])) { firstDxIdx = i; break; }
  }
  if (firstDxIdx === -1) return adx;
  const adxStart = firstDxIdx + period - 1;
  if (adxStart >= n) return adx;

  let sumDx = 0;
  for (let i = firstDxIdx; i < firstDxIdx + period && i < n; i++) sumDx += dx[i] || 0;
  adx[adxStart] = sumDx / period;
  for (let i = adxStart + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + (dx[i] || 0)) / period;
  }
  return adx;
}

export class SuperTrendPriceActionElliottStrategy {
  constructor(
    private atrLength = 10,
    private atrFactor = 2.0,
    private swingLen = 5,
    // زیر این آستانه، بازار «رنج/بدون‌روند» در نظر گرفته می‌شود و حتی اگر چرخش
    // سوپرترند و تایید پرایس‌اکشن هم رخ بدهد، از ورود صرف‌نظر می‌شود.
    private adxThreshold = 20,
    private adxPeriod = 14
  ) {}

  analyze(
    opens: number[], highs: number[], lows: number[], closes: number[]
  ): SuperTrendPAElliottResult {
    const n = closes.length;
    const st = computeSuperTrend(highs, lows, closes, this.atrLength, this.atrFactor);
    const ms = computeMarketStructure(highs, lows, closes, this.swingLen);
    const wave = computeElliottWave(ms.isSwingHigh, ms.isSwingLow);
    const candle = detectCandlestick(opens, highs, lows, closes);
    const adxSeries = computeADX(highs, lows, closes, this.adxPeriod);

    const last = n - 1;
    const dir = st.direction[last] as 1 | -1;
    const prevDir = st.direction[last - 1];
    const flipBull = prevDir === -1 && dir === 1;
    const flipBear = prevDir === 1 && dir === -1;

    const tr = trueRangeSeries(highs, lows, closes);
    const atrSeries = rollingMean(tr, this.atrLength);
    const atr = atrSeries[last] || 0;
    const adx = adxSeries[last];
    // اگر ADX هنوز به دلیل کمبود کندل قابل محاسبه نباشد، فیلتر را غیرفعال می‌کنیم
    // (fail-open) نه اینکه هر ورودی را به‌اشتباه رد کنیم.
    const trendIsStrong = isNaN(adx) ? true : adx >= this.adxThreshold;

    const bosUp = ms.bosUp[last];
    const bosDown = ms.bosDown[last];
    const chochBull = ms.chochBull[last];
    const chochBear = ms.chochBear[last];

    let action: "buy" | "sell" | "stay_out" = "stay_out";
    let score = 0.5;
    let confidence = 0.5;
    let reason = "شرایط ورود (چرخش سوپرترند + تایید پرایس‌اکشن + عدم اشباع موج) در حال حاضر برقرار نیست.";

    if (flipBull) {
      // 🔒 سخت‌گیرتر شد: قبلاً کافی بود کندل کلیدی *یا* BOS باشد (OR)؛ حالا هر
      // دو باید هم‌زمان تایید کنند (AND) تا سیگنال از تک‌شاخصی به هم‌گرایی
      // (confluence) واقعی ارتقا پیدا کند و ورودهای الکی کمتر شوند.
      const paConfirm = candle.bullish && bosUp;
      if (!trendIsStrong) {
        reason = `سوپرترند و پرایس‌اکشن هر دو صعودی بودند، اما بازار در حالت رنج/کم‌روند است (ADX=${adx.toFixed(1)} < ${this.adxThreshold}) — ریسک شکار حد ضرر بالاست، از ورود صرف‌نظر شد.`;
      } else if (paConfirm && !wave.waveRiskyZone) {
        let conf = 0.60;
        const bits: string[] = ["چرخش سوپرترند به صعودی"];
        bits.push(`الگوی کندلی: ${candle.label}`);
        bits.push("شکست ساختار صعودی (BOS)");
        conf += 0.12 + 0.08;
        if (chochBull) { conf += 0.05; bits.push("تغییر کاراکتر بازار به صعودی (CHoCH)"); }
        if (adx >= this.adxThreshold + 10) { conf += 0.05; bits.push(`روند قوی (ADX=${adx.toFixed(1)})`); }
        if (wave.waveLabel === "3" || wave.waveLabel === "1") { conf += 0.15; bits.push(`موقعیت موج الیوت مناسب (موج ${wave.waveLabel})`); }
        confidence = Math.min(conf, 0.95);
        score = Math.min(0.95, 0.5 + (confidence - 0.5));
        action = "buy";
        reason = bits.join(" + ");
      } else if (!paConfirm) {
        reason = "سوپرترند چرخش صعودی داشت، اما پرایس‌اکشن (کندل کلیدی و BOS همزمان) آن را تایید نکرد.";
      } else {
        reason = `سوپرترند چرخش صعودی داشت اما موقعیت فعلی در ناحیه پرریسک امواج الیوت (موج ${wave.waveLabel}) است — از ورود صرف‌نظر شد.`;
      }
    } else if (flipBear) {
      const paConfirm = candle.bearish && bosDown;
      if (!trendIsStrong) {
        reason = `سوپرترند و پرایس‌اکشن هر دو نزولی بودند، اما بازار در حالت رنج/کم‌روند است (ADX=${adx.toFixed(1)} < ${this.adxThreshold}) — ریسک شکار حد ضرر بالاست، از ورود صرف‌نظر شد.`;
      } else if (paConfirm && !wave.waveRiskyZone) {
        let conf = 0.60;
        const bits: string[] = ["چرخش سوپرترند به نزولی"];
        bits.push(`الگوی کندلی: ${candle.label}`);
        bits.push("شکست ساختار نزولی (BOS)");
        conf += 0.12 + 0.08;
        if (chochBear) { conf += 0.05; bits.push("تغییر کاراکتر بازار به نزولی (CHoCH)"); }
        if (adx >= this.adxThreshold + 10) { conf += 0.05; bits.push(`روند قوی (ADX=${adx.toFixed(1)})`); }
        if (wave.waveLabel === "3" || wave.waveLabel === "1") { conf += 0.15; bits.push(`موقعیت موج الیوت مناسب (موج ${wave.waveLabel})`); }
        confidence = Math.min(conf, 0.95);
        score = Math.max(0.05, 0.5 - (confidence - 0.5));
        action = "sell";
        reason = bits.join(" + ");
      } else if (!paConfirm) {
        reason = "سوپرترند چرخش نزولی داشت، اما پرایس‌اکشن (کندل کلیدی و BOS همزمان) آن را تایید نکرد.";
      } else {
        reason = `سوپرترند چرخش نزولی داشت اما موقعیت فعلی در ناحیه پرریسک امواج الیوت (موج ${wave.waveLabel}) است — از ورود صرف‌نظر شد.`;
      }
    }

    return {
      action, score, confidence, reason,
      superTrendDir: dir,
      superTrendFlipBull: flipBull,
      superTrendFlipBear: flipBear,
      bosUp, bosDown, chochBull, chochBear,
      candlestickBull: candle.bullish,
      candlestickBear: candle.bearish,
      waveLabel: wave.waveLabel,
      waveRiskyZone: wave.waveRiskyZone,
      atr,
      adx: isNaN(adx) ? null : adx,
    };
  }
}
