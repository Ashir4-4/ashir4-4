/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hourly Performance Ledger
 * =========================
 * هدف این ماژول پاسخ به این سؤال است: «ربات در کدام ساعت‌های شبانه‌روز
 * (به وقت تهران) بهترین/بدترین عملکرد سوددهی را داشته؟»
 *
 * هر بار که یک معامله به‌طور کامل و نهایی بسته می‌شود، نتیجه‌ی آن (سود/ضرر
 * دلاری) به همراه ساعت دقیق بسته‌شدن (۰ تا ۲۳، به وقت تهران) در یک لاگ روی
 * دیسک ذخیره می‌شود. این لاگ دقیقاً از همان الگوی ذخیره‌سازی سایر بخش‌های
 * پروژه (JSON روی دیسک، بدون وابستگی به دیتابیس) پیروی می‌کند تا با
 * ری‌استارت سرور از بین نرود.
 *
 * سپس با تجمیع این لاگ بر اساس ساعت، می‌توان:
 *   ۱) نمودار/جدول عملکرد هر یک از ۲۴ ساعت شبانه‌روز را ساخت.
 *   ۲) بهترین ساعت‌ها (بر مبنای میانگین سود هر معامله + حداقل نمونه‌ی آماری
 *      لازم برای معتبر بودن) را استخراج کرد — این همان چیزی است که هم در
 *      داشبورد و هم در ربات تلگرام («⏰ عملکرد ساعتی») نمایش داده می‌شود.
 *   ۳) اسکنر را طوری تنظیم کرد که یا ۲۴/۷ فعال بماند، یا فقط در همین
 *      ساعت‌های برتر پوزیشن جدید باز کند.
 */
import fs from "fs/promises";
import path from "path";

export interface HourlyTradeLogEntry {
  ts: number; // epoch ms — لحظه‌ی بسته‌شدن نهایی معامله
  hour: number; // 0-23 به وقت تهران
  pnlUsd: number;
  isWin: boolean;
}

export interface HourlyBucket {
  hour: number; // 0-23
  trades: number;
  wins: number;
  losses: number;
  winRate: number; // 0-100
  netUsd: number;
  avgPnlUsd: number; // میانگین سود/ضرر هر معامله در این ساعت
}

export interface BestHoursResult {
  computedAt: number;
  sufficientData: boolean;
  minTotalTradesRequired: number;
  minTradesPerHour: number;
  totalTrades: number;
  bestHours: number[]; // صعودی مرتب‌شده، ساعت‌های پیشنهادی برای معامله
  ranked: HourlyBucket[]; // فقط ساعت‌هایی با حداقل یک معامله، از بهترین به بدترین
  reason: string;
}

const LOG_FILE = path.join(process.cwd(), "hourly_trades_log.json");
const MAX_ENTRIES = 3000; // سقف تعداد ردیف‌های نگه‌داشته‌شده
const RETENTION_DAYS = 120; // داده‌های قدیمی‌تر از این بازه دور ریخته می‌شوند

let cache: HourlyTradeLogEntry[] = [];
let loaded = false;
let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const raw = await fs.readFile(LOG_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        cache = Array.isArray(parsed) ? parsed : [];
      } catch {
        cache = [];
      }
      loaded = true;
    })();
  }
  await loadingPromise;
}

async function persist(): Promise<void> {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    cache = cache.filter((e) => e.ts >= cutoff);
    if (cache.length > MAX_ENTRIES) {
      cache = cache.slice(cache.length - MAX_ENTRIES);
    }
    await fs.writeFile(LOG_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error("[hourlyStats] persist error:", e);
  }
}

/** ساعت محلی تهران (۰ تا ۲۳) برای یک زمان مشخص. */
export function tehranHourOf(ts: number = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ts));
    const hourPart = parts.find((p) => p.type === "hour");
    let h = hourPart ? parseInt(hourPart.value, 10) : 0;
    if (!Number.isFinite(h)) h = 0;
    return ((h % 24) + 24) % 24;
  } catch {
    return 0;
  }
}

/** ثبت نتیجه‌ی نهایی یک معامله‌ی کامل‌شده (فقط یک‌بار به ازای هر معامله). isWin باید از طبقه‌بندی صادقانه‌ی tradeOutcome.ts محاسبه شده باشد، نه فقط علامت pnlUsd. */
export async function recordHourlyTradeResult(pnlUsd: number, closedAt: number = Date.now(), isWin?: boolean): Promise<void> {
  await ensureLoaded();
  cache.push({
    ts: closedAt,
    hour: tehranHourOf(closedAt),
    pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
    isWin: isWin !== undefined ? isWin : pnlUsd >= 0,
  });
  await persist();
}

/** تجمیع لاگ معاملات بر اساس ساعت. windowDays اگر داده شود فقط بازه‌ی اخیر را لحاظ می‌کند. */
export async function getHourlyBuckets(windowDays?: number): Promise<HourlyBucket[]> {
  await ensureLoaded();
  const cutoff = windowDays && windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : 0;

  const buckets: HourlyBucket[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    netUsd: 0,
    avgPnlUsd: 0,
  }));

  for (const e of cache) {
    if (e.ts < cutoff) continue;
    const b = buckets[e.hour];
    if (!b) continue;
    b.trades += 1;
    if (e.isWin) b.wins += 1;
    else b.losses += 1;
    b.netUsd += e.pnlUsd;
  }

  for (const b of buckets) {
    b.winRate = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
    b.avgPnlUsd = b.trades > 0 ? b.netUsd / b.trades : 0;
  }

  return buckets;
}

