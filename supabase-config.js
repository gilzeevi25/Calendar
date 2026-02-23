const SUPABASE_URL = 'https://kcujtvxekwsrycjzeiuy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JUe7k3OEU0yTigfkYUk-SQ_LeHFwKHB';
// Save library reference (for migration script), then replace with initialized client
window._supabaseLib = window.supabase;
window.supabase = window._supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
