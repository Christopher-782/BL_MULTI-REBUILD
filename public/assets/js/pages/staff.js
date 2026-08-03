import { supabase } from '../config/supabase.js';
import { bindLogoutButtons, bindSessionUI, humanizeRole, requireActiveProfile } from '../auth/access.js';
import { createStaff, listStaff, updateStaff } from '../services/staff.service.js';

const session = await requireActiveProfile({ roles: ['super_admin', 'admin'] });

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const state = {
    actorRole: session.profile.role,
    staff: [],
  };

  const tableBody = document.querySelector('#staffTableBody');
  const emptyState = document.querySelector('#staffEmptyState');
  const pageMessage = document.querySelector('#pageMessage');
  const createForm = document.querySelector('#createStaffForm');
  const editDialog = document.querySelector('#editStaffDialog');
  const editForm = document.querySelector('#editStaffForm');

  function showMessage(message, type = 'success') {
    pageMessage.textContent = message;
    pageMessage.dataset.type = type;
    pageMessage.hidden = false;
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => {
      pageMessage.hidden = true;
    }, 5500);
  }

  function allowedRoles() {
    return state.actorRole === 'super_admin'
      ? ['super_admin', 'admin', 'manager', 'staff', 'auditor']
      : ['manager', 'staff', 'auditor'];
  }

  function fillRoleSelect(select, currentRole = '') {
    select.replaceChildren();

    const roles = allowedRoles();
    if (currentRole && !roles.includes(currentRole)) roles.unshift(currentRole);

    roles.forEach((role) => {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = humanizeRole(role);
      select.append(option);
    });
  }

  function formatDate(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function makeCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text ?? '—';
    if (className) cell.className = className;
    return cell;
  }

  function roleBadge(role) {
    const badge = document.createElement('span');
    badge.className = 'role-badge';
    badge.dataset.role = role;
    badge.textContent = humanizeRole(role);
    return badge;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    badge.dataset.status = status;
    badge.textContent = status;
    return badge;
  }

  function renderSummary() {
    document.querySelector('#totalStaff').textContent = state.staff.length;
    document.querySelector('#activeStaff').textContent = state.staff.filter((item) => item.status === 'active').length;
    document.querySelector('#privilegedStaff').textContent = state.staff.filter((item) => ['super_admin', 'admin'].includes(item.role)).length;
    document.querySelector('#suspendedStaff').textContent = state.staff.filter((item) => item.status !== 'active').length;
  }

  function canEdit(target) {
    if (state.actorRole === 'super_admin') return true;
    return target.role !== 'super_admin';
  }

  function openEditDialog(staff) {
    editForm.elements.staffId.value = staff.id;
    editForm.elements.fullName.value = staff.fullName || '';
    editForm.elements.phone.value = staff.phone || '';
    fillRoleSelect(editForm.elements.role, staff.role);
    editForm.elements.role.value = staff.role;
    editForm.elements.status.value = staff.status;
    editForm.elements.newPassword.value = '';
    editForm.elements.confirmNewPassword.value = '';

    const isSelf = staff.id === session.user.id;
    editForm.elements.role.disabled = isSelf;
    editForm.elements.status.disabled = isSelf;
    document.querySelector('#editLockoutNote').hidden = !isSelf;

    editDialog.showModal();
  }

  function renderStaff() {
    tableBody.replaceChildren();
    emptyState.hidden = state.staff.length > 0;

    state.staff.forEach((staff) => {
      const row = document.createElement('tr');

      const personCell = document.createElement('td');
      const personName = document.createElement('strong');
      personName.textContent = staff.fullName || 'Unnamed staff';
      const personEmail = document.createElement('small');
      personEmail.textContent = staff.email || 'No email';
      personCell.append(personName, personEmail);

      const roleCell = document.createElement('td');
      roleCell.append(roleBadge(staff.role));

      const statusCell = document.createElement('td');
      statusCell.append(statusBadge(staff.status));

      const lastSignInCell = makeCell(formatDate(staff.lastSignInAt));
      const createdCell = makeCell(formatDate(staff.authCreatedAt));

      const actionCell = document.createElement('td');
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'secondary-button compact';
      editButton.textContent = 'Edit';
      editButton.disabled = !canEdit(staff);
      editButton.addEventListener('click', () => openEditDialog(staff));
      actionCell.append(editButton);

      row.append(personCell, roleCell, statusCell, lastSignInCell, createdCell, actionCell);
      tableBody.append(row);
    });

    renderSummary();
  }

  async function loadStaff() {
    tableBody.replaceChildren();
    emptyState.hidden = true;
    document.querySelector('#staffLoading').hidden = false;

    try {
      const data = await listStaff();
      state.staff = data.staff ?? [];
      state.actorRole = data.actorRole || state.actorRole;
      fillRoleSelect(createForm.elements.role);
      renderStaff();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      document.querySelector('#staffLoading').hidden = true;
    }
  }

  async function loadAuditLogs() {
    const body = document.querySelector('#auditTableBody');
    const empty = document.querySelector('#auditEmptyState');

    const { data, error } = await supabase
      .from('audit_logs')
      .select('id, actor_name, actor_email, action, entity_type, description, created_at')
      .order('created_at', { ascending: false })
      .limit(25);

    if (error) {
      console.error('Audit log query failed:', error);
      return;
    }

    body.replaceChildren();
    empty.hidden = (data?.length ?? 0) > 0;

    (data ?? []).forEach((entry) => {
      const row = document.createElement('tr');
      row.append(
        makeCell(formatDate(entry.created_at)),
        makeCell(entry.actor_name || entry.actor_email || 'System'),
        makeCell(entry.action),
        makeCell(entry.description || `${entry.action} on ${entry.entity_type}`),
      );
      body.append(row);
    });
  }

  createForm.elements.showPassword.addEventListener('change', () => {
    const type = createForm.elements.showPassword.checked ? 'text' : 'password';
    createForm.elements.password.type = type;
    createForm.elements.confirmPassword.type = type;
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitButton = createForm.querySelector('button[type="submit"]');
    const password = createForm.elements.password.value;
    const confirmPassword = createForm.elements.confirmPassword.value;

    if (password.length < 8) {
      showMessage('Password must be at least 8 characters.', 'error');
      return;
    }

    if (password !== confirmPassword) {
      showMessage('Password and confirm password do not match.', 'error');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Creating account...';

    try {
      await createStaff({
        fullName: createForm.elements.fullName.value,
        email: createForm.elements.email.value,
        phone: createForm.elements.phone.value,
        role: createForm.elements.role.value,
        password,
      });

      createForm.reset();
      createForm.elements.password.type = 'password';
      createForm.elements.confirmPassword.type = 'password';
      fillRoleSelect(createForm.elements.role);
      showMessage('Staff account created successfully. They can log in immediately with the password you set.');
      await Promise.all([loadStaff(), loadAuditLogs()]);
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Create staff account';
    }
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitButton = editForm.querySelector('button[type="submit"]');
    const staffId = editForm.elements.staffId.value;
    const existing = state.staff.find((item) => item.id === staffId);
    const newPassword = editForm.elements.newPassword.value;
    const confirmNewPassword = editForm.elements.confirmNewPassword.value;

    if (newPassword && newPassword.length < 8) {
      showMessage('New password must be at least 8 characters.', 'error');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      showMessage('New password and confirmation do not match.', 'error');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    try {
      await updateStaff({
        staffId,
        fullName: editForm.elements.fullName.value,
        phone: editForm.elements.phone.value,
        role: editForm.elements.role.disabled ? existing.role : editForm.elements.role.value,
        status: editForm.elements.status.disabled ? existing.status : editForm.elements.status.value,
        newPassword: newPassword || null,
      });

      editDialog.close();
      showMessage('Staff account updated successfully.');
      await Promise.all([loadStaff(), loadAuditLogs()]);
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Save changes';
    }
  });

  document.querySelector('#closeEditDialog').addEventListener('click', () => editDialog.close());
  document.querySelector('#cancelEditDialog').addEventListener('click', () => editDialog.close());
  document.querySelector('#refreshStaff').addEventListener('click', async () => {
    await Promise.all([loadStaff(), loadAuditLogs()]);
  });

  fillRoleSelect(createForm.elements.role);
  await Promise.all([loadStaff(), loadAuditLogs()]);
}
