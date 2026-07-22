/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VolMetrics } from "./types";
import { mean, std, variance, sum } from "mathjs";

export class GARCH11 {
  public omega = 0.00001;
  public alpha = 0.05;
  public beta = 0.90;
  public fitted = false;
  public latest_variance: number | null = null;
  public annualized_vol: number | null = null;
  public volatility_regime: VolMetrics["regime"] = "normal";

  // Lightweight grid optimization to find alpha and beta that minimize GARCH Negative Log-Likelihood
  fit(returns: number[]): boolean {
    const validReturns = returns.filter((r) => isFinite(r)).map((r) => Math.max(-0.5, Math.min(0.5, r)));
    if (validReturns.length < 30) {
      return this._fallback(validReturns);
    }

    try {
      const initialVar = Math.max(variance(validReturns) as unknown as number, 0.0001);
      
      let bestOmega = 0.00001;
      let bestAlpha = 0.05;
      let bestBeta = 0.90;
      let minNegLogLikelihood = Infinity;

      // Sample a clean domain supporting GARCH(1,1) stationarity constraints (alpha + beta < 1)
      const alphaCandidates = [0.03, 0.06, 0.10, 0.14];
      const betaCandidates = [0.80, 0.85, 0.89, 0.93];

      for (const a of alphaCandidates) {
        for (const b of betaCandidates) {
          if (a + b >= 0.99) continue;
          
          let negLogL = 0;
          let currentV = initialVar;
          let isValid = true;

          for (let t = 1; t < validReturns.length; t++) {
            const nextV = 0.00001 + a * Math.pow(validReturns[t - 1], 2) + b * currentV;
            if (nextV <= 0 || !isFinite(nextV)) {
              isValid = false;
              break;
            }
            // Add contribution to negative log-likelihood: ln(variance) + return^2 / variance
            negLogL += Math.log(nextV) + Math.pow(validReturns[t], 2) / nextV;
            currentV = nextV;
          }

          if (isValid && negLogL < minNegLogLikelihood) {
            minNegLogLikelihood = negLogL;
            bestAlpha = a;
            bestBeta = b;
          }
        }
      }

      this.alpha = bestAlpha;
      this.beta = bestBeta;
      this.fitted = true;
      this._compute(validReturns);
      this._regime();
      return true;
    } catch (e) {
      return this._fallback(validReturns);
    }
  }

  private _compute(r: number[]) {
    const n = r.length;
    const v = new Array(n);
    const initialVar = Math.max(variance(r) as unknown as number, 0.0001);
    v[0] = initialVar;
    for (let t = 1; t < n; t++) {
      v[t] = this.omega + this.alpha * Math.pow(r[t - 1], 2) + this.beta * v[t - 1];
    }
    this.latest_variance = v[n - 1];
    // Since klines are 5-minute, annualizing vol requires scaling by 288 intervals/day * 365 days = 105120
    this.annualized_vol = Math.sqrt(this.latest_variance! * 105120);
  }

  private _fallback(r: number[]): boolean {
    const v = r.length > 0 ? Math.max(variance(r) as unknown as number, 0.0001) : 0.0001;
    this.latest_variance = v;
    this.annualized_vol = Math.sqrt(v * 105120);
    this._regime();
    return true;
  }

  private _regime() {
    if (this.annualized_vol === null) return;
    const v = this.annualized_vol;
    // Regime thresholds adjusted for true annualized volatility of crypto assets
    if (v < 0.45) this.volatility_regime = "low";
    else if (v < 0.95) this.volatility_regime = "normal";
    else if (v < 1.90) this.volatility_regime = "high";
    else this.volatility_regime = "extreme";
  }

  getMetrics(): VolMetrics {
    if (this.latest_variance === null) {
      return { daily_vol: 0, annualized_vol: 0, regime: "unknown", fitted: false };
    }
    // Convert 5m variance to daily variance: daily_var = 5m_var * 288 (since there are 288 5-minute candles a day)
    const daily_variance = this.latest_variance * 288;
    return {
      daily_vol: Math.sqrt(daily_variance),
      annualized_vol: this.annualized_vol!,
      regime: this.volatility_regime,
      fitted: this.fitted,
    };
  }
}

