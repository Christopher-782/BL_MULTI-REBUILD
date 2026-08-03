import { withSupabase } from 'npm:@supabase/server@^1'

const VALID_ROLES = ['super_admin', 'admin', 'manager', 'staff', 'auditor']
const VALID_STATUSES = ['active', 'suspended', 'disabled']

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

function cleanText(value, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function actorCanAssign(actorRole, targetRole) {
  if (actorRole === 'super_admin') return VALID_ROLES.includes(targetRole)
  if (actorRole === 'admin') return ['manager', 'staff', 'auditor'].includes(targetRole)
  return false
}

function responseError(message, status = 400, code = 'bad_request') {
  return Response.json({ error: message, code }, { status })
}

async function writeAudit(supabaseAdmin, actor, action, entityType, entityId, description, metadata = {}) {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    actor_id: actor.id,
    actor_name: actor.full_name || null,
    actor_email: actor.email || null,
    action,
    entity_type: entityType,
    entity_id: entityId || null,
    description,
    metadata,
  })

  if (error) {
    console.error('Audit insert failed:', error)
    throw new Error('The action completed but the audit record could not be written.')
  }
}

async function getActor(supabaseAdmin, ctx) {
  const actorId = ctx.userClaims?.id ?? ctx.jwtClaims?.sub
  const actorEmail = ctx.userClaims?.email ?? ctx.jwtClaims?.email ?? null

  if (!actorId) return null

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, phone, role, status')
    .eq('id', actorId)
    .single()

  if (error || !profile) return null

  return { ...profile, email: actorEmail }
}

