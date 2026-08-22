import { supabase } from '../config/supabase.js';

export async function getAuthenticatedUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export async function getRoleLandingPage(userId) {
  if (!userId) return './dashboard.html';

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile || profile.status !== 'active') {
    return './dashboard.html';
  }

  return profile.role === 'staff'
    ? './transactions.html'
    : './dashboard.html';
}

export async function requireAuth({ redirectTo = './login.html' } = {}) {
  const user = await getAuthenticatedUser();
  if (!user) {
    window.location.replace(redirectTo);
    return null;
  }
  return user;
}

export async function redirectIfAuthenticated({ redirectTo = '' } = {}) {
  const user = await getAuthenticatedUser();
  if (user) {
    const target = redirectTo || await getRoleLandingPage(user.id);
    window.location.replace(target);
    return true;
  }
  return false;
}
