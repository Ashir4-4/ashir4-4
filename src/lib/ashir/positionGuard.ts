/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { XTClient } from "./xtClient";
import { CorrelationManager } from "./correlationManager";
import { Position } from "./types";
import { ATR, OrderFlowAnalyzer } from "./indicators";

/**
 * 🛡️ Position Guard
 * ------------------
 * Supplies the "market pressure" context the Adaptive Exit Engine needs:
 *  - Current ATR% per symbol (volatility regime), cached with a TTL so we
 *    don't hammer the exchange on every 750ms tick.
 *  - Correlation/sector stress: what fraction of other open positions in the
 *    same correlation group are currently losing alongside this one.
 *  - Signal invalidation: a lightweight, throttled recheck of the order-flow
 *    imbalance that originally supported the trade direction. If it has
 *    flipped hard against the position, the original thesis no longer holds.
 */
export class PositionGuard {
  private client: XTClient;
  private corrMgr: CorrelationManager;
  private flow = new OrderFlowAnalyzer();

  private atrCache = new Map<string, { pct: number; ts: number }>();
  private invalidationCache = new Map<string, { ts: number; invalidated: boolean; reason?: string }>();

  private readonly ATR_TTL_MS = 5 * 60 * 1000;       // refresh ATR at most every 5 minutes per symbol
  private readonly INVALIDATION_TTL_MS = 20 * 1000;  // recheck order-flow at most every 20 seconds per order
  private readonly IMBALANCE_FLIP_THRESHOLD = 0.18;  // how hard the book must flip to count as invalidation

  constructor(client: XTClient, corrMgr: CorrelationManager) {
    this.client = client;
    this.corrMgr = corrMgr;
  }

  clear(orderId: string) {
    this.invalidationCache.delete(orderId);
  }

  /** Current ATR as a fraction of price (e.g. 0.018 = 1.8%), cached per symbol. Returns null if unavailable. */
  async getAtrPct(symbol: string): Promise<number | null> {
    const cached = this.atrCache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.ts < this.ATR_TTL_MS) return cached.pct;

    try {
      const klines = await this.client.getKlines(symbol, "5m", 100);
      if (!klines || klines.close.length < 20) return cached?.pct ?? null;
      const atrValue = ATR.calculate(klines.high, klines.low, klines.close, 14);
      const lastClose = klines.close[klines.close.length - 1];
      if (!lastClose) return cached?.pct ?? null;
      const pct = atrValue / lastClose;
      this.atrCache.set(symbol, { pct, ts: now });
      return pct;
    } catch {
      return cached?.pct ?? null;
    }
  }

  /**
   * Fraction (0..1) of other *filled* positions in the same correlation group
   * that are currently in loss, alongside this order. 0 if this symbol has no
   * meaningful group, or it's the only open position in its group.
   */
  getCorrelationStress(order: Position, allOrders: Position[]): number {
    const group = this.corrMgr.getGroup(order.symbol);
    if (group === "other") return 0;
    const groupOrders = allOrders.filter(
      (o) => o.status === "filled" && this.corrMgr.getGroup(o.symbol) === group
    );
    if (groupOrders.length <= 1) return 0;
    const losing = groupOrders.filter((o) => (o.pnl_pct ?? 0) < 0).length;
    return losing / groupOrders.length;
  }

  /**
   * Throttled recheck of whether the order-flow imbalance that supported the
   * original trade direction has flipped hard against it. Returns cached
   * result between throttle intervals to avoid excessive orderbook fetches.
   */
  async checkSignalInvalidated(order: Position): Promise<{ invalidated: boolean; reason?: string }> {
    const now = Date.now();
    const cached = this.invalidationCache.get(order.id);
    if (cached && now - cached.ts < this.INVALIDATION_TTL_MS) {
      return { invalidated: cached.invalidated, reason: cached.reason };
    }

    try {
      const ob = await this.client.getOrderbook(order.symbol, 50);
      if (!ob || !ob.bids?.length || !ob.asks?.length) {
        const result = { invalidated: false };
        this.invalidationCache.set(order.id, { ts: now, ...result });
        return result;
      }

      const currentPrice = order.current_price || order.entry_price;
      const { imbalance } = this.flow.analyze(ob.bids, ob.asks, currentPrice);

      let invalidated = false;
      let reason: string | undefined;

      if (order.action === "buy" && imbalance <= -this.IMBALANCE_FLIP_THRESHOLD) {
        invalidated = true;
        reason = `اوردربوک برخلاف خرید چرخید (عدم تعادل ${(imbalance * 100).toFixed(1)}٪ به نفع فروشندگان)`;
      } else if (order.action === "sell" && imbalance >= this.IMBALANCE_FLIP_THRESHOLD) {
        invalidated = true;
        reason = `اوردربوک برخلاف فروش چرخید (عدم تعادل ${(imbalance * 100).toFixed(1)}٪ به نفع خریداران)`;
      }

      this.invalidationCache.set(order.id, { ts: now, invalidated, reason });
      return { invalidated, reason };
    } catch {
      const result = cached ? { invalidated: cached.invalidated, reason: cached.reason } : { invalidated: false };
      return result;
    }
  }
}
