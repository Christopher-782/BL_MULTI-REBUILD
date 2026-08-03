import { bindLogoutButtons, bindSessionUI, requireActiveProfile } from './access.js';

const session = await requireActiveProfile();

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();
}
