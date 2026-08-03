import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  dispatchSmsAlerts,
  getSmsStatus,
  sendTestSms,
} from '../services/sms.service.js';

const session = await requireActiveProfile({
  roles: ['super_admin', 'admin'],
});

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const message = document.querySelector('#pageMessage');
  const refreshButton = document.querySelector('#refreshSms');
  const dispatchButton = document.querySelector('#dispatchSms');
  const testForm = document.querySelector('#smsTestForm');
  const sendTestButton = document.querySelector('#sendTestSms');

  function showMessage(text, type = 'success', duration = 6500) {
    message.textContent = text;
    message.dataset.type = type;
    message.hidden = false;

    window.clearTimeout(showMessage.timer);
    if (duration > 0) {
      showMessage.timer = window.setTimeout(() => {
        message.hidden = true;
      }, duration);
    }
  }

  function setText(id, value) {
    const element = document.querySelector(`#${id}`);
    if (element) element.textContent = value;
  }

  function renderStatus(status = {}) {
    setText('smsProvider', status.provider || 'BulkSMS Nigeria');
    setText('smsMode', status.testMode ? 'Test' : 'Live');
    setText('smsPending', Number(status.queue?.pending || 0).toLocaleString('en-NG'));
    setText('smsSentToday', Number(status.queue?.sentToday || 0).toLocaleString('en-NG'));
    setText('smsFailed', Number(status.queue?.failed || 0).toLocaleString('en-NG'));
    setText('smsSkipped', Number(status.queue?.skipped || 0).toLocaleString('en-NG'));
    setText('smsSenderId', status.senderId || 'Not configured');
    setText('smsGateway', status.gateway || 'direct-refund');

    const badge = document.querySelector('#smsConfigBadge');
    badge.textContent = status.configured ? 'Configured' : 'Setup required';
    badge.dataset.state = status.configured ? 'active' : 'rejected';
  }

  async function refreshStatus() {
    refreshButton.disabled = true;
    try {
      renderStatus(await getSmsStatus());
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', refreshStatus);

  dispatchButton.addEventListener('click', async () => {
    dispatchButton.disabled = true;
    dispatchButton.textContent = 'Dispatching...';

    try {
      const result = await dispatchSmsAlerts(100);
      if (!result?.configured) {
        showMessage(
          'SMS provider setup is incomplete. Configure the Edge Function secrets first.',
          'error',
        );
      } else {
        showMessage(
          `${result.sent || 0} sent, ${result.failed || 0} failed, ${result.skipped || 0} skipped.`,
          result.failed ? 'error' : 'success',
        );
      }

      await refreshStatus();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      dispatchButton.disabled = false;
      dispatchButton.textContent = 'Dispatch pending';
    }
  });

  testForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const data = new FormData(testForm);
    const phone = String(data.get('phone') || '').trim();
    const customMessage = String(data.get('message') || '').trim();

    if (!phone) {
      showMessage('Enter a phone number.', 'error');
      return;
    }

    sendTestButton.disabled = true;
    sendTestButton.textContent = 'Sending...';

    try {
      const result = await sendTestSms({
        phone,
        message: customMessage,
      });

      showMessage(
        result?.testMode
          ? 'Test request succeeded in BulkSMS Nigeria sandbox mode.'
          : 'Test SMS sent successfully.',
      );
      await refreshStatus();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      sendTestButton.disabled = false;
      sendTestButton.textContent = 'Send test SMS';
    }
  });

  await refreshStatus();
}
