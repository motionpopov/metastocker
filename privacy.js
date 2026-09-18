(() => {
  const button = document.getElementById('statsToggle');
  const status = document.getElementById('statsStatus');
  function render() {
    try {
      const off = localStorage.getItem('metastocker_stats_disabled') === '1';
      const browser = navigator.doNotTrack === '1' || navigator.globalPrivacyControl;
      button.textContent = off ? 'Allow anonymous statistics' : 'Disable anonymous statistics';
      button.disabled = Boolean(browser);
      status.textContent = browser ? 'Statistics are disabled by your browser privacy preference.' : off ? 'Anonymous statistics are disabled in this browser.' : 'Anonymous statistics are enabled. No persistent visitor ID is used.';
    } catch { button.disabled = true; status.textContent = 'Browser storage is unavailable. Statistics are disabled.'; }
  }
  button.addEventListener('click', () => { try { localStorage.setItem('metastocker_stats_disabled', localStorage.getItem('metastocker_stats_disabled') === '1' ? '0' : '1'); } catch { } render(); });
  render();
})();
