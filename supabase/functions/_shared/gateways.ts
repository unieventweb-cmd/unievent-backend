import { createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { hmacSha256Hex, pktStamp } from "./common.ts";

/* =====================================================================
 * JazzCash — "Page Redirection" (HTTP POST) integration
 * Secure hash = HMAC-SHA256( key = integrity salt,
 *   message = salt & every non-empty pp_/ppmpf_ value sorted by field name, joined by "&" )
 * ===================================================================== */
export async function jazzcashHash(fields: Record<string, string>): Promise<string> {
  const salt = Deno.env.get("JAZZCASH_INTEGRITY_SALT")!;
  const keys = Object.keys(fields)
    .filter((k) => k !== "pp_SecureHash" && fields[k] !== undefined && fields[k] !== null && fields[k] !== "")
    .sort();
  const message = [salt, ...keys.map((k) => fields[k])].join("&");
  return (await hmacSha256Hex(salt, message)).toUpperCase();
}

export async function buildJazzcashRequest(opts: { txnRef: string; amountPkr: number; returnUrl: string; description: string }) {
  const now = new Date();
  const fields: Record<string, string> = {
    pp_Version: "1.1",
    pp_TxnType: "",
    pp_Language: "EN",
    pp_MerchantID: Deno.env.get("JAZZCASH_MERCHANT_ID")!,
    pp_SubMerchantID: "",
    pp_Password: Deno.env.get("JAZZCASH_PASSWORD")!,
    pp_BankID: Deno.env.get("JAZZCASH_BANK_ID") ?? "TBANK",
    pp_ProductID: Deno.env.get("JAZZCASH_PRODUCT_ID") ?? "RETL",
    pp_TxnRefNo: opts.txnRef,
    pp_Amount: String(Math.round(opts.amountPkr * 100)), // paisa
    pp_TxnCurrency: "PKR",
    pp_TxnDateTime: pktStamp(now),
    pp_BillReference: "UniEvents",
    pp_Description: opts.description.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 100) || "Event ticket",
    pp_TxnExpiryDateTime: pktStamp(new Date(now.getTime() + 60 * 60 * 1000)),
    pp_ReturnURL: opts.returnUrl,
    ppmpf_1: "1", ppmpf_2: "2", ppmpf_3: "3", ppmpf_4: "4", ppmpf_5: "5",
  };
  fields.pp_SecureHash = await jazzcashHash(fields);
  return {
    action: Deno.env.get("JAZZCASH_POST_URL") ??
      "https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/",
    fields,
  };
}

/* =====================================================================
 * Easypaisa — Easypay hosted checkout
 * merchantHashedReq = Base64( AES-128-ECB/PKCS5( "k1=v1&k2=v2..." sorted by key, non-empty ) ), key = store hash key
 * ===================================================================== */
export function easypaisaHash(params: Record<string, string>): string {
  const key = Deno.env.get("EASYPAISA_HASH_KEY")!;
  const plain = Object.keys(params).filter((k) => params[k] !== "").sort()
    .map((k) => `${k}=${params[k]}`).join("&");
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "utf8"), null);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

export function buildEasypaisaRequest(opts: { txnRef: string; amountPkr: number; postBackUrl: string; email?: string; mobile?: string; method?: string }) {
  const expiry = pktStamp(new Date(Date.now() + 60 * 60 * 1000));
  const params: Record<string, string> = {
    amount: opts.amountPkr.toFixed(1),
    autoRedirect: "1",
    emailAddr: opts.email ?? "",
    expiryDate: `${expiry.slice(0, 8)} ${expiry.slice(8)}`,
    mobileNum: opts.mobile ?? "",
    orderRefNum: opts.txnRef,
    paymentMethod: opts.method ?? "",
    postBackURL: opts.postBackUrl,
    storeId: Deno.env.get("EASYPAISA_STORE_ID")!,
  };
  const fields: Record<string, string> = { ...params, merchantHashedReq: easypaisaHash(params) };
  for (const k of Object.keys(fields)) if (fields[k] === "") delete fields[k];
  return {
    action: `${easypayBase()}/easypay/Index.jsf`,
    fields,
  };
}

export function easypayBase(): string {
  return (Deno.env.get("EASYPAISA_BASE_URL") ?? "https://easypaystg.easypaisa.com.pk").replace(/\/+$/, "");
}

/** Server-to-server check — the redirect alone is NEVER trusted for Easypaisa. */
export async function easypaisaInquire(orderId: string): Promise<{ paid: boolean; known: boolean; amount?: number; txnId?: string; raw: Record<string, unknown> }> {
  const user = Deno.env.get("EASYPAISA_USERNAME");
  const pass = Deno.env.get("EASYPAISA_PASSWORD");
  const account = Deno.env.get("EASYPAISA_ACCOUNT_NUM");
  if (!user || !pass || !account) {
    console.error("Easypaisa inquiry credentials missing — payment cannot be verified");
    return { paid: false, known: false, raw: { error: "inquiry_not_configured" } };
  }
  try {
    const res = await fetch(`${easypayBase()}/easypay-service/rest/v4/inquire-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Credentials: btoa(`${user}:${pass}`) },
      body: JSON.stringify({ orderId, storeId: Deno.env.get("EASYPAISA_STORE_ID"), accountNum: account }),
    });
    const data = await res.json();
    const status = String(data.transactionStatus ?? "").toUpperCase();
    return {
      paid: String(data.responseCode) === "0000" && status === "PAID",
      known: String(data.responseCode) === "0000",
      amount: data.transactionAmount !== undefined ? Number(data.transactionAmount) : undefined,
      txnId: data.transactionId ? String(data.transactionId) : undefined,
      raw: data,
    };
  } catch (e) {
    console.error("Easypaisa inquiry failed", e);
    return { paid: false, known: false, raw: { error: "inquiry_failed" } };
  }
}
