import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const missingConfig =
  SUPABASE_URL.includes('YOUR_PROJECT_ID') ||
  SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME');

if (missingConfig) {
  console.warn('Supabase is not configured yet. Update assets/js/config/supabase-config.js');
}

if (!window.supabase?.createClient) {
  throw new Error('Supabase JavaScript client failed to load.');
}

export const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
