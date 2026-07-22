import React, { useState } from "react";
import { Calculator, Percent, Sparkles, TrendingUp, AlertCircle, Info } from "lucide-react";
import { motion } from "motion/react";

export function KellyCalculator() {
  const [balance, setBalance] = useState<number>(10000);
  const [winRate, setWinRate] = useState<number>(65); // 65% win rate default
  const [riskReward, setRiskReward] = useState<number>(2.5); // 1:2.5 RR ratio
  const [kellyFraction, setKellyFraction] = useState<number>(0.5); // Half Kelly (safer)

  // Kelly Formula: f* = (p * (b + 1) - 1) / b
  // where p is win probability, b is net odds (risk reward ratio)
  const p = winRate / 100;
  const b = riskReward;
  
  const idealKelly = b > 0 ? (p * (b + 1) - 1) / b : 0;
  const safeKelly = Math.max(0, idealKelly * kellyFraction);
  const calculatedPosition = balance * safeKelly;

  return (
    <div className="bg-gradient-to-b from-slate-900/50 to-slate-950/60 border border-cyan-950/40 rounded-3xl p-6 backdrop-blur-md relative overflow-hidden flex flex-col justify-between neon-glow-cyan">
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 blur-3xl pointer-events-none" />
      
      <div className="space-y-6">
        {/* Title */}
        <div className="flex items-center justify-between border-b border-white/5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-cyan-500/10 rounded-lg text-cyan-400">
              <Calculator size={16} />
            </div>
            <h3 className="text-sm font-semibold text-white tracking-wider">سیستم مدیریت سرمایه کِلی (Kelly Formula)</h3>
          </div>
          <span className="text-[10px] bg-cyan-500/10 text-cyan-400 font-bold px-2 py-0.5 rounded-full border border-cyan-500/20 font-mono">
            ALGO-RISK
          </span>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          فرمول کِلی به صورت ریاضی اندازه بهینه موقعیت معاملاتی را بر اساس نرخ برد (Win Rate) و نسبت سود به زیان (R:R) برای به حداکثر رساندن رشد سرمایه تعیین می‌کند.
        </p>

        {/* Inputs */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5 text-right">
            <label className="text-[10px] text-slate-400 font-medium block">کل سرمایه صرافی ($)</label>
            <input 
              type="number"
              value={balance}
              onChange={(e) => setBalance(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500/50 transition-colors text-left"
            />
          </div>

          <div className="space-y-1.5 text-right">
            <label className="text-[10px] text-slate-400 font-medium block">نسبت سود به زیان (R:R)</label>
            <input 
              type="number"
              step="0.1"
              value={riskReward}
              onChange={(e) => setRiskReward(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500/50 transition-colors text-left"
            />
          </div>

          <div className="space-y-1.5 text-right">
            <label className="text-[10px] text-slate-400 font-medium block">نرخ برد فرضی ربات (Win %)</label>
            <div className="relative">
              <input 
                type="number"
                min="0"
                max="100"
                value={winRate}
                onChange={(e) => setWinRate(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                className="w-full bg-black/40 border border-white/10 rounded-xl pl-8 pr-3 py-2 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500/50 transition-colors text-left"
              />
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 font-mono font-bold">%</span>
            </div>
          </div>

          <div className="space-y-1.5 text-right">
            <label className="text-[10px] text-slate-400 font-medium block">ضریب احتیاط (Kelly Fraction)</label>
            <select
              value={kellyFraction}
              onChange={(e) => setKellyFraction(parseFloat(e.target.value))}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-mono text-cyan-300 focus:outline-none focus:border-cyan-500/50 transition-colors text-left" dir="ltr"
            >
              <option value="1">1.0 (Full Kelly - پرریسک)</option>
              <option value="0.5">0.5 (Half Kelly - استاندارد)</option>
              <option value="0.25">0.25 (Quarter Kelly - امن)</option>
            </select>
          </div>
        </div>

        {/* Results */}
        <div className="bg-black/30 border border-cyan-950/30 rounded-2xl p-4 space-y-3.5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-400 font-medium">درصد از کل سرمایه (Kelly %):</span>
            <span className="text-purple-400 font-mono font-bold">
              {(safeKelly * 100).toFixed(1)}%
            </span>
          </div>

          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-400 font-medium">حجم معامله ایده آل پیشنهادی:</span>
            <span className="text-cyan-400 font-mono font-bold text-sm">
              ${calculatedPosition.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-400 font-medium">ریسک احتمالی در استاپ لاس:</span>
            <span className="text-red-400 font-mono font-bold">
              ${(calculatedPosition * 0.05).toLocaleString("en-US", { maximumFractionDigits: 1 })} (فرضی ۵٪)
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-white/5 pt-3 flex items-start gap-2 text-[10px] text-slate-500 bg-slate-950/20 p-3 rounded-xl border">
        <Info size={14} className="text-cyan-500 shrink-0 mt-0.5" />
        <span className="leading-normal">
          اگر درصد برد یا نسبت سود به زیان موقعیت شما خیلی پایین باشد، فرمول کِلی جهت جلوگیری از زیان بزرگ، ماندن در خارج از بازار را پیشنهاد می‌دهد (0%).
        </span>
      </div>
    </div>
  );
}
