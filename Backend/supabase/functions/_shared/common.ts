import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function siteUrl(): string {
  return (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
}

export function corsHeaders(): Record<string, string> {
  let origin = "*";
  try { origin = new URL(siteUrl()).origin; } catch { /* SITE_URL not set yet */ }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

/** Resolve the logged-in user from the Authorization header. */
export async function getUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  return error ? null : data.user;
}

/** yyyyMMddHHmmss in Pakistan time (UTC+5). */
export function pktStamp(d = new Date()): string {
  const p = new Date(d.getTime() + 5 * 3600 * 1000);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.getUTCFullYear()}${z(p.getUTCMonth() + 1)}${z(p.getUTCDate())}` +
    `${z(p.getUTCHours())}${z(p.getUTCMinutes())}${z(p.getUTCSeconds())}`;
}

/** 19-char alphanumeric transaction reference, e.g. T202610061110234821 */
export function newTxnRef(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return "T" + pktStamp() + String(n).padStart(4, "0");
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Redirect the customer's browser back to the website result page. */
export function redirectToSite(params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `${siteUrl()}/pages/payment-result.html?${qs}` },
  });
}

/** Remove secrets before storing a gateway payload. */
export function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/password|secret|hash|token/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function readParams(req: Request): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => (params[k] = v));
  if (req.method === "POST") {
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = await req.json();
        for (const [k, v] of Object.entries(body)) params[k] = String(v);
      } else {
        const fd = await req.formData();
        fd.forEach((v, k) => { if (typeof v === "string") params[k] = v; });
      }
    } catch { /* empty body */ }
  }
  return params;
}
