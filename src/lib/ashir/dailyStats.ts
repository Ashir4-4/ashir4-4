/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daily Stats Ledger
 * ==================
 * آمار روزانه‌ی معاملات (تعداد، برد/باخت، سود/ضرر دلاری و درصدی) را به تفکیک
 * هر روز (به وقت تهران) نگه می‌دارد و روی دیسک ذخیره می‌کند تا با ری‌استارت
 * سرور از بین نرود و بشود آمار روزهای قبل را هم مرور کرد.
 *
 * این فایل دقیقاً از همان الگوی ذخیره‌سازی state پروژه (JSON روی دیسک)
 * استفاده می‌کند تا وابستگی جدیدی (دیتابیس SQL) به پروژه اضافه نشود.
 */
import fs from "fs/promises";
import path from "path";

export interface DailyStatEntry {
  date: string; // YYYY-MM-DD (Asia/Tehran)
  trades: number;
  wins: number;
  losses: number;
  profitUsd: number;   // مجموع سودهای دلاری (فقط بخش مثبت)
  lossUsd: number;      // مجموع ضررهای دلاری (مقدار مثبت ذخیره می‌شود)
  profitPct: number;    // مجموع درصد سود (نسبت به سرمایه پایه، فقط بخش مثبت)
  lossPct: number;      // مجموع درصد ضرر (نسبت به سرمایه پایه، مقدار مثبت)
}

const STATS_FILE = path.join(process.cwd(), "daily_stats.json");

let cache: Record<string, DailyStatEntry> = {};
let loaded = false;
let loadingPromise: Promise<void> | null = null;

function todayKey(): string {
  // en-CA locale formats as YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tehran" });
}

function emptyEntry(date: string): DailyStatEntry {
  return { date, trades: 0, wins: 0, losses: 0, profitUsd: 0, lossUsd: 0, profitPct: 0, lossPct: 0 };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const raw = await fs.readFile(STATS_FILE, "utf-8");
        cache = JSON.parse(raw);
      } catch {
        cache = {};
      }
      loaded = true;
    })();
  }
  await loadingPromise;
}

async function persist(): Promise<void> {
  try {
    // فقط ۹۰ روز اخیر نگه‌داشته می‌شود تا فایل بی‌نهایت رشد نکند
    const keys = Object.keys(cache).sort().reverse();
    if (keys.length > 90) {
      const toDrop = keys.slice(90);
      for (const k of toDrop) delete cache[k];
    }
    await fs.writeFile(STATS_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("[dailyStats] persist error:", e);
  }
}

/** ثبت نتیجه‌ی نهایی یک معامله کامل (برد/باخت) — فقط یک بار به ازای هر معامله. */
export async function recordDailyTradeResult(isWin: boolean): Promise<void> {
  await ensureLoaded();
  const key = todayKey();
  if (!cache[key]) cache[key] = emptyEntry(key);
  cache[key].trades += 1;
  if (isWin) cache[key].wins += 1;
  else cache[key].losses += 1;
  await persist();
}

/**
 * ثبت مقدار سود/ضرر دلاری و درصدی محقق‌شده (چه از بستن کامل، چه از تارگت
 * جزئی TP1) — می‌تواند چند بار برای یک معامله فراخوانی شود، چون هر بار فقط
 * مقدار محقق‌شده‌ی همان مرحله را اضافه می‌کند (بدون شمارش مضاعف).
 */
export async function recordDailyPnl(pnlUsd: number, pnlPctOfCapital: number): Promise<void> {
  await ensureLoaded();
  const key = todayKey();
  if (!cache[key]) cache[key] = emptyEntry(key);
  if (pnlUsd >= 0) {
    cache[key].profitUsd += pnlUsd;
    cache[key].profitPct += Math.max(0, pnlPctOfCapital);
  } else {
    cache[key].lossUsd += Math.abs(pnlUsd);
    cache[key].lossPct += Math.abs(Math.min(0, pnlPctOfCapital));
  }
  await persist();
}

export async function getDailyStats(date?: string): Promise<DailyStatEntry> {
  await ensureLoaded();
  const key = date || todayKey();
  return cache[key] || emptyEntry(key);
}

/** لیست آمار n روز اخیر (شامل امروز)، از جدید به قدیم. */
export async function getRecentDailyStats(days = 7): Promise<DailyStatEntry[]> {
  await ensureLoaded();
  const out: DailyStatEntry[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toLocaleDateString("en-CA", { timeZone: "Asia/Tehran" });
    out.push(cache[key] || emptyEntry(key));
  }
  return out;
}

export function formatDailyStatsMessage(entry: DailyStatEntry, title = "📊 آمار امروز"): string {
  const net = entry.profitUsd - entry.lossUsd;
  const netPct = entry.profitPct - entry.lossPct;
  const winRate = entry.trades > 0 ? (entry.wins / entry.trades) * 100 : 0;
  const netEmoji = net >= 0 ? "🟢" : "🔴";
  const dateLabel = new Date(entry.date + "T12:00:00").toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran", year: "numeric", month: "long", day: "numeric" });

  return `
${title} — <b>${dateLabel}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔢 <b>تعداد معاملات:</b> <code>${entry.trades}</code>
🟢 <b>برد:</b> <code>${entry.wins}</code>   🔴 <b>باخت:</b> <code>${entry.losses}</code>   🎯 <b>وین‌ریت:</b> <code>${winRate.toFixed(1)}٪</code>

💰 <b>سود ناخالص:</b> <code>+$${entry.profitUsd.toFixed(2)}</code> (<code>+${entry.profitPct.toFixed(2)}٪</code>)
💸 <b>ضرر ناخالص:</b> <code>-$${entry.lossUsd.toFixed(2)}</code> (<code>-${entry.lossPct.toFixed(2)}٪</code>)

${netEmoji} <b>خالص روز:</b> <code>${net >= 0 ? "+" : ""}$${net.toFixed(2)}</code> (<code>${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}٪</code>)
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه آمار اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })}`.trim();
}
