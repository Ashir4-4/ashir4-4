/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Position } from "./types";

// ─────────────────────────────────────────────────────────────────
// 🎯 طبقه‌بندی صادقانه‌ی نتیجه‌ی معامله.
//
// قبلاً «برد/باخت» فقط بر اساس علامت pnl_usd تعیین می‌شد — یعنی یک
// خروج اضطراری (Stop Loss / خروج هوشمند زودهنگام) که به‌طور اتفاقی با
// چند سنت سود بسته شده بود، دقیقاً مثل یک Take Profit کامل «برد»
// حساب می‌شد. این باعث می‌شد وین‌ریت نمایشی واقعیِ عملکرد استراتژی را
// نشان ندهد.
//
// این ماژول به‌جای «فقط علامت عدد»، «چرا معامله بسته شد» را هم در نظر
// می‌گیرد:
//   • win        → واقعاً به یک هدف سود (TP1/TP2/Trailing) رسید، یا بعد
//                  از یک TP1 موفق با ریسک‌فری بسته شد (چون سود TP1 قبلاً
//                  قطعی شده و کل معامله در مجموع سودده است).
//   • defensive  → یک مکانیزم دفاعی (Stop Loss خام یا خروج هوشمند
//                  زودهنگام) بدون این‌که TP1 قبلاً زده باشد، فعال شده —
//                  حتی اگر عدد نهایی به‌طور جزئی مثبت باشد، این «برد»
//                  محسوب نمی‌شود؛ فقط یعنی ضرر بزرگ‌تر جلوگیری شده.
//   • loss       → هر خروج دیگری با سود/زیان نهایی منفی.
// ─────────────────────────────────────────────────────────────────

export type TradeOutcome = "win" | "loss" | "defensive";

const DEFENSIVE_EXIT_REASONS = [
  "Stop Loss (حد ضرر)",
  "خروج هوشمند زودهنگام",
  "خروج ایمنی فوری",
];

export function classifyTradeOutcome(order: Pick<Position, "exit_reason" | "tp1_hit" | "pnl_usd">): TradeOutcome {
  const pnl = typeof order.pnl_usd === "number" && Number.isFinite(order.pnl_usd) ? order.pnl_usd : 0;
  const reason = order.exit_reason || "";

  const isDefensiveExit = !order.tp1_hit && DEFENSIVE_EXIT_REASONS.some((r) => reason.includes(r));

  if (isDefensiveExit) {
    return pnl >= 0 ? "defensive" : "loss";
  }
  return pnl >= 0 ? "win" : "loss";
}

/** برای محاسبات وین‌ریت: فقط "win" واقعی حساب می‌شود، نه "defensive". */
export function isRealWin(order: Pick<Position, "exit_reason" | "tp1_hit" | "pnl_usd">): boolean {
  return classifyTradeOutcome(order) === "win";
}
