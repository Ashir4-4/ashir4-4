import React, { useState } from "react";
import { Clock, Globe, Target, TrendingUp, TrendingDown, CalendarDays, CalendarRange, Sparkles, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AppStatus } from "../types";

interface HourlyPerformancePanelProps {
  status: AppStatus;
  onRefresh?: () => Promise<void> | void;
}

function hourLabel(h: number): string {
  const from = String(h).padStart(2, "0");
  const to = String((h + 1) % 24).padStart(2, "0");
  return `${from}-${to}`;
}

const fa = new Intl.NumberFormat("fa-IR");

export function HourlyPerformancePanel({ status, onRefresh }: HourlyPerformancePanelProps) {
  const [switching, setSwitching] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const mode = status.tradingHoursMode || "24_7";
  const buckets = status.hourlyBuckets || [];
  const best = status.bestHours || null;
  const bestSet = new Set(best?.bestHours || []);
  const today = status.todayStats;
  const week = status.weeklyStats || [];

  const maxAbs = Math.max(1, ...buckets.map((b) => Math.abs(b.avgPnlUsd)));

  const handleSetMode = async (newMode: "24_7" | "smart") => {
    if (newMode === mode || switching) return;
    try {
      setSwitching(true);
      const res = await fetch("/api/bot/trading-hours-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      const data = await res.json();
      setActionMessage(data.message || (res.ok ? "با موفقیت تغییر کرد." : "خطا در تغییر حالت."));
      if (onRefresh) await onRefresh();
    } catch (err: any) {
      setActionMessage(`خطا: ${err.message}`);
    } finally {
      setSwitching(false);
      setTimeout(() => setActionMessage(null), 5000);
    }
  };

  const weekNet = week.reduce((s, d) => s + (d.profitUsd - d.lossUsd), 0);
  const weekTrades = week.reduce((s, d) => s + d.trades, 0);
  const weekWins = week.reduce((s, d) => s + d.wins, 0);
  const weekWinRate = weekTrades > 0 ? (weekWins / weekTrades) * 100 : 0;

  const todayNet = today ? today.profitUsd - today.lossUsd : 0;
  const todayWinRate = today && today.trades > 0 ? (today.wins / today.trades) * 100 : 0;

  return (
    <section className="bg-[#181A20] border border-amber-500/20 hover:border-amber-500/40 transition-colors rounded-xl p-4.5 space-y-4 shadow-lg text-right relative overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* HEADER */}
      <div className="flex items-center justify-between border-b border-[#2B3139]/80 pb-2.5 relative z-10 flex-wrap gap-2">
        <div className="flex items-center gap-1.5 font-sans">
          <Clock className="text-amber-400" size={16} />
          <h3 className="text-xs font-black text-white uppercase font-mono">عملکرد ساعتی و آمار روزانه/هفتگی</h3>
        </div>
        <span className="text-[8px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded font-mono font-bold">HOURLY GUARD</span>
      </div>

      {/* MODE SWITCH */}
      <div className="bg-black/20 border border-white/[0.03] p-3 rounded-xl space-y-2.5 relative z-10">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-[10px] text-slate-300 font-bold flex items-center gap-1">
            <Sparkles size={11} className="text-amber-400" />
            حالت ساعات معاملاتی
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleSetMode("24_7")}
            disabled={switching}
            className={`flex items-center justify-center gap-1.5 p-2.5 rounded-lg border text-xs font-black transition-all ${
              mode === "24_7"
                ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
                : "bg-black/30 border-white/5 text-slate-400 hover:border-cyan-500/20 hover:text-cyan-300"
            }`}
          >
            <Globe size={13} /> ۲۴/۷ (بدون محدودیت)
          </button>
          <button
            onClick={() => handleSetMode("smart")}
            disabled={switching}
            className={`flex items-center justify-center gap-1.5 p-2.5 rounded-lg border text-xs font-black transition-all ${
              mode === "smart"
                ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                : "bg-black/30 border-white/5 text-slate-400 hover:border-amber-500/20 hover:text-amber-300"
            }`}
          >
            {switching ? <Loader2 size={13} className="animate-spin" /> : <Target size={13} />} فقط ساعات طلایی
          </button>
        </div>

        <AnimatePresence>
          {actionMessage && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="text-[9px] bg-amber-950/40 border border-amber-500/20 text-amber-300 px-2.5 py-1 rounded-md text-right font-medium"
            >
              ℹ️ {actionMessage}
            </motion.div>
          )}
        </AnimatePresence>

        {mode === "smart" && best && (
          <div className="text-[9px] text-slate-400 leading-relaxed bg-black/25 border border-white/5 rounded-lg p-2">
            {best.sufficientData ? (
              <>
                <span className="text-amber-400 font-bold">ساعت‌های طلایی فعال: </span>
                {best.bestHours.map((h) => hourLabel(h)).join("، ")}
              </>
            ) : (
              <span>{best.reason}</span>
            )}
          </div>
        )}
      </div>

      {/* TODAY / WEEK CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 relative z-10">
        <div className="bg-black/35 border border-white/5 p-3 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-400 font-bold flex items-center gap-1">
              <CalendarDays size={11} className="text-cyan-400" /> آمار امروز
            </span>
            {todayNet >= 0 ? <TrendingUp size={12} className="text-emerald-400" /> : <TrendingDown size={12} className="text-rose-400" />}
          </div>
          <span className={`text-sm font-black ${todayNet >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {todayNet >= 0 ? "+" : ""}${todayNet.toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-500 block">
            {today ? `${fa.format(today.trades)} معامله — وین‌ریت ${todayWinRate.toFixed(0)}٪` : "هنوز معامله‌ای ثبت نشده"}
          </span>
        </div>

        <div className="bg-black/35 border border-white/5 p-3 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-400 font-bold flex items-center gap-1">
              <CalendarRange size={11} className="text-cyan-400" /> آمار ۷ روز اخیر
            </span>
            {weekNet >= 0 ? <TrendingUp size={12} className="text-emerald-400" /> : <TrendingDown size={12} className="text-rose-400" />}
          </div>
          <span className={`text-sm font-black ${weekNet >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {weekNet >= 0 ? "+" : ""}${weekNet.toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-500 block">
            {fa.format(weekTrades)} معامله — وین‌ریت {weekWinRate.toFixed(0)}٪
          </span>
        </div>
      </div>

      {/* WEEKLY BREAKDOWN TABLE */}
      {week.length > 0 && (
        <div className="space-y-1.5 relative z-10">
          <label className="text-[9px] text-slate-500 block">تفکیک روزهای اخیر:</label>
          <div className="grid grid-cols-7 gap-1">
            {[...week].reverse().map((d) => {
              const net = d.profitUsd - d.lossUsd;
              const label = new Date(d.date + "T12:00:00").toLocaleDateString("fa-IR", { day: "numeric", month: "short" });
              return (
                <div
                  key={d.date}
                  className={`p-1.5 rounded-lg border text-center ${
                    net > 0 ? "bg-emerald-500/5 border-emerald-500/20" : net < 0 ? "bg-rose-500/5 border-rose-500/20" : "bg-black/20 border-white/5"
                  }`}
                  title={`${d.trades} معامله`}
                >
                  <span className="block text-[7.5px] text-slate-500">{label}</span>
                  <span className={`block text-[9px] font-black ${net > 0 ? "text-emerald-400" : net < 0 ? "text-rose-400" : "text-slate-400"}`}>
                    {net >= 0 ? "+" : ""}${net.toFixed(0)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 24-HOUR PERFORMANCE STRIP */}
      <div className="space-y-1.5 relative z-10">
        <label className="text-[9px] text-slate-500 block border-t border-white/5 pt-2.5">
          عملکرد میانگین هر ساعت (میله سبز = میانگین سود مثبت، قرمز = میانگین ضرر — قاب طلایی = ساعت پیشنهادی):
        </label>
        <div className="grid grid-cols-8 sm:grid-cols-12 lg:grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
          {buckets.map((b) => {
            const isBest = bestSet.has(b.hour);
            const heightPct = b.trades > 0 ? Math.max(8, (Math.abs(b.avgPnlUsd) / maxAbs) * 100) : 4;
            const isPositive = b.avgPnlUsd >= 0;
            return (
              <div key={b.hour} className="flex flex-col items-center gap-1" title={`${hourLabel(b.hour)} — ${b.trades} معامله، میانگین ${b.avgPnlUsd.toFixed(2)}$`}>
                <div className={`w-full h-12 rounded flex items-end justify-center overflow-hidden ${isBest ? "ring-1 ring-amber-400/70" : ""} bg-black/30`}>
                  <div
                    className={`w-full rounded-t ${b.trades === 0 ? "bg-white/5" : isPositive ? "bg-emerald-500/60" : "bg-rose-500/60"}`}
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
                <span className={`text-[6.5px] font-mono ${isBest ? "text-amber-400 font-black" : "text-slate-500"}`}>{b.hour}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
