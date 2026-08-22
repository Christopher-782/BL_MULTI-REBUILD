import { withSupabase } from 'npm:@supabase/server@^1'

const PROVIDER = String(Deno.env.get('SMS_PROVIDER') || 'bulksms').trim().toLowerCase()
const API_TOKEN = Deno.env.get('BULKSMS_TOKEN') || ''
const SENDER_ID = Deno.env.get('SMS_SENDER_ID') || Deno.env.get('BULKSMS_SENDER_ID') || ''
const TEST_MODE = String(Deno.env.get('SMS_TEST_MODE') ?? Deno.env.get('TEST_MODE') ?? 'true').toLowerCase() === 'true'
const GATEWAY = Deno.env.get('SMS_GATEWAY') || 'direct-refund'

const PROD_URL = 'https://www.bulksmsnigeria.com/api/v2/sms'
const SANDBOX_URL = 'https://www.bulksmsnigeria.com/api/sandbox/v2/sms'

function responseError(message: string, status = 400, code = 'bad_request') {
  return Response.json({ error: message, code }, { status })
}

function cleanText(value: unknown, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}


function cleanMessage(value: unknown) {
  return String(value ?? '')
    .replace(/₦/g, 'N')
    .replace(/\r\n/g, '\n')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1530)
}

function formatPhoneNumber(value: unknown) {
  let digits = String(value ?? '').replace(/\D/g, '')

  if (!digits) return null

  if (digits.startsWith('00234')) digits = digits.slice(2)
  if (digits.startsWith('0') && digits.length === 11) {
    digits = `234${digits.slice(1)}`
  } else if (digits.length === 10 && /^[789]/.test(digits)) {
    digits = `234${digits}`
  }

  return /^234\d{10}$/.test(digits) ? digits : null
}

