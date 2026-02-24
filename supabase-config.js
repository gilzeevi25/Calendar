const SUPABASE_URL = 'https://kcujtvxekwsrycjzeiuy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JUe7k3OEU0yTigfkYUk-SQ_LeHFwKHB';
const DATE_START = '2026-04-26';
const DATE_END = '2026-06-18';
// Save library reference (for migration script), then replace with initialized client
window._supabaseLib = window.supabase;
window.supabase = window._supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
