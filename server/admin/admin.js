'use strict';
const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value || 0);
const percent = (part, total) => total ? number(100 * part / total) + '%' : '—';
const modelNames = { 'local-gemma-e2b': 'Gemma 4 E2B', 'local-gemma-e4b': 'Gemma 4 E4B', 'local-qwen-2b': 'Qwen3.5 2B', 'gpt-6-luna': 'GPT-6 Luna', 'gpt-5.6-luna': 'GPT-5.6 Luna', 'gpt-5.4-mini': 'GPT-5.4 Mini', 'gpt-5.4-nano': 'GPT-5.4 Nano' };
const errorNames = { memory: 'Не хватает памяти', gpu: 'WebGPU / GPU', network: 'Сеть или таймаут', auth: 'Доступ к API', quota: 'Лимит API', invalid_output: 'Некорректный результат', preview: 'Не удалось прочитать файл', unknown: 'Другая ошибка' };
const model = value => modelNames[value] || 'Неизвестная модель';
const duration = value => value === null ? '—' : value < 60000 ? number(value / 1000) + ' с' : number(value / 60000) + ' мин';
const dateLabel = date => new Date(date + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Warsaw' });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function empty(target, message = 'В этом периоде пока нет данных.') { target.replaceChildren(node('p', message, 'empty')); }
function table(id, headers, rows, message) {
  const target = $(id); if (!rows.length) return empty(target, message);
  const el = node('table', undefined, 'analytics-table'), head = node('thead'), tr = node('tr');
  for (const title of headers) { const th = node('th', title); th.scope = 'col'; tr.append(th); }
  head.append(tr); el.append(head);
  const body = node('tbody');
  for (const row of rows) { const tr = node('tr'); for (const value of row) tr.append(node('td', String(value))); body.append(tr); }
  el.append(body); target.replaceChildren(el);
}
function bars(id, rows, total, label = v => v, links = false) {
  const target = $(id); if (!rows.length) return empty(target);
  target.replaceChildren();
  for (const item of rows) {
    const row = node('div', undefined, 'rank-row'), top = node('div', undefined, 'bar-label');
    let title = node('span', label(item.name));
    if (links && /^\/(?:blog\/(?:(?:ru|bn|hi)\/)?(?:[a-z0-9-]+\.html|(?:topics\/[a-z0-9-]+\/)?(?:page\/[1-9][0-9]*\/)?)?)?$/.test(item.name)) { title = node('a', label(item.name)); title.href = item.name; }
    top.append(title, node('span', `${number(item.count)} · ${percent(item.count, total)}`, 'bar-value'));
    const track = node('div', undefined, 'bar-track'), fill = node('div', undefined, 'bar-fill');
    fill.style.width = Math.min(100, total ? 100 * item.count / total : 0) + '%'; track.append(fill); row.append(top, track); target.append(row);
  }
}
let data, controller;
function renderChart() {
  if (!data) return;
  const key = $('chartMetric').value, rows = data.daily;
  const max = Math.max(2, Math.ceil(Math.max(...rows.map(r => r[key])) / 2) * 2);
  const make = (tag, attrs, text) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text !== undefined) el.textContent = text; return el; };
  const svg = make('svg', { viewBox: '0 0 560 230', role: 'img', 'aria-label': `${$('chartMetric').selectedOptions[0].textContent} по дням. Подробные значения доступны в таблице ниже.` });
  for (let i = 0; i <= 2; i++) {
    const y = 185 - i * 75;
    svg.append(make('line', { x1: 43, x2: 552, y1: y, y2: y, class: 'chart-grid' }), make('text', { x: 35, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }, number(max * i / 2)));
  }
  const step = 505 / rows.length;
  rows.forEach((r, i) => {
    const height = r[key] / max * 150, x = 46 + step * i;
    svg.append(make('rect', { x, y: 185 - height, width: Math.max(1, step * .66), height, rx: 2, class: 'chart-bar' }));
    const label = `${dateLabel(r.day)}: ${number(r[key])}`;
    const hit = make('rect', { x: x - 1, y: 24, width: step, height: 162, class: 'chart-hit', tabindex: 0, role: 'img', 'aria-label': label });
    hit.append(make('title', {}, label));
    for (const event of ['focus', 'mouseenter']) hit.addEventListener(event, () => { $('chartHint').textContent = label; });
    svg.append(hit);
    if (i === 0 || (rows.length > 3 && i === Math.floor(rows.length / 2)) || i === rows.length - 1) svg.append(make('text', { x: i === rows.length - 1 ? 550 : x, y: 211, class: 'chart-axis', 'text-anchor': i === rows.length - 1 ? 'end' : 'start' }, dateLabel(r.day)));
  });
  $('chart').replaceChildren(svg);
  $('chartHint').textContent = rows.every(r => !r[key]) ? 'За выбранный период событий этого типа ещё нет.' : 'Наведите на день или выберите его клавишей Tab.';
}
function render() {
  const t = data.totals;
  $('collectionNote').textContent = `Сбор начался ${new Date(data.collectionStarted).toLocaleDateString('ru-RU', { timeZone: 'Europe/Warsaw' })}. Без постоянного ID посетителя. Ваши посещения в этом браузере исключены.`;
  $('kpis').replaceChildren();
  for (const [label, value, note] of [
    ['Посещения', number(t.visits), 'Открытия генератора и страниц блога'],
    ['Успешные обработки', number(t.success), `${number(t.attempts)} запусков · ${percent(t.local, t.attempts)} на локальных моделях`],
    ['Экспорты CSV', number(t.exports), `${number(t.exportedRows)} строк в скачанных CSV`],
    ['Доля успеха', percent(t.success, t.success + t.errors), `${number(t.errors)} ошибок · ${number(t.cancelled)} отмен`]
  ]) { const card = node('section', undefined, 'card pad'); card.append(node('h2', label, 'kpi-label'), node('p', value, 'kpi-value'), node('p', note, 'kpi-note')); $('kpis').append(card); }
  $('funnel').replaceChildren();
  ['Открыли генератор', 'Добавили файлы', 'Начали обработку', 'Получили результат', 'Скачали CSV'].forEach((name, i) => {
    const item = node('li'), top = node('div', undefined, 'bar-label'), track = node('div', undefined, 'bar-track'), fill = node('div', undefined, 'bar-fill');
    top.append(node('span', name), node('span', `${number(data.funnel[i])} · ${percent(data.funnel[i], data.funnel[0])}`, 'bar-value'));
    fill.style.width = (data.funnel[0] ? 100 * data.funnel[i] / data.funnel[0] : 0) + '%'; track.append(fill); item.append(top, track); $('funnel').append(item);
  });
  table('models', ['Модель', 'Запуски', 'Успешно', 'Ошибки', 'Среднее время', 'Потоки в среднем'], data.models.filter(m => m.attempts || m.success || m.errors).map(m => [model(m.model), number(m.attempts), `${number(m.success)} · ${percent(m.success, m.success + m.errors)}`, number(m.errors), duration(m.duration), m.threads === null ? '—' : number(m.threads)]), 'Модели появятся после первых запусков обработки.');
  table('loads', ['Модель', 'Начали', 'Готово', 'Ошибки', 'Отмены'], data.models.filter(m => m.loads || m.loaded || m.load_errors).map(m => [model(m.model), number(m.loads), number(m.loaded), number(m.load_errors), number(m.load_cancelled)]), 'Локальные модели ещё не загружали.');
  let countries; try { countries = new Intl.DisplayNames(['ru'], { type: 'region' }); } catch { }
  bars('countries', data.countries, t.visits, code => code === 'ZZ' ? 'Страна не определена' : countries?.of(code) || code);
  bars('referrers', data.referrers, t.visits, host => host === 'direct' ? 'Прямой / источник неизвестен' : host);
  bars('pages', data.pages, t.visits, page => page === '/' ? 'Генератор' : page === '/blog/' ? 'Блог' : page.replace('/blog/', '').replace('.html', ''), true);
  bars('devices', data.devices, t.visits, value => ({ desktop: 'Компьютер', mobile: 'Телефон', tablet: 'Планшет' })[value] || value);
  bars('browsers', data.browsers, t.visits);
  $('gpu').textContent = `Проверка локального AI: WebGPU доступен — ${number(t.gpuAvailable)}, недоступен — ${number(t.gpuUnavailable)}. Проверяется при выборе локальной модели.`;
  table('formats', ['Формат', 'Экспорты', 'Строки'], data.formats.map(f => [({ adobe: 'Adobe Stock', envato: 'Envato', shutterstock: 'Shutterstock', freepik: 'Freepik' })[f.name] || f.name, number(f.count), number(f.rows)]));
  table('errors', ['Причина / этап', 'Модель', 'Число'], data.errors.map(e => [`${errorNames[e.name] || 'Другая ошибка'} · ${e.kind === 'model_load_error' ? 'загрузка' : 'обработка'}`, model(e.model), number(e.count)]), 'Ошибок в этом периоде не зафиксировано.');
  table('dailyTable', ['День', 'Посещения', 'Успехи', 'CSV', 'Ошибки'], data.daily.map(r => [dateLabel(r.day), number(r.visits), number(r.success), number(r.exports), number(r.errors)]));
  renderChart(); $('dashboard').hidden = false;
}
async function load() {
  void loadEditorial();
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  $('requestError').hidden = true; $('refresh').disabled = true; $('freshness').textContent = 'Обновляем статистику…';
  try {
    const response = await fetch(`/admin/api/summary?from=${encodeURIComponent($('from').value)}&to=${encodeURIComponent($('to').value)}`, { signal });
    if (response.status === 401) { location.replace('/admin/login'); return; }
    if (!response.ok) throw new Error(response.status === 400 ? 'Выберите период в пределах последних 90 дней, не позже сегодняшнего дня.' : 'Статистика временно недоступна. Попробуйте обновить.');
    data = await response.json(); render();
    $('freshness').textContent = `${dateLabel(data.range.from)} — ${dateLabel(data.range.to)} · Europe/Warsaw · Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('dashboard').hidden = true; $('freshness').textContent = 'Данные не загружены.'; $('requestError').hidden = false;
    $('requestError').textContent = error instanceof TypeError ? 'Нет связи с сервером. Попробуйте обновить.' : error.message;
  } finally { if (!signal.aborted) $('refresh').disabled = false; }
}
async function loadEditorial() {
  try {
    const response = await fetch('/admin/api/editorial');
    if (!response.ok) throw new Error();
    const value = await response.json();
    const names = { ready: 'Готов к ежедневному выпуску', planning: 'Подбираются новые темы', published: 'Последний выпуск опубликован', writing: 'Готовится новая статья', translating: 'Готовятся переводы', reviewing: 'Проверяется новая статья', correcting: 'Исправляются замечания редактора', publishing: 'Развёртывается новый выпуск', failed: 'Выпуск остановлен из-за ошибки', not_configured: 'Расписание ещё не настроено' };
    $('editorialStatus').textContent = names[value.status] || 'Статус обновляется';
    const details = $('editorialDetails'); details.replaceChildren();
    details.append(node('p', `${number(value.articles)} статей · ${number(value.topics)} тем · английский, русский, бенгальский и хинди`));
    if (value.schedule) details.append(node('p', `Ежедневно в ${value.schedule}: одна тема на четырёх языках. Тем в очереди: ${number(value.remaining_topics)}.`, 'small'));
    if (value.last_success) details.append(node('p', `Последняя публикация: ${new Date(value.last_success).toLocaleString('ru-RU', { timeZone: 'Europe/Warsaw' })}`, 'small'));
    if (value.current_topic || value.last_topic) details.append(node('p', value.current_topic || value.last_topic, 'small muted'));
    if (value.error) details.append(node('p', `Публикация не завершена: ${value.error}. Черновик сохранён; текущий сайт продолжает работать.`, 'error-message'));
  } catch { $('editorialStatus').textContent = 'Не удалось получить статус публикаций. Обновите страницу.'; }
}
function setPeriod(days) {
  const end = today(), start = new Date(Date.parse(end) - (days - 1) * 86400000).toISOString().slice(0, 10);
  $('from').value = start; $('to').value = end;
  document.querySelectorAll('[data-days]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.days) === days)));
}
function theme(dark) { document.documentElement.className = dark ? 'dark' : 'light'; $('theme').textContent = dark ? 'Светлая тема' : 'Тёмная тема'; $('theme').setAttribute('aria-pressed', String(dark)); }
try { theme(localStorage.getItem('meta_theme') === 'dark'); } catch { theme(false); }
$('theme').addEventListener('click', () => { const dark = !document.documentElement.classList.contains('dark'); theme(dark); try { localStorage.setItem('meta_theme', dark ? 'dark' : 'light'); } catch { } });
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { const response = await fetch('/admin/api/logout', { method: 'POST' }); if (response.ok || response.status === 401) location.replace('/admin/login'); else throw new Error(); }
  catch { $('requestError').hidden = false; $('requestError').textContent = 'Не удалось выйти. Повторите попытку.'; $('logout').disabled = false; }
});
$('chartMetric').addEventListener('change', renderChart);
$('rangeForm').addEventListener('submit', e => { e.preventDefault(); document.querySelectorAll('[data-days]').forEach(el => el.setAttribute('aria-pressed', 'false')); void load(); });
document.querySelectorAll('[data-days]').forEach(el => el.addEventListener('click', () => { setPeriod(Number(el.dataset.days)); void load(); }));
$('refresh').addEventListener('click', () => void load());
const min = new Date(Date.parse(today()) - 89 * 86400000).toISOString().slice(0, 10);
for (const input of [$('from'), $('to')]) { input.min = min; input.max = today(); }
setPeriod(7); void load();
