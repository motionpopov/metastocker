try { document.documentElement.className = localStorage.getItem('meta_theme') === 'dark' ? 'dark' : 'light'; } catch { }
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const button = document.getElementById('loginButton'), error = document.getElementById('loginError');
  button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много попыток. Попробуйте через 15 минут.' : response.status === 401 ? 'Неверный пароль.' : 'Не удалось войти. Повторите попытку.');
    // This is a privacy preference, not a visitor ID. Owner activity is excluded.
    try { localStorage.setItem('metastocker_stats_disabled', '1'); } catch { }
    document.getElementById('password').value = '';
    location.replace('/admin/');
  } catch (err) { error.textContent = err instanceof TypeError ? 'Нет связи с сервером. Повторите попытку.' : err.message; button.disabled = false; }
});
