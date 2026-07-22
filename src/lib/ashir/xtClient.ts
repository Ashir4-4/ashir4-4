/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import axios, { AxiosInstance } from "axios";
import { Ticker, Klines, OrderBook } from "./types";

export class XTClient {
  private api_key: string;
  private base_url: string;
  private session: AxiosInstance;
  private _ticker_cache: Ticker[] | null = null;
  private _ticker_time = 0;

  constructor(api_key: string, base_url = "https://sapi.xt.com") {
    this.api_key = api_key;
    this.base_url = base_url;
    this.session = axios.create({
      baseURL: base_url,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
      },
      timeout: 15000,
    });
  }

  private async _get<T>(endpoint: string, params: any = {}): Promise<T | null> {
    try {
      const resp = await this.session.get(endpoint, { params });
      if (resp.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return this._get(endpoint, params);
      }
      const data = resp.data;
      return data?.rc === 0 ? data : null;
    } catch (error) {
      return null;
    }
  }

  async getAllUsdtPairs(force_refresh = false): Promise<Ticker[]> {
    const now = Date.now();
    // Reduce default cache duration to 1000ms for split-second real-time responsiveness
    if (this._ticker_cache && !force_refresh && (now - this._ticker_time) < 1000) {
      return this._ticker_cache;
    }

    const result: any = await this._get("/v4/public/ticker", force_refresh ? { _t: now } : {});
    if (!result) return this._ticker_cache || [];

    const pairs: Ticker[] = [];
    for (const item of result.result || []) {
      const symbol = item.s || "";
      const price = parseFloat(item.c || "0");
      const vol = parseFloat(item.v || "0");
      const change = parseFloat(item.cp || "0");
      if (symbol.toLowerCase().endsWith("_usdt") && price > 0 && vol > 0) {
        const clean = symbol.replace(/_USDT$/i, "").toUpperCase();
        pairs.push({ symbol, clean, price, volume: vol, change_24h: change });
      }
    }

    const seen = new Set<string>();
    const unique: Ticker[] = [];
    for (const p of pairs) {
      if (!seen.has(p.clean)) {
        seen.add(p.clean);
        unique.push(p);
      }
    }

    this._ticker_cache = unique.sort((a, b) => b.volume - a.volume);
    this._ticker_time = now;
    return this._ticker_cache;
  }

  async getLivePrice(symbol: string): Promise<number | null> {
    const symbolWithUsdt = symbol.toLowerCase().includes("_usdt") ? symbol.toLowerCase() : `${symbol.toLowerCase()}_usdt`;
    
    // 1. Try to fetch the top of the orderbook (limit 1) which is absolute real-time and never cached by any CDN
    try {
      const orderbook = await this.getOrderbook(symbolWithUsdt, 1);
      if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
        const topBid = orderbook.bids[0][0];
        const topAsk = orderbook.asks[0][0];
        if (topBid > 0 && topAsk > 0) {
          return (topBid + topAsk) / 2;
        }
      }
    } catch (err) {
      // Fallback if depth request fails
    }

    // 2. Fetch live ticker directly with cache-buster parameter for ultra-low latency & zero CDN caching
    const result: any = await this._get("/v4/public/ticker", { 
      symbol: symbolWithUsdt, 
      _t: Date.now() 
    });
    if (result && result.result) {
      const items = Array.isArray(result.result) ? result.result : [result.result];
      const item = items.find((i: any) => i.s.toLowerCase() === symbolWithUsdt);
      if (item && item.c) {
        return parseFloat(item.c);
      }
    }
    
    // 3. Fallback: Lookup in the fresh unified tickers batch
    const all = await this.getAllUsdtPairs(true);
    const p = all.find(x => x.symbol.toLowerCase() === symbolWithUsdt);
    return p ? p.price : null;
  }

  async getKlines(symbol: string, interval = "1d", limit = 200): Promise<Klines | null> {
    if (!symbol.toLowerCase().includes("_usdt")) {
      symbol = `${symbol.toLowerCase()}_usdt`;
    }
    const result: any = await this._get("/v4/public/kline", { symbol, interval, limit });
    if (result?.result) {
      const data = result.result;
      if (data && data.length > 0) {
        return {
          open: data.map((d: any) => parseFloat(d.o)),
          high: data.map((d: any) => parseFloat(d.h)),
          low: data.map((d: any) => parseFloat(d.l)),
          close: data.map((d: any) => parseFloat(d.c)),
          volume: data.map((d: any) => parseFloat(d.v)),
        };
      }
    }
    return null;
  }

  async getOrderbook(symbol: string, depth = 100): Promise<OrderBook | null> {
    if (!symbol.toLowerCase().includes("_usdt")) {
      symbol = `${symbol.toLowerCase()}_usdt`;
    }
    const result: any = await this._get("/v4/public/depth", { symbol, limit: depth });
    if (result?.result) {
      const data = result.result;
      return {
        bids: (data.bids || []).slice(0, depth).map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]),
        asks: (data.asks || []).slice(0, depth).map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]),
      };
    }
    return null;
  }

  async getRecentTrades(symbol: string, limit = 30): Promise<any[] | null> {
    if (!symbol.toLowerCase().includes("_usdt")) {
      symbol = `${symbol.toLowerCase()}_usdt`;
    }
    const result: any = await this._get("/v4/public/trade/recent", { symbol, limit });
    if (result?.result) {
      return result.result.map((t: any) => ({
        id: t.i,
        time: t.t,
        price: parseFloat(t.p),
        qty: parseFloat(t.q),
        value: parseFloat(t.v || "0"),
        isBuyerMaker: t.b
      }));
    }
    return null;
  }
}
