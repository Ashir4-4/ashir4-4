import { useEffect, useState, useCallback } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Lock,
  User,
  ShieldCheck,
  LogOut,
  Check,
  X,
  Ban,
  RotateCcw,
  KeyRound,
  UserPlus,
  Search,
  Loader2,
  Crown,
  CalendarClock,
  Hourglass,
  AlertCircle,
} from "lucide-react";
import type { LicenseUser, LicenseSummary, SubscriptionType, AccountStatus } from "../lib/ashir/licenseTypes";

// ─────────────────────────────────────────────────────────────────
// 🔐 پنل وب مدیریت اشتراک‌ها — همتای وبِ پنل شیشه‌ای تلگرام.
// همان هویت بصری داشبورد اصلی (زمینه‌ی تیره + طلایی #F0B90B) را حفظ
// می‌کند تا هر دو صفحه بخشی از یک محصول واحد به‌نظر برسند.
// ─────────────────────────────────────────────────────────────────

export const TOKEN_KEY = "ashir_web_token";
export const ROLE_KEY = "ashir_web_role";

export type Role = "admin" | "user";

const PKG_LABEL: Record<SubscriptionType, string> = {
  trial: "🎁 تست",
  monthly: "📅 ماهانه",
  lifetime: "💎 مادام‌العمر",
  admin: "👑 ادمین",
};
const STATUS_LABEL: Record<AccountStatus, string> = {
  not_registered: "ثبت‌نشده",
  pending: "در انتظار تایید",
  active: "فعال",
  expired: "منقضی",
  rejected: "رد شده",
  banned: "مسدود",
};
const STATUS_COLOR: Record<AccountStatus, string> = {
  not_registered: "text-slate-500 bg-slate-500/10 border-slate-500/30",
  pending: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  active: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  expired: "text-red-400 bg-red-400/10 border-red-400/30",
  rejected: "text-red-400 bg-red-400/10 border-red-400/30",
  banned: "text-red-500 bg-red-500/10 border-red-500/30",
};

async function api(path: string, opts: RequestInit = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ success: false, error: "پاسخ نامعتبر از سرور" }));
  if (!res.ok || !data.success) throw new Error(data.error || "خطای ناشناخته");
  return data;
}

// ─── 🔘 دکمه‌ی عمومی سبک برند ─────────────────────────────────────
function GoldButton({ children, onClick, disabled, variant = "solid", className = "" }: any) {
  const base = "px-3.5 h-9 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const styles =
    variant === "solid"
      ? "bg-gradient-to-b from-[#F0B90B] to-[#b38905] text-black shadow-[0_0_12px_rgba(240,185,11,0.2)] hover:brightness-110"
      : variant === "danger"
      ? "border border-red-500/40 text-red-400 hover:bg-red-500/10"
      : "border border-[#2B3139] bg-[#1C2028] text-slate-300 hover:border-slate-500";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

function Panel({ children, className = "" }: any) {
  return <div className={`bg-[#181A20] border border-[#242731] rounded-xl ${className}`}>{children}</div>;
}

// ─── 👋 صفحه‌ی ورود ────────────────────────────────────────────────
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (role: Role) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ROLE_KEY, data.role);
      onLoggedIn(data.role);
    } catch (err: any) {
      setError(err.message || "ورود ناموفق بود.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0C0D10] flex items-center justify-center relative overflow-hidden px-4" dir="rtl">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#F0B90B]/5 blur-[200px] rounded-full pointer-events-none" />
      <Panel className="relative w-full max-w-sm p-7 shadow-2xl">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#F0B90B] to-[#b38905] flex items-center justify-center shadow-[0_0_25px_rgba(240,185,11,0.25)] mb-3">
            <ShieldCheck className="w-7 h-7 text-black" strokeWidth={2.5} />
          </div>
          <h1 className="text-lg font-black text-[#EAECEF] font-display tracking-wide">ورود به پنل اشتراک</h1>
          <p className="text-xs text-slate-500 mt-1">با نام کاربری و رمزی که ادمین در اختیارتان گذاشته وارد شوید</p>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="relative">
            <User className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="نام کاربری"
              autoComplete="username"
              className="w-full h-11 bg-[#0C0D10] border border-[#2B3139] rounded-lg pr-9 pl-3 text-sm text-[#EAECEF] focus:border-[#F0B90B]/60 focus:outline-none transition-colors"
            />
          </div>
          <div className="relative">
            <Lock className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="رمز عبور"
              autoComplete="current-password"
              className="w-full h-11 bg-[#0C0D10] border border-[#2B3139] rounded-lg pr-9 pl-3 text-sm text-[#EAECEF] focus:border-[#F0B90B]/60 focus:outline-none transition-colors"
            />
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full h-11 rounded-lg bg-gradient-to-b from-[#F0B90B] to-[#b38905] text-black font-black text-sm shadow-[0_0_15px_rgba(240,185,11,0.2)] hover:brightness-110 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "ورود"}
          </button>
        </form>
      </Panel>
    </div>
  );
}

// ─── 📊 کارت اطلاعات یک اشتراک (مشترک بین پنل کاربر و ردیف‌های ادمین) ──
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#242731] last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm text-[#EAECEF] font-mono">{value}</span>
    </div>
  );
}

