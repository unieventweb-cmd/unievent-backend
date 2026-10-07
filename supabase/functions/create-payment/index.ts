// POST { booking_id, provider: "jazzcash" | "easypaisa", mobile?: string }
// Returns { action, fields } — the website auto-submits these as a hidden POST form to the gateway.
import { adminClient, corsHeaders, getUser, json, newTxnRef } from "../_shared/common.ts";
import { buildEasypaisaRequest, buildJazzcashRequest } from "../_shared/gateways.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const user = await getUser(req);
    if (!user) return json({ error: "Please login first" }, 401);

    const { booking_id, provider, mobile } = await req.json();
    if (!booking_id || !["jazzcash", "easypaisa"].includes(provider)) {
      return json({ error: "booking_id and a valid provider are required" }, 400);
    }

    const db = adminClient();
    const { data: booking, error } = await db
      .from("bookings")
      .select("id, user_id, amount_pkr, email, status, event_id, events(title)")
      .eq("id", booking_id)
      .maybeSingle();

    if (error || !booking) return json({ error: "Booking not found" }, 404);
    if (booking.user_id !== user.id) return json({ error: "Not your booking" }, 403);
    if (booking.status !== "pending_payment") return json({ error: "This booking does not need payment" }, 400);
    if (!(booking.amount_pkr > 0)) return json({ error: "Free ticket — no payment required" }, 400);

    const txnRef = newTxnRef();
    const { error: insErr } = await db.from("payments").insert({
      booking_id: booking.id,
      provider,
      amount_pkr: booking.amount_pkr, // always from the database, never from the browser
      txn_ref: txnRef,
    });
    if (insErr) throw insErr;

    const fnBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    // deno-lint-ignore no-explicit-any
    const title = (booking as any).events?.title ?? "Event ticket";

    const payload = provider === "jazzcash"
      ? await buildJazzcashRequest({
        txnRef,
        amountPkr: booking.amount_pkr,
        returnUrl: `${fnBase}/jazzcash-callback`,
        description: `Ticket ${title}`,
      })
      : buildEasypaisaRequest({
        txnRef,
        amountPkr: booking.amount_pkr,
        postBackUrl: `${fnBase}/easypaisa-callback?ref=${txnRef}`,
        email: booking.email,
        mobile: typeof mobile === "string" ? mobile.replace(/\D/g, "") : "",
      });

    return json({ txn_ref: txnRef, ...payload });
  } catch (e) {
    console.error("create-payment error", e);
    return json({ error: "Could not start payment. Please try again." }, 500);
  }
});
