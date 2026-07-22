import React, { useState, useEffect } from "react";
import { Brain, ShieldCheck, ShieldAlert, Cpu, Layers, Flame, Clock, Heart, Zap, RefreshCw, Server, CheckCircle2, Trash2, XCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface DiagnosticLog {
  id: string;
  time: number;
  symbol: string;
  type: string;
  title: string;
  message: string;
  actionTaken: string;
}

interface CortexDiagnosticsHubProps {
  status: {
    consecutiveLosses?: number;
    adaptiveSensitivityOverride?: "conservative" | "balanced" | "active" | null;
    leverageMultiplier?: number;
    riskReductionMap?: Record<string, { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }>;
    diagnosticLogs?: DiagnosticLog[];
    sensitivity?: "conservative" | "balanced" | "active";
  };
  onRefresh?: () => Promise<void> | void;
}

export function CortexDiagnosticsHub({ status, onRefresh }: CortexDiagnosticsHubProps) {
  const consecutiveLosses = status.consecutiveLosses || 0;
  const multiplier = status.leverageMultiplier !== undefined ? status.leverageMultiplier : 1.0;
  const isClipped = multiplier < 1.0;
  const limitOverride = status.adaptiveSensitivityOverride;
  const riskReductions = status.riskReductionMap || {};
  const logs = status.diagnosticLogs || [];

  // Local actions state
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const handleResetSymbol = async (symbol: string) => {
    try {
      setLoadingAction(symbol);
      const res = await fetch("/api/bot/reset-quarantine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      if (res.ok) {
        const data = await res.json();
        setActionMessage(data.message);
        if (onRefresh) await onRefresh();
      } else {
        setActionMessage("خطا در برقراری ارتباط با سرور");
      }
    } catch (err: any) {
      setActionMessage(`خطا: ${err.message}`);
    } finally {
      setLoadingAction(null);
      setTimeout(() => setActionMessage(null), 4000);
    }
  };

  const handleResetAll = async () => {
    try {
      setLoadingAction("all");
      const res = await fetch("/api/bot/reset-quarantine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}) // Empty body resets all
      });
      if (res.ok) {
        const data = await res.json();
        setActionMessage(data.message);
        if (onRefresh) await onRefresh();
      } else {
        setActionMessage("خطا در ریست لیست قرنطینه");
      }
    } catch (err: any) {
      setActionMessage(`خطا: ${err.message}`);
    } finally {
      setLoadingAction(null);
      setTimeout(() => setActionMessage(null), 4000);
    }
  };

  const handleManualRefresh = async () => {
    try {
      setLoadingAction("refresh");
      if (onRefresh) {
        await onRefresh();
      }
    } catch (err) {
      // ignore
    } finally {
      setLoadingAction(null);
    }
  };

  // Local state to force continuous re-render of remaining cooldown seconds
  const [, setTicks] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTicks(t => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Filter active smart risk-reductions (still within their decay window)
  const now = Date.now();
  const activeRiskReductions = Object.entries(riskReductions)
    .map(([key, entry]) => ({
      name: key,
      remaining: entry.until - now,
      sizeFactor: entry.sizeFactor,
      extraConfidence: entry.extraConfidence,
    }))
    .filter(item => item.remaining > 0);

  const formatRemainingTime = (ms: number) => {
    const secs = Math.ceil(ms / 1000);
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    
    if (hrs > 0) {
      return `${hrs}h ${mins}m ${s}s`;
    }
    if (mins > 0) {
      return `${mins}m ${s}s`;
    }
    return `${s}s`;
  };

  return (
    <section className="bg-[#181A20] border border-cyan-500/20 hover:border-cyan-500/40 transition-colors rounded-xl p-4.5 space-y-4 shadow-lg text-right relative overflow-hidden">
      {/* Decorative ambient background light */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* HEADER BAR */}
      <div className="flex items-center justify-between border-b border-[#2B3139]/80 pb-2.5 relative z-10">
        <div className="flex items-center gap-1.5 font-sans">
          <Brain className="text-cyan-400 animate-pulse" size={16} />
          <h3 className="text-xs font-black text-white uppercase font-mono">هسته پایش خودمراقبتی و خوداصلاحگری کورتکس (Cortex Hub)</h3>
        </div>
        <span className="text-[8px] bg-cyan-500/10 text-cyan-400 px-1.5 py-0.5 rounded font-mono font-bold">CORTEX MONITOR</span>
      </div>

      {/* CORTEX RUNTIME STATUS DIAGRAM */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 relative z-10 text-right">
        {/* State indicator card */}
        <div className="bg-black/35 border border-white/5 hover:border-cyan-500/10 p-3 rounded-xl flex flex-col justify-between space-y-1.5 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-400 font-bold">وضعیت کورتکس:</span>
            {consecutiveLosses > 0 ? (
              <ShieldAlert size={14} className="text-orange-400 animate-pulse" />
            ) : (
              <ShieldCheck size={14} className="text-emerald-400" />
            )}
          </div>
          <span className={`text-xs font-black ${consecutiveLosses > 0 ? "text-orange-400" : "text-emerald-400"}`}>
            {consecutiveLosses > 0 
              ? `آماده‌باش دفاعی (${consecutiveLosses} زیان)` 
              : "پایدار و ایده‌آل (سبز)"}
          </span>
          <span className="text-[8.5px] text-slate-500 leading-normal">
            {consecutiveLosses > 0 
              ? "محدودسازهای انطباقی مارجین صرافی روشن است" 
              : "دیتابیس در تراز امن معاملاتی قرار دارد"}
          </span>
        </div>

        {/* Leverage shrink indicator */}
        <div className="bg-black/35 border border-white/5 hover:border-cyan-500/10 p-3 rounded-xl flex flex-col justify-between space-y-1.5 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-400 font-bold">ضریب تعدیل ریسک:</span>
            <Cpu size={14} className={isClipped ? "text-amber-400" : "text-slate-500"} />
          </div>
          <span className={`text-xs font-black ${isClipped ? "text-amber-400" : "text-slate-200"}`}>
            {isClipped ? `${(multiplier * 100).toFixed(0)}% حجم و اهرم` : "1.00x (حجم اصلی)"}
          </span>
          <span className="text-[8.5px] text-slate-500 leading-normal">
            {isClipped 
              ? `اعمال فشرده‌سازی ${(100 - multiplier*100).toFixed(0)}٪ دارایی ترید پیاپی` 
              : "ریسک‌ ترید بر روی اهرم استاندارد کاربری"}
          </span>
        </div>

        {/* Active Sensitivity Clamp */}
        <div className="bg-black/35 border border-white/5 hover:border-cyan-500/10 p-3 rounded-xl flex flex-col justify-between space-y-1.5 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-400 font-bold">آستانه حساسیت:</span>
            <Layers size={14} className={limitOverride ? "text-cyan-400" : "text-slate-500"} />
          </div>
          <span className={`text-xs font-black ${limitOverride ? "text-cyan-400" : "text-slate-200"}`}>
            {limitOverride ? limitOverride.toUpperCase() : (status.sensitivity || "balanced").toUpperCase()}
          </span>
          <span className="text-[8.5px] text-slate-500 leading-normal">
            {limitOverride 
              ? "ارتفاء اتوماتیک فیلترها جهت فیلترینگ نویزها" 
              : `آستانه ماتریکس برابر حساسیت کاربر است`}
          </span>
        </div>
      </div>

      {/* SMART RISK-REDUCTION STATUS LIST (replaces hard quarantine) */}
      <div className="bg-black/20 border border-white/[0.03] p-3 rounded-xl space-y-2 relative z-10 text-right">
        <div className="flex items-center justify-between border-b border-white/5 pb-1.5 flex-wrap gap-2">
          <span className="text-[10px] text-slate-300 font-bold flex items-center gap-1">
            <Clock size={11} className="text-cyan-400" />
            نمادهای تحت کاهش ریسک هوشمند (بدون توقف کامل)
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleManualRefresh}
              disabled={loadingAction === "refresh"}
              className="p-1 hover:bg-white/10 text-slate-400 hover:text-cyan-400 rounded transition-all"
              title="بروزرسانی وضعیت"
            >
              <RefreshCw size={10} className={loadingAction === "refresh" ? "animate-spin text-cyan-400" : ""} />
            </button>
            
            {activeRiskReductions.length > 0 && (
              <button
                onClick={handleResetAll}
                disabled={loadingAction !== null}
                className="px-1.5 py-0.5 text-[8.5px] font-black bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded transition-all"
                title="حذف کلیه محدودیت‌های ریسک فعال"
              >
                {loadingAction === "all" ? "درحال ریست..." : "حذف همه محدودیت‌ها"}
              </button>
            )}

            <span className="bg-cyan-500/10 text-cyan-400 font-mono text-[9px] px-1.5 py-0.5 rounded">
              {activeRiskReductions.length} نماد فعال
            </span>
          </div>
        </div>

        <AnimatePresence>
          {actionMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="text-[9px] bg-cyan-950/40 border border-cyan-500/20 text-cyan-300 px-2.5 py-1 rounded-md text-right font-medium"
            >
              ℹ️ {actionMessage}
            </motion.div>
          )}
        </AnimatePresence>

        {activeRiskReductions.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {activeRiskReductions.map((item, idx) => (
              <div 
                key={idx} 
                className="bg-[#1C2028]/50 border border-cyan-500/15 p-2 rounded-lg flex items-center justify-between text-right gap-2 hover:border-cyan-500/30 transition-all"
              >
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleResetSymbol(item.name)}
                    disabled={loadingAction !== null}
                    className="p-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded border border-rose-500/25 transition-all flex items-center justify-center gap-0.5 shrink-0"
                    title={`حذف محدودیت ریسک ${item.name}`}
                  >
                    <Trash2 size={9} />
                    <span className="text-[8.5px] font-extrabold">حذف</span>
                  </button>
                  <div className="flex items-center gap-1 text-[10px] text-cyan-400 font-mono font-black" dir="ltr">
                    <Clock size={10} className="animate-spin-slow text-cyan-500/40" />
                    <span>{formatRemainingTime(item.remaining)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="font-mono font-black text-white text-[11px] block">{item.name}</span>
                  <span className="text-[8px] text-amber-400 block leading-none">
                    حجم {(item.sizeFactor * 100).toFixed(0)}٪ + اطمینان +{(item.extraConfidence * 100).toFixed(0)}٪
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-slate-600 text-[10.5px] italic text-center py-3 flex items-center justify-center gap-1.5">
            <CheckCircle2 size={13} className="text-emerald-500" />
            هیچ نمادی تحت کاهش ریسک نیست. همه نمادها با شرایط استاندارد فعالند.
          </div>
        )}
      </div>

      {/* TIMELINE OF SELF-CORRECTIVE INTERVENTIONS */}
      <div className="space-y-2 relative z-10 text-right">
        <label className="text-[10px] text-slate-400 block pb-1 border-b border-white/5 font-bold">تب لت وقایع عیب‌یابی و مداخله خودمراقبتی ربات:</label>
        <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 text-right custom-scrollbar">
          {logs && logs.length > 0 ? (
            logs.map((log) => (
              <div 
                key={log.id} 
                className="bg-black/40 border border-cyan-500/10 hover:border-cyan-500/35 p-3 rounded-xl flex flex-col gap-2 text-xs transition-colors relative"
              >
                {/* Timeline dot */}
                <div className="absolute right-0 top-3.5 w-1 h-8 rounded bg-cyan-500/40" />
                
                <div className="flex items-center justify-between mr-2.5">
                  <span className="text-[9px] text-[#A0A5AF] font-mono leading-none">
                    {new Date(log.time).toLocaleTimeString("fa-IR")} - {new Date(log.time).toLocaleDateString("fa-IR")}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-black text-rose-400 text-xs">{log.symbol}/USDT</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  </div>
                </div>

                <div className="mr-2.5 text-slate-100 text-[11px] leading-relaxed font-bold border-t border-white/[0.02] pt-1.5">
                  {log.message}
                </div>

                <div className="mr-2.5 bg-cyan-500/5 border border-cyan-500/15 p-2 rounded-lg text-cyan-300 text-[10.5px] leading-relaxed">
                  <span className="font-black block text-[10px] uppercase text-cyan-400 mb-0.5">⚙️ اقدام خوداصلاحی کورتکس:</span>
                  {log.actionTaken}
                </div>
              </div>
            ))
          ) : (
            <div className="text-slate-600 text-[10px] italic text-center py-8 bg-black/10 border border-white/5 border-dashed rounded-xl">
              هیچ زیان یا رخداد مشکوکی تاکنون جهت عیب‌یابی کورتکس ثبت نشده است. عملکرد ربات هم‌اکنون ۱۰۰٪ تضمین شده است.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
