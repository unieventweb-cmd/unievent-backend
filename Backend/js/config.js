// Supabase project settings. The anon key is PUBLIC by design (security comes from RLS in the database).
// NEVER put the service_role key, JazzCash or Easypaisa secrets in any file inside the website.
window.UNIEVENTS_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
};
