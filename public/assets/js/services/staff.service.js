import { supabase } from '../config/supabase.js';

async function callStaffAdmin(body) {
  const { data, error } = await supabase.functions.invoke('staff-admin', { body });

  if (error) {
    let message = error.message || 'Staff administration request failed.';

    try {
      const context = error.context;
      if (context && typeof context.json === 'function') {
        const details = await context.json();
        message = details?.error || message;
      }
    } catch {
      // Keep the original SDK error message.
    }

    throw new Error(message);
  }

  if (data?.error) throw new Error(data.error);
  return data;
}

export function listStaff(page = 1, perPage = 100) {
  return callStaffAdmin({ action: 'list', page, perPage });
}

export function createStaff(payload) {
  return callStaffAdmin({ action: 'create', ...payload });
}

export function updateStaff(payload) {
  return callStaffAdmin({ action: 'update', ...payload });
}
