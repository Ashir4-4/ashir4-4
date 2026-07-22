import React, { useState, useEffect, useRef } from "react";
import { 
  Bot, 
  Activity, 
  Zap, 
  TrendingUp, 
  TrendingDown, 
  Shield, 
  ShieldAlert,
  BarChart3, 
  RefreshCcw, 
  ExternalLink, 
  Target,
  ArrowUpRight,
  Cpu,
  Globe,
  Lock,
  ShieldCheck,
  X,
  Play,
  Square,
  Search,
  Radio,
  Clock,
  Layers,
  Sparkles,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Terminal,
  Copy,
  CheckCircle2,
  HelpCircle,
  Info,
  Compass,
  Network,
  Eye,
  Sliders,
  Database,
  Briefcase,
  AlertCircle,
  Maximize,
  RotateCcw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AppStatus, Position } from "./types";
import { CortexLedger } from "./components/CortexLedger";
import { CortexDiagnosticsHub } from "./components/CortexDiagnosticsHub";
import { HourlyPerformancePanel } from "./components/HourlyPerformancePanel";
import { SignalChart } from "./components/SignalChart";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const formatPrice = (v: number | undefined | null) => {
  if (v === undefined || v === null) return "0.0000";
  if (v === 0) return "0.0000";
  if (v < 0.0001) return v.toFixed(8);
  if (v < 2) return v.toFixed(5);
  if (v < 10) return v.toFixed(4);
  return v.toFixed(2);
};