/**
 * انتخاب «ساعت‌های طلایی» معاملاتی از روی آمار تجمیعی هر ساعت.
 * برای معتبر بودن آماری، حداقل تعداد معامله در کل و به ازای هر ساعت لازم است؛
 * در غیر این صورت sufficientData=false برمی‌گردد و بهتر است حالت ۲۴/۷ حفظ شود.
 */
export function pickBestHours(
  buckets: HourlyBucket[],
  opts?: { minTradesPerHour?: number; minTotalTrades?: number }
): BestHoursResult {
  const minTradesPerHour = opts?.minTradesPerHour ?? 3;
  const minTotalTrades = opts?.minTotalTrades ?? 20;
  const totalTrades = buckets.reduce((s, b) => s + b.trades, 0);

  const eligible = buckets.filter((b) => b.trades >= minTradesPerHour);

  if (totalTrades < minTotalTrades || eligible.length === 0) {
    return {
      computedAt: Date.now(),
      sufficientData: false,
      minTotalTradesRequired: minTotalTrades,
      minTradesPerHour,
      totalTrades,
      bestHours: [],
      ranked: buckets.filter((b) => b.trades > 0).sort((a, b) => b.avgPnlUsd - a.avgPnlUsd),
      reason: `داده کافی نیست — حداقل ${minTotalTrades} معامله بسته‌شده (با حداقل ${minTradesPerHour} معامله در هر ساعت) لازم است. تا رسیدن به این حد، حالت ۲۴/۷ توصیه می‌شود.`,
    };
  }

  const ranked = [...eligible].sort((a, b) => b.avgPnlUsd - a.avgPnlUsd || b.winRate - a.winRate);
  const positive = ranked.filter((b) => b.avgPnlUsd > 0);
  // اگر هیچ ساعتی میانگین سود مثبت نداشت، نیمه‌ی بهتر ساعت‌ها (کمترین ضرر) جایگزین می‌شود
  const chosen = positive.length > 0 ? positive : ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  const bestHours = chosen.map((b) => b.hour).sort((a, b) => a - b);

  return {
    computedAt: Date.now(),
    sufficientData: true,
    minTotalTradesRequired: minTotalTrades,
    minTradesPerHour,
    totalTrades,
    bestHours,
    ranked,
    reason:
      positive.length > 0
        ? `${bestHours.length} ساعت با میانگین سود مثبت به ازای هر معامله شناسایی شد.`
        : `در هیچ ساعتی میانگین سود مثبت نبود؛ به‌عنوان جایگزین، نیمه‌ی بهتر ساعت‌ها (کمترین میانگین ضرر) انتخاب شد.`,
  };
}

function hourLabel(h: number): string {
  const from = String(h).padStart(2, "0");
  const to = String((h + 1) % 24).padStart(2, "0");
  return `${from}:00-${to}:00`;
}

/** پیام آماده‌ی تلگرام برای گزارش عملکرد ساعتی + ساعت‌های طلایی پیشنهادی. */
export function formatHourlyReportMessage(
  buckets: HourlyBucket[],
  best: BestHoursResult,
  mode: "24_7" | "smart"
): string {
  const modeText = mode === "24_7" ? "🌍 ۲۴/۷ (بدون محدودیت ساعتی)" : "🎯 فقط ساعات طلایی هوشمند";
  let out = `⏰ <b>عملکرد ساعتی ربات (به وقت تهران)</b>\n━━━━━━━━━━━━━━━━━━\n`;
  out += `🎛 <b>حالت فعال:</b> ${modeText}\n\n`;

  if (!best.sufficientData) {
    out += `⚠️ ${best.reason}\n📦 <b>تعداد معاملات ثبت‌شده تاکنون:</b> ${best.totalTrades}`;
    return out.trim();
  }

  out += `🏆 <b>ساعت‌های طلایی پیشنهادی (${best.bestHours.length} ساعت):</b>\n`;
  out += best.bestHours.map((h) => hourLabel(h)).join("، ") + "\n\n";

  out += `📊 <b>رتبه‌بندی ساعت‌ها (بهترین تا بدترین):</b>\n`;
  for (const b of best.ranked.slice(0, 10)) {
    const emoji = b.avgPnlUsd > 0 ? "🟢" : b.avgPnlUsd < 0 ? "🔴" : "⚪";
    out += `${emoji} <b>${hourLabel(b.hour)}:</b> ${b.trades} معامله | وین‌ریت ${b.winRate.toFixed(0)}٪ | میانگین ${b.avgPnlUsd >= 0 ? "+" : ""}$${b.avgPnlUsd.toFixed(2)} | خالص ${b.netUsd >= 0 ? "+" : ""}$${b.netUsd.toFixed(2)}\n`;
  }
  out += `━━━━━━━━━━━━━━━━━━\n📦 <b>مجموع معاملات تحلیل‌شده:</b> ${best.totalTrades}`;
  return out.trim();
}
