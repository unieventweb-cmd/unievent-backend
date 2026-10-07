// JazzCash POSTs the customer's browser here after payment (pp_ReturnURL).
import { adminClient, readParams, redirectToSite, scrub, timingSafeEqual } from "../_shared/common.ts";
import { jazzcashHash } from "../_shared/gateways.ts";

Deno.serve(async (req) => {
  const p = await readParams(req);
  const ref = p.pp_TxnRefNo ?? "";

  if (!ref || !p.pp_SecureHash) return redirectToSite({ status: "failed", reason: "invalid_response" });

  const expected = await jazzcashHash(p);
  if (!timingSafeEqual(expected, p.pp_SecureHash.toUpperCase())) {
    console.error("JazzCash hash mismatch for", ref);
    return redirectToSite({ status: "failed", ref, reason: "bad_signature" });
  }

  const db = adminClient();
  const raw = scrub(p);

  if (p.pp_ResponseCode === "000") {
    const { data, error } = await db.rpc("confirm_payment", {
      p_txn_ref: ref,
      p_provider_txn_id: p.pp_RetreivalReferenceNo ?? null,
      p_amount_pkr: Number(p.pp_Amount) / 100, // paisa -> PKR
      p_raw: raw,
    });
    if (error || !data) {
      console.error("confirm_payment failed", error);
      return redirectToSite({ status: "failed", ref, reason: "confirm_failed" });
    }
    return redirectToSite({ status: "paid", ref });
  }

  await db.rpc("fail_payment", { p_txn_ref: ref, p_code: p.pp_ResponseCode ?? "UNKNOWN", p_raw: raw });
  return redirectToSite({ status: "failed", ref, reason: p.pp_ResponseMessage ?? "declined" });
});