// ─── 👤 داشبورد کاربر عادی ──────────────────────────────────────────
export function UserDashboard({ onLogout }: { onLogout: () => void }) {
  const [summary, setSummary] = useState<LicenseSummary | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    api("/api/me")
      .then((d) => setSummary(d.summary))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="min-h-screen bg-[#0C0D10] text-[#EAECEF] font-sans px-4 py-8" dir="rtl">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-base font-black font-display">👤 حساب کاربری</h1>
          <button onClick={onLogout} className="text-xs text-slate-500 hover:text-red-400 flex items-center gap-1 transition-colors">
            <LogOut className="w-3.5 h-3.5" /> خروج
          </button>
        </div>

        {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">{error}</div>}

        {summary && (
          <Panel className="p-5 mb-4">
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${STATUS_COLOR[summary.user.status]}`}
              >
                {STATUS_LABEL[summary.user.status]}
              </div>
              {summary.isActive && (
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Hourglass className="w-3 h-3" /> {summary.remainingLabel}
                </div>
              )}
            </div>

            <SummaryRow label="شناسه تلگرام" value={summary.user.telegramId} />
            <SummaryRow label="نام کاربری تلگرام" value={summary.user.username ? "@" + summary.user.username : "—"} />
            <SummaryRow
              label="نوع اکانت"
              value={summary.user.subscriptionType ? PKG_LABEL[summary.user.subscriptionType] : "—"}
            />
            {summary.user.startDate && (
              <SummaryRow label="تاریخ شروع" value={new Date(summary.user.startDate).toLocaleDateString("fa-IR")} />
            )}
            {summary.isLifetime ? (
              <SummaryRow label="تاریخ انقضا" value="ندارد ♾️" />
            ) : summary.user.expireDate ? (
              <SummaryRow label="تاریخ انقضا" value={new Date(summary.user.expireDate).toLocaleDateString("fa-IR")} />
            ) : null}
          </Panel>
        )}

        {summary?.isActive ? (
          <ExchangeConnectionCard user={summary.user} onChanged={reload} />
        ) : (
          summary && (
            <div className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-lg p-3 text-center">
              اتصال به صرافی فقط برای کاربران با اشتراک فعال در دسترس است.
            </div>
          )
        )}

        <p className="text-[11px] text-slate-600 mt-4 text-center">
          برای فعال‌سازی یا تمدید اشتراک، به ربات تلگرام مراجعه کنید.
        </p>
      </div>
    </div>
  );
}

// ─── 💱 کارت اتصال شخصی کاربر به صرافی XT برای معامله‌ی خودکار واقعی ──
function ExchangeConnectionCard({ user, onChanged }: { user: LicenseUser; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const connected = !!user.exchangeConnected;
  const autoTrade = !!user.exchangeAutoTrade;
  const positions = user.exchangePositions ? Object.values(user.exchangePositions) : [];

  const connect = async () => {
    setError("");
    if (!confirmed) {
      setError("لطفاً ابتدا تأیید کنید که ریسک معامله‌ی واقعی را می‌پذیرید.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/me/exchange/connect", { method: "POST", body: JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }) });
      setApiKey("");
      setApiSecret("");
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api("/api/me/exchange/disconnect", { method: "POST" });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoTrade = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/me/exchange/autotrade", { method: "POST", body: JSON.stringify({ enabled: !autoTrade }) });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold text-[#EAECEF]">💱 اتصال به صرافی XT</span>
        {connected && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border text-emerald-400 bg-emerald-400/10 border-emerald-400/30">
            متصل
          </span>
        )}
      </div>

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 mb-3">{error}</div>}

      {!connected ? (
        <div className="space-y-3">
          <div className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-lg p-3 leading-6">
            ⚠️ این بخش با <b>پول واقعی</b> شما معامله می‌کند. کلید API را با دسترسی «فقط معامله» بسازید و
            هرگز دسترسی برداشت (Withdraw) را فعال نکنید.
          </div>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="XT API Key"
            className="w-full h-10 bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B]/50 focus:outline-none"
          />
          <input
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            type="password"
            placeholder="XT API Secret"
            className="w-full h-10 bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B]/50 focus:outline-none"
          />
          <label className="flex items-start gap-2 text-[11px] text-slate-400 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>می‌دانم این اتصال با حساب واقعی صرافی من معامله می‌کند و مسئولیت آن با من است.</span>
          </label>
          <GoldButton className="w-full justify-center h-10" disabled={busy || !apiKey || !apiSecret} onClick={connect}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "اتصال به صرافی"}
          </GoldButton>
        </div>
      ) : (
        <div className="space-y-3">
          <SummaryRow label="کلید متصل" value={user.xtApiKeyMasked || "••••"} />

          <div className="flex items-center justify-between bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 py-2.5">
            <div>
              <div className="text-xs text-[#EAECEF] font-bold">معامله‌ی خودکار</div>
              <div className="text-[10px] text-slate-500">
                {autoTrade ? "روشن — سیگنال‌های اصلی روی حساب شما اجرا می‌شوند" : "خاموش — فقط متصل، معامله‌ای انجام نمی‌شود"}
              </div>
            </div>
            <button
              onClick={toggleAutoTrade}
              disabled={busy}
              className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${autoTrade ? "bg-emerald-500" : "bg-[#2B3139]"}`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${autoTrade ? "translate-x-[-22px]" : "translate-x-[-2px]"}`}
              />
            </button>
          </div>

          {user.exchangeLastError && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
              آخرین خطا: {user.exchangeLastError}
            </div>
          )}

          {positions.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1.5">موقعیت‌های باز شما</div>
              <div className="space-y-1.5">
                {positions.map((p) => (
                  <div key={p.symbol} className="flex items-center justify-between bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 py-2 text-xs">
                    <span className="text-[#EAECEF] font-mono">{p.symbol}/USDT</span>
                    <span className="text-slate-400 font-mono">
                      {p.quantity} @ ${p.entryPrice}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <GoldButton variant="danger" className="w-full justify-center h-9" disabled={busy} onClick={disconnect}>
            قطع اتصال از صرافی
          </GoldButton>
        </div>
      )}
    </Panel>
  );
}

// ─── 🧩 مودال ساده ──────────────────────────────────────────────────
function Modal({ title, onClose, children }: any) {
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm">
        <Panel className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-[#EAECEF]">{title}</h3>
            <button onClick={onClose} className="text-slate-500 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          {children}
        </Panel>
      </div>
    </div>
  );
}

function PackagePicker({ onPick }: { onPick: (t: SubscriptionType) => void }) {
  return (
    <div className="space-y-2">
      {(Object.keys(PKG_LABEL) as SubscriptionType[]).map((t) => (
        <button
          key={t}
          onClick={() => onPick(t)}
          className="w-full text-right px-3.5 h-10 rounded-lg border border-[#2B3139] bg-[#1C2028] hover:border-[#F0B90B]/50 text-sm text-[#EAECEF] transition-colors"
        >
          {PKG_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

// ─── 🛠 داشبورد ادمین ───────────────────────────────────────────────
export function AdminDashboard({ onLogout, onOpenTradingDashboard }: { onLogout: () => void; onOpenTradingDashboard?: () => void }) {
  const [users, setUsers] = useState<LicenseUser[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { kind: "approve" | "renew" | "credentials" | "adduser"; telegramId?: string }>(null);
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [addId, setAddId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api("/api/admin/users");
      setUsers(d.users);
      setStats(d.stats);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (telegramId: string, action: () => Promise<any>) => {
    setBusyId(telegramId);
    setError("");
    try {
      await action();
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
      setModal(null);
    }
  };

  const filtered = users.filter((u) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return u.telegramId.includes(q) || (u.username || "").toLowerCase().includes(q);
  });

  return (
    <div className="min-h-screen bg-[#0C0D10] text-[#EAECEF] font-sans px-4 py-6" dir="rtl">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-base font-black font-display flex items-center gap-2">
            <ShieldCheck className="w-4.5 h-4.5 text-[#F0B90B]" /> پنل مدیریت اشتراک‌ها
          </h1>
          <div className="flex items-center gap-2">
            {onOpenTradingDashboard && (
              <button
                onClick={onOpenTradingDashboard}
                className="text-xs text-slate-500 hover:text-[#F0B90B] flex items-center gap-1 transition-colors"
              >
                ← بازگشت به ترمینال معاملاتی
              </button>
            )}
            <GoldButton onClick={() => setModal({ kind: "adduser" })}>
              <UserPlus className="w-3.5 h-3.5" /> افزودن کاربر
            </GoldButton>
            <button onClick={onLogout} className="text-xs text-slate-500 hover:text-red-400 flex items-center gap-1 transition-colors">
              <LogOut className="w-3.5 h-3.5" /> خروج
            </button>
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-5">
            {[
              ["کل کاربران", stats.totalUsers, "text-[#EAECEF]"],
              ["فعال", stats.active, "text-emerald-400"],
              ["منقضی", stats.expired, "text-red-400"],
              ["در انتظار", stats.pending, "text-amber-400"],
              ["مسدود", stats.banned, "text-red-500"],
            ].map(([label, value, color]: any) => (
              <Panel key={label} className="p-3 text-center">
                <div className={`text-lg font-black font-mono ${color}`}>{value}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
              </Panel>
            ))}
          </div>
        )}

        {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">{error}</div>}

        <div className="relative mb-3">
          <Search className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="جست‌وجو بر اساس آیدی تلگرام یا نام کاربری..."
            className="w-full h-10 bg-[#181A20] border border-[#2B3139] rounded-lg pr-9 pl-3 text-xs text-[#EAECEF] focus:border-[#F0B90B]/50 focus:outline-none"
          />
        </div>

        <Panel className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#242731] text-slate-500">
                <th className="text-right p-3 font-medium">کاربر</th>
                <th className="text-right p-3 font-medium">پکیج</th>
                <th className="text-right p-3 font-medium">وضعیت</th>
                <th className="text-right p-3 font-medium">انقضا</th>
                <th className="text-right p-3 font-medium">اقدامات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.telegramId} className="border-b border-[#242731] last:border-0 hover:bg-white/[0.02]">
                  <td className="p-3">
                    <div className="font-mono text-[#EAECEF]">{u.telegramId}</div>
                    <div className="text-slate-500">{u.username ? "@" + u.username : "—"}</div>
                  </td>
                  <td className="p-3">
                    {u.subscriptionType ? PKG_LABEL[u.subscriptionType] : "—"}
                    {u.exchangeConnected && (
                      <div className={`mt-1 text-[10px] font-bold ${u.exchangeAutoTrade ? "text-emerald-400" : "text-slate-500"}`}>
                        💱 {u.exchangeAutoTrade ? "معامله فعال" : "متصل (خاموش)"}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_COLOR[u.status]}`}>
                      {STATUS_LABEL[u.status]}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-slate-400">
                    {u.subscriptionType === "lifetime" || u.subscriptionType === "admin"
                      ? "♾️"
                      : u.expireDate
                      ? new Date(u.expireDate).toLocaleDateString("fa-IR")
                      : "—"}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {busyId === u.telegramId ? (
                        <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
                      ) : (
                        <>
                          {u.status === "pending" && (
                            <>
                              <button
                                title="تایید"
                                onClick={() => setModal({ kind: "approve", telegramId: u.telegramId })}
                                className="w-7 h-7 rounded-md border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 flex items-center justify-center"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                title="رد"
                                onClick={() => run(u.telegramId, () => api(`/api/admin/users/${u.telegramId}/reject`, { method: "POST" }))}
                                className="w-7 h-7 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 flex items-center justify-center"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          {u.status === "banned" ? (
                            <button
                              title="رفع بن"
                              onClick={() => run(u.telegramId, () => api(`/api/admin/users/${u.telegramId}/unban`, { method: "POST" }))}
                              className="w-7 h-7 rounded-md border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 flex items-center justify-center"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              title="بن کردن"
                              onClick={() => run(u.telegramId, () => api(`/api/admin/users/${u.telegramId}/ban`, { method: "POST" }))}
                              className="w-7 h-7 rounded-md border border-[#2B3139] text-slate-400 hover:border-red-500/40 hover:text-red-400 flex items-center justify-center"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            title="تمدید"
                            onClick={() => setModal({ kind: "renew", telegramId: u.telegramId })}
                            className="w-7 h-7 rounded-md border border-[#2B3139] text-slate-400 hover:border-[#F0B90B]/50 hover:text-[#F0B90B] flex items-center justify-center"
                          >
                            <Crown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="تنظیم رمز ورود پنل"
                            onClick={() => {
                              setCredUsername(u.webUsername || "");
                              setCredPassword("");
                              setModal({ kind: "credentials", telegramId: u.telegramId });
                            }}
                            className="w-7 h-7 rounded-md border border-[#2B3139] text-slate-400 hover:border-slate-400 hover:text-white flex items-center justify-center"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    کاربری یافت نشد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      {modal?.kind === "approve" && (
        <Modal title="تایید و انتخاب پکیج" onClose={() => setModal(null)}>
          <PackagePicker
            onPick={(t) =>
              run(modal.telegramId!, () =>
                api(`/api/admin/users/${modal.telegramId}/approve`, { method: "POST", body: JSON.stringify({ packageType: t }) })
              )
            }
          />
        </Modal>
      )}

      {modal?.kind === "renew" && (
        <Modal title="تمدید با پکیج جدید" onClose={() => setModal(null)}>
          <PackagePicker
            onPick={(t) =>
              run(modal.telegramId!, () =>
                api(`/api/admin/users/${modal.telegramId}/renew`, { method: "POST", body: JSON.stringify({ packageType: t }) })
              )
            }
          />
        </Modal>
      )}

      {modal?.kind === "credentials" && (
        <Modal title="تنظیم ورود پنل وب برای این کاربر" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <input
              value={credUsername}
              onChange={(e) => setCredUsername(e.target.value)}
              placeholder="نام کاربری (انگلیسی)"
              className="w-full h-10 bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 text-sm text-[#EAECEF] focus:border-[#F0B90B]/50 focus:outline-none"
            />
            <input
              value={credPassword}
              onChange={(e) => setCredPassword(e.target.value)}
              placeholder="رمز عبور (حداقل ۶ کاراکتر)"
              className="w-full h-10 bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 text-sm text-[#EAECEF] focus:border-[#F0B90B]/50 focus:outline-none"
            />
            <GoldButton
              className="w-full justify-center h-10"
              disabled={!credUsername || credPassword.length < 6}
              onClick={() =>
                run(modal.telegramId!, () =>
                  api(`/api/admin/users/${modal.telegramId}/credentials`, {
                    method: "POST",
                    body: JSON.stringify({ username: credUsername, password: credPassword }),
                  })
                )
              }
            >
              ذخیره
            </GoldButton>
          </div>
        </Modal>
      )}

      {modal?.kind === "adduser" && (
        <Modal title="افزودن کاربر دستی" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <input
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
              placeholder="آیدی عددی تلگرام"
              className="w-full h-10 bg-[#0C0D10] border border-[#2B3139] rounded-lg px-3 text-sm text-[#EAECEF] font-mono focus:border-[#F0B90B]/50 focus:outline-none"
            />
            <PackagePicker
              onPick={(t) =>
                run(addId, () => api(`/api/admin/users/manual-add`, { method: "POST", body: JSON.stringify({ telegramId: addId, packageType: t }) }))
              }
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
