
(() => {
  const greeting = document.querySelector('#dynamicGreeting');
  const portalTime = document.querySelector('#portalTime');
  const portalDate = document.querySelector('#portalDate');
  const preview = document.querySelector('#operationsPreview');
  const brandPanel = document.querySelector('.brand-panel');

  function greetingForHour(hour) {
    if (hour >= 5 && hour < 12) return 'GOOD MORNING';
    if (hour >= 12 && hour < 17) return 'GOOD AFTERNOON';
    if (hour >= 17 && hour < 22) return 'GOOD EVENING';
    return 'WELCOME BACK';
  }

  function updatePortalClock() {
    const now = new Date();

    if (greeting) {
      greeting.textContent = greetingForHour(now.getHours());
    }

    if (portalTime) {
      portalTime.textContent = new Intl.DateTimeFormat(
        undefined,
        {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        },
      ).format(now);
    }

    if (portalDate) {
      portalDate.textContent = new Intl.DateTimeFormat(
        undefined,
        {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        },
      ).format(now);
    }
  }

  updatePortalClock();
  window.setInterval(updatePortalClock, 1000);

  if (
    preview &&
    brandPanel &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    brandPanel.addEventListener('pointermove', (event) => {
      if (window.innerWidth <= 960) return;

      const box = brandPanel.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5;
      const y = (event.clientY - box.top) / box.height - .5;

      preview.style.transform =
        `perspective(1000px) rotateX(${-y * 1.6}deg) rotateY(${x * 2.2}deg) translate3d(${x * 2}px, ${y * 2}px, 0)`;
    });

    brandPanel.addEventListener('pointerleave', () => {
      preview.style.transform =
        'perspective(1000px) rotateX(0deg) rotateY(0deg) translate3d(0,0,0)';
    });
  }
})();
