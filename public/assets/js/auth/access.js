import { supabase } from '../config/supabase.js';
import { requireAuth } from './session.js';

export function humanizeRole(role = '') {
  return String(role).replaceAll('_', ' ');
}

const STAFF_ALLOWED_PAGES = new Set(['transactions.html']);

function currentPageName() {
  const value = window.location.pathname.split('/').pop() || 'dashboard.html';
  return value.toLowerCase();
}

export function landingPageForRole(role) {
  return role === 'staff' ? './transactions.html' : './dashboard.html';
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

  const landingPage = landingPageForRole(profile.role);

  if (
    profile.role === 'staff' &&
    !STAFF_ALLOWED_PAGES.has(currentPageName())
  ) {
    window.location.replace(landingPage);
    return null;
  }

  if (roles.length && !roles.includes(profile.role)) {
    window.location.replace(landingPage);
    return null;
  }

  return { user, profile };
}

const APPROVAL_ROLES = new Set(['super_admin', 'admin', 'manager']);

function ensureApprovalNotificationStyles() {
  if (document.querySelector('#approvalNotificationStyles')) return;

  const style = document.createElement('style');
  style.id = 'approvalNotificationStyles';
  style.textContent = `
    .approval-notification {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 7px 10px;
      border: 1px solid #f2c46d;
      border-radius: 12px;
      background: #fff8e8;
      color: #8a4b08;
      text-decoration: none;
      font-size: 0.78rem;
      font-weight: 800;
      line-height: 1.15;
      box-shadow: 0 8px 24px rgba(138, 75, 8, 0.09);
      transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
      white-space: nowrap;
    }

    .approval-notification:hover {
      transform: translateY(-1px);
      border-color: #e5a83d;
      box-shadow: 0 10px 28px rgba(138, 75, 8, 0.14);
    }

    .approval-notification[hidden] {
      display: none !important;
    }

    .approval-notification-icon {
      position: relative;
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
    }

    .approval-notification-icon svg {
      display: block;
      width: 18px;
      height: 18px;
    }

    .approval-notification-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      border-radius: 999px;
      background: #b54708;
      color: #fff;
      font-size: 0.72rem;
      font-weight: 900;
    }

    .approval-notification.is-loading .approval-notification-count {
      background: #d9a441;
    }

    .approval-notification.is-new {
      animation: approvalNotificationPulse 900ms ease 1;
    }

    @keyframes approvalNotificationPulse {
      0%, 100% { transform: scale(1); }
      45% { transform: scale(1.035); }
    }

    @media (max-width: 760px) {
      .approval-notification-label {
        display: none;
      }

      .approval-notification {
        padding: 7px 9px;
      }
    }
  `;
  document.head.append(style);
}

function getApprovalNotificationHost() {
  return (
    document.querySelector('.topbar-actions') ||
    document.querySelector('.header-actions') ||
    document.querySelector('.top-header .header-actions') ||
    null
  );
}

function ensureApprovalNotification() {
  let link = document.querySelector('#pendingApprovalNotification');
  if (link) return link;

  ensureApprovalNotificationStyles();

  link = document.createElement('a');
  link.id = 'pendingApprovalNotification';
  link.className = 'approval-notification is-loading';
  link.href = './transactions.html#bulkApprovalPanel';
  link.hidden = true;
  link.setAttribute('aria-label', 'Pending transactions awaiting approval');
  link.innerHTML = `
    <span class="approval-notification-icon" aria-hidden="true">
      <svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
    </span>
    <span class="approval-notification-label">Pending approvals</span>
    <span class="approval-notification-count" data-pending-approval-count>0</span>
  `;

  const host = getApprovalNotificationHost();
  if (host) {
    host.insertBefore(link, host.firstChild);
  } else {
    link.style.position = 'fixed';
    link.style.right = '18px';
    link.style.bottom = '18px';
    link.style.zIndex = '1000';
    document.body.append(link);
  }

  return link;
}

async function loadPendingApprovalCount(profile) {
  let query = supabase
    .from('transaction_directory')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (profile?.id) {
    query = query.neq('initiated_by', profile.id);
  }

  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

async function refreshPendingApprovalNotification(profile) {
  if (!APPROVAL_ROLES.has(profile?.role)) return;

  const link = ensureApprovalNotification();

  try {
    const count = await loadPendingApprovalCount(profile);
    const countElement = link.querySelector('[data-pending-approval-count]');
    const previousCount = Number(link.dataset.pendingCount || 0);

    link.classList.remove('is-loading');
    link.dataset.pendingCount = String(count);
    link.hidden = count <= 0;

    if (countElement) {
      countElement.textContent = count > 99 ? '99+' : String(count);
    }

    link.setAttribute(
      'aria-label',
      count === 1
        ? '1 transaction is awaiting your approval'
        : `${count} transactions are awaiting your approval`,
    );
    link.title = count === 1
      ? '1 transaction is awaiting approval'
      : `${count} transactions are awaiting approval`;

    if (count > previousCount && previousCount !== 0) {
      link.classList.remove('is-new');
      requestAnimationFrame(() => link.classList.add('is-new'));
      window.setTimeout(() => link.classList.remove('is-new'), 1000);
    }
  } catch (error) {
    console.warn('Unable to load pending approval notification:', error);
    link.hidden = true;
  }
}

function bindPendingApprovalNotification(profile) {
  if (!APPROVAL_ROLES.has(profile?.role)) return;

  refreshPendingApprovalNotification(profile);

  if (window.__blPendingApprovalTimer) {
    window.clearInterval(window.__blPendingApprovalTimer);
  }

  window.__blPendingApprovalTimer = window.setInterval(() => {
    refreshPendingApprovalNotification(profile);
  }, 60000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPendingApprovalNotification(profile);
  });

  window.addEventListener('bl:approvals-changed', () => {
    refreshPendingApprovalNotification(profile);
  });
}

export function bindSessionUI(profile, user) {
  const displayName = profile.full_name || user.email || 'Staff member';
  const staffTransactionOnly = profile.role === 'staff';

  document.documentElement.dataset.appRole = profile.role;

  document.querySelectorAll('[data-session-name]').forEach((element) => {
    element.textContent = displayName;
  });

  document.querySelectorAll('[data-session-role]').forEach((element) => {
    element.textContent = staffTransactionOnly
      ? 'Transaction staff'
      : humanizeRole(profile.role);
  });

  document.querySelectorAll('[data-admin-only]').forEach((element) => {
    element.hidden = !['super_admin', 'admin'].includes(profile.role);
  });

  document.querySelectorAll('[data-management-only]').forEach((element) => {
    element.hidden = staffTransactionOnly;
  });

  if (staffTransactionOnly) {
    document.body.classList.add('staff-transaction-only');

    document.querySelectorAll('.sidebar-brand').forEach((brand) => {
      brand.href = './transactions.html';
      brand.setAttribute('aria-label', 'BL Multi Concept transactions');
    });

    document.querySelectorAll('.sidebar .nav-link[href]').forEach((link) => {
      const href = String(link.getAttribute('href') || '').split('?')[0].split('#')[0];
      link.hidden = !href.endsWith('transactions.html');
    });

    document.querySelectorAll('.sidebar .nav-label').forEach((label) => {
      label.hidden = true;
    });
  }

  bindPendingApprovalNotification(profile);
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
