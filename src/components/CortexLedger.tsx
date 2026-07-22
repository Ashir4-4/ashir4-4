import React from "react";
import { TrendingUp, TrendingDown, RefreshCcw, DollarSign, Award, Percent, ChevronRight, BarChart3, AlertCircle } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface LedgerStats {
  totalClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  netUsd: number;
  netPct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  bestTrade: { symbol: string; pnl_usd: number; pnl_pct: number } | null;
  worstTrade: { symbol: string; pnl_usd: number; pnl_pct: number } | null;
  profitFactor: number | null;
  profitFactorLabel: string;
  baseCapital: number;
}

interface CortexLedgerProps {
  status: any;
  ledgerStats: LedgerStats;
  profitParts: any[];
  lossParts: any[];
  profitTradesCount: number;
  profitTotalUsd: number;
  lossTradesCount: number;
  lossTotalUsd: number;
  onOpenArchive: (type: "profit" | "stop") => void;
  onResetSimulatedTrades: () => void;
  isResettingTrades: boolean;
}

export function CortexLedger({
  status,
  ledgerStats,
  profitParts,
  lossParts,
  profitTradesCount,
  profitTotalUsd,
  lossTradesCount,
  lossTotalUsd,
  onOpenArchive,
  onResetSimulatedTrades,
  isResettingTrades
}: CortexLedgerProps) {
  // All headline numbers below come straight from the backend's computeLedgerStats()
  // (the same function powering the Telegram bot's "سود/ضرر کل" button), so the
  // dashboard and Telegram can never disagree, and only truly closed positions
  // ever factor into win-rate / ROI / profit-factor.
  const totalClosed = ledgerStats.totalClosed;
  const winRate = ledgerStats.winRate;
  const netEarningsUsd = ledgerStats.netUsd;
  const isNetProfit = netEarningsUsd >= 0;
  const finalStartingCapital = ledgerStats.baseCapital;
  const cumulativePct = ledgerStats.netPct;
  const bestTrade = ledgerStats.bestTrade;

  return (
    <section className="bg-[#181A20] border border-[#242731] rounded-xl p-4.5 space-y-4 shadow-lg text-right">
      {/* CARD HEADER */}
      <div className="flex items-center justify-between border-b border-[#2B3139]/80 pb-2.5">
        <div className="flex items-center gap-1.5 font-sans">
          <Award className="text-[#F0B90B]" size={16} />
          <h3 className="text-xs font-black text-white uppercase font-mono">تراز عملکرد و آمار حساب (Ledger Ledger)</h3>
        </div>
        <span className="text-[8px] bg-[#F0B90B]/10 text-[#F0B90B] px-1.5 py-0.5 rounded font-mono font-bold">CORTEX LEDGER</span>
      </div>

      {/* WIN RATE METER GAUGE */}
      <div className="bg-black/30 border border-[#2B3139]/40 p-3 rounded-xl space-y-2">
        <div className="flex items-center justify-between text-xs font-sans font-bold">
          <span className="text-slate-400">موفقیت معاملات (Win Rate):</span>
          <span className={cn(
            "font-mono font-black text-sm",
            winRate >= 50 ? "text-emerald-400" : "text-rose-400"
          )}>
            {winRate.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-slate-900/60 h-2.5 rounded-full overflow-hidden flex border border-[#2B3139]/20">
          <div 
            style={{ width: `${winRate}%` }} 
            className={cn(
              "h-full transition-all duration-700 rounded-full",
              winRate >= 50 
                ? "bg-gradient-to-r from-emerald-500 to-teal-400" 
                : "bg-gradient-to-r from-rose-500 to-orange-400"
            )}
          />
        </div>
        <div className="flex justify-between items-center text-[10px] text-slate-500 font-medium">
          <span>{lossTradesCount} ضرر</span>
          <span>{profitTradesCount} سود</span>
          <span>{totalClosed} معامله بسته شده</span>
        </div>
      </div>

      {/* NET EARNINGS & ROI PANEL */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-[#161920]/60 p-3 rounded-xl border border-white/[0.02] flex flex-col justify-between">
          <span className="text-[10px] text-slate-400 font-bold block mb-1">عایدی خالص کل (USD)</span>
          <div className={cn(
            "font-mono font-black text-sm block tracking-wider",
            isNetProfit ? "text-emerald-400" : "text-rose-400"
          )}>
            {isNetProfit ? "+" : ""}${netEarningsUsd.toFixed(2)}
          </div>
        </div>

        <div className="bg-[#161920]/60 p-3 rounded-xl border border-white/[0.02] flex flex-col justify-between">
          <div>
            <span className="text-[10px] text-slate-400 font-bold block mb-0.5">بازده درصد تجمعی (Account ROI)</span>
            <span className="text-[8px] text-[#A5B4FC]/60 block leading-none mb-1">نسبت به کل سرمایه اولیه (${finalStartingCapital.toFixed(0)})</span>
          </div>
          <div className={cn(
            "font-mono font-black text-sm block tracking-wider",
            isNetProfit ? "text-[#10B981]" : "text-[#EF4444]"
          )}>
            {isNetProfit ? "+" : ""}{cumulativePct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* ADDITIONAL KEY DETAILS STATS */}
      <div className="bg-black/15 p-2.5 rounded-lg border border-[#2B3139]/40 space-y-1.5 text-xs text-slate-400">
        <div className="flex justify-between items-center">
          <span className="text-[10px]">بهترین معامله (Best Profit):</span>
          {bestTrade ? (
            <span className="font-mono text-emerald-400 font-black text-[11px]">
              {bestTrade.symbol}: +${bestTrade.pnl_usd.toFixed(1)} (+{bestTrade.pnl_pct.toFixed(1)}%)
            </span>
          ) : (
            <span className="text-slate-600 italic font-medium">موردی ثبت نشده</span>
          )}
        </div>
        <div className="flex justify-between items-center border-t border-white/[0.03] pt-1.5">
          <span className="text-[10px]">فاکتور سود تجمعی:</span>
          <span className="font-mono text-slate-200 font-bold text-[11px]">
            {ledgerStats.profitFactorLabel} PF
          </span>
        </div>
      </div>

      {/* CLOSED TRADES ARCHIVE NAVIGATION BUTTONS */}
      <div className="grid grid-cols-2 gap-2 text-[10px] font-black">
        <button
          onClick={() => onOpenArchive("profit")}
          className="h-9 truncate bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-[0.98] border border-emerald-500/20 hover:border-emerald-500/50 text-emerald-300 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-all"
        >
          <TrendingUp size={11} />
          <span>آرشیو سودها ({profitTradesCount})</span>
        </button>
        <button
          onClick={() => onOpenArchive("stop")}
          className="h-9 truncate bg-rose-500/10 hover:bg-rose-500/20 active:scale-[0.98] border border-rose-500/20 hover:border-rose-500/50 text-rose-300 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-all"
        >
          <TrendingDown size={11} />
          <span>آرشیو ضررها ({lossTradesCount})</span>
        </button>
      </div>

      {/* DENSE RECENT CLOSED SIMULATED TRADES SUB-PANEL */}
      <div className="space-y-1.5 text-right">
        <label className="text-[10px] text-slate-400 block mb-1 font-bold">آخرین موقعیت‌های تسویه شده:</label>
        <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1 custom-scrollbar text-[10px]">
          {status.closedOrders && status.closedOrders.length > 0 ? (
            status.closedOrders.slice(0, 4).map((coin: any, idx: number) => {
              const isProfit = (coin.pnl_pct || 0) >= 0;
              return (
                <div 
                  key={coin.id || idx} 
                  className="bg-black/20 p-2 rounded-lg border border-white/5 flex items-center justify-between text-right font-sans transition-colors hover:border-[#F0B90B]/30"
                >
                  <div className="font-mono flex items-center gap-1.5">
                    <span className={cn(
                      "font-black px-1.5 py-0.5 rounded text-[9px]",
                      isProfit ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                    )}>
                      {isProfit ? "+" : ""}{(coin.pnl_pct || 0).toFixed(1)}%
                    </span>
                    <span className={cn(
                      "font-extrabold",
                      isProfit ? "text-[#10B981]" : "text-[#EF4444]"
                    )}>
                      ${(coin.pnl_usd || 0).toFixed(1)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="text-right">
                      <span className="font-mono font-black text-white text-[10px]">{coin.symbol}</span>
                      <span className="text-[8px] text-slate-500 block leading-none">{coin.action === "buy" ? "خرید" : "فروش"}</span>
                    </div>
                    <div className={cn(
                      "w-6 h-6 rounded-md flex items-center justify-center border",
                      isProfit ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                    )}>
                      {isProfit ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-5 text-center text-slate-600 bg-black/10 border border-[#2B3139]/40 border-dashed rounded-lg italic">
              هیچ پوزیشن بسته‌ای تاکنون ثبت نشده است.
            </div>
          )}
        </div>
      </div>

      {/* QUICK SIMULATOR RESET BUTTON */}
      <button
        onClick={onResetSimulatedTrades}
        disabled={isResettingTrades}
        className="w-full h-8.5 border border-rose-500/30 bg-rose-500/5 hover:bg-rose-500/15 text-rose-400 hover:text-rose-300 rounded-lg text-[10px] font-black transition-all flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
      >
        {isResettingTrades ? (
          <div className="w-3.5 h-3.5 border border-rose-400 border-t-transparent rounded-full animate-spin" />
        ) : (
          <RefreshCcw size={11} className="text-rose-400" />
        )}
        <span>پاکسازی تاریخچه و ریست دارایی تستی شبیه‌ساز</span>
      </button>

    </section>
  );
}
