/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class ShadowHunter {
  private lookback: number;
  private orderHistory: { bids: [number, number][]; asks: [number, number][] }[] = [];

  constructor(lookback = 20) {
    this.lookback = lookback;
  }

  detectIceberg(bids: [number, number][], asks: [number, number][]) {
    if (!bids.length || !asks.length) {
      return { iceberg_detected: false, direction: "none", strength: 0, message: "" };
    }
    const currentBids = bids.slice(0, 10);
    const currentAsks = asks.slice(0, 10);
    this.orderHistory.push({ bids: currentBids, asks: currentAsks });
    if (this.orderHistory.length > this.lookback) this.orderHistory.shift();

    if (this.orderHistory.length < 5) {
      return { iceberg_detected: false, direction: "none", strength: 0, message: "" };
    }

    const bidPatterns = this._findPatterns("bids");
    const askPatterns = this._findPatterns("asks");

    if (bidPatterns.score > askPatterns.score && bidPatterns.score > 0.6) {
      return {
        iceberg_detected: true,
        direction: "accumulation",
        strength: bidPatterns.score,
        message: `Iceberg buy detected (${(bidPatterns.score * 100).toFixed(0)}%)`,
      };
    } else if (askPatterns.score > bidPatterns.score && askPatterns.score > 0.6) {
      return {
        iceberg_detected: true,
        direction: "distribution",
        strength: askPatterns.score,
        message: `Iceberg sell detected (${(askPatterns.score * 100).toFixed(0)}%)`,
      };
    }
    return { iceberg_detected: false, direction: "none", strength: 0, message: "" };
  }

  private _findPatterns(side: "bids" | "asks") {
    const history = this.orderHistory.slice(-5);
    const volumes: number[] = [];
    for (const hist of history) {
      const orders = hist[side];
      volumes.push(...orders.map((o) => o[1]));
    }

    const volCounts: Record<number, number> = {};
    for (const v of volumes) {
      const rounded = Math.round(v * 100000000) / 100000000;
      volCounts[rounded] = (volCounts[rounded] || 0) + 1;
    }

    const icebergVols = Object.entries(volCounts)
      .filter(([v, count]) => count >= 3)
      .map(([v]) => parseFloat(v));

    if (icebergVols.length > 0) {
      return { score: Math.min(icebergVols.length / 10, 1.0), count: icebergVols.length };
    }
    return { score: 0, count: 0 };
  }
}

export class PainPointDetector {
  public painPoints: { price: number; type: string; reason: string }[] = [];

  detect(
    currentPrice: number,
    yesterdayHigh: number,
    yesterdayLow: number,
    weeklyOpen: number,
    orderbookBids: [number, number][],
    orderbookAsks: [number, number][]
  ) {
    const points: { price: number; type: string; reason: string }[] = [];
    if (currentPrice < yesterdayHigh * 1.02) {
      points.push({ price: yesterdayHigh, type: "Yesterday High", reason: "سقف دیروز — حد ضرر فروشندگان" });
    }
    if (currentPrice > yesterdayLow * 0.98) {
      points.push({ price: yesterdayLow, type: "Yesterday Low", reason: "کف دیروز — حد ضرر خریداران" });
    }
    if (currentPrice > weeklyOpen * 0.98 && currentPrice < weeklyOpen * 1.02) {
      points.push({ price: weeklyOpen, type: "Weekly Open", reason: "باز شدن هفتگی — نقدینگی سنگین" });
    }
    const roundNum = Math.round(currentPrice / 1000) * 1000;
    if (Math.abs(currentPrice - roundNum) / currentPrice < 0.01) {
      points.push({ price: roundNum, type: `Round Number ${roundNum}`, reason: "عدد رند روانی" });
    }
    if (orderbookBids.length > 0) {
      const maxBidWall = orderbookBids.slice(0, 20).reduce((max, b) => (b[1] > max[1] ? b : max), orderbookBids[0]);
      points.push({ price: maxBidWall[0], type: "Bid Wall", reason: `دیوار خرید در ${maxBidWall[0].toFixed(2)}` });
    }
    if (orderbookAsks.length > 0) {
      const maxAskWall = orderbookAsks.slice(0, 20).reduce((max, a) => (a[1] > max[1] ? a : max), orderbookAsks[0]);
      points.push({ price: maxAskWall[0], type: "Ask Wall", reason: `دیوار فروش در ${maxAskWall[0].toFixed(2)}` });
    }

    points.sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price));
    this.painPoints = points.slice(0, 5);

    if (this.painPoints.length > 0 && Math.abs(currentPrice - this.painPoints[0].price) / currentPrice < 0.005) {
      const nearest = this.painPoints[0];
      return {
        active: true,
        target_price: nearest.price,
        reason: nearest.reason,
        distance_pct: (Math.abs(currentPrice - nearest.price) / currentPrice) * 100,
      };
    }
    return { active: false, target_price: 0, reason: "", distance_pct: 0 };
  }
}