export default function App({ onLogout, onManageUsers }: { onLogout?: () => void; onManageUsers?: () => void } = {}) {
  const [status, setStatus] = useState<AppStatus>({
    isRunning: false,
    count: 0,
    btcChange: 0,
    orders: [],
    closedOrders: [],
    lastScanTime: null,
    nextScanTime: null,
    scanInterval: 300,
    currentProgress: "System Standby",
    lastError: null,
    logs: []
  });

  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedSignal, setExpandedSignal] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<"all" | "whales" | "liquidity" | "system">("all");
  const [logSearchQuery, setLogSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"cockpit" | "signals" | "gateways">("cockpit");
  const [showGuide, setShowGuide] = useState(false);
  const [selectedArchiveType, setSelectedArchiveType] = useState<"profit" | "stop" | null>(null);
  const [expandedArchiveSignal, setExpandedArchiveSignal] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // XT Exchange Connection States
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [modeInput, setModeInput] = useState<"simulation" | "real">("simulation");
  const [sensitivityInput, setSensitivityInput] = useState<"conservative" | "balanced" | "active" | "auto_cortex">("auto_cortex");
  const [strategyInput, setStrategyInput] = useState<"strict_elitescalp" | "active_goldenscalp" | "auto_cortex" | "auto">("auto");
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // 🔌 Real (measured) connectivity health for the header — replaces hardcoded "ACTIVE WEBSOCK v4"
  const [apiHealthy, setApiHealthy] = useState(true);
  const [lastPriceUpdateAt, setLastPriceUpdateAt] = useState<number | null>(null);

  // High Frequency Order Book & Live Trades Seed

  // Selected coin for focus technical analysis chart
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  // States to support view chart popup modal & direct close position signals
  const [modalActiveOrder, setModalActiveOrder] = useState<any | null>(null);
  const [isClosingId, setIsClosingId] = useState<string | null>(null);

  // ASHIR4 Premium Additions: Fullscreen, Simulated Trade Reset and Live Client-Side Trade Monitoring
  const [isResettingTrades, setIsResettingTrades] = useState(false);
  const [selectedTradeCoin, setSelectedTradeCoin] = useState<string>("BTC");
  const [liveTrades, setLiveTrades] = useState<any[]>([]);
  const [orderBook, setOrderBook] = useState<{ bids: [number, number][], asks: [number, number][] }>({ bids: [], asks: [] });
  const [lastLivePrice, setLastLivePrice] = useState<number>(0);
  const [priceDirection, setPriceDirection] = useState<"up" | "down" | "stable">("stable");

  // Custom dialog states (to avoid blocked window.confirm / window.alert inside iframe environment)
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showCloseConfirmOrder, setShowCloseConfirmOrder] = useState<any | null>(null);
  const [showCloseApiConfirmOrder, setShowCloseApiConfirmOrder] = useState<any | null>(null);
  const [customNotify, setCustomNotify] = useState<string | null>(null);
  const [cookieBlocked, setCookieBlocked] = useState(false);

  // ⚡️ قیمت لحظه‌ای واقعی: مستقیماً از بک‌اند (همان مقداری که تلگرام و
  // اسکنر استفاده می‌کنند) — بدون هیچ نوسان تصادفی/ساختگی برای «حس زنده‌بودن».
  // نسخه‌ی قبلی این مقدار را هر ۲۸۰ میلی‌ثانیه با یک عدد تصادفی کوچک تکان
  // می‌داد که باعث می‌شد سود/ضرر نمایش داده‌شده با مقدار واقعی (و با آنچه
  // ربات تلگرام گزارش می‌دهد) فرق داشته باشد. حذف شد.
  const [clientPrices, setClientPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    if (status.orders && status.orders.length > 0) {
      setClientPrices(prev => {
        const next = { ...prev };
        let hasAnyUpdate = false;
        status.orders.forEach(o => {
          const freshPrice = o.current_price || o.entry_price || 0;
          if (freshPrice > 0 && next[o.id] !== freshPrice) {
            next[o.id] = freshPrice;
            hasAnyUpdate = true;
          }
        });
        return hasAnyUpdate ? next : prev;
      });
    }
  }, [status.orders]);

  // Toggle fullscreen mode
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error("Enable fullscreen failed: ", err);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  // Reset simulated trades handler with automatic Telegram dispatch
  const handleResetSimulatedTrades = () => {
    setShowResetConfirm(true);
  };

  const executeResetSimulatedTrades = async () => {
    setShowResetConfirm(false);
    setIsResettingTrades(true);
    try {
      const res = await fetch(`/api/bot/reset-simulated-trades`, { method: "POST" });
      if (res.ok) {
        setCustomNotify("تمامی معاملات تستی شبیه‌سازی و وضعیت مالی با موفقیت ریست شدند.");
        await fetchStatus();
      } else {
        console.error("Failed to reset trades");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsResettingTrades(false);
    }
  };

  const [isToggling9Layers, setIsToggling9Layers] = useState(false);

  const handleToggle9Layers = async () => {
    setIsToggling9Layers(true);
    try {
      const res = await fetch("/api/bot/toggle-9layers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disable9Layers: !status.disable9Layers })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setCustomNotify(data.message);
        await fetchStatus();
      } else {
        setCustomNotify(`خطا در همگام‌سازی تأییدیه‌ها: ${data.error || "رویداد پیش‌بینی نشده"}`);
      }
    } catch (e: any) {
      setCustomNotify(`خطای شبکه کورتکس: ${e.message}`);
    } finally {
      setIsToggling9Layers(false);
    }
  };

  // Fetch real-time trades and orderbook depth from exchange for selectedTradeCoin
  useEffect(() => {
    let active = true;
    
    const fetchData = async () => {
      if (!selectedTradeCoin) return;
      let targetBasePrice = lastLivePrice || 0;

      // 1. Fetch live trades
      try {
        const res = await fetch(`/api/xt/trades?symbol=${selectedTradeCoin}&limit=12`);
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          setCookieBlocked(true);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (active && data.success && data.trades && data.trades.length > 0) {
            setLiveTrades(data.trades);
            setCookieBlocked(false);
            const latestPrice = data.trades[0].price;
            if (latestPrice) {
              targetBasePrice = latestPrice;
              setLastLivePrice((prev) => {
                if (prev > 0 && latestPrice !== prev) {
                  setPriceDirection(latestPrice > prev ? "up" : "down");
                }
                return latestPrice;
              });
              setLastPriceUpdateAt(Date.now());
            }
          }
        }
      } catch (err) {
        console.error("Trades fetch error:", err);
        if (err instanceof Error && (err.message.includes("Unexpected token") || err.message.includes("is not valid JSON"))) {
          setCookieBlocked(true);
        }
      }

      // 2. Fetch orderbook depth
      try {
        const res = await fetch(`/api/xt/orderbook?symbol=${selectedTradeCoin}&limit=8`);
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          setCookieBlocked(true);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (active && data.success && data.bids && data.asks && data.bids.length > 0) {
            setOrderBook({
              bids: data.bids.slice(0, 8).map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]),
              asks: data.asks.slice(0, 8).map((a: any) => [parseFloat(a[0]), parseFloat(a[1])])
            });
            setCookieBlocked(false);
          }
          // If the API returns no data, keep the previous (last-known-real) order book
          // instead of replacing it with fake/random numbers.
        }
      } catch (err) {
        console.error("Orderbook fetch error:", err);
        if (err instanceof Error && (err.message.includes("Unexpected token") || err.message.includes("is not valid JSON"))) {
          setCookieBlocked(true);
        }
        // Keep the previous real order book on transient errors — never fabricate data.
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedTradeCoin, lastLivePrice]);

  const handleCloseActiveOrder = async (orderId: string, symbol: string) => {
    if (!orderId) return;
    setIsClosingId(orderId);
    try {
      const res = await fetch(`/api/bot/close-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      if (res.ok) {
        await fetchStatus();
      } else {
        const err = await res.json();
        console.error("Failed to close order:", err);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsClosingId(null);
    }
  };

  useEffect(() => {
    if (status) {
      if (status.tradingMode) {
        setModeInput(status.tradingMode);
      }
      if (status.sensitivity) {
        setSensitivityInput(status.sensitivity);
      }
      if (status.strategy) {
        setStrategyInput(status.strategy);
      }
    }
  }, [status?.tradingMode, status?.sensitivity, status?.strategy]);

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKeyInput,
          secretKey: secretKeyInput,
          tradingMode: modeInput,
          sensitivity: sensitivityInput,
          strategy: strategyInput
        })
      });
      const data = await res.json();
      if (res.ok) {
        setSaveMessage("اتصال لایه سرد با موفقیت همگام‌سازی شد.");
        setApiKeyInput("");
        setSecretKeyInput("");
        await fetchStatus();
      } else {
        setSaveMessage(`خطا: ${data.error || "تأیید نشد"}`);
      }
    } catch (err: any) {
      setSaveMessage(`خطای اتصال شبکه: ${err.message}`);
    } finally {
      setSaveLoading(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/bot/status");
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("text/html")) {
        setCookieBlocked(true);
        setLoading(false);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object") {
          setCookieBlocked(false);

          // Safe Auto-Restore check: If the server-side has freshly initialized (e.g., count is 0)
          // but we have a valid, richer session backup in browser's local storage, auto-sync and recover it.
          const localStr = localStorage.getItem("ashir_bot_saved_state");
          if (localStr) {
            try {
              const localState = JSON.parse(localStr);
              if (
                data.count === 0 && 
                localState && 
                (localState.count > 0 || (localState.closedOrders && localState.closedOrders.length > 0))
              ) {
                console.log("[RESTORE ENGINE] Server reset detected. Re-hydrating background engine session...");
                const restoreRes = await fetch("/api/bot/restore-state", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(localState),
                });
                if (restoreRes.ok) {
                  const freshRes = await fetch("/api/bot/status");
                  if (freshRes.ok) {
                    const freshData = await freshRes.json();
                    setStatus(freshData);
                    setLoading(false);
                    return;
                  }
                }
              }
            } catch (err) {
              console.error("Local storage raw parse/sync exception:", err);
            }
          }

          // Update UI status state
          setStatus(data);
          setApiHealthy(true);

          // Safe Auto-Backup: If current data has valid active/closed orders or log count, save state to local browser cache
          if (data.count > 0 || (data.closedOrders && data.closedOrders.length > 0)) {
            const stateToSave = {
              count: data.count,
              orders: data.orders,
              closedOrders: data.closedOrders,
              scanLogs: data.logs,
              tradingMode: data.tradingMode,
              sensitivity: data.sensitivity,
              disable9Layers: data.disable9Layers,
              rejectedSignals: data.rejectedSignals,
              demoCapital: data.demoBalance,
              totalTrades: data.closedOrders ? data.closedOrders.length : 0,
              winTrades: data.winTrades || 0,
              consecutiveLosses: data.consecutiveLosses || 0,
              diagnosticLogs: data.diagnosticLogs || []
            };
            localStorage.setItem("ashir_bot_saved_state", JSON.stringify(stateToSave));
          }
        } else {
          setCookieBlocked(true);
        }
      }
      setLoading(false);
    } catch (e) {
      console.error("Status fetch failed", e);
      setLoading(false);
      setApiHealthy(false);
      if (e instanceof Error && (e.message.includes("Unexpected token") || e.message.includes("is not valid JSON"))) {
        setCookieBlocked(true);
      }
    }
  };

  // Poll status from API
  useEffect(() => {
    fetchStatus();
    const pollRate = status.orders?.some(o => o.status === "filled") ? 900 : 2200;
    const interval = setInterval(fetchStatus, pollRate);
    return () => clearInterval(interval);
  }, [status.orders?.some(o => o.status === "filled")]);

  // Countdown timer logic
  useEffect(() => {
    const timer = setInterval(() => {
      if (status.isRunning && status.nextScanTime) {
        const remaining = Math.max(0, Math.round((status.nextScanTime - Date.now()) / 1000));
        setTimeLeft(remaining);
      } else {
        setTimeLeft(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status.isRunning, status.nextScanTime]);

  // Sync scroll terminal logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [status.logs]);

  const toggleBot = async () => {
    setActionLoading(true);
    const endpoint = status.isRunning ? "/api/bot/stop" : "/api/bot/start";
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) {
        await fetchStatus();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Filter logs logic
  const filteredLogs = status.logs.filter(log => {
    if (logSearchQuery && !log.toLowerCase().includes(logSearchQuery.toLowerCase())) {
      return false;
    }
    if (logFilter === "all") return true;
    if (logFilter === "whales") return log.toLowerCase().includes("whale") || log.toLowerCase().includes("iceberg") || log.toLowerCase().includes("orderbook");
    if (logFilter === "liquidity") return log.toLowerCase().includes("stop") || log.toLowerCase().includes("hunt") || log.toLowerCase().includes("liquid");
    if (logFilter === "system") return log.toLowerCase().includes("fit") || log.toLowerCase().includes("scan") || log.toLowerCase().includes("garch");
    return true;
  });

  const isActivelyScanning = status.isRunning && 
    status.currentProgress !== "System in hibernation. Cooling down." &&
    status.currentProgress !== "System Standby" &&
    (!timeLeft || timeLeft <= 0 || status.currentProgress.includes("Analyzing") || status.currentProgress.includes("OB") || status.currentProgress.includes("Fetching"));

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Ledger stats (win rate, ROI, profit factor, best/worst trade, etc.) are computed
  // ONCE on the backend by computeLedgerStats() — the exact same function the
  // Telegram bot uses for "سود/ضرر کل" — so these numbers can never drift or
  // disagree between the dashboard and Telegram, and only ever reflect positions
  // that are truly closed (status.closedOrders). Still-open positions (even ones
  // that already realized a partial TP1 exit) are intentionally never counted here.
  //
  // Memoized on the closed-order id list (not object identity, since a fresh poll
  // always returns a new array/object even when nothing changed) to avoid
  // re-deriving these arrays on every ~1s status poll — this was the source of the
  // periodic UI stutter/"hang" on longer trade histories.
  const closedOrdersKey = React.useMemo(
    () => (status.closedOrders || []).map(o => o.id).join(","),
    [status.closedOrders]
  );

  const { profitParts, lossParts } = React.useMemo(() => {
    const closed = status.closedOrders || [];
    // NOTE: only truly closed positions are mapped here. The old implementation
    // also synthesized a "tp1_partial" entry for still-OPEN positions that had
    // merely hit TP1 — that meant a position could be counted once (prematurely,
    // as an open partial) and then again later (correctly, once actually closed),
    // and it used the nominal take_profit_1 price instead of the real fill price.
    // That inflated/duplicated the win-rate and trade-count stats. Fixed by
    // dropping that branch entirely — win/loss stats now only ever reflect
    // positions that have fully and finally closed.
    const parts = closed.map(o => ({
      symbol: o.symbol,
      action: o.action,
      type: (o.tp1_hit ? "tp1_tp2_combined" : "full") as "full" | "tp1_tp2_combined",
      price_in: o.entry_price,
      price_out: o.exit_price ?? o.entry_price,
      value: o.tp1_hit ? (o.initial_position_value ?? o.position_value * 2) : o.position_value,
      pnl_pct: o.pnl_pct ?? 0,
      pnl_usd: o.pnl_usd ?? 0,
      time: o.closed_at ?? Date.now(),
      exitReason: o.exit_reason ?? (o.tp1_hit ? "تارگت ۲ یا حد ضرر بریک‌اون" : "خروج کامل"),
      order: o,
    }));
    return {
      profitParts: parts.filter(p => p.pnl_usd >= 0),
      lossParts: parts.filter(p => p.pnl_usd < 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedOrdersKey]);

  const ledgerStats = status.ledgerStats || {
    totalClosed: profitParts.length + lossParts.length,
    wins: profitParts.length,
    losses: lossParts.length,
    winRate: 0,
    netUsd: 0,
    netPct: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    bestTrade: null,
    worstTrade: null,
    profitFactor: null,
    profitFactorLabel: "0.00",
    baseCapital: status.baseCapital || 1000,
  };

  const profitTradesCount = ledgerStats.wins;
  const profitTotalUsd = ledgerStats.grossProfitUsd;
  const lossTradesCount = ledgerStats.losses;
  const lossTotalUsd = -ledgerStats.grossLossUsd;

  const profitClosedCount = profitTradesCount;
  const stopClosedCount = lossTradesCount;

  // Auto-select first active or closed trade if no selection made
  useEffect(() => {
    if (!selectedSymbol) {
      if (status.orders && status.orders.length > 0) {
        setSelectedSymbol(status.orders[0].symbol);
      } else if (status.closedOrders && status.closedOrders.length > 0) {
        setSelectedSymbol(status.closedOrders[0].symbol);
      } else {
        setSelectedSymbol("BTC");
      }
    }
  }, [status.orders, status.closedOrders, selectedSymbol]);

  // Find active selected signal object
  const activeSelectedOrder = status.orders.find(o => o.symbol === selectedSymbol) || 
                              status.closedOrders.find(o => o.symbol === selectedSymbol);

  // Helper to retrieve active orders with high-frequency client-side ticked prices and PnL values
  const getTickedOrders = () => {
    return (status.orders || []).map(o => {
      const livePrice = clientPrices[o.id] || o.current_price || o.entry_price || 0;
      let pnlPct = o.pnl_pct || 0;
      if (livePrice > 0 && o.entry_price > 0) {
        if (o.action === "buy") {
          pnlPct = ((livePrice - o.entry_price) / o.entry_price) * 100 * (o.leverage || 1);
        } else {
          pnlPct = ((o.entry_price - livePrice) / o.entry_price) * 100 * (o.leverage || 1);
        }
      }
      return { 
        ...o, 
        current_price: livePrice,
        pnl_pct: pnlPct,
        pnl_usd: (pnlPct / 100) * (o.position_value || 100)
      };
    });
  };

  // Only show active (live) orders for our signals grid to avoid cluttering screen with static closed cards
  const allSignalsToShow = [
    ...getTickedOrders().map(o => ({ ...o, isLive: true }))
  ];

    if (loading) {
    return (
      <div className="min-h-screen bg-[#0C0D10] flex flex-col items-center justify-center relative overflow-hidden font-sans text-slate-300">
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#F0B90B]/5 blur-[200px] rounded-full" />
        </div>
        <div className="relative flex flex-col items-center">
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
            className="w-20 h-20 border-2 border-[#2B3139] border-t-[#F0B90B] rounded-full shadow-[0_0_25px_rgba(240,185,11,0.15)]"
          />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs text-[#F0B90B] font-black tracking-widest font-mono">
            XT.COM CORE
          </div>
          <span className="text-sm text-slate-300 font-extrabold mt-8 animate-pulse text-center">
            در حال همگام‌سازی و اتصال به صرافی XT.COM...
          </span>
          <p className="text-[10px] text-slate-500 mt-2 font-mono uppercase tracking-widest">establishing high frequency api handshake</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0C0D10] text-[#EAECEF] font-sans overflow-x-hidden selection:bg-[#F0B90B]/20 select-none pb-12" dir="rtl">
      
      {cookieBlocked && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-500 px-4 py-2.5 text-xs sm:text-sm text-center font-sans relative z-50 flex flex-col sm:flex-row items-center justify-center gap-3 animate-pulse">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span className="font-semibold select-text">
              محدودیت پیش‌نمایش آی‌فریم و کوکی‌های شخص‌ثالث فعال است. جهت اتصال پایدار و همگام‌سازی لحظه‌ای، لطفاً برنامه را در تب جدید باز کنید.
            </span>
          </div>
          <button
            onClick={() => window.open(window.location.href, "_blank")}
            className="bg-amber-500 text-[#0C0D10] font-black px-3.5 py-1.5 rounded hover:bg-amber-400 transition cursor-pointer"
          >
            باز کردن در تب جدید مرورگر ↗
          </button>
        </div>
      )}

      {/* 🚀 XT.COM ADVANCED TICKERTAPE */}
      <div className="bg-[#12161A] border-b border-[#1E2329] py-1.5 overflow-hidden text-[10px] font-mono whitespace-nowrap text-slate-400 flex items-center relative z-40" dir="ltr">
        <div className="flex animate-marquee gap-10">
          <div className="flex items-center gap-8 pr-12 shrink-0">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <strong className="text-white font-black">BTC/USDT:</strong> 
              <span className={status.btcChange >= 0 ? "text-emerald-400" : "text-rose-400 font-semibold"}>
                {status.btcChange >= 0 ? "+" : ""}{status.btcChange.toFixed(2)}%
              </span>
            </span>
            <span className="text-slate-700 font-bold">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">آخرین اسکن:</strong>{" "}
              {status.lastScanDurationMs != null ? (
                <span className="text-[#F0B90B] font-bold">{(status.lastScanDurationMs / 1000).toFixed(2)}s</span>
              ) : (
                <span className="text-slate-500">در حال محاسبه...</span>
              )}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">نرخ اسکن:</strong>{" "}
              {status.lastScanAssetsPerSec != null ? (
                <span className="text-emerald-400">{status.lastScanAssetsPerSec.toFixed(1)} دارایی/ثانیه ({status.lastScanAssetCount} دارایی)</span>
              ) : (
                <span className="text-slate-500">در انتظار اولین اسکن</span>
              )}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">اتصال صرافی XT:</strong>{" "}
              <span className={apiHealthy ? "text-[#F0B90B] font-semibold" : "text-rose-400 font-semibold"}>
                {apiHealthy ? "متصل و پایدار" : "قطع - در حال تلاش مجدد"}
              </span>
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">قیمت لحظه‌ای:</strong>{" "}
              {lastPriceUpdateAt && Date.now() - lastPriceUpdateAt < 5000 ? (
                <span className="text-purple-400 font-bold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                  زنده (همگام با صرافی)
                </span>
              ) : (
                <span className="text-slate-500">در انتظار داده زنده</span>
              )}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <strong className="text-white">مدیریت ریسک هوشمند:</strong> <span className="text-emerald-400">فعال (بدون توقف کامل)</span>
            </span>
          </div>

          {/* Repeat for endless scroll */}
          <div className="flex items-center gap-8 pr-12 shrink-0">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <strong className="text-white font-black">BTC/USDT:</strong> 
              <span className={status.btcChange >= 0 ? "text-emerald-400" : "text-rose-400 font-semibold"}>
                {status.btcChange >= 0 ? "+" : ""}{status.btcChange.toFixed(2)}%
              </span>
            </span>
            <span className="text-slate-700 font-bold">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">آخرین اسکن:</strong>{" "}
              {status.lastScanDurationMs != null ? (
                <span className="text-[#F0B90B] font-bold">{(status.lastScanDurationMs / 1000).toFixed(2)}s</span>
              ) : (
                <span className="text-slate-500">در حال محاسبه...</span>
              )}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">نرخ اسکن:</strong>{" "}
              {status.lastScanAssetsPerSec != null ? (
                <span className="text-emerald-400">{status.lastScanAssetsPerSec.toFixed(1)} دارایی/ثانیه ({status.lastScanAssetCount} دارایی)</span>
              ) : (
                <span className="text-slate-500">در انتظار اولین اسکن</span>
              )}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1.5">
              <strong className="text-white">اتصال صرافی XT:</strong>{" "}
              <span className={apiHealthy ? "text-[#F0B90B] font-semibold" : "text-rose-400 font-semibold"}>
                {apiHealthy ? "متصل و پایدار" : "قطع - در حال تلاش مجدد"}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* 💼 BRAND HEADER BAR - STRICT ORIGINAL XT MARKET STYLE */}
      <header className="bg-[#181A20] border-b border-[#242731] sticky top-0 z-40 transition-colors duration-200">
        <div className="max-w-[1720px] mx-auto px-4 h-16 flex items-center justify-between">
          
          {/* XT BRAND LOGO WRAP */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="bg-gradient-to-br from-[#F0B90B] to-[#b38905] text-black px-2.5 h-9 rounded-lg flex items-center justify-center font-black text-sm tracking-widest shadow-[0_0_15px_rgba(240,185,11,0.2)] font-mono">
                ASHIR4
              </div>
              <div className="text-right">
                <span className="text-white font-display font-black text-lg tracking-wider block leading-none">
                  ASHIR<span className="text-[#F0B90B]">4</span>
                </span>
                <span className="text-[9px] text-[#A0A5AF] font-mono font-bold tracking-widest block uppercase mt-0.5">
                  پیشرفته‌ترین ایستگاه اطلاعاتی و ربات هوش مصنوعی
                </span>
              </div>
            </div>

            {/* Quick status dots */}
            <div className="hidden md:flex items-center gap-3 bg-black/40 border border-[#2B3139] px-3 py-1.5 rounded-lg text-[10px] font-mono text-slate-400 mr-2">
              <span className="flex items-center gap-1.5">
                <span className={cn("w-2 h-2 rounded-full", status.isRunning ? "bg-emerald-500 animate-pulse" : "bg-rose-500")} />
                <span>ربات: <strong className="text-white">{status.isRunning ? "ONLINE" : "STANDBY"}</strong></span>
              </span>
              <span className="text-slate-700">|</span>
              <span>استراتژی: <strong className="text-cyan-400 font-display">{status.strategy === "active_goldenscalp" ? "ACTIVE GOLDEN SCALPER" : "ELITE STRICT SCALPER"}</strong></span>
              <span className="text-slate-700">|</span>
              <span>اپک: <strong className="text-white">{status.count}</strong></span>
            </div>
          </div>

          {/* XT CENTER TERMINAL — REAL LIVE STATUS (no marketing text) */}
          <div className="hidden lg:flex items-center gap-2.5 bg-[#0C0D10]/95 px-4 h-10 rounded-xl border border-[#2B3139] shadow-inner select-none">
            <span className={cn("w-1.5 h-1.5 rounded-full", status.isRunning ? "bg-emerald-500 animate-pulse shadow-[0_0_8px_#10B981]" : "bg-slate-500")} />
            <span className="font-mono text-[10px] font-black tracking-widest text-[#F0B90B] uppercase">
              {status.isRunning ? `چرخه اسکن #${status.count}` : "ربات در حالت آماده‌باش"}
            </span>
            <span className="text-[10px] text-slate-500 font-bold border-r border-[#2B3139] pr-2.5 h-4 flex items-center">
              لوریج هوشمند: ۱۰x تا ۵۰x بر اساس اطمینان سیگنال
            </span>
          </div>

          {/* XT HEADER RIGHT CONTROL COMMANDS */}
          <div className="flex items-center gap-1.5 md:gap-3 flex-nowrap shrink-0">
            {/* FULLSCREEN BUTTON */}
            <button
              onClick={toggleFullscreen}
              title="تمام صفحه کردن ربات"
              className="w-10 h-10 border border-[#2B3139] bg-gradient-to-b from-[#1C2028] to-black hover:border-slate-500 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)] rounded-xl hidden sm:flex items-center justify-center transition-all cursor-pointer text-slate-300 hover:scale-[1.03] shrink-0"
            >
              <Maximize size={15} className="text-[#F0B90B]" />
            </button>

            {/* SUBSCRIPTION / USER MANAGEMENT PANEL */}
            {onManageUsers && (
              <button
                onClick={onManageUsers}
                title="مدیریت اشتراک‌ها و کاربران"
                className="w-10 h-10 border border-[#2B3139] bg-gradient-to-b from-[#1C2028] to-black hover:border-slate-500 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)] rounded-xl hidden sm:flex items-center justify-center transition-all cursor-pointer text-slate-300 hover:scale-[1.03] shrink-0"
              >
                <ShieldCheck size={15} className="text-[#F0B90B]" />
              </button>
            )}

            {/* LOGOUT BUTTON — visible when the app is rendered behind the login gate */}
            {onLogout && (
              <button
                onClick={onLogout}
                title="خروج از حساب"
                className="w-10 h-10 border border-[#2B3139] bg-gradient-to-b from-[#1C2028] to-black hover:border-red-500/50 hover:shadow-[0_0_10px_rgba(239,68,68,0.1)] rounded-xl hidden sm:flex items-center justify-center transition-all cursor-pointer text-slate-300 hover:scale-[1.03] shrink-0"
              >
                <Lock size={15} className="text-[#F0B90B]" />
              </button>
            )}

            {/* RESET SIMULATED TRADES BUTTON */}
            <button
              onClick={handleResetSimulatedTrades}
              disabled={isResettingTrades}
              title="ریست کل معاملات تستی و موجودی شبیه‌ساز"
              className="px-3 h-10 border border-rose-500/35 bg-gradient-to-r from-rose-500/10 to-rose-950/20 hover:from-rose-500/20 hover:to-rose-950/30 hover:shadow-[0_0_15px_rgba(244,63,94,0.2)] hover:border-rose-500/80 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 cursor-pointer text-rose-400 hover:scale-[1.02] whitespace-nowrap shrink-0"
            >
              {isResettingTrades ? (
                <div className="w-3.5 h-3.5 border border-rose-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <RotateCcw size={13} className="text-rose-400" />
              )}
              <span className="hidden lg:inline">ریست معاملات تستی</span>
            </button>

            <button
              onClick={() => setShowGuide(!showGuide)}
              className="px-3 h-10 border border-[#2B3139] bg-gradient-to-b from-[#1C2028] to-black hover:border-slate-500 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)] rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer text-slate-300 hover:scale-[1.02] whitespace-nowrap shrink-0"
            >
              <HelpCircle size={14} className="text-[#F0B90B]" />
              <span className="hidden lg:inline">راهنمای سیستم</span>
            </button>

            {/* DIRECT ACTION ENGINE TRIGGER CONTROL */}
            <button 
              onClick={toggleBot}
              disabled={actionLoading}
              className={cn(
                "h-10 px-3 sm:px-5 rounded-xl text-xs font-black transition-all duration-300 flex items-center gap-2 cursor-pointer border shadow-lg outline-none whitespace-nowrap shrink-0",
                status.isRunning 
                  ? "border-rose-600 bg-gradient-to-r from-rose-600 to-rose-900 text-white shadow-[0_0_15px_rgba(244,63,94,0.35)] hover:from-rose-550 hover:to-rose-800 hover:scale-[1.04]" 
                  : "border-emerald-500/50 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-black shadow-[0_0_20px_rgba(16,185,129,0.35)] hover:scale-[1.04]"
              )}
            >
              {actionLoading ? (
                <div className="w-3.5 h-3.5 border border-current border-t-transparent rounded-full animate-spin" />
              ) : status.isRunning ? (
                <>
                  <Square size={11} fill="currentColor" />
                  <span className="hidden md:inline">توقف اتصال (STOP BOT)</span>
                  <span className="inline md:hidden">STOP</span>
                </>
              ) : (
                <>
                  <Play size={11} fill="currentColor" />
                  <span className="hidden md:inline">استارت پایش (START BOT)</span>
                  <span className="inline md:hidden">START</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* FOOTER-LIKE NOTIFICATION / SCANNER CURRENT STATE */}
      <div className="bg-[#1F222B] border-b border-[#2B3139] px-4 py-2 text-right flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400">
        <div className="flex items-center gap-3">
          <span className="text-[#F0B90B] font-bold font-mono">وضعیت سیستم:</span>
          <span className="font-sans font-medium text-slate-200 animate-pulse">
            {status.isRunning ? status.currentProgress : "سامانه اسکنر فرکانس بالا اشیر در آمادگی کامل جهت استارت پایش و گزارش دهی تلگرام قرار دارد."}
          </span>
        </div>

        {status.isRunning && timeLeft !== null && timeLeft > 0 && (
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-amber-400 bg-amber-500/10 px-3 py-1 rounded border border-amber-500/20 mt-1 sm:mt-0">
            <Clock size={12} className="animate-pulse" />
            <span>اسکن چرخه بعدی در صرافی XT:</span>
            <span className="font-extrabold">{formatTime(timeLeft)}</span>
          </div>
        )}
      </div>

      <main className="max-w-[1720px] mx-auto px-4 mt-4 space-y-4">

        {/* XT.COM DOCUMENTATION SLIDER INFO */}
        <AnimatePresence>
          {showGuide && (
            <motion.section 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-[#181A20] border border-[#2B3139] rounded-xl p-5 relative overflow-hidden"
            >
              <button 
                onClick={() => setShowGuide(false)}
                className="absolute top-4 left-4 p-1.5 hover:bg-white/5 rounded-lg text-slate-400"
              >
                <X size={16} />
              </button>
              <div className="max-w-4xl text-right space-y-3 relative z-10">
                <h3 className="text-sm font-black text-white flex items-center gap-2">
                  <Sparkles className="text-[#F0B90B]" size={15} />
                  راهنمای راهبری و کاربری ربات اشیر ۴.۵ کورتکس صرافی XT.com
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  ربات اشیر به کورتکس تحلیل‌گر فوق فرکانسی مجهز شده است که دیتای صرافی را رصد می‌کند. در این آپدیت، وقتی معامله به <strong>تارگت اول (TP1 - ۵۰٪ پوزیشن)</strong> دست پیدا کند، ربات بیدرنگ و به‌صورت خودکار ۵۰ درصد از حجم ترید را با گرفتن سود ثبت کرده و پیام اختصاصی، جمع‌و‌جور و بسیار حرفه‌ای حاوی میزان سود دلاری و درصدی را به زبان شیرین فارسی به تلگرام کاربر مخابره می‌کند!
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1.5 text-xs">
                  <div className="bg-black/30 p-3.5 rounded-lg border border-white/5 space-y-1">
                    <h4 className="text-[#F0B90B] font-bold">✓ تارگت‌های ۵۰ درصدی</h4>
                    <p className="text-slate-400 text-[11px] leading-relaxed">سیستم با پایش صرافی، به محض اصابت تارگت اول نیمی از کار خود را بسته و در تلگرام سود نهایی پله اول را یادداشت می‌کند.</p>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-lg border border-white/5 space-y-1">
                    <h4 className="text-[#F0B90B] font-bold">✓ گزارش جمع و جور تلگرام</h4>
                    <p className="text-slate-400 text-[11px] leading-relaxed">شکلی شکیل، پروانه‌ای، فشرده و حرفه‌ای منطبق با استانداردهای وال استریت بدون شلوغ‌کاری و ارسال زیاده از حد دیتای بیهوده.</p>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-lg border border-white/5 space-y-1">
                    <h4 className="text-[#F0B90B] font-bold">✓ ماتریس تحلیل GARCH</h4>
                    <p className="text-slate-400 text-[11px] leading-relaxed">۹ بعد بازار شامل اردر بوک مخفی، نهنگ یاب و فاندینگ ریت در قالب این پوسته جدید با بالاترین شفافیت رسم می‌شوند.</p>
                  </div>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ⚙️ MAIN EXCHANGE TERMINAL CONTAINER (COCKPIT) */}
        {activeTab === "cockpit" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            
            {/* COLUMN 1: MOCK ORDER BOOK & LIVE WORKPLACE (3 Columns - Left) */}
            <div className="lg:col-span-3 space-y-4">
              
              {/* 📊 REALTIME MARKET LIVE ORDER BOOK MONITOR (PRO STYLE) */}
              <section className="bg-[#181A20] border border-[#242731] rounded-xl p-4 space-y-3.5 shadow-lg">
                <div className="flex items-center justify-between border-b border-[#2B3139] pb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-[#F0B90B] rounded-full animate-ping" />
                    <h3 className="text-xs font-black text-white uppercase font-mono">دفتر سفارشات زنده (Live Order Book)</h3>
                  </div>
                  <span className="text-[8px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold">LIVE BOOK</span>
                </div>

                {/* Coin selection box */}
                <div className="space-y-1 text-right">
                  <label className="text-[10px] text-slate-400 font-sans block mb-1">انتخاب ارز جهت رصد زنده:</label>
                  <select
                    value={selectedTradeCoin}
                    onChange={(e) => setSelectedTradeCoin(e.target.value)}
                    className="bg-[#1E222B] text-white border border-[#2B3139] px-2.5 py-2 rounded-lg text-xs font-mono font-bold focus:outline-none focus:border-[#F0B90B] w-full cursor-pointer shadow-inner"
                    dir="ltr"
                  >
                    {Array.from(new Set([
                      "BTC", "ETH", "ZEC", "DOGE", "LINK", "BNB", "SOL", "ADA", "XRP", "LTC", "TRX", "DOT",
                      ...(status?.orders || []).map(o => o.symbol),
                      ...(status?.closedOrders || []).map(o => o.symbol)
                    ])).filter(Boolean).map(coin => (
                      <option key={coin} value={coin}>{coin}/USDT</option>
                    ))}
                  </select>
                </div>

                {/* 📊 ORDERBOOK VISUALIZATION DISPLAY */}
                <div className="space-y-1 font-mono text-[11px] select-none" dir="ltr">
                  {/* Table headers */}
                  <div className="grid grid-cols-3 text-slate-500 pb-1.5 border-b border-[#2B3139]/40 text-[9px] font-bold font-sans">
                    <span className="text-left font-extrabold pb-0.5">قیمت (USDT)</span>
                    <span className="text-right font-extrabold pb-0.5">حجم (Qty)</span>
                    <span className="text-right font-extrabold pb-0.5">مجموع (USDT)</span>
                  </div>

                  {/* 🔴 ASKS (Sellers) - Top Rows (highest price descending down to lowest ask) */}
                  <div className="space-y-[1px] min-h-[140px] flex flex-col justify-end">
                    {orderBook?.asks && orderBook.asks.length > 0 ? (
                      (() => {
                        const maxAskQty = Math.max(...orderBook.asks.slice(0, 6).map(a => a[1]), 0.0001);
                        return [...orderBook.asks]
                          .slice(0, 6)
                          .reverse()
                          .map(([price, qty], idx) => {
                            const percentage = Math.min(100, (qty / maxAskQty) * 100);
                            const total = price * qty;
                            return (
                              <div 
                                key={`ask-${idx}`} 
                                className="grid grid-cols-3 py-0.5 hover:bg-white/[0.02] transition-colors relative items-center text-[10px]"
                              >
                                {/* Horizontal ratio fill depth bar */}
                                <div 
                                  style={{ width: `${percentage}%` }}
                                  className="absolute right-0 top-0 bottom-0 bg-rose-500/[0.05] transition-all pointer-events-none"
                                />
                                <span className="text-left font-black text-[#F43F5E] pr-1 z-10">
                                  ${formatPrice(price)}
                                </span>
                                <span className="text-[#8E9CAE] text-right font-bold z-10">
                                  {qty.toFixed(4)}
                                </span>
                                <span className="text-slate-500 text-right font-semibold pr-1 z-10">
                                  ${total.toFixed(1)}
                                </span>
                              </div>
                            );
                          });
                      })()
                    ) : (
                      <div className="py-6 text-center text-slate-600 text-[10px] font-sans">
                        دریافت اردرهای فروش...
                      </div>
                    )}
                  </div>

                  {/* 🟢 CENTER: EXTREMELY POLISHED LIVE PRICE WIDGET */}
                  <div className="flex items-center justify-between py-2 px-3 bg-[#1C2030]/60 border-y border-[#2B3139]/60 my-1.5 transition-all rounded-md">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "w-2 h-2 rounded-full animate-pulse",
                        priceDirection === "up" ? "bg-emerald-400 shadow-[0_0_8px_#10B981]" : "bg-rose-400 shadow-[0_0_8px_#F43F5E]"
                      )} />
                      <span className={cn(
                        "text-sm font-black font-mono tracking-wide",
                        priceDirection === "up" ? "text-emerald-400" : "text-rose-400"
                      )}>
                        ${formatPrice(lastLivePrice || 60000)}
                      </span>
                      {priceDirection === "up" ? (
                        <TrendingUp size={13} className="text-emerald-400" />
                      ) : (
                        <TrendingDown size={13} className="text-rose-400" />
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[8.5px] text-slate-500 font-sans font-bold">قیمت لحظه‌ای</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                    </div>
                  </div>

                  {/* 🟢 BIDS (Buyers) - Bottom Rows (highest bid down to lowest bid) */}
                  <div className="space-y-[1px] min-h-[140px]">
                    {orderBook?.bids && orderBook.bids.length > 0 ? (
                      (() => {
                        const maxBidQty = Math.max(...orderBook.bids.slice(0, 6).map(b => b[1]), 0.0001);
                        return [...orderBook.bids]
                          .slice(0, 6)
                          .map(([price, qty], idx) => {
                            const percentage = Math.min(100, (qty / maxBidQty) * 100);
                            const total = price * qty;
                            return (
                              <div 
                                key={`bid-${idx}`} 
                                className="grid grid-cols-3 py-0.5 hover:bg-white/[0.02] transition-colors relative items-center text-[10px]"
                              >
                                {/* Horizontal ratio fill depth bar */}
                                <div 
                                  style={{ width: `${percentage}%` }}
                                  className="absolute right-0 top-0 bottom-0 bg-emerald-500/[0.05] transition-all pointer-events-none"
                                />
                                <span className="text-left font-black text-[#10B981] pr-1 z-10">
                                  ${formatPrice(price)}
                                </span>
                                <span className="text-[#8E9CAE] text-right font-bold z-10">
                                  {qty.toFixed(4)}
                                </span>
                                <span className="text-slate-500 text-right font-semibold pr-1 z-10">
                                  ${total.toFixed(1)}
                                </span>
                              </div>
                            );
                          });
                      })()
                    ) : (
                      <div className="py-6 text-center text-slate-650 text-[10px] font-sans">
                        دریافت اردرهای خرید...
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* OUTWARD FILTERED VETO TARGETS HISTORY (Compact) */}
              <section className="bg-[#181A20] border border-[#242731] rounded-xl p-4 space-y-3 shadow-lg text-right">
                <div className="flex items-center justify-between border-b border-[#2B3139] pb-2">
                  <h3 className="text-xs font-black text-white flex items-center gap-1.5">
                    <ShieldAlert size={14} className="text-[#F0B90B]" />
                    سیگنال‌های مردود (Veto Logs)
                  </h3>
                  <span className="text-[9px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded font-mono font-bold">
                    {status.rejectedSignals?.length || 0}
                  </span>
                </div>

                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 text-right custom-scrollbar">
                  {status.rejectedSignals && status.rejectedSignals.length > 0 ? (
                    [...status.rejectedSignals].reverse().slice(0, 40).map((sig, index) => (
                      <div key={index} className="bg-black/25 border border-white/5 hover:border-slate-800 p-2 rounded flex flex-col justify-between gap-1.5 text-xs transition-colors">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-slate-500 font-mono">
                            {new Date(sig.time).toLocaleTimeString("fa-IR")}
                          </span>
                          <span className="font-mono font-bold text-white text-[11px]">{sig.symbol}/USDT</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] border-t border-white/5 pt-1 text-slate-400">
                          <span className="truncate max-w-[140px] text-right">{sig.reason}</span>
                          <span className="bg-slate-900 px-1 py-0.5 rounded text-amber-400 font-mono text-[9px]">
                            {sig.score?.toFixed(1)}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-600 text-[10px] italic text-center py-6">
                      بدون مورد فیلتر شده اخیر.
                    </div>
                  )}
                </div>
              </section>

            </div>

            {/* COLUMN 2: PRIMARY CHART WORKSPACE & INLINE 9-LAYER CHECKLIST (6 Columns - Center) */}
            <div className="lg:col-span-6 space-y-4">
              
              {/* TARGET REPLACED: NEW LIVE SIGNALS GRID (NOT TOO BIG, NOT TOO SMALL CARDS WITH FULL INFO) */}
              <div className="space-y-3 text-right">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-black text-white flex items-center gap-1.5 uppercase font-mono">
                    <Activity className="text-[#F0B90B]" size={15} />
                    <span>کارت‌های سیگنال فعال و موقعیت‌های بازار کورتکس</span>
                  </h3>
                  <span className="text-[10px] text-slate-500 font-sans">
                    کلیک روی هر کارت برای دیدن تأییدیه‌های ۹ بعدی ↴
                  </span>
                </div>

                {allSignalsToShow.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {allSignalsToShow.map((order) => {
                      const isActive = order.isLive;
                      const isSelected = selectedSymbol === order.symbol;
                      
                      // Precise real-time profit and loss computation
                      const pnlPct = order.pnl_pct || 0;
                      const pnlUsd = (pnlPct / 100) * (order.position_value || 100);
                      const isProfit = pnlPct >= 0;

                      return (
                        <div
                          key={order.id}
                          onClick={() => setSelectedSymbol(order.symbol)}
                          className={cn(
                            "bg-gradient-to-b from-[#14161C] to-[#0D0F13] border rounded-2xl p-4.5 relative transition-all duration-300 cursor-pointer flex flex-col justify-between space-y-4 shadow-xl hover:scale-[1.01]",
                            isSelected 
                              ? "border-[#F0B90B] shadow-[0_0_20px_rgba(240,185,11,0.12)] bg-gradient-to-b from-[#1D2028] to-[#121419]" 
                              : "border-[#2B3139]/80 hover:border-slate-500/50 hover:shadow-[0_4px_20px_rgba(0,0,0,0.3)] bg-gradient-to-b from-[#14161C] to-[#0D0F13]"
                          )}
                        >
                          {/* Top row: Symbol & Direction Badge */}
                          <div className="flex items-center justify-between border-b border-[#2B3139]/50 pb-3">
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "text-[9px] font-black px-2.5 py-1 rounded-md tracking-wide font-mono",
                                order.action === "buy" 
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                                  : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                              )}>
                                {order.action === "buy" ? "LONG / خرید" : "SHORT / فروش"}
                              </span>
                              {isActive ? (
                                <span className={cn(
                                  "flex items-center gap-1 text-[9px] px-2 py-1 rounded-md border font-extrabold animate-pulse",
                                  isProfit 
                                    ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" 
                                    : "bg-rose-500/8 text-rose-400 border-rose-500/20"
                                )}>
                                  <span className={cn("w-1.5 h-1.5 rounded-full", isProfit ? "bg-emerald-400" : "bg-rose-400")} />
                                  لایو ({order.tp1_hit ? "Target 1 Hit" : "تحت پایش"})
                                </span>
                              ) : (
                                <span className="text-[9px] bg-slate-800/80 text-slate-400 px-2 py-1 rounded-md border border-slate-700/30">
                                  بسته شده
                                </span>
                              )}
                            </div>
                            <h4 className="text-sm font-extrabold font-mono text-white text-left tracking-wide">
                              {order.symbol}<span className="text-slate-500 text-[11px] font-normal">/USDT</span>
                            </h4>
                          </div>

                          {/* Info Rows: Full Pricing Information & Target Matrix */}
                          <div className="grid grid-cols-2 gap-2.5 text-right">
                            <div className="bg-[#1C2028]/40 p-2.5 rounded-xl border border-white/[0.02]">
                              <span className="text-[9px] text-[#8C929E] block mb-0.5">قیمت ورود</span>
                              <span className="font-mono font-bold text-slate-200 text-xs">${formatPrice(order.entry_price)}</span>
                            </div>
                            <div className="bg-[#1C2028]/40 p-2.5 rounded-xl border border-white/[0.02]">
                              <span className="text-[9px] text-[#8C929E] block mb-0.5">
                                {isActive ? "قیمت لحظه‌ای" : "قیمت نهایی"}
                              </span>
                              <span className="font-mono font-bold text-[#F0B90B] text-xs">${formatPrice(order.current_price || order.entry_price)}</span>
                            </div>
                            <div className="bg-[#1C2028]/40 p-2.5 rounded-xl border border-white/[0.02]">
                              <span className="text-[9px] text-[#8C929E] block mb-0.5">حد سود (TP1 / TP2)</span>
                              <div className="text-[10px] font-mono font-bold flex flex-row-reverse items-center justify-end gap-1 text-emerald-400">
                                <span>${formatPrice(order.take_profit_1)}</span>
                                <span className="text-slate-600 text-[9px]">/</span>
                                <span>${formatPrice(order.take_profit_2)}</span>
                              </div>
                            </div>
                            <div className="bg-[#1C2028]/40 p-2.5 rounded-xl border border-white/[0.02]">
                              <span className="text-[9px] text-[#8C929E] block mb-0.5">حد ضرر قطعی SL</span>
                              <span className="font-mono font-bold text-rose-400 text-xs">${formatPrice(order.stop_loss)}</span>
                            </div>

                            {/* ✨ Real-time Profit/Loss percentage and USD Badge Panel */}
                            <div className={cn(
                              "col-span-2 p-2.5 rounded-xl border flex items-center justify-between text-right transition-all backdrop-blur-md",
                              isProfit 
                                ? "bg-emerald-500/[0.03] border-emerald-500/25 text-emerald-400 shadow-[inset_0_1px_10px_rgba(16,185,129,0.02)]" 
                                : "bg-rose-500/[0.03] border-rose-500/25 text-rose-400 shadow-[inset_0_1px_10px_rgba(244,63,94,0.02)]"
                            )}>
                              <div className="flex items-center gap-1.5 text-[9px] text-slate-400 font-bold">
                                <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse", isProfit ? "bg-emerald-400" : "bg-rose-400")} />
                                <span>سود / ضرر لحظه‌ای (PnL):</span>
                              </div>
                              <div className="flex items-center gap-2 font-mono" style={{ direction: "ltr" }}>
                                <span className={cn(
                                  "text-xs font-black px-2 py-0.5 rounded",
                                  isProfit ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                                )}>
                                  {isProfit ? "+" : "-"}{Math.abs(pnlPct).toFixed(2)}%
                                </span>
                                <span className="text-slate-700 text-[9px]">|</span>
                                <span className={cn(
                                  "text-xs font-black",
                                  isProfit ? "text-[#10B981]" : "text-[#EF4444]"
                                )}>
                                  {isProfit ? "+" : "-"}${Math.abs(pnlUsd).toFixed(2)} <span className="text-[10px] text-slate-500 font-medium">USDT</span>
                                </span>
                              </div>
                            </div>

                            {/* Vol & Pressure indicators */}
                            <div className="bg-[#1C2028]/25 p-2.5 rounded-xl border border-white/[0.02] col-span-2 space-y-2">
                              <div className="flex items-center justify-between text-[9px] text-slate-400 font-sans">
                                <div className="flex items-center gap-1">
                                  <span>امتیاز مدل کورتکس:</span>
                                  <span className="text-[#F0B90B] font-mono font-extrabold">{(order.score * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span>حجم پوزیشن:</span>
                                  <span className="text-slate-200 font-mono font-bold">${order.position_value?.toFixed(1) ?? "100.0"} USDT</span>
                                </div>
                              </div>
                              <div className="w-full bg-slate-900/80 h-1.5 rounded-full overflow-hidden flex">
                                <div 
                                  style={{ width: `${Math.min(100, order.score * 100)}%` }} 
                                  className={cn("h-full transition-all duration-500", order.action === 'buy' ? 'bg-emerald-500' : 'bg-rose-500')}
                                />
                                <div className="flex-1" />
                              </div>
                            </div>
                          </div>

                          {/* Footer action keys */}
                          <div className="flex items-center gap-1.5 border-t border-[#2B3139]/50 pt-2.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setModalActiveOrder(order)}
                              className="flex-1 h-8 bg-gradient-to-b from-[#1C2028] to-black hover:border-[#F0B90B]/40 hover:text-white text-[#F0B90B] border border-[#2B3139] rounded-lg text-[10px] font-black flex items-center justify-center gap-1 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                            >
                              <BarChart3 size={11} />
                              <span>دیدن چارت</span>
                            </button>

                            {isActive && (
                              <button
                                onClick={() => {
                                  setShowCloseConfirmOrder(order);
                                }}
                                disabled={isClosingId === order.id}
                                className="px-2.5 h-8 bg-gradient-to-b from-rose-950/10 to-rose-950/30 hover:from-rose-500/20 hover:to-rose-950/35 text-rose-400 border border-rose-500/30 hover:border-rose-500/60 rounded-lg text-[10px] font-black flex items-center justify-center gap-1 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                              >
                                {isClosingId === order.id ? (
                                  <div className="w-3.5 h-3.5 border border-rose-400 border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <>
                                    <X size={11} />
                                    <span>بستن پوزیشن</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-12 bg-black/20 border border-[#2B3139] border-dashed rounded-xl text-center text-slate-500 text-xs">
                    <Zap className="mx-auto text-slate-600 mb-2 animate-pulse" size={24} />
                    هیچ سیگنال فعال یا اخیری پیدا نشد. منتظر کشف نوسان بهینه توسط کورتکس...
                  </div>
                )}
              </div>

            </div>

            {/* COLUMN 3: EXCHANGE API GATEWAY & KELLY ALLOCATOR (3 Columns - Right) */}
            <div className="lg:col-span-3 space-y-4">
              
              {/* SIMULATE vs REAL ACCOUNT OFFICE */}
              <section className="bg-[#181A20] border border-[#F0B90B]/30 hover:border-[#F0B90B]/60 transition-colors rounded-xl p-4 space-y-4 shadow-lg">
                <div className="flex items-center justify-between border-b border-[#2B3139] pb-2">
                  <div className="flex items-center gap-1.5">
                    <Shield className="text-[#F0B90B]" size={16} />
                    <h3 className="text-xs font-black text-white">انتخاب موتور مبادلات (Trading Engine)</h3>
                  </div>
                  <span className={cn(
                    "text-[8px] font-black px-1.5 py-0.5 rounded z-10",
                    status.tradingMode === "real" ? "bg-emerald-500/10 text-emerald-400" : "bg-cyan-500/10 text-cyan-400"
                  )}>
                    {status.tradingMode === "real" ? "REAL BOT" : "SIMULATED"}
                  </span>
                </div>

                {/* DYNAMIC DUAL BALANCE MONITOR DISPLAY */}
                <div className="flex flex-col gap-2.5 bg-black/40 border border-[#2B3139] p-3 rounded-xl text-right">
                  <div className="flex items-center justify-between border-b border-[#2B3139]/40 pb-2">
                    <span className="text-[10px] text-slate-400 font-bold">موجودی در دسترس (Available):</span>
                    {status.tradingMode === "real" ? (
                      <span className="text-emerald-400 font-mono font-black text-xs">
                        ${status.realBalance?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "0.00"} USDT
                      </span>
                    ) : (
                      <span className="text-[#F0B90B] font-mono font-black text-xs">
                        ${(status.demoFreeBalance ?? 10000).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400 font-bold">ارزش کل سرمایه (Equity):</span>
                    {status.tradingMode === "real" ? (
                      <span className="text-slate-300 font-mono font-bold text-[11px] animate-pulse">
                        حساب فیوچرز صرافی
                      </span>
                    ) : (
                      <span className="text-emerald-400 font-mono font-black text-xs animate-pulse">
                        ${(status.demoTotalEquity ?? 10000).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 leading-relaxed text-right font-medium pt-1">
                  پشتیبانی از تریدهای جفت ارزهای صرافی XT در هر دو حالت شبیه‌ساز و اتصال حساب فیوچرز واقعی فراهم است. کلیدها در لایه امن کورتکس ثبت می‌شوند.
                </div>
              </section>

              {/* INTEGRATED API KEYS GATEWAY DESK */}
              <section className="bg-[#181A20] border border-[#242731] rounded-xl p-4 space-y-4 shadow-lg text-right">
                <div className="flex items-center justify-between border-b border-[#2B3139] pb-2">
                  <div className="flex items-center gap-1.5">
                    <Lock size={15} className="text-[#F0B90B]" />
                    <h3 className="text-xs font-black text-white">پیکربندی درگاه وب‌سرویس XT</h3>
                  </div>
                  <HelpCircle size={14} className="text-slate-500 cursor-pointer" />
                </div>

                <form onSubmit={saveConfig} className="space-y-3">
                  <div className="space-y-1 text-right">
                    <label className="text-[9px] text-slate-400 font-bold block">کلید دسترسی (XT API Key)</label>
                    <input
                      type="text"
                      placeholder={status.apiKey ? `${status.apiKey} (ذخیره شده)` : "XT v4 AppKey..."}
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      className="w-full h-10 bg-black/30 border border-[#2B3139] focus:border-[#F0B90B] text-slate-200 rounded-lg px-3 text-xs font-mono outline-none transition-colors"
                    />
                  </div>

                  <div className="space-y-1 text-right">
                    <label className="text-[9px] text-slate-400 font-bold block">کلید حفاظتی سکسشن (XT Trade Secret)</label>
                    <input
                      type="password"
                      placeholder={status.hasSecret ? "•••••••••••• (کدگذاری شده)" : "XT v4 Secret..."}
                      value={secretKeyInput}
                      onChange={(e) => setSecretKeyInput(e.target.value)}
                      className="w-full h-10 bg-black/30 border border-[#2B3139] focus:border-[#F0B90B] text-slate-200 rounded-lg px-3 text-xs font-mono outline-none transition-colors"
                    />
                  </div>

                  <div className="space-y-1 text-right">
                    <label className="text-[9px] text-slate-400 font-bold block">موتور تسویه مالی و معامله</label>
                    <select
                      value={modeInput}
                      onChange={(e) => setModeInput(e.target.value as "simulation" | "real")}
                      className="w-full h-10 bg-[#12161A] border border-[#2B3139] text-[#EAECEF] rounded-lg px-2 text-xs outline-none"
                    >
                      <option value="simulation">حالت شبیه‌سازی (Simulation)</option>
                      <option value="real">اتصال به فیوچرز واقعی (Futures Account)</option>
                    </select>
                  </div>



                  <button
                    type="submit"
                    disabled={saveLoading}
                    className="w-full h-10 bg-gradient-to-r from-[#F0B90B] to-[#b38905] hover:scale-[1.01] active:scale-[0.99] text-black font-black text-xs rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-[0_0_15px_rgba(240,185,11,0.2)] hover:shadow-[0_0_22px_rgba(240,185,11,0.35)] cursor-pointer"
                  >
                    {saveLoading ? (
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <RefreshCcw size={13} className="animate-spin-slow" />
                        <span>ذخیره اتصال صرافی XT</span>
                      </>
                    )}
                  </button>
                </form>

                {saveMessage && (
                  <div className="p-2.5 bg-black/30 border border-[#2B3139] rounded text-[10px] text-center text-[#F0B90B] font-semibold leading-normal">
                    {saveMessage}
                  </div>
                )}
              </section>

              {/* INTEGRATED CORTEX PERFORMANCE LEDGER (REPLACES KELLY) */}
              <div className="shadow-lg">
                <CortexLedger
                  status={status}
                  ledgerStats={ledgerStats}
                  profitParts={profitParts}
                  lossParts={lossParts}
                  profitTradesCount={profitTradesCount}
                  profitTotalUsd={profitTotalUsd}
                  lossTradesCount={lossTradesCount}
                  lossTotalUsd={lossTotalUsd}
                  onOpenArchive={(type) => setSelectedArchiveType(type)}
                  onResetSimulatedTrades={handleResetSimulatedTrades}
                  isResettingTrades={isResettingTrades}
                />
              </div>

              {/* ⏰ HOURLY PERFORMANCE GUARD + DAILY/WEEKLY STATS (mirrors Telegram panel) */}
              <div className="shadow-lg">
                <HourlyPerformancePanel status={status} onRefresh={fetchStatus} />
              </div>

              {/* 🧠 CORTEX AUTOMATIC SELF-CORRECTION & DIAGNOSTICS CONTROL CENTER */}
              <div className="shadow-lg">
                <CortexDiagnosticsHub status={status} onRefresh={fetchStatus} />
              </div>

            </div>

          </div>
        )}

        {/* 📑 TAB 2: POSITION MANAGEMENT VIEW */}
        {activeTab === "signals" && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            className="space-y-4"
          >
            <div className="bg-[#181A20] border border-[#242731] p-5 rounded-xl flex items-center justify-between">
              <h3 className="text-base font-black text-white flex items-center gap-2">
                <Zap className="text-[#F0B90B] animate-pulse" size={18} />
                <span>لیست جامع پوزیشن‌های معاملاتی صادر شده اشیر</span>
              </h3>
              <span className="text-xs bg-[#F0B90B]/15 text-[#F0B90B] border border-[#F0B90B]/35 px-3 py-1 rounded-full font-mono font-bold">
                {status.orders.length} ACTIVE TRACKING SIGNALS
              </span>
            </div>

            <div className="space-y-4">
              {getTickedOrders().length > 0 ? (
                getTickedOrders().map((order) => {
                  const isExpanded = expandedSignal === order.id;
                  return (
                    <div 
                      key={order.id} 
                      className="border border-[#2B3139] bg-[#181A20] rounded-xl p-5 hover:border-[#F0B90B]/40 transition-all cursor-pointer text-right"
                      onClick={() => setExpandedSignal(isExpanded ? null : order.id)}
                    >
                      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={cn(
                            "w-12 h-12 rounded-lg flex items-center justify-center text-sm font-black font-mono",
                            order.action === "buy" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/15" : "bg-rose-500/10 text-rose-400 border border-rose-500/15"
                          )}>
                            {order.symbol[0]}
                          </span>
                          <div className="text-right">
                            <h4 className="text-base font-black text-white font-mono uppercase">{order.symbol}/USDT</h4>
                            <span className="text-[10px] text-slate-500 tracking-wider">کشف سیگنال: {new Date(order.created_at || Date.now()).toLocaleTimeString("fa-IR")}</span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-right">
                          <div>
                            <span className="text-[9px] text-[#A0A5AF] block">قیمت ورود اصلی</span>
                            <span className="text-xs font-mono font-black text-white">${formatPrice(order.entry_price)}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-[#A0A5AF] block">حد سود اول (50% بسته)</span>
                            <span className="text-xs font-mono font-black text-[#F0B90B]">${formatPrice(order.take_profit_1)}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-[#A0A5AF] block">حد سود نهایی (100%)</span>
                            <span className="text-xs font-mono font-black text-emerald-400">${formatPrice(order.take_profit_2)}</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-[#A0A5AF] block">اهرم هوشمند</span>
                            <span className="text-xs font-mono font-black text-amber-500">{order.leverage || 20}x</span>
                          </div>
                          <div>
                            <span className="text-[9px] text-[#A0A5AF] block">بازدهی لحظه‌ای شناور</span>
                            <span className={cn(
                              "text-xs font-mono font-black",
                              (order.pnl_pct || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                            )}>
                              {(order.pnl_pct || 0) >= 0 ? "+" : ""}{(order.pnl_pct || 0).toFixed(2)}%
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end md:self-auto">
                          {order.status === "filled" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowCloseApiConfirmOrder(order);
                              }}
                              className="px-3 h-8 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] font-black rounded border border-rose-500/20 cursor-pointer"
                            >
                              خروج فوری و بستن معامله
                            </button>
                          )}
                          <div className="w-8 h-8 rounded bg-black/25 flex items-center justify-center text-slate-400">
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </div>
                        </div>
                      </div>

                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div 
                            initial={{ opacity: 0, height: 0 }} 
                            animate={{ opacity: 1, height: "auto" }} 
                            className="mt-4 pt-4 border-t border-[#1E2329] space-y-4"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <SignalChart 
                              symbol={order.symbol}
                              action={order.action}
                              entryPrice={order.entry_price}
                              stopLoss={order.stop_loss}
                              takeProfit1={order.take_profit_1}
                              takeProfit2={order.take_profit_2}
                              positionValue={order.position_value}
                              isLive={order.status !== "closed"}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })
              ) : (
                <div className="py-16 text-center bg-[#181A20] border border-[#2B3139] rounded-xl text-slate-500 block">
                  <Target size={36} className="mx-auto mb-2 opacity-50 text-[#F0B90B]" />
                  <p className="text-xs font-bold uppercase font-mono tracking-widest text-[#F0B90B]">AWAITING NEW TARGETS</p>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto mt-2 leading-relaxed font-sans">
                    سیگنال‌های دریافتی صرافی صیاد پس از فعال‌سازی اسکنر به همراه تارگت اول و دوم خروج در این بخش قرار می‌گیرند.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* 📑 TAB 4: API credentials portal */}
        {activeTab === "gateways" && (
          <div className="max-w-xl mx-auto space-y-6">
            <div className="bg-[#181A20] border border-[#F0B90B]/30 hover:border-[#F0B90B]/50 transition-colors rounded-xl p-6 space-y-4 shadow-xl text-right">
              <div className="flex items-center gap-2 border-b border-[#2B3139] pb-3">
                <Lock className="text-[#F0B90B]" size={20} />
                <h3 className="text-base font-black text-white">درگاه اتصال اطلاعات API صرافی XT.com</h3>
              </div>
              
              <p className="text-xs text-slate-400 leading-normal font-sans">
                کلاینت ایمن کورتکس اشیر دیتای جفت کلیدهای خصوصی و وب‌سرویس‌ها را در هاست لوکال کپسوله نگهداری می‌کند. هیچ سروری دیتای کلید خصوصی شما را شنود نخواهد کرد.
              </p>

              <form onSubmit={saveConfig} className="space-y-4">
                <div className="space-y-1 text-right">
                  <label className="text-[11px] text-slate-300 font-bold block">کلید عمومی حساب (XT API Key)</label>
                  <input
                    type="text"
                    placeholder={status.apiKey ? `${status.apiKey} (ذخیره شده)` : "XT AppKey..."}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className="w-full h-11 bg-black/30 border border-[#2B3139] focus:border-[#F0B90B] text-slate-200 rounded-lg px-3 text-xs font-mono outline-none"
                  />
                </div>

                <div className="space-y-1 text-right">
                  <label className="text-[11px] text-slate-300 font-bold block">کلید خصوصی معاملاتی (XT Secret Key)</label>
                  <input
                    type="password"
                    placeholder={status.hasSecret ? "••••••••••••••••" : "XT Secret Key..."}
                    value={secretKeyInput}
                    onChange={(e) => setSecretKeyInput(e.target.value)}
                    className="w-full h-11 bg-black/30 border border-[#2B3139] focus:border-[#F0B90B] text-slate-200 rounded-lg px-3 text-xs font-mono outline-none"
                  />
                </div>

                <div className="space-y-1 text-right">
                  <label className="text-[11px] text-slate-300 font-bold block">حالت تراکنش معاملاتی ربات</label>
                  <select
                    value={modeInput}
                    onChange={(e) => setModeInput(e.target.value as "simulation" | "real")}
                    className="w-full h-11 bg-[#12161A] border border-[#2B3139] text-[#EAECEF] rounded-lg px-2 text-xs outline-none"
                  >
                    <option value="simulation">معاملات شبیه‌ساز (دمو با موجودی فرضی)</option>
                    <option value="real">اتصال به جفت‌ارزهای معتبر واقعی (رئال فیوچرز)</option>
                  </select>
                </div>



                <button
                  type="submit"
                  disabled={saveLoading}
                  className="w-full h-11 bg-gradient-to-r from-[#F0B90B] to-[#b38905] hover:scale-[1.01] active:scale-[0.99] text-black font-black text-xs rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-[0_0_15px_rgba(240,185,11,0.2)] hover:shadow-[0_0_22px_rgba(240,185,11,0.35)] cursor-pointer"
                >
                  {saveLoading ? (
                    <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <RefreshCcw size={14} className="animate-spin-slow" />
                      <span>همگام سازی درگاه صرافی XT</span>
                    </>
                  )}
                </button>
              </form>

              {saveMessage && (
                <div className="p-3 bg-black/40 border border-[#2B3139] rounded text-xs text-center text-[#F0B90B] font-semibold leading-normal">
                  {saveMessage}
                </div>
              )}
            </div>

            {/* Auto System Health State Indicator - Informative only, no interactive controls */}
            <div className="bg-[#181A20] border border-[#242731] rounded-xl p-5 space-y-3 text-right">
              <div className="flex items-center gap-2 border-b border-[#2B3139] pb-2">
                <Database className="text-[#F0B90B]" size={16} />
                <h4 className="text-xs font-black text-white">سامانه پایداری و خود-نگهداری اطلاعات (Smart Auto-Sync)</h4>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                ربات به سیستم حفاظت از فریز و ذخیره‌سازی ابری مجهز است. دیتای موقعیت‌ها، لاگ‌ها و دارایی دمو به طور هوشمند و در پس‌زمینه در فایل سرور و کش مرورگر ذخیره و همگام‌سازی می‌شود. در صورت رفرش صفحه یا لود شدن مجدد کانتینر، ربات اطلاعات تریدها را به طور کامل و خودکار بازیابی خواهد کرد. <strong className="text-[#F0B90B]">عملیات کاملاً اتوماتیک است و نیازی به اقدام دستی شما نیست.</strong>
              </p>
              <div className="flex items-center gap-2 justify-end text-[10px] text-emerald-400 font-mono">
                <span>سنسور پایداری: فعال و در حال محافظت</span>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse inline-block" />
              </div>
            </div>
          </div>
        )}



        {/* 📜 BOTTOM PORTION: HIGH PERFORMANCE TELEMETRY STREAM & TELEGRAM MONITOR */}
        <section className="space-y-3">
          <div className="flex items-center justify-between border-b border-[#2B3139] pb-2">
            <h2 className="text-xs font-black uppercase tracking-wider flex items-center gap-1.5 text-white font-mono">
              <Terminal size={17} className="text-[#F0B90B] animate-pulse" />
              کنسول پایش لحظه‌ای و ثبت تلمتری کورتکس (Cortex System Feed)
            </h2>
            {status.isRunning && (
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
            )}
          </div>

          <div className="bg-[#181A20] border border-[#242731] rounded-xl p-5 shadow-2xl space-y-4">
            
            {/* Quick telemetry indices */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <div className="bg-black/30 border border-[#2B3139] p-2.5 rounded flex justify-between items-center text-[10px] font-mono">
                <span className="text-slate-500 font-bold">WEBSOCK FEED</span>
                <span className="text-emerald-400 font-black">● STANDBY OK</span>
              </div>
              <div className="bg-black/30 border border-[#2B3139] p-2.5 rounded flex justify-between items-center text-[10px] font-mono">
                <span className="text-slate-500 font-bold">REALIZED PROFIT REPORT</span>
                <span className="text-emerald-400 font-black">● 50% TP MESSAGE</span>
              </div>
              <div className="bg-black/30 border border-[#2B3139] p-2.5 rounded flex justify-between items-center text-[10px] font-mono">
                <span className="text-slate-500 font-bold">GARCH RISK INDEX</span>
                <span className="text-[#F0B90B] font-black">0.86 READY</span>
              </div>
              <div className="bg-black/30 border border-[#2B3139] p-2.5 rounded flex justify-between items-center text-[10px] font-mono">
                <span className="text-slate-500 font-bold">TELEGRAM REPORTERS</span>
                <span className="text-emerald-400 font-black">ACTIVE RELAY</span>
              </div>
            </div>

            {/* Logs controller line */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-[#2B3139] pb-3">
              <div className="flex flex-wrap items-center gap-1.5" dir="ltr">
                <button 
                  onClick={() => setLogFilter("all")}
                  className={cn(
                    "px-3 py-1 bg-black/40 text-[10px] font-black font-mono rounded border transition-all cursor-pointer",
                    logFilter === "all" 
                      ? "text-black bg-gradient-to-r from-[#F0B90B] to-[#b38905] border-[#F0B90B] shadow-[0_0_8px_rgba(240,185,11,0.2)] scale-[1.03]" 
                      : "text-slate-400 border-[#2B3139] hover:text-white hover:bg-[#1E222B]/60 hover:border-slate-500/30"
                  )}
                >
                  ALL LOGS
                </button>
                <button 
                  onClick={() => setLogFilter("whales")}
                  className={cn(
                    "px-3 py-1 bg-black/40 text-[10px] font-black font-mono rounded border transition-all cursor-pointer",
                    logFilter === "whales" 
                      ? "text-black bg-gradient-to-r from-[#F0B90B] to-[#b38905] border-[#F0B90B] shadow-[0_0_8px_rgba(240,185,11,0.2)] scale-[1.03]" 
                      : "text-slate-400 border-[#2B3139] hover:text-white hover:bg-[#1E222B]/60 hover:border-slate-500/30"
                  )}
                >
                  WHALE INSIGHTS
                </button>
                <button 
                  onClick={() => setLogFilter("liquidity")}
                  className={cn(
                    "px-3 py-1 bg-black/40 text-[10px] font-black font-mono rounded border transition-all cursor-pointer",
                    logFilter === "liquidity" 
                      ? "text-black bg-gradient-to-r from-[#F0B90B] to-[#b38905] border-[#F0B90B] shadow-[0_0_8px_rgba(240,185,11,0.2)] scale-[1.03]" 
                      : "text-slate-400 border-[#2B3139] hover:text-white hover:bg-[#1E222B]/60 hover:border-slate-500/30"
                  )}
                >
                  STOP HUNTS
                </button>
                <button 
                  onClick={() => setLogFilter("system")}
                  className={cn(
                    "px-3 py-1 bg-black/40 text-[10px] font-black font-mono rounded border transition-all cursor-pointer",
                    logFilter === "system" 
                      ? "text-black bg-gradient-to-r from-[#F0B90B] to-[#b38905] border-[#F0B90B] shadow-[0_0_8px_rgba(240,185,11,0.2)] scale-[1.03]" 
                      : "text-slate-400 border-[#2B3139] hover:text-white hover:bg-[#1E222B]/60 hover:border-slate-500/30"
                  )}
                >
                  CORE MODEL
                </button>
              </div>

              {/* Keyword search input */}
              <div className="relative w-full md:w-64">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input 
                  type="text" 
                  placeholder="جستجو در تلمتری زنده..."
                  value={logSearchQuery}
                  onChange={(e) => setLogSearchQuery(e.target.value)}
                  className="w-full h-8 pl-9 pr-3 bg-black/40 border border-[#2B3139] focus:border-[#F0B90B] rounded text-xs text-white outline-none font-sans text-left font-mono"
                  dir="ltr"
                />
              </div>
            </div>

            {/* Scroll logs feed panel */}
            <div className="space-y-1 bg-[#12161A] border border-[#2B3139] p-3 rounded" style={{ direction: 'ltr' }}>
              <div 
                ref={scrollRef}
                className="space-y-1.5 font-mono text-[10px] h-60 overflow-y-auto pr-2 custom-scrollbar text-left"
              >
                {filteredLogs.length > 0 ? (
                  filteredLogs.map((log, index) => {
                    const hasWhale = log.toLowerCase().includes("whale") || log.toLowerCase().includes("iceberg");
                    const hasSignal = log.toLowerCase().includes("buy") || log.toLowerCase().includes("sell") || log.toLowerCase().includes("signal");
                    const hasStop = log.toLowerCase().includes("stop") || log.toLowerCase().includes("hunt");
                    const hasError = log.toLowerCase().includes("fail") || log.toLowerCase().includes("error");

                    return (
                      <div 
                        key={index} 
                        className={cn(
                          "py-1 px-2 border-l-2 text-left hover:bg-white/5 transition-colors font-mono font-semibold",
                          hasWhale 
                            ? "border-purple-500 text-purple-300" 
                            : hasSignal 
                              ? "border-emerald-500 text-emerald-300"
                              : hasStop 
                                ? "border-amber-500 text-amber-300"
                                : hasError
                                  ? "border-rose-500 text-rose-400"
                                  : "border-slate-700 text-slate-400"
                        )}
                      >
                        <span className="block break-all leading-relaxed">{log}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-slate-600 text-xs italic text-center py-12 uppercase font-mono tracking-widest">
                    AWAITING INCOMING CORTEX LOG PIPELINE...
                  </div>
                )}
              </div>
            </div>

            {/* Error logs exceptions warning overlay */}
            {status.lastError && (
              <div className="bg-rose-500/10 border border-rose-500/30 p-3.5 rounded-lg flex items-start gap-3">
                <AlertTriangle className="text-rose-400 shrink-0 mt-0.5" size={15} />
                <div>
                  <h4 className="text-[10px] font-black text-rose-400 uppercase tracking-widest font-mono">CORTEX HANDSHAKE WARNING EXCEPTIONS</h4>
                  <p className="text-[10px] text-slate-300 font-mono mt-1 leading-normal">{status.lastError}</p>
                </div>
              </div>
            )}

          </div>
        </section>

      </main>

      {/* ARCHIVE DIALOG MODAL BOX */}
      <AnimatePresence>
        {selectedArchiveType && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setSelectedArchiveType(null);
                setExpandedArchiveSignal(null);
              }}
              className="absolute inset-0 bg-black/85 backdrop-blur-sm"
            />

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-4xl bg-[#181A20] border border-[#2B3139] rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh] text-right"
            >
              {/* Modal top ribbon line */}
              <div className="h-[3px] bg-[#F0B90B]" />
              
              <div className="p-5 border-b border-[#2B3139] flex items-center justify-between">
                <button 
                  onClick={() => {
                    setSelectedArchiveType(null);
                    setExpandedArchiveSignal(null);
                  }}
                  className="w-10 h-10 bg-white/5 hover:bg-white/10 text-slate-400 rounded-lg flex items-center justify-center cursor-pointer"
                >
                  <X size={18} />
                </button>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <h3 className="text-base font-black text-white">
                      {selectedArchiveType === "profit" ? "بایگانی موقعیت‌های سرریز سود (TP 1 / TP 2)" : "بایگانی موقعیت‌های تات رهای استاپ لاس"}
                    </h3>
                    <p className="text-[10px] text-[#A0A5AF] font-mono">
                      Showing {selectedArchiveType === "profit" ? profitClosedCount : stopClosedCount} closed trades logs
                    </p>
                  </div>
                  <div className={cn(
                    "w-10 h-10 rounded-lg flex items-center justify-center border",
                    selectedArchiveType === "profit" 
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                      : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  )}>
                    {selectedArchiveType === "profit" ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                  </div>
                </div>
              </div>

              {/* Modal scroll contents */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4 max-h-[60vh] custom-scrollbar">
                {(selectedArchiveType === "profit" ? profitParts : lossParts).length === 0 ? (
                  <div className="text-center py-12 text-slate-500 bg-black/20 border border-white/5 rounded-xl">
                    <Info size={32} className="mx-auto mb-2 text-[#F0B90B]" />
                    <p className="text-xs font-bold">هیچ سیگنالی در این دسته طبقه‌بندی هنوز ثبت نشده است.</p>
                  </div>
                ) : (
                  (selectedArchiveType === "profit" ? profitParts : lossParts).map((part, partIdx) => {
                    const partUniqueId = `${part.symbol}-${part.type}-${partIdx}`;
                    const isArchExpanded = expandedArchiveSignal === partUniqueId;
                    return (
                      <div key={partUniqueId} className="bg-black/15 border border-[#2B3139] rounded-xl overflow-hidden hover:border-[#F0B90B]/30 transition-colors text-right">
                        <div 
                          onClick={() => setExpandedArchiveSignal(isArchExpanded ? null : partUniqueId)}
                          className="p-4 flex flex-col md:flex-row-reverse md:items-center justify-between gap-4 cursor-pointer select-none"
                        >
                          <div className="flex items-center gap-3 justify-end">
                            <div className="text-right">
                              <div className="flex items-center gap-1.5 justify-end">
                                {part.type === "tp1_tp2_combined" && (
                                  <span className="text-[8px] bg-indigo-500/15 text-indigo-300 font-black px-1.5 py-0.5 rounded border border-indigo-500/10">دو مرحله‌ای (تارگت اول + نهایی)</span>
                                )}
                                {part.type === "tp1_partial" && (
                                  <span className="text-[8px] bg-emerald-500/15 text-emerald-400 font-black px-1.5 py-0.5 rounded border border-emerald-500/10">تارگت اول (۵۰٪)</span>
                                )}
                                {part.type === "remaining_50" && (
                                  <span className="text-[8px] bg-sky-500/15 text-sky-400 font-black px-1.5 py-0.5 rounded border border-sky-500/10">مابقی ۵۰٪</span>
                                )}
                                {part.type === "full" && (
                                  <span className="text-[8px] bg-slate-500/15 text-slate-400 font-black px-1.5 py-0.5 rounded border border-slate-500/10">خروج کامل</span>
                                )}
                                <span className="text-sm font-black text-white font-mono uppercase block">
                                  {part.symbol}/USDT
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-1 justify-end text-[10px]">
                                <span className="text-slate-500 font-mono">
                                  {part.time ? new Date(part.time).toLocaleDateString("fa-IR") + " " + new Date(part.time).toLocaleTimeString("fa-IR") : ""}
                                </span>
                                <span className={cn(
                                  "font-black font-mono uppercase tracking-wider",
                                  part.action === "buy" ? "text-emerald-400" : "text-rose-400"
                                )}>
                                  {part.action === "buy" ? "LONG" : "SHORT"}
                                </span>
                              </div>
                            </div>
                            <div className={cn(
                              "w-10 h-10 rounded-lg flex items-center justify-center text-sm font-black font-mono",
                              part.action === "buy" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                            )}>
                              {part.symbol[0]}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-y-2 text-right md:flex-row-reverse w-full md:w-auto md:justify-end md:gap-x-8">
                            <div className="min-w-[80px]">
                              <span className="text-[10px] text-slate-500 block">ورود</span>
                              <span className="text-xs font-mono font-bold text-white">${formatPrice(part.price_in)}</span>
                            </div>
                            <div className="min-w-[80px]">
                              <span className="text-[10px] text-slate-500 block">قیمت خروج</span>
                              <span className="text-xs font-mono font-bold text-slate-200">${formatPrice(part.price_out)}</span>
                            </div>
                            <div className="min-w-[80px]">
                              <span className="text-[10px] text-slate-500 block">اندازه معامله</span>
                              <span className="text-xs font-mono font-bold text-slate-400">${part.value.toFixed(1)}</span>
                            </div>
                            <div className="min-w-[60px]">
                              <span className="text-[10px] text-slate-500 block">اهرم اصلی</span>
                              <span className="text-xs font-mono font-bold text-amber-500">{(part.order?.leverage) || 20}x</span>
                            </div>
                            <div className="min-w-[90px]">
                              <span className="text-[10px] text-slate-500 block">بازدهی معامله</span>
                              <span className={cn(
                                "text-xs font-mono font-bold block",
                                part.pnl_pct >= 0 ? "text-emerald-400" : "text-rose-400"
                              )}>
                                {part.pnl_pct >= 0 ? "+" : ""}{part.pnl_pct.toFixed(2)}%
                                <span className="text-[9px] text-slate-500 font-mono block mt-0.5">
                                  {part.pnl_usd >= 0 ? "+" : ""}${part.pnl_usd.toFixed(2)}
                                </span>
                              </span>
                            </div>
                          </div>

                          <div className="text-slate-500">
                            {isArchExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </div>
                        </div>

                        {/* Expand micro archived targets chart */}
                        <AnimatePresence>
                          {isArchExpanded && part.order && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="border-t border-[#2B3139] bg-black/30 p-4 space-y-4"
                            >
                              {part.type === "tp1_tp2_combined" && (
                                <div className="bg-indigo-500/5 border border-indigo-500/15 p-3 rounded-xl space-y-2 text-right">
                                  <span className="text-[10px] text-indigo-400 font-bold block mb-1">📊 گزارش تفکیکی مراحل معامله دو مرحله‌ای:</span>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-b border-indigo-500/10 pb-2.5">
                                    <div className="bg-black/20 p-2.5 rounded-lg border border-white/[0.02] text-right space-y-1">
                                      <span className="text-[9px] text-[#A5B4FC] font-black block">🟢 مرحله ۱ (فروش جزئی ۵۰٪ در تارگت ۱)</span>
                                      <div className="text-[11px] text-slate-300 space-y-0.5">
                                        <div>قیمت خروجی مرحله اول: <span className="font-mono text-white font-bold">${formatPrice(part.order.tp1_exit_price || part.order.take_profit_1)}</span></div>
                                        <div>سود واقعی مرحله اول: <span className="font-mono text-emerald-400 font-bold">+{part.order.tp1_pnl_pct?.toFixed(2)}% (+${part.order.tp1_pnl_usd?.toFixed(2)})</span></div>
                                      </div>
                                    </div>
                                    <div className="bg-black/20 p-2.5 rounded-lg border border-white/[0.02] text-right space-y-1">
                                      <span className="text-[9px] text-teal-400 font-black block">🔵 مرحله ۲ (تسویه ۵۰٪ باقیمانده معامله)</span>
                                      <div className="text-[11px] text-slate-300 space-y-0.5">
                                        <div>قیمت خروجی مرحله دوم: <span className="font-mono text-white font-bold">${formatPrice(part.order.exit_price)}</span></div>
                                        <div>بازدهی واقعی مرحله دوم: <span className={`font-mono font-bold ${part.order.tp2_pnl_pct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                          {part.order.tp2_pnl_pct >= 0 ? "+" : ""}{part.order.tp2_pnl_pct?.toFixed(2)}% ({part.order.tp2_pnl_usd >= 0 ? "+" : ""}${part.order.tp2_pnl_usd?.toFixed(2)})
                                        </span></div>
                                        <div>علت تسویه مرحله دوم: <span className="text-[#F0B90B] font-bold">{part.order.exit_reason || "شناسایی سود تارگت ۲"}</span></div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}

                              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <div className="bg-[#12161A] p-2.5 rounded-lg border border-[#2B3139] text-right">
                                  <span className="text-[9px] text-slate-500 block font-semibold">علت خروج</span>
                                  <span className="text-xs font-bold text-[#F0B90B]">{part.exitReason || "اجرا در حد سود"}</span>
                                </div>
                                <div className="bg-[#12161A] p-2.5 rounded-lg border border-[#2B3139] text-right">
                                  <span className="text-[9px] text-slate-500 block font-semibold">تارگت اول (TP1)</span>
                                  <span className="text-xs font-mono font-bold text-[#A5B4FC]">${formatPrice(part.order.take_profit_1)}</span>
                                </div>
                                <div className="bg-[#12161A] p-2.5 rounded-lg border border-[#2B3139] text-right">
                                  <span className="text-[9px] text-slate-500 block font-semibold">تارگت دوم (TP2)</span>
                                  <span className="text-xs font-mono font-bold text-[#0ECB81]">${formatPrice(part.order.take_profit_2)}</span>
                                </div>
                                <div className="bg-[#12161A] p-2.5 rounded-lg border border-[#2B3139] text-right">
                                  <span className="text-[9px] text-slate-500 block font-semibold">حد ضرر نهایی SL</span>
                                  <span className="text-xs font-mono font-bold text-red-400">${formatPrice(part.order.stop_loss)}</span>
                                </div>
                              </div>

                              <SignalChart 
                                symbol={part.order.symbol}
                                action={part.order.action}
                                entryPrice={part.order.entry_price}
                                stopLoss={part.order.stop_loss}
                                takeProfit1={part.order.take_profit_1}
                                takeProfit2={part.order.take_profit_2}
                                positionValue={part.order.position_value}
                                isLive={false}
                              />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 📊 POPUP LIVE CHART DIALOG MODAL BOX */}
      <AnimatePresence>
        {modalActiveOrder && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setModalActiveOrder(null)}
              className="absolute inset-0 bg-black/85 backdrop-blur-sm"
            />

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-2xl bg-[#181A20] border border-[#2B3139] rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] text-right"
            >
              {/* Modal Header */}
              <div className="p-4 border-b border-[#2B3139] flex items-center justify-between bg-black/15">
                <button 
                  onClick={() => setModalActiveOrder(null)}
                  className="p-1.5 hover:bg-white/5 rounded-lg text-slate-400 transition-colors cursor-pointer animate-none"
                >
                  <X size={18} />
                </button>

                <div className="flex items-center gap-2.5">
                  <span className={cn(
                    "text-[9px] font-black px-2.5 py-1 rounded tracking-wide font-mono",
                    modalActiveOrder.action === "buy" 
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/15" 
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/15"
                  )}>
                    {modalActiveOrder.action === "buy" ? "LONG / خرید" : "SHORT / فروش"}
                  </span>
                  
                  <span className="text-slate-400 font-sans text-[11px]">سناریوی اهداف چارت</span>
                  
                  <h3 className="text-sm font-black font-mono text-white text-left">
                    {modalActiveOrder.symbol}<span className="text-slate-500 text-xs font-normal">/USDT</span>
                  </h3>
                </div>
              </div>

              {/* Modal Body / Scroll content */}
              <div className="p-4 overflow-y-auto space-y-4 max-h-[75vh] custom-scrollbar">
                
                {/* Glowing borders for setups */}
                <div className="bg-[#181A20] border border-[#242731] rounded-xl p-1 shadow-2xl relative">
                  <div className={cn(
                    "absolute inset-x-0 top-0 h-[2px]",
                    modalActiveOrder.action === "buy" ? "bg-[#0ECB81]" : "bg-[#F6465D]"
                  )} />

                  <SignalChart 
                    symbol={modalActiveOrder.symbol}
                    action={modalActiveOrder.action}
                    entryPrice={modalActiveOrder.entry_price}
                    stopLoss={modalActiveOrder.stop_loss}
                    takeProfit1={modalActiveOrder.take_profit_1}
                    takeProfit2={modalActiveOrder.take_profit_2}
                    positionValue={modalActiveOrder.position_value}
                    isLive={modalActiveOrder.isLive}
                  />
                </div>

                {/* Pricing summary widget inside modal */}
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="bg-black/20 p-2.5 rounded border border-white/5 text-right">
                    <span className="text-[10px] text-slate-400 block mb-0.5">قیمت ورود اصلی</span>
                    <span className="font-mono font-bold text-slate-200">${formatPrice(modalActiveOrder.entry_price)}</span>
                  </div>
                  <div className="bg-black/20 p-2.5 rounded border border-white/5 text-right">
                    <span className="text-[10px] text-slate-400 block mb-0.5 font-bold text-emerald-400">حد سود نهایی</span>
                    <span className="font-mono font-bold text-emerald-400">${formatPrice(modalActiveOrder.take_profit_2)}</span>
                  </div>
                  <div className="bg-black/20 p-2.5 rounded border border-white/5 text-right">
                    <span className="text-[10px] text-slate-400 block mb-0.5 font-bold text-rose-400">حد ضرر قطعی SL</span>
                    <span className="font-mono font-bold text-rose-400">${formatPrice(modalActiveOrder.stop_loss)}</span>
                  </div>
                </div>

              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ⚠️ CUSTOM CONFIRMATION DIALOG FOR SIMULATED TRADES RESET */}
      <AnimatePresence>
        {showResetConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md" dir="rtl">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#12161C] border border-rose-500/35 rounded-2xl w-full max-w-md overflow-hidden shadow-[0_0_50px_rgba(244,63,94,0.15)] p-6 space-y-6 text-right"
            >
              <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                <div className="w-10 h-10 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-400">
                  <AlertTriangle size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-white py-0.5">تأیید ریست کل معاملات</h3>
                  <p className="text-[10px] text-slate-400">اقدام حساس شبیه‌ساز</p>
                </div>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                آیا مطمئن هستید که می‌خواهید تمامی <span className="text-rose-400 font-bold">معاملات تستی فعال</span>، آرشیو سود/ضرر شبیه‌سازی و تاریخچه مالی را به طور کامل پاک کنید؟ این عمل غیرقابل بازگشت است و پیام ریست به کانال تلگرام ارسال خواهد شد.
              </p>
              <div className="flex gap-3 justify-end pt-2">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="px-4 py-2 bg-[#2B3139] hover:bg-[#3E454F] text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  onClick={executeResetSimulatedTrades}
                  className="px-4 py-2 bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white rounded-xl text-xs font-black transition-all shadow-[0_0_15px_rgba(244,63,94,0.3)] cursor-pointer"
                >
                  تأیید و پاکسازی کامل
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ⚠️ CUSTOM CONFIRMATION DIALOG FOR CLOSING ACTIVE ORDER */}
      <AnimatePresence>
        {showCloseConfirmOrder && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md" dir="rtl">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#12161C] border border-rose-500/35 rounded-2xl w-full max-w-md overflow-hidden shadow-[0_0_50px_rgba(244,63,94,0.15)] p-6 space-y-6 text-right"
            >
              <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                <div className="w-10 h-10 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-400">
                  <AlertCircle size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-white py-0.5">تأیید بستن فوری پوزیشن</h3>
                  <p className="text-[10px] text-slate-400">{showCloseConfirmOrder.symbol}/USDT</p>
                </div>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed flex flex-col gap-1">
                <span>آیا مطمئن هستید که می‌خواهید پوزیشن لایو <span className="text-[#F0B90B] font-mono font-black">{showCloseConfirmOrder.symbol}</span> فوراً بسته شود؟</span>
                <span className="text-[10px] text-slate-400">قیمت ورود: ${formatPrice(showCloseConfirmOrder.entry_price)}</span>
              </p>
              <div className="flex gap-3 justify-end pt-2">
                <button
                  onClick={() => setShowCloseConfirmOrder(null)}
                  className="px-4 py-2 bg-[#2B3139] hover:bg-[#3E454F] text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  onClick={async () => {
                    const orderToClose = showCloseConfirmOrder;
                    setShowCloseConfirmOrder(null);
                    await handleCloseActiveOrder(orderToClose.id, orderToClose.symbol);
                  }}
                  className="px-4 py-2 bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white rounded-xl text-xs font-black transition-all shadow-[0_0_15px_rgba(244,63,94,0.3)] cursor-pointer"
                >
                  بستن فوری پوزیشن
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ⚠️ CUSTOM CONFIRMATION DIALOG FOR CLOSING API POSITION */}
      <AnimatePresence>
        {showCloseApiConfirmOrder && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md" dir="rtl">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#12161C] border border-rose-500/35 rounded-2xl w-full max-w-md overflow-hidden shadow-[0_0_50px_rgba(244,63,94,0.15)] p-6 space-y-6 text-right"
            >
              <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                <div className="w-10 h-10 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-450 font-black">
                  <AlertCircle size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-white py-0.5">درخواست انسداد و بستن اضطراری</h3>
                  <p className="text-[10px] text-slate-400">{showCloseApiConfirmOrder.symbol}</p>
                </div>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                آیا درخواست بستن فوری و لغو کلیه سفارش‌های مربوط به معامله <span className="text-[#F0B90B] font-mono font-black">{showCloseApiConfirmOrder.symbol}</span> را در موتور هسته اصلی سیستم دارید؟
              </p>
              <div className="flex gap-3 justify-end pt-2">
                <button
                  onClick={() => setShowCloseApiConfirmOrder(null)}
                  className="px-4 py-2 bg-[#2B3139] hover:bg-[#3E454F] text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  onClick={async () => {
                    const orderToClose = showCloseApiConfirmOrder;
                    setShowCloseApiConfirmOrder(null);
                    await fetch(`/api/bot/close-order`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ orderId: orderToClose.id }),
                    });
                    await fetchStatus();
                  }}
                  className="px-4 py-2 bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white rounded-xl text-xs font-black transition-all shadow-[0_0_15px_rgba(244,63,94,0.3)] cursor-pointer"
                >
                  تأیید بستن و لغو همزمان
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ✨ CUSTOM SUCCESS NOTIFICATION DIALOG */}
      <AnimatePresence>
        {customNotify && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm" dir="rtl">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#12161C] border border-emerald-500/30 rounded-2xl w-full max-w-sm overflow-hidden shadow-[0_0_40px_rgba(16,185,129,0.15)] p-6 space-y-4 text-center"
            >
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-400 mx-auto">
                <CheckCircle2 size={24} />
              </div>
              <h3 className="text-sm font-black text-white">عملیات با موفقیت انجام شد</h3>
              <p className="text-xs text-slate-300 leading-normal">{customNotify}</p>
              <button
                onClick={() => setCustomNotify(null)}
                className="w-full py-2 bg-gradient-to-r from-emerald-500 to-teal-500 text-black font-black text-xs rounded-xl shadow-[0_0_15px_rgba(16,185,129,0.2)] transition-all cursor-pointer"
              >
                تأیید و بازگشت
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* FOOTER COGNITIVE COPYRIGHT FRAME */}
      <footer className="mt-16 border-t border-[#1E2329] pt-8 text-center text-slate-600 font-mono text-[9px] tracking-[0.45em] select-none uppercase">
        ASHIR TERMINAL v4.5 ELITE © POWERED BY DYNAMIC GARCH METRICS & WEB API CORRESPONDENCE
      </footer>

    </div>
  );
}
