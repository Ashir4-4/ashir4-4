/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────
// 🔐 صندوق رمزنگاری کلیدهای API صرافی کاربران.
//
// چون این کلیدها دسترسی به معاملات با پول واقعی می‌دهند، هرگز به‌صورت
// متن ساده روی دیسک ذخیره نمی‌شوند. از AES-256-GCM (رمزنگاری متقارن
// احرازشده) با یک کلید اصلی مشتق‌شده از EXCHANGE_KEY_ENCRYPTION_SECRET
// استفاده می‌شود. هر رمزنگاری یک IV تصادفی جدید دارد.
// ─────────────────────────────────────────────────────────────────

function deriveKey(secret: string): Buffer {
  // یک نمک ثابت و مخصوص این پروژه — چون خودِ secret از env و مخفی است،
  // نمک ثابت برای این کاربرد (رمزنگاری در حافظه‌ی سرور خودمان) کفایت می‌کند.
  return crypto.scryptSync(secret, "ashir4-exchange-vault", 32);
}

export function encryptSecret(plain: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // بسته‌بندی: iv.authTag.ciphertext همه base64
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(packed: string, masterSecret: string): string {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
  const key = deriveKey(masterSecret);
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf-8");
}

/** برای نمایش امن در UI: فقط ۴ کاراکتر آخر کلید را نشان می‌دهد. */
export function maskKey(plain: string): string {
  if (plain.length <= 4) return "••••";
  return `••••••••${plain.slice(-4)}`;
}
