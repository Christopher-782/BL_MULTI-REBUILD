(() => {
  const MOBILE_BREAKPOINT = 980;
  const SEARCH_DEBOUNCE_MS = 360;

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!parts.length) return 'BL';

    return parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('');
  }

  function normalizePath(value) {
    const path = String(value || '')
      .split('?')[0]
      .split('#')[0]
      .replace(/^\.\//, '')
      .replace(/^\//, '');

    return path || 'dashboard.html';
  }

  function initActiveNavigation() {
    const current = normalizePath(window.location.pathname.split('/').pop());

    document.querySelectorAll('.sidebar a.nav-link[href]').forEach((link) => {
      const href = normalizePath(link.getAttribute('href'));

      // Detail pages map to their module nav item.
      const customerMatch = current === 'customer.html' && href === 'customers.html';
      const loanMatch = current === 'loan.html' && href === 'loans.html';
      const directMatch = current === href;

      link.classList.toggle('active', directMatch || customerMatch || loanMatch);

      if (directMatch || customerMatch || loanMatch) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function initSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mobile-menu-button';
    toggle.setAttribute('aria-label', 'Open navigation');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span>';

    const overlay = document.createElement('button');
    overlay.type = 'button';
    overlay.className = 'mobile-sidebar-overlay';
    overlay.setAttribute('aria-label', 'Close navigation');

    document.body.append(toggle, overlay);

    const close = () => {
      sidebar.classList.remove('is-open');
      overlay.classList.remove('is-open');
      document.body.classList.remove('sidebar-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    };

    const open = () => {
      sidebar.classList.add('is-open');
      overlay.classList.add('is-open');
      document.body.classList.add('sidebar-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation');
    };

    toggle.addEventListener('click', () => {
      sidebar.classList.contains('is-open') ? close() : open();
    });

    overlay.addEventListener('click', close);

    sidebar.querySelectorAll('a.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= MOBILE_BREAKPOINT) close();
      });
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
        close();
        toggle.focus();
      }
    });
  }

  function initSidebarAvatar() {
    const user = document.querySelector('.sidebar-user');
    if (!user || user.querySelector('.sidebar-avatar')) return;

    const nameElement = user.querySelector('[data-session-name]');
    if (!nameElement) return;

    const avatar = document.createElement('div');
    avatar.className = 'sidebar-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(nameElement.textContent);

    user.insertBefore(avatar, user.firstElementChild);

    const observer = new MutationObserver(() => {
      avatar.textContent = initials(nameElement.textContent);
    });

    observer.observe(nameElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function initLiveSearch() {
    const searchInputs = document.querySelectorAll('form input[type="search"]');

    searchInputs.forEach((input) => {
      const form = input.closest('form');
      const wrapper = input.closest('.filter-search') || input.parentElement;

      if (!form || !wrapper || input.dataset.liveSearchReady === 'true') return;

      input.dataset.liveSearchReady = 'true';
      input.setAttribute('spellcheck', 'false');

      const shortcut = document.createElement('span');
      shortcut.className = 'search-shortcut';
      shortcut.textContent = '/';
      shortcut.setAttribute('aria-hidden', 'true');

      const indicator = document.createElement('span');
      indicator.className = 'live-search-indicator';
      indicator.textContent = 'GO';
      indicator.setAttribute('aria-hidden', 'true');

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'search-clear-button';
      clear.setAttribute('aria-label', 'Clear search');
      clear.textContent = '×';

      wrapper.append(shortcut, clear, indicator);

      let timer = null;

      const syncValueState = () => {
        wrapper.classList.toggle('has-search-value', Boolean(input.value.trim()));
      };

      const submit = () => {
        wrapper.classList.add('is-live-searching');

        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }

        window.setTimeout(() => {
          wrapper.classList.remove('is-live-searching');
        }, 520);
      };

      input.addEventListener('input', () => {
        syncValueState();
        window.clearTimeout(timer);
        timer = window.setTimeout(submit, SEARCH_DEBOUNCE_MS);
      });

      clear.addEventListener('click', () => {
        input.value = '';
        syncValueState();
        input.focus();
        submit();
      });

      form.querySelectorAll('select').forEach((select) => {
        if (select.dataset.liveFilterReady === 'true') return;
        select.dataset.liveFilterReady = 'true';
        select.addEventListener('change', submit);
      });

      document.addEventListener('keydown', (event) => {
        const target = event.target;
        const typing =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target?.isContentEditable;

        if (event.key === '/' && !typing && input.offsetParent !== null) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      });

      syncValueState();
    });
  }

  function improveTablesForMobile() {
    document.querySelectorAll('.table-wrap').forEach((wrap) => {
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('role', 'region');

      const heading = wrap.closest('.panel')?.querySelector('h2')?.textContent?.trim();
      if (heading) {
        wrap.setAttribute(
          'aria-label',
          `${heading} table. Scroll horizontally on small screens.`,
        );
      }
    });
  }

  function initPageMotion() {
    requestAnimationFrame(() => {
      document.body.classList.add('ui-ready');
    });
  }

  function init() {
    initActiveNavigation();
    initSidebar();
    initSidebarAvatar();
    initLiveSearch();
    improveTablesForMobile();
    initPageMotion();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
