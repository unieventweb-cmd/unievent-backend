/**
 * UniEvents PK — Supabase API client
 * Load order on every page:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="js/config.js"></script>
 *   <script src="js/api.js"></script>
 * Everything is available as window.UniAPI.
 */
(function () {
  const cfg = window.UNIEVENTS_CONFIG;
  if (!window.supabase || !cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
      cfg.SUPABASE_URL.includes("YOUR-PROJECT-REF") || cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON-PUBLIC-KEY")) {
    console.error("UniEvents backend is not configured. Set the Supabase URL and anon key in Backend/js/config.js.");
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const unwrap = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  const UniAPI = {
    sb,

    /* ---------------- Auth ---------------- */
    async signUp(fullName, email, password) {
      return unwrap(await sb.auth.signUp({ email, password, options: { data: { full_name: fullName } } }));
    },
    async signIn(email, password) {
      return unwrap(await sb.auth.signInWithPassword({ email, password }));
    },
    async signOut() { await sb.auth.signOut(); },
    async getUser() { return (await sb.auth.getUser()).data.user; },
    async isLoggedIn() { return !!(await sb.auth.getSession()).data.session; },
    async resetPassword(email) {
      return unwrap(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/pages/login.html" }));
    },
    async getProfile() {
      const user = await this.getUser();
      if (!user) return null;
      return unwrap(await sb.from("profiles").select("*").eq("id", user.id).single());
    },
    async updateProfile(fields) {           // full_name, phone, university only
      const user = await this.getUser();
      return unwrap(await sb.from("profiles").update(fields).eq("id", user.id).select().single());
    },

    /* ---------------- Events ---------------- */
    async listEvents({ category, city, free, search } = {}) {
      let q = sb.from("events")
        .select("*, ticket_tiers(id, name, price_pkr)")
        .eq("status", "approved")
        .gte("event_date", new Date().toISOString().slice(0, 10))
        .order("event_date");
      if (category && category !== "all") q = q.eq("category", category);
      if (city && city !== "all") q = q.eq("city", city);
      if (free === "free") q = q.eq("is_free", true);
      if (free === "paid") q = q.eq("is_free", false);
      if (search) {
        const s = search.replace(/[%,()]/g, " ").trim();
        if (s) q = q.or(`title.ilike.%${s}%,venue.ilike.%${s}%,organization_name.ilike.%${s}%`);
      }
      return unwrap(await q);
    },
    async getEvent(id) {
      return unwrap(await sb.from("events").select("*, ticket_tiers(*)").eq("id", id).single());
    },

    /** Organizer: submit an event (goes to admin review). tiers = [{name, description, price_pkr, quantity}] */
    async submitEvent(ev, posterFile, tiers = []) {
      const user = await this.getUser();
      if (!user) throw new Error("Please login first");
      let poster_url = null;
      if (posterFile) {
        const path = `${user.id}/${Date.now()}-${posterFile.name.replace(/[^\w.-]/g, "_")}`;
        unwrap(await sb.storage.from("posters").upload(path, posterFile, { contentType: posterFile.type }));
        poster_url = sb.storage.from("posters").getPublicUrl(path).data.publicUrl;
      }
      const row = unwrap(await sb.from("events").insert({
        organizer_id: user.id,
        organization_name: ev.organization_name,
        title: ev.title,
        description: ev.description,
        category: ev.category,
        city: ev.city,
        venue: ev.venue,
        event_date: ev.event_date,
        start_time: ev.start_time || null,
        registration_url: ev.registration_url || null,
        is_free: !!ev.is_free,
        poster_url,
      }).select().single());
      if (!ev.is_free && tiers.length) {
        unwrap(await sb.from("ticket_tiers").insert(tiers.map((t) => ({ ...t, event_id: row.id }))));
      }
      return row;
    },
    async myEvents() {
      const user = await this.getUser();
      return unwrap(await sb.from("events").select("*, ticket_tiers(*)").eq("organizer_id", user.id).order("created_at", { ascending: false }));
    },
    async attendees(eventId) { return unwrap(await sb.rpc("event_attendees", { p_event_id: eventId })); },
    async checkIn(ticketCode) { return unwrap(await sb.rpc("check_in_ticket", { p_ticket_code: ticketCode })); },

    /* ---------------- Booking + payment ---------------- */
    async createBooking({ eventId, tierId, fullName, email, cnic, roll, university }) {
      return unwrap(await sb.rpc("create_booking", {
        p_event_id: eventId, p_tier_id: tierId, p_full_name: fullName, p_email: email,
        p_cnic: cnic, p_roll: roll || null, p_university: university || null,
      }));
    },
    async myBookings() {
      return unwrap(await sb.from("bookings")
        .select("id, status, amount_pkr, ticket_code, created_at, checked_in_at, events(id, title, event_date, venue), ticket_tiers(name)")
        .order("created_at", { ascending: false }));
    },
    /** provider: "jazzcash" | "easypaisa". Redirects the browser to the gateway. */
    async startPayment(bookingId, provider, mobile) {
      const { data, error } = await sb.functions.invoke("create-payment", {
        body: { booking_id: bookingId, provider, mobile },
      });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (_) { /* keep default */ }
        throw new Error(msg);
      }
      UniAPI.postForm(data.action, data.fields);
    },
    postForm(action, fields) {
      const f = document.createElement("form");
      f.method = "POST";
      f.action = action;
      for (const [k, v] of Object.entries(fields)) {
        const i = document.createElement("input");
        i.type = "hidden"; i.name = k; i.value = v;
        f.appendChild(i);
      }
      document.body.appendChild(f);
      f.submit();
    },
    /** Free ticket => booking is already confirmed; paid => go to gateway. */
    async bookAndPay(bookingInput, provider, mobile) {
      const booking = await this.createBooking(bookingInput);
      if (booking.status === "confirmed") return { booking, paid: false, free: true };
      await this.startPayment(booking.id, provider, mobile);
      return { booking, paid: false, redirected: true };
    },
    async bookingByTxnRef(txnRef) {
      const pay = unwrap(await sb.from("payments").select("status, booking_id").eq("txn_ref", txnRef).maybeSingle());
      if (!pay) return null;
      const bk = unwrap(await sb.from("bookings").select("ticket_code, status, events(title)").eq("id", pay.booking_id).single());
      return { payment_status: pay.status, ...bk };
    },

    /* ---------------- Contact form ---------------- */
    async sendContact({ name, email, university, message }) {
      return unwrap(await sb.from("contact_messages").insert({ name, email, university, message }));
    },

    /* ---------------- Messaging (student <-> organizer) ---------------- */
    async startConversation(eventId) { return unwrap(await sb.rpc("start_conversation", { p_event_id: eventId })); },
    async myConversations() { return unwrap(await sb.rpc("my_conversations")); },
    async loadMessages(conversationId) {
      return unwrap(await sb.from("messages").select("*").eq("conversation_id", conversationId).order("created_at"));
    },
    async sendMessage(conversationId, body) {
      const user = await this.getUser();
      return unwrap(await sb.from("messages").insert({ conversation_id: conversationId, sender_id: user.id, body: body.trim() }).select().single());
    },
    async markRead(conversationId) {
      const user = await this.getUser();
      return unwrap(await sb.from("messages").update({ read_at: new Date().toISOString() })
        .eq("conversation_id", conversationId).neq("sender_id", user.id).is("read_at", null));
    },
    /** Live updates: onMessage(row) fires for every new message in that chat. Returns an unsubscribe fn. */
    subscribeMessages(conversationId, onMessage) {
      const ch = sb.channel("chat-" + conversationId)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
          (payload) => onMessage(payload.new))
        .subscribe();
      return () => sb.removeChannel(ch);
    },

    /* ---------------- Admin (needs profiles.role = 'admin') ---------------- */
    admin: {
      stats: async () => unwrap(await sb.rpc("admin_stats")),
      pendingEvents: async () => unwrap(await sb.from("events").select("*").eq("status", "pending").order("created_at")),
      allEvents: async () => unwrap(await sb.from("events").select("*").order("created_at", { ascending: false })),
      reviewEvent: async (id, approve, reason) =>
        unwrap(await sb.rpc("review_event", { p_event_id: id, p_approve: approve, p_reason: reason || null })),
      users: async () => unwrap(await sb.from("profiles").select("*").order("created_at", { ascending: false })),
      setRole: async (userId, role) => unwrap(await sb.rpc("set_user_role", { p_user_id: userId, p_role: role })),
      bookings: async () => unwrap(await sb.from("bookings").select("*, events(title), ticket_tiers(name)").order("created_at", { ascending: false })),
      payments: async () => unwrap(await sb.from("payments").select("*").order("created_at", { ascending: false })),
      contactMessages: async () => unwrap(await sb.from("contact_messages").select("*").order("created_at", { ascending: false })),
      setContactStatus: async (id, status) => unwrap(await sb.from("contact_messages").update({ status }).eq("id", id)),
    },
  };

  window.UniAPI = UniAPI;
})();
