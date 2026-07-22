/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Position } from "./types";

export class CorrelationManager {
  private correlationGroups: Record<string, { coins: string[]; max_exposure: number; description: string }> = {
    layer1: { coins: ["BTC", "ETH", "BNB", "SOL"], max_exposure: 0.3, description: "لایه ۱ — زیرساخت اصلی" },
    defi: { coins: ["UNI", "AAVE", "MKR", "COMP", "CRV", "SNX"], max_exposure: 0.15, description: "دیفای — پروتکلهای مالی" },
    layer2: { coins: ["MATIC", "ARB", "OP", "STRK", "ZK", "IMX"], max_exposure: 0.15, description: "لایه ۲ — مقیاسپذیری" },
    gaming: { coins: ["GALA", "SAND", "MANA", "AXS", "ENJ", "ILV"], max_exposure: 0.1, description: "بازی و متاورس" },
    meme: { coins: ["DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI"], max_exposure: 0.1, description: "میم — نوسان بالا" },
    oracle: { coins: ["LINK", "BAND", "TRB", "API3"], max_exposure: 0.1, description: "اوراکل — تأمینکنندگان داده" },
  };

  getGroup(symbol: string): string {
    const s = symbol.toUpperCase();
    for (const [name, data] of Object.entries(this.correlationGroups)) {
      if (data.coins.includes(s)) return name;
    }
    return "other";
  }

  getMaxExposure(symbol: string): number {
    const group = this.getGroup(symbol);
    return group === "other" ? 0.05 : this.correlationGroups[group].max_exposure;
  }

  getGroupDescription(symbol: string): string {
    const group = this.getGroup(symbol);
    return group === "other" ? "سایر — بدون گروه" : this.correlationGroups[group].description;
  }

  calculateGroupExposure(group: string, currentPositions: Position[], capital: number): number {
    const coins = group === "other" ? [] : this.correlationGroups[group]?.coins || [];
    const exposure = currentPositions
      .filter((p) => coins.includes(p.symbol.toUpperCase()))
      .reduce((s, p) => s + p.position_value, 0);
    return capital > 0 ? exposure / capital : 0;
  }

  checkCorrelationLimit(symbol: string, currentPositions: Position[], proposedSize: number, capital: number) {
    const group = this.getGroup(symbol);
    const currentExposure = this.calculateGroupExposure(group, currentPositions, capital);
    const maxExposure = this.getMaxExposure(symbol);
    const proposedPct = capital > 0 ? proposedSize / capital : 0;
    const newExposure = currentExposure + proposedPct;

    if (newExposure > maxExposure) {
      const allowedAddition = Math.max(0, (maxExposure - currentExposure) * capital);
      const reductionPct = proposedSize > 0 ? ((proposedSize - allowedAddition) / proposedSize) * 100 : 0;
      return {
        allowed: true,
        adjusted_size: allowedAddition,
        original_size: proposedSize,
        reduction_pct: reductionPct,
        warning: `حجم از $${proposedSize.toFixed(2)} به $${allowedAddition.toFixed(2)} کاهش یافت (گروه ${this.getGroupDescription(symbol)} به سقف ${(maxExposure * 100).toFixed(0)}٪ نزدیک شد)`,
        group,
        current_exposure: currentExposure,
        max_exposure: maxExposure,
      };
    }

    return {
      allowed: true,
      adjusted_size: proposedSize,
      original_size: proposedSize,
      reduction_pct: 0,
      warning: "",
      group,
      current_exposure: currentExposure,
      max_exposure: maxExposure,
    };
  }
}
