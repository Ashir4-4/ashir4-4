/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// ─────────────────────────────────────────────────────────────────
// 📅 تبدیل تاریخ میلادی به شمسی (جلالی) — پیاده‌سازی مستقل بدون نیاز
// به کتابخانه‌ی خارجی. الگوریتم استاندارد و شناخته‌شده‌ی تبدیل تقویم.
// ─────────────────────────────────────────────────────────────────

function div(a: number, b: number): number {
  return ~~(a / b);
}
function mod(a: number, b: number): number {
  return a - ~~(a / b) * b;
}

// تعداد سال‌های کبیسه‌ی جلالی سپری‌شده تا ابتدای سال jy (الگوریتم استاندارد
// مبتنی بر مقاله‌ی Kazimierz M. Borkowski — همان پایه‌ی کتابخانه‌ی jalaali-js).
function jalCal(jy: number) {
  const breaks = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
    2192, 2262, 2324, 2394, 2456, 3178,
  ];
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  if (jy < jp || jy >= breaks[bl - 1]) {
    throw new Error("Invalid Jalali year " + jy);
  }
  let jump = 0;
  let i = 1;
  for (; i < bl; i += 1) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2j(jdn: number): [number, number, number] {
  let gy = d2gYear(jdn);
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(r.gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      const jm = 1 + div(k, 31);
      const jd = mod(k, 31) + 1;
      return [jy, jm, jd];
    } else {
      k -= 186;
    }
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  const jm = 7 + div(k, 30);
  const jd = mod(k, 30) + 1;
  return [jy, jm, jd];
}

function d2gYear(jdn: number): number {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return gy;
}

/** تبدیل تاریخ میلادی (Date) به [سال، ماه، روز] شمسی (به وقت تهران) */
export function gregorianToJalali(gDate: Date): [number, number, number] {
  // زمان را به وقت تهران منتقل می‌کنیم تا نیمه‌شب‌های مرزی درست محاسبه شوند.
  const tehranStr = gDate.toLocaleString("en-US", { timeZone: "Asia/Tehran" });
  const t = new Date(tehranStr);
  const jdn = g2d(t.getFullYear(), t.getMonth() + 1, t.getDate());
  return d2j(jdn);
}

const JALALI_MONTH_NAMES = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];

/** فرمت خوانا: «۱۴ مرداد ۱۴۰۴» */
export function formatJalali(gDate: Date): string {
  const [jy, jm, jd] = gregorianToJalali(gDate);
  const toFa = (n: number) => n.toLocaleString("fa-IR", { useGrouping: false });
  return `${toFa(jd)} ${JALALI_MONTH_NAMES[jm - 1]} ${toFa(jy)}`;
}

/** فرمت خوانا با ساعت: «۱۴ مرداد ۱۴۰۴ - ۱۸:۳۰» (به وقت تهران) */
export function formatJalaliDateTime(gDate: Date): string {
  const timeStr = gDate.toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${formatJalali(gDate)} - ${timeStr}`;
}

/** فرمت میلادی ساده: «2026-07-12» */
export function formatGregorian(gDate: Date): string {
  return gDate.toISOString().slice(0, 10);
}

/** تبدیل بازه‌ی زمانی (میلی‌ثانیه) به برچسب «۲۴ روز و ۱۲ ساعت» */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "منقضی شده";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const toFa = (n: number) => n.toLocaleString("fa-IR", { useGrouping: false });

  if (days > 0) {
    return `${toFa(days)} روز و ${toFa(hours)} ساعت`;
  }
  if (hours > 0) {
    return `${toFa(hours)} ساعت و ${toFa(minutes)} دقیقه`;
  }
  return `${toFa(minutes)} دقیقه`;
}
