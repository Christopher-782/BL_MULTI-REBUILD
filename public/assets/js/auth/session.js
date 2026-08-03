import { supabase } from '../config/supabase.js';

export async function getAuthenticatedUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export async function requireAuth({ redirectTo = './login.html' } = {}) {
  const user = await getAuthenticatedUser();
  if (!user) {
    window.location.replace(redirectTo);
    return null;
  }
  return user;
}

export async function redirectIfAuthenticated({ redirectTo = './dashboard.html' } = {}) {
  const user = await getAuthenticatedUser();
  if (user) {
    window.location.replace(redirectTo);
    return true;
  }
  return false;
}