export class DivergenceSniffer {
  sniff(closes: number[], volumes: number[]) {
    if (closes.length < 25) {
      return { divergence: false, type: "none", strength: 0, message: "" };
    }

    // 1. Calculate RSI-14 series for the last 20 elements
    const rsiValues: number[] = [];
    for (let i = closes.length - 20; i < closes.length; i++) {
      const slice = closes.slice(0, i + 1);
      let gains = 0;
      let losses = 0;
      const period = 14;
      if (slice.length < period + 1) {
        rsiValues.push(50);
        continue;
      }
      for (let j = slice.length - period; j < slice.length; j++) {
        const diff = slice[j] - slice[j - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      const rs = losses === 0 ? 100 : gains / losses;
      rsiValues.push(100 - (100 / (1 + rs)));
    }

    const prices = closes.slice(-20);
    const len = rsiValues.length;

    // 2. Bullish Divergence: Price Lower Low, RSI Higher Low
    let p_low_recent_idx = -1;
    let p_low_recent_val = Infinity;
    for (let i = len - 8; i < len; i++) {
      if (prices[i] < p_low_recent_val) {
        p_low_recent_val = prices[i];
        p_low_recent_idx = i;
      }
    }

    let p_low_hist_idx = -1;
    let p_low_hist_val = Infinity;
    for (let i = len - 20; i < len - 8; i++) {
      if (prices[i] < p_low_hist_val) {
        p_low_hist_val = prices[i];
        p_low_hist_idx = i;
      }
    }

    if (p_low_recent_idx !== -1 && p_low_hist_idx !== -1 && p_low_recent_idx !== p_low_hist_idx) {
      const rsi_low_recent = rsiValues[p_low_recent_idx];
      const rsi_low_hist = rsiValues[p_low_hist_idx];

      if (p_low_recent_val < p_low_hist_val && rsi_low_recent > rsi_low_hist && rsi_low_recent < 42) {
        const diff_price_pct = ((p_low_hist_val - p_low_recent_val) / p_low_hist_val) * 100;
        const diff_rsi = rsi_low_recent - rsi_low_hist;
        return {
          divergence: true,
          type: "bullish",
          strength: Math.min(diff_rsi / 25, 1.0),
          message: `واگرایی مثبت RSI: قیمت کف جدید ساخت (${diff_price_pct.toFixed(2)}%) اما RSI متناظر افزایش یافت (+${diff_rsi.toFixed(1)})`,
        };
      }
    }

    // 3. Bearish Divergence: Price Higher High, RSI Lower High
    let p_high_recent_idx = -1;
    let p_high_recent_val = -Infinity;
    for (let i = len - 8; i < len; i++) {
      if (prices[i] > p_high_recent_val) {
        p_high_recent_val = prices[i];
        p_high_recent_idx = i;
      }
    }

    let p_high_hist_idx = -1;
    let p_high_hist_val = -Infinity;
    for (let i = len - 20; i < len - 8; i++) {
      if (prices[i] > p_high_hist_val) {
        p_high_hist_val = prices[i];
        p_high_hist_idx = i;
      }
    }

    if (p_high_recent_idx !== -1 && p_high_hist_idx !== -1 && p_high_recent_idx !== p_high_hist_idx) {
      const rsi_high_recent = rsiValues[p_high_recent_idx];
      const rsi_high_hist = rsiValues[p_high_hist_idx];

      if (p_high_recent_val > p_high_hist_val && rsi_high_recent < rsi_high_hist && rsi_high_recent > 58) {
        const diff_price_pct = ((p_high_recent_val - p_high_hist_val) / p_high_hist_val) * 100;
        const diff_rsi = rsi_high_hist - rsi_high_recent;
        return {
          divergence: true,
          type: "bearish",
          strength: Math.min(diff_rsi / 25, 1.0),
          message: `واگرایی منفی RSI: قیمت سقف جدید ساخت (${diff_price_pct.toFixed(2)}%) اما RSI متناظر کاهش یافت (-${diff_rsi.toFixed(1)})`,
        };
      }
    }

    return { divergence: false, type: "none", strength: 0, message: "" };
  }
}
