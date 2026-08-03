import { supabase } from '../config/supabase.js';

const form = document.querySelector('#passwordForm');
const message = document.querySelector('#inviteMessage');
const submitButton = form.querySelector('button[type="submit"]');

function setMessage(text, type = 'error') {
  message.textContent = text;
  message.dataset.type = type;
  message.hidden = false;
}

async function getInviteSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

let session = null;
try {
  session = await getInviteSession();
} catch (error) {
  console.error('Invite session error:', error);
}

if (!session) {
  setMessage('This invitation link is invalid or has expired. Ask an administrator to send a new invitation.');
  submitButton.disabled = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!session) return;

  const password = form.elements.password.value;
  const confirmPassword = form.elements.confirmPassword.value;

  if (password.length < 10) {
    setMessage('Use a password with at least 10 characters.');
    return;
  }

  if (password !== confirmPassword) {
    setMessage('The two passwords do not match.');
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = 'Setting password...';

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    setMessage(error.message || 'Your password could not be set.');
    submitButton.disabled = false;
    submitButton.textContent = 'Set password';
    return;
  }

  setMessage('Password created. Opening your dashboard...', 'success');
  window.setTimeout(() => window.location.replace('./dashboard.html'), 700);
});