function naira(minor: unknown) {
  const value = Number(minor ?? 0) / 100
  return new Intl.NumberFormat('en-NG', {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value)
}

function percentFromBps(bps: unknown) {
  return (Number(bps ?? 0) / 100).toFixed(2).replace(/\.00$/, '')
}

function eventDate(value: unknown) {
  const date = value ? new Date(String(value)) : new Date()
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

function reason(value: unknown) {
  return cleanText(value || 'Please contact us for more information.', 180)
}

function messageFor(item: any) {
  const p = item?.payload || {}
  const name = cleanText(p.customer_name || 'Customer', 80)
  const date = eventDate(p.event_at)
  const brand = 'BL MULTI CONCEPT'

  if (item.event_type === 'transaction.approved') {
    const type = String(p.transaction_type || '')
    const label =
      type === 'deposit' ? 'CR ALERT'
      : type === 'withdrawal' ? 'DR ALERT'
      : 'REVERSAL ALERT'

    const lines = [
      brand,
      '',
      label,
      `Amount: N${naira(p.amount_minor)}`,
    ]

    if (Number(p.charge_minor || 0) > 0) {
      lines.push(`Charges: N${naira(p.charge_minor)}`)
    }

    if (type === 'deposit' && Number(p.net_amount_minor || 0) !== Number(p.amount_minor || 0)) {
      lines.push(`Net Credit: N${naira(p.net_amount_minor)}`)
    }

    if (p.balance_after_minor !== null && p.balance_after_minor !== undefined) {
      lines.push(`Balance: N${naira(p.balance_after_minor)}`)
    }

    lines.push(`Date: ${date}`, `Ref: ${p.reference}`, '', 'Thank you for trusting us.')
    return lines.join('\n')
  }

  if (item.event_type === 'transaction.rejected') {
    return [
      brand,
      '',
      'TRANSACTION DECLINED',
      `Type: ${String(p.transaction_type || '').replaceAll('_', ' ').toUpperCase()}`,
      `Amount: N${naira(p.amount_minor)}`,
      `Ref: ${p.reference}`,
      `Reason: ${reason(p.rejection_reason)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  if (item.event_type === 'loan.approved') {
    return [
      brand,
      '',
      'LOAN DISBURSEMENT',
      `Dear ${name},`,
      `Loan: ${p.loan_number}`,
      `Amount: N${naira(p.principal_minor)}`,
      `Interest: ${percentFromBps(p.interest_rate_bps)}% (N${naira(p.interest_minor)})`,
      `Total Repayable: N${naira(p.total_payable_minor)}`,
      `Due: ${p.due_date || 'N/A'}`,
      `Account Balance: N${naira(p.balance_after_minor)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  if (item.event_type === 'loan.rejected') {
    return [
      brand,
      '',
      'LOAN REQUEST DECLINED',
      `Dear ${name},`,
      `Loan: ${p.loan_number}`,
      `Amount: N${naira(p.principal_minor)}`,
      `Reason: ${reason(p.rejection_reason)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  if (item.event_type === 'loan_repayment.approved') {
    const remaining =
      Number(p.principal_outstanding_minor || 0) +
      Number(p.interest_outstanding_minor || 0)

    const lines = [
      brand,
      '',
      'LOAN REPAYMENT RECEIVED',
      `Dear ${name},`,
      `Loan: ${p.loan_number}`,
      `Receipt: ${p.repayment_number}`,
      `Amount: N${naira(p.amount_minor)}`,
      `Principal: N${naira(p.principal_component_minor)}`,
      `Interest: N${naira(p.interest_component_minor)}`,
      `Remaining: N${naira(remaining)}`,
    ]

    if (String(p.loan_status) === 'paid') {
      lines.push('Status: LOAN FULLY REPAID')
    }

    lines.push(`Date: ${date}`, '', 'Thank you for your payment.')
    return lines.join('\n')
  }

  if (item.event_type === 'loan_repayment.rejected') {
    return [
      brand,
      '',
      'LOAN REPAYMENT DECLINED',
      `Dear ${name},`,
      `Loan: ${p.loan_number}`,
      `Receipt: ${p.repayment_number}`,
      `Amount: N${naira(p.amount_minor)}`,
      `Reason: ${reason(p.rejection_reason)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  if (item.event_type === 'overdraft.approved') {
    return [
      brand,
      '',
      'OVERDRAFT APPROVED',
      `Dear ${name},`,
      `Ref: ${p.overdraft_number}`,
      `Payout: N${naira(p.requested_amount_minor)}`,
      `Charge: N${naira(p.charge_minor)}`,
      `Account Balance: N${naira(p.balance_after_minor)}`,
      `Outstanding Exposure: N${naira(p.exposure_after_minor)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  if (item.event_type === 'overdraft.rejected') {
    return [
      brand,
      '',
      'OVERDRAFT REQUEST DECLINED',
      `Dear ${name},`,
      `Ref: ${p.overdraft_number}`,
      `Amount: N${naira(p.requested_amount_minor)}`,
      `Reason: ${reason(p.rejection_reason)}`,
      `Date: ${date}`,
    ].join('\n')
  }

  return `${brand}\n\nAccount notification.\nRef: ${cleanText(item.event_key, 100)}`
}

function providerConfigured() {
  return ['bulksms', 'bulksmsnigeria'].includes(PROVIDER) &&
    Boolean(API_TOKEN) &&
    Boolean(SENDER_ID) &&
    SENDER_ID.length <= 11
}

async function providerSend(phone: string, body: string) {
  if (!providerConfigured()) {
    throw new Error(
      'SMS provider is not fully configured. Set SMS_PROVIDER=bulksms, BULKSMS_TOKEN, and an approved SMS_SENDER_ID of 11 characters or fewer.',
    )
  }

  const url = TEST_MODE ? SANDBOX_URL : PROD_URL

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: SENDER_ID,
      to: phone,
      body: cleanMessage(body),
      gateway: GATEWAY,
    }),
  })

  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || (data?.status && data.status !== 'success')) {
    const detail =
      cleanText(data?.message || data?.error || `Provider HTTP ${response.status}`, 300)
    throw new Error(detail || 'SMS provider rejected the request.')
  }

  return {
    providerMessageId:
      cleanText(
        data?.data?.message_id ||
        data?.message_id ||
        data?.data?.id ||
        '',
        160,
      ) || null,
  }
}

async function getActor(supabaseAdmin: any, ctx: any) {
  const actorId = ctx.userClaims?.id ?? ctx.jwtClaims?.sub
  const actorEmail = ctx.userClaims?.email ?? ctx.jwtClaims?.email ?? null

  if (!actorId) return null

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, status')
    .eq('id', actorId)
    .single()

  if (error || !profile) return null
  return { ...profile, email: actorEmail }
}

function canDispatch(role: string) {
  return ['super_admin', 'admin', 'manager'].includes(role)
}

function canConfigure(role: string) {
  return ['super_admin', 'admin'].includes(role)
}

async function complete(
  supabaseAdmin: any,
  id: string,
  status: 'sent' | 'failed' | 'skipped',
  providerMessageId: string | null,
  errorText: string | null,
) {
  const { error } = await supabaseAdmin.rpc('complete_sms_outbox_item', {
    p_id: id,
    p_status: status,
    p_provider_message_id: providerMessageId,
    p_error_text: errorText,
  })

  if (error) console.error('SMS completion update failed:', error)
}

async function dispatchQueue(supabaseAdmin: any, requestedLimit: unknown) {
  if (!providerConfigured()) {
    return {
      configured: false,
      provider: PROVIDER,
      testMode: TEST_MODE,
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      error: 'SMS provider is not fully configured.',
    }
  }

  const limit = Math.min(Math.max(Number(requestedLimit) || 25, 1), 100)

  const { data: items, error } = await supabaseAdmin.rpc('claim_sms_outbox', {
    p_limit: limit,
  })

  if (error) throw error

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const item of items || []) {
    const phone = formatPhoneNumber(item.phone)

    if (!phone) {
      skipped += 1
      await complete(
        supabaseAdmin,
        item.id,
        'skipped',
        null,
        'Invalid or unsupported Nigerian phone number.',
      )
      continue
    }

    try {
      const body = messageFor(item)
      const result = await providerSend(phone, body)
      sent += 1
      await complete(
        supabaseAdmin,
        item.id,
        'sent',
        result.providerMessageId,
        null,
      )
    } catch (sendError) {
      failed += 1
      await complete(
        supabaseAdmin,
        item.id,
        'failed',
        null,
        cleanText(sendError?.message || sendError, 800),
      )
    }
  }

  return {
    configured: true,
    provider: PROVIDER,
    testMode: TEST_MODE,
    processed: (items || []).length,
    sent,
    failed,
    skipped,
  }
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return responseError('Method not allowed.', 405, 'method_not_allowed')
    }

    const { supabaseAdmin } = ctx
    const actor = await getActor(supabaseAdmin, ctx)

    if (!actor || actor.status !== 'active') {
      return responseError('Your staff account is not active.', 403, 'inactive_account')
    }

    let payload: any = {}
    try {
      payload = await req.json()
    } catch {
      payload = {}
    }

    const action = cleanText(payload?.action || 'dispatch', 30)

    if (action === 'dispatch') {
      if (!canDispatch(actor.role)) {
        return responseError('You do not have permission to dispatch SMS alerts.', 403, 'forbidden')
      }

      try {
        return Response.json(await dispatchQueue(supabaseAdmin, payload?.limit))
      } catch (error) {
        console.error('SMS dispatch error:', error)
        return responseError('Unable to process the SMS queue.', 500, 'dispatch_failed')
      }
    }

    if (action === 'status') {
      if (!canConfigure(actor.role)) {
        return responseError('You do not have permission to view SMS configuration.', 403, 'forbidden')
      }

      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)

      const [
        { count: pending },
        { count: failed },
        { count: sentToday },
        { count: skipped },
      ] = await Promise.all([
        supabaseAdmin.from('sms_outbox').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabaseAdmin.from('sms_outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
        supabaseAdmin.from('sms_outbox').select('id', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', today.toISOString()),
        supabaseAdmin.from('sms_outbox').select('id', { count: 'exact', head: true }).eq('status', 'skipped'),
      ])

      return Response.json({
        provider: 'BulkSMS Nigeria',
        configured: providerConfigured(),
        testMode: TEST_MODE,
        senderId: SENDER_ID || null,
        gateway: GATEWAY,
        queue: {
          pending: pending ?? 0,
          failed: failed ?? 0,
          sentToday: sentToday ?? 0,
          skipped: skipped ?? 0,
        },
      })
    }

    if (action === 'test') {
      if (!canConfigure(actor.role)) {
        return responseError('You do not have permission to send a test SMS.', 403, 'forbidden')
      }

      const phone = formatPhoneNumber(payload?.phone)
      if (!phone) {
        return responseError('Enter a valid Nigerian phone number.', 422, 'invalid_phone')
      }

      const custom = cleanText(payload?.message, 500)
      const body = custom
        ? `BL MULTI CONCEPT\n\n${custom}`
        : `BL MULTI CONCEPT\n\nSMS TEST\nYour SMS integration is working.\nDate: ${eventDate(new Date().toISOString())}`

      try {
        const result = await providerSend(phone, body)

        await supabaseAdmin.from('audit_logs').insert({
          actor_id: actor.id,
          actor_name: actor.full_name || null,
          actor_email: actor.email || null,
          action: 'sms.test_sent',
          entity_type: 'sms',
          entity_id: null,
          description: 'Sent an SMS configuration test.',
          metadata: {
            provider: PROVIDER,
            test_mode: TEST_MODE,
            phone_last4: phone.slice(-4),
            provider_message_id: result.providerMessageId,
          },
        })

        return Response.json({
          ok: true,
          testMode: TEST_MODE,
          providerMessageId: result.providerMessageId,
        })
      } catch (error) {
        return responseError(
          cleanText(error?.message || 'SMS test failed.', 300),
          502,
          'provider_error',
        )
      }
    }

    return responseError('Unknown SMS action.', 400, 'unknown_action')
  }),
}
