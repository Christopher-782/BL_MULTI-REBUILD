import { supabase } from '../config/supabase.js';
import { redirectIfAuthenticated } from './session.js';

const form = document.querySelector('#loginForm');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const message = document.querySelector('#formMessage');
const button = document.querySelector('#loginButton');
const togglePassword = document.querySelector('#togglePassword');

await redirectIfAuthenticated();

togglePassword.addEventListener('click', () => {
  const isPassword = passwordInput.type === 'password';
  passwordInput.type = isPassword ? 'text' : 'password';
  togglePassword.textContent = isPassword ? 'Hide' : 'Show';
  togglePassword.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';

  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!email || !password) {
    message.textContent = 'Enter your email address and password.';
    return;
  }

  setLoading(true);

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      console.error('Supabase sign-in rejected:', {
        status: error?.status,
        code: error?.code,
        message: error?.message,
      });

      message.textContent = getAuthErrorMessage(error);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, role, status')
      .eq('id', data.user.id)
      .single();

    if (profileError || !profile) {
      console.error('Staff profile lookup failed:', {
        userId: data.user.id,
        code: profileError?.code,
        message: profileError?.message,
        details: profileError?.details,
      });
      await supabase.auth.signOut({ scope: 'local' });
      message.textContent = 'Your staff profile is not ready. Run the profile repair migration or contact an administrator.';
      return;
    }

    if (profile.status !== 'active') {
      await supabase.auth.signOut({ scope: 'local' });
      message.textContent = 'This account is not active. Contact an administrator.';
      return;
    }

    window.location.replace('./dashboard.html');
  } catch (error) {
    console.error('Login error:', error);
    message.textContent = 'Unable to sign in right now. Please try again.';
  } finally {
    setLoading(false);
  }
});

function setLoading(isLoading) {
  button.disabled = isLoading;
  button.classList.toggle('loading', isLoading);
  emailInput.disabled = isLoading;
  passwordInput.disabled = isLoading;
}


function getAuthErrorMessage(error) {
  const code = error?.code || 'unknown_auth_error';
  const status = error?.status ?? 'unknown';
  const rawMessage = (error?.message || '').toLowerCase();

  if (code === 'email_not_confirmed' || rawMessage.includes('email not confirmed')) {
    return 'Your email address has not been confirmed in Supabase Auth yet.';
  }

  if (code === 'invalid_credentials' || rawMessage.includes('invalid login credentials')) {
    return 'Invalid email or password. Make sure this user exists in Supabase Authentication > Users.';
  }

  if (code === 'email_provider_disabled' || rawMessage.includes('email provider')) {
    return 'Email/password authentication is disabled for this Supabase project.';
  }

  if (code === 'user_banned') {
    return 'This Supabase Auth user is currently banned. Remove the ban in Authentication > Users before signing in.';
  }

  if (code === 'bad_jwt' || rawMessage.includes('invalid api key') || rawMessage.includes('jwt')) {
    return 'Supabase rejected the project key/token. Check that the Project URL and publishable key belong to the SAME Supabase project.';
  }

  if (code === 'validation_failed') {
    return 'Supabase rejected the sign-in data as invalid. Re-enter the email and password and check the browser console.';
  }

  if (code === 'over_request_rate_limit' || error?.status === 429) {
    return 'Too many sign-in attempts. Wait for the Supabase Auth rate limit to clear, then try again.';
  }

  if (code === 'unexpected_failure' || error?.status === 500) {
    return 'Supabase Auth encountered a server/database error. Check Supabase Logs > Auth for the matching request.';
  }

  // Development diagnostic: show the stable Auth error code/status so we can fix the exact cause.
  return `Supabase sign-in failed (${code}, HTTP ${status}). Check the console for the full Auth message.`;
}
