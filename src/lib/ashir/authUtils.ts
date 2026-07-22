/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────
// 🔐 ابزارهای احراز هویت پنل وب (لاگین ادمین/کاربران).
// از crypto داخلی Node استفاده می‌کند — بدون نیاز به bcrypt/jsonwebtoken،
// تا نصب پروژه هیچ وابستگی native جدیدی نگیرد.
// ─────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;

export function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(plain: string, hash: string, salt: string): boolean {
  try {
    const candidate = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, "hex");
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export interface TokenPayload {
  role: "admin" | "user";
  telegramId?: string;
  exp: number; // timestamp (ms)
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** توکن امضاشده‌ی ساده (شبیه JWT اما بدون نیاز به کتابخانه‌ی خارجی). */
export function signToken(payload: TokenPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as TokenPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