async function ensureLastSuperAdminIsProtected(supabaseAdmin, targetProfile, nextRole, nextStatus) {
  const removesActiveSuperAdmin =
    targetProfile.role === 'super_admin' &&
    targetProfile.status === 'active' &&
    (nextRole !== 'super_admin' || nextStatus !== 'active')

  if (!removesActiveSuperAdmin) return null

  const { count, error } = await supabaseAdmin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin')
    .eq('status', 'active')

  if (error) throw error

  if ((count ?? 0) <= 1) {
    return responseError(
      'You cannot demote or suspend the last active super administrator.',
      409,
      'last_super_admin',
    )
  }

  return null
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

    if (!['super_admin', 'admin'].includes(actor.role)) {
      return responseError('You do not have permission to manage staff.', 403, 'forbidden')
    }

    let payload
    try {
      payload = await req.json()
    } catch {
      return responseError('Invalid JSON request.', 400, 'invalid_json')
    }

    const action = cleanText(payload?.action, 40)

    if (action === 'list') {
      const page = Math.max(Number(payload?.page) || 1, 1)
      const perPage = Math.min(Math.max(Number(payload?.perPage) || 100, 1), 250)

      const [{ data: authData, error: authError }, { data: profiles, error: profileError }] =
        await Promise.all([
          supabaseAdmin.auth.admin.listUsers({ page, perPage }),
          supabaseAdmin
            .from('profiles')
            .select('id, full_name, phone, role, status, created_at, updated_at')
            .order('created_at', { ascending: false }),
        ])

      if (authError) return responseError(authError.message, 500, 'auth_list_failed')
      if (profileError) return responseError(profileError.message, 500, 'profile_list_failed')

      const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile]))
      const staff = (authData?.users ?? []).map((user) => {
        const profile = profileMap.get(user.id) ?? {}
        return {
          id: user.id,
          email: user.email ?? '',
          emailConfirmedAt: user.email_confirmed_at ?? null,
          lastSignInAt: user.last_sign_in_at ?? null,
          authCreatedAt: user.created_at ?? null,
          fullName: profile.full_name ?? '',
          phone: profile.phone ?? '',
          role: profile.role ?? 'staff',
          status: profile.status ?? 'active',
          profileCreatedAt: profile.created_at ?? null,
          profileUpdatedAt: profile.updated_at ?? null,
        }
      })

      return Response.json({ staff, actorRole: actor.role, page, perPage })
    }

    if (action === 'create') {
      const email = normalizeEmail(payload?.email)
      const fullName = cleanText(payload?.fullName, 120)
      const phone = cleanText(payload?.phone, 40)
      const role = cleanText(payload?.role || 'staff', 30)
      const password = String(payload?.password ?? '')

      if (!email || !email.includes('@')) {
        return responseError('Enter a valid staff email address.', 422, 'invalid_email')
      }
      if (!fullName) {
        return responseError('Full name is required.', 422, 'missing_full_name')
      }
      if (password.length < 8 || password.length > 128) {
        return responseError('Password must be between 8 and 128 characters.', 422, 'invalid_password')
      }
      if (!actorCanAssign(actor.role, role)) {
        return responseError('You cannot assign that role.', 403, 'role_not_allowed')
      }

      const { data: createData, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        })

      if (createError) {
        return responseError(createError.message, createError.status || 400, 'create_user_failed')
      }

      const userId = createData?.user?.id
      if (!userId) return responseError('Supabase did not return the created user.', 500, 'create_missing_user')

      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .upsert(
          {
            id: userId,
            full_name: fullName,
            phone: phone || null,
            role,
            status: 'active',
          },
          { onConflict: 'id' },
        )

      if (profileError) {
        await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {})
        return responseError(profileError.message, 500, 'profile_setup_failed')
      }

      try {
        await writeAudit(
          supabaseAdmin,
          actor,
          'staff.created',
          'staff',
          userId,
          `${actor.full_name || actor.email || 'Administrator'} created ${email} as ${role}.`,
          { email, role },
        )
      } catch (error) {
        return responseError(error.message, 500, 'audit_failed')
      }

      return Response.json({
        ok: true,
        staff: { id: userId, email, fullName, phone, role, status: 'active' },
      })
    }

    if (action === 'update') {
      const targetId = cleanText(payload?.staffId, 80)
      const fullName = cleanText(payload?.fullName, 120)
      const phone = cleanText(payload?.phone, 40)
      const role = cleanText(payload?.role, 30)
      const status = cleanText(payload?.status, 30)
      const newPassword = payload?.newPassword ? String(payload.newPassword) : ''

      if (!targetId) return responseError('Staff ID is required.', 422, 'missing_staff_id')
      if (!fullName) return responseError('Full name is required.', 422, 'missing_full_name')
      if (!VALID_ROLES.includes(role)) return responseError('Invalid staff role.', 422, 'invalid_role')
      if (!VALID_STATUSES.includes(status)) return responseError('Invalid staff status.', 422, 'invalid_status')
      if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
        return responseError('New password must be between 8 and 128 characters.', 422, 'invalid_password')
      }
      if (!actorCanAssign(actor.role, role)) {
        return responseError('You cannot assign that role.', 403, 'role_not_allowed')
      }

      const { data: target, error: targetError } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, phone, role, status')
        .eq('id', targetId)
        .single()

      if (targetError || !target) return responseError('Staff member was not found.', 404, 'staff_not_found')

      if (actor.role !== 'super_admin' && target.role === 'super_admin') {
        return responseError('Only a super administrator can modify another super administrator.', 403, 'protected_role')
      }

      if (targetId === actor.id && (role !== actor.role || status !== actor.status)) {
        return responseError('You cannot change your own role or account status.', 409, 'self_lockout_protection')
      }

      const lastAdminProtection = await ensureLastSuperAdminIsProtected(
        supabaseAdmin,
        target,
        role,
        status,
      )
      if (lastAdminProtection) return lastAdminProtection

      const before = {
        fullName: target.full_name,
        phone: target.phone,
        role: target.role,
        status: target.status,
      }

      if (newPassword) {
        const { error: passwordError } = await supabaseAdmin.auth.admin.updateUserById(
          targetId,
          { password: newPassword },
        )

        if (passwordError) {
          return responseError(passwordError.message, passwordError.status || 400, 'password_update_failed')
        }
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
          full_name: fullName,
          phone: phone || null,
          role,
          status,
        })
        .eq('id', targetId)
        .select('id, full_name, phone, role, status, created_at, updated_at')
        .single()

      if (updateError) return responseError(updateError.message, 500, 'profile_update_failed')

      try {
        await writeAudit(
          supabaseAdmin,
          actor,
          'staff.updated',
          'staff',
          targetId,
          `${actor.full_name || actor.email || 'Administrator'} updated a staff account.`,
          {
            before,
            after: {
              fullName: updated.full_name,
              phone: updated.phone,
              role: updated.role,
              status: updated.status,
            },
            passwordReset: Boolean(newPassword),
          },
        )
      } catch (error) {
        return responseError(error.message, 500, 'audit_failed')
      }

      return Response.json({ ok: true, staff: updated })
    }

    return responseError('Unknown staff administration action.', 400, 'unknown_action')
  }),
}
