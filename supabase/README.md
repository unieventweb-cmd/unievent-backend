# UniEvents PK — Supabase Backend

Auth, database, security rules, payments (JazzCash + Easypaisa), organizer↔student messaging, and admin tools.

## 1. Setup (one time)

1. Create a project at supabase.com.
2. **SQL Editor** → run, in order: `migrations/001_schema.sql`, `migrations/002_rls_and_functions.sql`, then (optional demo data) `seed.sql`.
3. **Authentication → Providers → Email**: keep enabled. For testing you may turn off "Confirm email".
4. Put your project URL and **anon** key in `js/config.js` (Project Settings → API). Never put the `service_role` key in the website.
5. Sign up on the website once, then make yourself admin (SQL Editor):
   ```sql
   update public.profiles set role = 'admin' where email = 'your-email@example.com';
   ```
6. Deploy payments:
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   cp supabase/.env.example supabase/.env      # fill in the values
   supabase secrets set --env-file supabase/.env
   supabase functions deploy create-payment
   supabase functions deploy jazzcash-callback --no-verify-jwt
   supabase functions deploy easypaisa-callback --no-verify-jwt
   ```
7. Add to every page that uses the backend (before your own scripts):
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="../js/config.js"></script>
   <script src="../js/api.js"></script>
   ```
8. Configure the frontend server and start the website:

   ```bash
   cd Fronted
   npm install
   npm start
   ```

   Open `http://localhost:5000`. The Express server serves the frontend and exposes only the public browser client from `Backend/js`; payment secrets remain in Supabase Edge Function secrets.

## 2. How it works

| Feature | Where |
|---|---|
| Sign up / login / reset | Supabase Auth → `UniAPI.signUp / signIn / resetPassword`. A `profiles` row is created automatically. |
| Events (browse, filter, search) | `UniAPI.listEvents({category, city, free, search})` — only `approved` events are public. |
| Post event + poster | `UniAPI.submitEvent(...)` → status `pending` → admin approves. Posters go to Storage bucket `posters`. |
| Booking | `UniAPI.createBooking` (SQL function). Price always comes from the ticket tier in the database, never from the browser. Free ticket = confirmed instantly. |
| Payment | `UniAPI.startPayment(bookingId, "jazzcash" \| "easypaisa", mobile)` → Edge Function builds the signed request → browser goes to the gateway → gateway returns to `*-callback` → hash/inquiry verified → ticket confirmed → browser lands on `pages/payment-result.html`. |
| Messaging | `startConversation(eventId)`, `sendMessage`, `subscribeMessages` (live via Realtime), `myConversations`. A student chats with the event's organizer. |
| Organizer tools | `myEvents`, `attendees(eventId)` (CNIC is hidden), `checkIn(ticketCode)` at the gate. |
| Admin | `UniAPI.admin.*` — stats, approve/reject events, users & roles, all bookings/payments, contact-form inbox. Admin can also open the Supabase dashboard tables directly. |
| Contact form | `UniAPI.sendContact(...)` → table `contact_messages` (anyone can write, only admin can read). |

## 3. Security model (short)

- Row Level Security is ON for every table. Students only see their own bookings; CNIC is visible only to the owner and admins.
- Browser **cannot** write `payments`, change booking status/price, approve its own event, or change its own role.
- Gateway secrets live only in Edge Function secrets.
- JazzCash response is accepted only if its HMAC-SHA256 hash matches. Easypaisa result is **never** taken from the redirect; the function asks Easypay's server (inquiry) and confirms only on `PAID`.
- Amount mismatch ⇒ payment marked failed. Confirming the same payment twice is harmless (idempotent).

## 4. Before going live — please test in sandbox

I could not run live gateway calls from here (needs your merchant credentials), so verify these in **sandbox** first:

1. **JazzCash**: make a test payment → ticket becomes `confirmed`. If the hash check fails, compare the fields with the "Page Redirection" sample in your JazzCash merchant portal docs (field list/sample values like `pp_BankID`, `pp_ProductID` can differ per merchant account; adjust via `.env`).
2. **Easypaisa**: confirm in your Easypay integration document that the hosted-checkout parameter names, the `Confirm.jsf` step and the *inquire-transaction* API path match `_shared/gateways.ts`. If they differ, only that one file needs changes.
3. Register your callback URLs with the gateways if required:
   - `https://YOUR-PROJECT-REF.supabase.co/functions/v1/jazzcash-callback`
   - `https://YOUR-PROJECT-REF.supabase.co/functions/v1/easypaisa-callback`
4. Switch the `.env` URLs from sandbox to live only after sandbox passes.

## 5. Not included yet

- SMS / WhatsApp / email notifications (chat is in-site only).
- Automatic refunds (status `refunded` exists; refund via gateway portal, then update the booking).
- Login, registration, event browsing/details, booking/payment, event submissions, contact messages, and payment results use `UniAPI`. Set the real project URL and anon key in `Backend/js/config.js` before testing; the template values intentionally do not connect to a project.
