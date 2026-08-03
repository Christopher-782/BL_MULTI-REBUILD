import { supabase } from '../config/supabase.js';
import { requireAuth } from './session.js';

export function humanizeRole(role = '') {
  return String(role).replaceAll('_', ' ');
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, phone, role, status, created_at, updated_at')
    .eq('id', userId)
    .single();

  return { profile: data ?? null, error };
}

export async function requireActiveProfile({ roles = [], redirectTo = './login.html' } = {}) {
  const user = await requireAuth({ redirectTo });
  if (!user) return null;

  const { profile, error } = await getProfile(user.id);

  if (error || !profile || profile.status !== 'active') {
    await supabase.auth.signOut({ scope: 'local' });
    window.location.replace('./login.html');
    return null;
  }

  if (roles.length && !roles.includes(profile.role)) {
    window.location.replace('./dashboard.html');
    return null;
  }

  return { user, profile };
}

export function bindSessionUI(profile, user) {
  const displayName = profile.full_name || user.email || 'Staff member';

  document.querySelectorAll('[data-session-name]').forEach((element) => {
    element.textContent = displayName;
  });

  document.querySelectorAll('[data-session-role]').forEach((element) => {
    element.textContent = humanizeRole(profile.role);
  });

  document.querySelectorAll('[data-admin-only]').forEach((element) => {
    element.hidden = !['super_admin', 'admin'].includes(profile.role);
  });
}

export function bindLogoutButtons() {
  document.querySelectorAll('[data-logout]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      await supabase.auth.signOut({ scope: 'local' });
      window.location.replace('./login.html');
    });
  });
}
