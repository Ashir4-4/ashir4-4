export interface SubSignals {
  orderflow?: { score: number; signal: string };
  vol_regime?: { score: number; reason: string };
  liquidity?: { score: number; reason: string };
  funding?: { score: number; reason: string };
  correlation?: { score: number; reason: string };
  time_sniper?: { score: number; reason: string };
  iceberg?: { score: number; message: string };
  pain_point?: { score: number; message: string };
  divergence?: { score: number; message: string };
}

export interface IcebergData {
  iceberg_detected: boolean;
  direction: string;
  strength: number;
  message: string;
}

export interface PainPointData {
  active: boolean;
  type: string;
  price: number;
  distance_pct: number;
  reason: string;
}

export interface DivergenceData {
  divergence: boolean;
  type: string;
  strength: number;
  message: string;
}

export interface Position {
  id: string;
  symbol: string;
  action: "buy" | "sell" | "stay_out";
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  position_value: number;
  score: number;
  confidence: number;
  daily_vol: number;
  regime: string;
  vol_surge: boolean;
  vol_surge_msg: string;
  imbalance: number;
  iceberg?: IcebergData;
  pain_point?: PainPointData;
  divergence?: DivergenceData;
  ml_weights?: Record<string, number>;
  dynamic_threshold?: number;
  sub_signals?: SubSignals;
  created_at: number;
  status?: "filled" | "closed" | string;
  mode?: "simulation" | "real";
  current_price?: number;
  pnl_pct?: number;
  pnl_usd?: number;
  tp1_hit?: boolean;
  leverage?: number;
  exit_price?: number;
  closed_at?: number;
  exit_reason?: string;
  initial_position_value?: number;
  initial_quantity?: number;
  tp1_pnl_usd?: number;
  tp1_pnl_pct?: number;
  tp1_exit_price?: number;
  tp2_pnl_usd?: number;
  tp2_pnl_pct?: number;
}

export interface AppStatus {
  isRunning: boolean;
  count: number;
  btcChange: number;
  orders: any[]; // Use any[] or custom extended position for flex
  closedOrders: any[];
  lastScanTime: number | null;
  nextScanTime: number | null;
  scanInterval: number;
  currentProgress: string;
  lastError: string | null;
  logs: string[];
  apiKey?: string;
  hasSecret?: boolean;
  tradingMode?: "simulation" | "real";
  realBalance?: number;
  demoBalance?: number;
  demoTotalEquity?: number;
  demoFreeBalance?: number;
  sensitivity?: "conservative" | "balanced" | "active" | "auto_cortex";
  disable9Layers?: boolean;
  rejectedSignals?: { symbol: string; action: string; score: number; threshold: number; reason: string; time: number }[];
  consecutiveLosses?: number;
  adaptiveSensitivityOverride?: "conservative" | "balanced" | "active" | null;
  leverageMultiplier?: number;
  riskReductionMap?: Record<string, { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }>;
  diagnosticLogs?: { id: string; time: number; symbol: string; type: string; title: string; message: string; actionTaken: string }[];
  strategy?: string;
  // 📊 Real (measured) performance metrics for the header tickertape — never hardcoded.
  lastScanDurationMs?: number | null;
  lastScanAssetCount?: number;
  lastScanAssetsPerSec?: number | null;
  // 🧾 Single source of truth for closed-trade performance stats (win rate, ROI,
  // profit factor, best/worst trade). Computed once on the backend and shared
  // with the Telegram bot, so the dashboard and Telegram can never disagree.
  ledgerStats?: {
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
  };
  baseCapital?: number;
  // ⏰ Hourly Performance Guard: 24/7 vs. smart golden-hours mode, plus the
  // hour-by-hour performance breakdown used to compute it (mirrors Telegram).
  tradingHoursMode?: "24_7" | "smart";
  hourlyBuckets?: {
    hour: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    netUsd: number;
    avgPnlUsd: number;
  }[];
  bestHours?: {
    computedAt: number;
    sufficientData: boolean;
    minTotalTradesRequired: number;
    minTradesPerHour: number;
    totalTrades: number;
    bestHours: number[];
    reason: string;
  } | null;
  // 📅 Daily / weekly stats — same numbers shown by the Telegram "آمار امروز" /
  // "آمار ۷ روز اخیر" buttons, mirrored here for the web dashboard.
  todayStats?: {
    date: string;
    trades: number;
    wins: number;
    losses: number;
    profitUsd: number;
    lossUsd: number;
    profitPct: number;
    lossPct: number;
  } | null;
  weeklyStats?: {
    date: string;
    trades: number;
    wins: number;
    losses: number;
    profitUsd: number;
    lossUsd: number;
    profitPct: number;
    lossPct: number;
  }[];
}
