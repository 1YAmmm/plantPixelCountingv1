import { createHmac, timingSafeEqual } from "node:crypto";

// Who may use the daily-report routes (newplan.md step 5). Without this, anyone with the URL could
// change the recipients and send email from the client's Gmail.
//   Camera:   Authorization: Bearer <DEVICE_API_KEY>
//   Settings: httpOnly cookie plant_admin = HMAC-SHA256(ADMIN_PASSWORD, "plant-admin"), set by
//             POST /api/automation/session. Changing ADMIN_PASSWORD signs everyone out.

export const ADMIN_COOKIE = "plant_admin";
export const ADMIN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function deviceKey(): string | null {
  return process.env.DEVICE_API_KEY?.trim() || null;
}

function adminSecret(): string | null {
  return process.env.ADMIN_PASSWORD || null;
}

/** The admin cookie's value for `password`. */
export function adminToken(password: string): string {
  return createHmac("sha256", password).update("plant-admin").digest("hex");
}

export function checkAdminPassword(password: string): boolean {
  const secret = adminSecret();
  return !!secret && safeEqual(adminToken(password), adminToken(secret));
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function denied(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** null when the request carries the device key; otherwise the error response to return. */
export function requireDevice(request: Request): Response | null {
  const key = deviceKey();
  if (!key) return denied("DEVICE_API_KEY is not set on the server", 503);
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && safeEqual(match[1].trim(), key) ? null : denied("Wrong device key", 401);
}

/** null when the request carries the admin cookie; otherwise the error response to return. */
export function requireAdmin(request: Request): Response | null {
  const secret = adminSecret();
  if (!secret) return denied("ADMIN_PASSWORD is not set on the server", 503);
  const value = cookie(request, ADMIN_COOKIE);
  return value && safeEqual(value, adminToken(secret)) ? null : denied("Sign in first", 401);
}
