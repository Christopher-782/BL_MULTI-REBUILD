import { supabase } from '../config/supabase.js';

export async function getManagementReport(
  fromDate,
  toDate,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'get_management_report',
    {
      p_from:
        fromDate,

      p_to:
        toDate,
    },
  );

  if (error) {
    throw new Error(
      error.message ||
      'Unable to generate report.',
    );
  }

  return data;
}
