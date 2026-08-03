import { supabase } from '../config/supabase.js';

function normalizeFunctionError(error, fallback = 'SMS service request failed.') {
  if (!error) return new Error(fallback);

  const contextMessage =
    error?.context?.body?.error ||
    error?.context?.error ||
    error?.message;

  return new Error(contextMessage || fallback);
}

export async function dispatchSmsAlerts(limit = 25) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const { data, error } = await supabase.functions.invoke('sms-alerts', {
    body: {
      action: 'dispatch',
      limit: safeLimit,
    },
  });

  if (error) {
    throw normalizeFunctionError(error, 'Unable to dispatch SMS alerts.');
  }

  return data;
}

export function kickSmsDispatcher(limit = 25) {
  dispatchSmsAlerts(limit).catch((error) => {
    // Financial operations must remain successful even if the external
    // SMS provider is temporarily unavailable. Failed queue items remain
    // retryable in sms_outbox.
    console.warn('SMS alert dispatch deferred:', error.message);
  });
}

export async function getSmsStatus() {
  const { data, error } = await supabase.functions.invoke('sms-alerts', {
    body: { action: 'status' },
  });

  if (error) {
    throw normalizeFunctionError(error, 'Unable to load SMS configuration.');
  }

  return data;
}

export async function sendTestSms({ phone, message = '' }) {
  const { data, error } = await supabase.functions.invoke('sms-alerts', {
    body: {
      action: 'test',
      phone,
      message,
    },
  });

  if (error) {
    throw normalizeFunctionError(error, 'Unable to send the test SMS.');
  }

  return data;
}