export class VolumeAnalyzer {
  static detectVolumeSurge(volumes: number[]) {
    if (volumes.length < 30) return { surge: false, strength: 0 };
    
    // Check immediate local high-frequency volume surge comparing last 4 periods to preceding 20 periods Average
    const recentVol = sum(volumes.slice(-4));
    const baseVol = sum(volumes.slice(-24, -4)) / 5; // Average over 4-period groups

    if (baseVol > 0 && recentVol > baseVol * 1.35) {
      const strength = recentVol / baseVol;
      return {
        surge: true,
        strength,
        message: `افزایش حجم لوکال ۵ دقیقه‌ای (×${strength.toFixed(1)})`,
      };
    }

    // Fallback/Legacy daily/multi-hour surge check if enough history exists
    if (volumes.length >= 72) {
      const blockVol: number[] = [];
      for (let i = 0; i <= volumes.length - 24; i += 24) {
        blockVol.push(sum(volumes.slice(i, i + 24)));
      }

      if (blockVol.length >= 3) {
        const today = blockVol[blockVol.length - 1];
        const yesterday = blockVol[blockVol.length - 2];
        const dayBefore = blockVol[blockVol.length - 3];

        if (yesterday > dayBefore && today > yesterday) {
          const strength = Math.min(today / Math.max(dayBefore, 0.0001), 5.0);
          return {
            surge: true,
            strength,
            message: `افزایش متوالی حجم بلاکی (×${strength.toFixed(1)})`,
          };
        }
      }
    }
    return { surge: false, strength: 0 };
  }
}

export class OrderFlowAnalyzer {
  analyze(bids: [number, number][], asks: [number, number][], currentPrice: number) {
    if (!bids.length || !asks.length) {
      return { score: 0.5, signal: "neutral", imbalance: 0 };
    }
    const bidVol = sum(bids.slice(0, 50).map((b) => b[1]));
    const askVol = sum(asks.slice(0, 50).map((a) => a[1]));
    const totalVol = bidVol + askVol;
    
    if (totalVol === 0) return { score: 0.5, signal: "neutral", imbalance: 0 };
    
    const imbalance = (bidVol - askVol) / totalVol;
    let score = 0.5 + imbalance * 0.35;
    score = Math.max(0, Math.min(1, score));
    const signal = score > 0.65 ? "buy" : score < 0.35 ? "sell" : "neutral";
    
    return { score, signal, imbalance };
  }
}

export class ATR {
  static calculate(highs: number[], lows: number[], closes: number[], periods = 14) {
    if (highs.length < periods + 1) return 0;
    const trueRanges: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const h = highs[i];
      const l = lows[i];
      const pc = closes[i - 1];
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      trueRanges.push(tr);
    }
    const atrValue = mean(trueRanges.slice(-periods)) as unknown as number;
    return atrValue;
  }
}

export class RSI {
  static calculate(closes: number[], periods = 14) {
    if (closes.length < periods + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - periods; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / periods) / (losses / periods);
    return 100 - (100 / (1 + rs));
  }
}

export class RegimeDetector {
  private short: number;
  private long: number;
  public regime = "unknown";
  public conf = 0.0;

  constructor(short = 20, long = 50) {
    this.short = short;
    this.long = long;
  }

  detect(closes: number[], returns: number[]) {
    if (closes.length < this.long) return { regime: "unknown", confidence: 0 };
    
    const ma_s = mean(closes.slice(-this.short)) as unknown as number;
    const ma_l = mean(closes.slice(-this.long)) as unknown as number;
    const trend = ma_l > 0 ? (ma_s - ma_l) / ma_l : 0;
    
    const vol_s = std(returns.slice(-this.short)) as unknown as number;
    const vol_l = std(returns.slice(-this.long)) as unknown as number;
    const vol_r = vol_l > 0 ? vol_s / vol_l : 1;
    
    const mom = sum(returns.slice(-10)) as number;
    
    let regime = "ranging";
    let conf = 0.5;

    if (vol_r > 1.5) {
      regime = "volatile";
      conf = Math.min(vol_r / 3, 1);
    } else if (Math.abs(trend) > 0.03 && Math.abs(mom) > 0.02) {
      regime = trend > 0 ? "trending_up" : "trending_down";
      conf = Math.min(Math.abs(trend) * 10, 1);
    } else {
      regime = mom > 0.01 ? "weak_uptrend" : mom < -0.01 ? "weak_downtrend" : "ranging";
      conf = 0.5;
    }

    this.regime = regime;
    this.conf = conf;
    return { regime, confidence: conf };
  }

  getBias() {
    if (["trending_up", "weak_uptrend"].includes(this.regime)) {
      return { direction: "buy", weight: this.conf };
    } else if (["trending_down", "weak_downtrend"].includes(this.regime)) {
      return { direction: "sell", weight: this.conf };
    } else if (this.regime === "volatile") {
      return { direction: "stay_out", weight: 0 };
    }
    return { direction: "neutral", weight: 0.3 };
  }
}
