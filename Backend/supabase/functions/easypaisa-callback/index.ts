// Easypay (Easypaisa) sends the customer's browser back here (postBackURL).
// Step 1: returns with auth_token  -> send the browser to payment-result.html which POSTs it to Easypay's Confirm page.
// Step 2: returns with the final result -> we ignore the claimed status and ask Easypay's server directly (inquiry).
import { adminClient, readParams, redirectToSite, scrub } from "../_shared/common.ts";
import { easypaisaInquire, easypayBase } from "../_shared/gateways.ts";

Deno.serve(async (req) => {
  const p = await readParams(req);
  const ref = p.ref ?? p.orderRefNumber ?? p.orderRefNum ?? "";
  if (!/^T\d{18}$/.test(ref)) return redirectToSite({ status: "failed", reason: "invalid_response" });

  const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/easypaisa-callback?ref=${ref}`;

  // ---- Step 1: confirm handshake ----
  if (p.auth_token && !p.status && !p.desc) {
    return redirectToSite({
      step: "easypaisa_confirm",
      ref,
      auth_token: p.auth_token,
      action: `${easypayBase()}/easypay/Confirm.jsf`,
      post_back: fnUrl,
    });
  }

  // ---- Step 2: verify server-to-server ----
  const db = adminClient();
  const result = await easypaisaInquire(ref);
  const raw = scrub({ callback: p, inquiry: result.raw });

  if (result.paid) {
    const { data, error } = await db.rpc("confirm_payment", {
      p_txn_ref: ref,
      p_provider_txn_id: result.txnId ?? null,
      p_amount_pkr: result.amount ?? null,
      p_raw: raw,
    });
    if (error || !data) {
      console.error("confirm_payment failed", error);
      return redirectToSite({ status: "failed", ref, reason: "confirm_failed" });
    }
    return redirectToSite({ status: "paid", ref });
  }

  if (!result.known) {
    // Could not verify (network / not configured). Keep it pending — never mark paid, never mark failed.
    return redirectToSite({ status: "pending", ref });
  }

  await db.rpc("fail_payment", { p_txn_ref: ref, p_code: String(p.status ?? "NOT_PAID"), p_raw: raw });
  return redirectToSite({ status: "failed", ref, reason: p.desc ?? "not_paid" });
});
