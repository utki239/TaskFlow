(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const form = $('#task-form'), input = $('#task-input'), list = $('#task-list');
  const authScreen = $('#auth-screen'), authForm = $('#auth-form'), dialog = $('#edit-dialog');
  const filters = [...document.querySelectorAll('[data-filter]')];
  let tasks = [], user = null, activeFilter = 'all', search = '', categoryFilter = 'all', authMode = 'login', editingId = null, toastTimer;
  const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };
  const escapeDate = value => value || '';
  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
    return data;
  };
  const showToast = message => { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600); };
  const announceError = (target, message) => { target.textContent = message; target.hidden = false; };
  const category = value => value || 'Personal';

  async function loadTasks() { const result = await api('/api/tasks'); tasks = result.tasks; render(); }
  function updateStats() {
    const total = tasks.length, completed = tasks.filter(task => task.completed).length, remaining = total - completed;
    const percent = total ? Math.round(completed / total * 100) : 0;
    $('#total-stat').textContent = total; $('#completed-stat').textContent = completed; $('#remaining-stat').textContent = remaining;
    $('#task-count').textContent = `${total} ${total === 1 ? 'TASK' : 'TASKS'}`;
    $('#progress-percent').textContent = `${percent}%`; $('#progress-bar').style.width = `${percent}%`;
    const progress = $('#progress-track'); progress.setAttribute('aria-valuenow', String(percent)); progress.setAttribute('aria-valuetext', `${percent}% complete`);
    $('#momentum-title').textContent = !total ? 'Every little step counts.' : completed === total ? 'Look at you go!' : completed ? 'You’re finding your flow.' : 'A good plan starts here.';
    $('#momentum-copy').textContent = !total ? 'Add your first task and start building momentum. Progress is progress, no matter the size.' : completed === total ? 'You completed every task on your list. Take a breath and enjoy that feeling.' : completed ? `You’ve finished ${completed} ${completed === 1 ? 'task' : 'tasks'} so far. Keep that good energy going.` : `You have ${remaining} ${remaining === 1 ? 'task' : 'tasks'} waiting. Pick one and take the first step.`;
  }
  function dateLabel(task) {
    if (!task.dueDate) return new Date(task.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const due = new Date(`${task.dueDate}T00:00:00`);
    return `Due ${due.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }
  function actionButton(label, symbol, action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'task-action'; button.setAttribute('aria-label', label); button.textContent = symbol; button.addEventListener('click', action); return button;
  }
  function render() {
    list.replaceChildren();
    const categories = [...new Set(tasks.map(task => category(task.category)))].sort((a,b) => a.localeCompare(b));
    const categorySelect = $('#category-filter'), prior = categoryFilter;
    categorySelect.replaceChildren(new Option('All categories', 'all'), ...categories.map(item => new Option(item, item)));
    categorySelect.value = categories.includes(prior) || prior === 'all' ? prior : 'all'; categoryFilter = categorySelect.value;
    const visible = tasks.filter(task => (activeFilter === 'all' || (activeFilter === 'active' ? !task.completed : task.completed)) && (categoryFilter === 'all' || category(task.category) === categoryFilter) && `${task.title} ${task.notes} ${category(task.category)}`.toLowerCase().includes(search));
    $('#empty-state').hidden = visible.length > 0;
    if (!visible.length) {
      const filtered = search || categoryFilter !== 'all' || activeFilter !== 'all';
      $('#empty-title').textContent = filtered ? 'No matching tasks' : tasks.length ? 'A fresh start' : 'A fresh start';
      $('#empty-copy').textContent = filtered ? 'Try another search or change your filters.' : 'Your list is looking peaceful. Add a task above and make today count.';
    }
    for (const task of visible) {
      const item = document.createElement('li'); item.className = `task-item${task.completed ? ' completed' : ''}`;
      const check = document.createElement('button'); check.type = 'button'; check.className = `check-button${task.completed ? ' checked' : ''}`; check.setAttribute('aria-label', `${task.completed ? 'Mark' : 'Complete'} ${task.title}`); check.setAttribute('aria-pressed', String(Boolean(task.completed))); check.textContent = task.completed ? '✓' : ''; check.addEventListener('click', () => toggleTask(task));
      const copy = document.createElement('div'); copy.className = 'task-copy';
      const title = document.createElement('span'); title.className = 'task-text'; title.textContent = task.title; title.tabIndex = 0; title.setAttribute('role', 'button'); title.setAttribute('aria-label', `Edit ${task.title}`); title.addEventListener('click', () => openEditor(task)); title.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(task); } });
      const meta = document.createElement('div'); meta.className = 'task-meta'; const date = document.createElement('span'); date.textContent = dateLabel(task); if (task.dueDate && task.dueDate < today() && !task.completed) date.className = 'task-overdue';
      const dot = document.createElement('span'); dot.className = 'mini-dot'; dot.setAttribute('aria-hidden', 'true'); const cat = document.createElement('span'); cat.className = 'task-category'; cat.textContent = category(task.category);
      const priority = document.createElement('span'); priority.className = `task-priority priority-${task.priority}`; priority.textContent = task.priority; meta.append(date, dot, cat, dot.cloneNode(true), priority);
      copy.append(title, meta);
      if (task.notes) { const note = document.createElement('div'); note.className = 'task-note'; note.textContent = task.notes; copy.append(note); }
      const tools = document.createElement('div'); tools.className = 'task-tools'; tools.append(actionButton(`Edit ${task.title}`, '✎', () => openEditor(task)), actionButton(`Delete ${task.title}`, '×', () => deleteTask(task)));
      item.append(check, copy, tools); list.append(item);
    }
    filters.forEach(button => { const selected = button.dataset.filter === activeFilter; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); }); updateStats();
  }
  async function addTask(event) {
    event.preventDefault(); const title = input.value.trim(); if (!title) return;
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try { const result = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, category: $('#new-category').value, priority: $('#new-priority').value, dueDate: $('#new-due').value || null }) }); tasks.unshift(result.task); activeFilter = 'all'; categoryFilter = 'all'; form.reset(); $('#new-category').value = 'Personal'; $('#new-priority').value = 'medium'; render(); input.focus(); showToast('Task added'); }
    catch (error) { showToast(error.message); } finally { button.disabled = false; }
  }
  async function toggleTask(task) { try { const result = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: !task.completed }) }); tasks = tasks.map(item => item.id === task.id ? result.task : item); render(); showToast(result.task.completed ? 'Task completed' : 'Task moved back to your list'); } catch (error) { showToast(error.message); } }
  async function deleteTask(task) { try { await api(`/api/tasks/${task.id}`, { method: 'DELETE' }); tasks = tasks.filter(item => item.id !== task.id); render(); showToast('Task deleted'); } catch (error) { showToast(error.message); } }
  function openEditor(task) { editingId = task.id; $('#edit-title').value = task.title; $('#edit-notes').value = task.notes || ''; const categorySelect = $('#edit-category'); if (![...categorySelect.options].some(option => option.value === task.category)) categorySelect.add(new Option(task.category, task.category)); categorySelect.value = task.category; $('#edit-priority').value = task.priority; $('#edit-due').value = escapeDate(task.dueDate); dialog.showModal(); $('#edit-title').focus(); }
  $('#edit-form').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault(); const task = tasks.find(item => item.id === editingId); if (!task) return;
    const save = $('#save-edit'); save.disabled = true;
    try { const result = await api(`/api/tasks/${editingId}`, { method: 'PATCH', body: JSON.stringify({ title: $('#edit-title').value, notes: $('#edit-notes').value, category: $('#edit-category').value, priority: $('#edit-priority').value, dueDate: $('#edit-due').value || null }) }); tasks = tasks.map(item => item.id === editingId ? result.task : item); dialog.close(); render(); showToast('Task updated'); }
    catch (error) { showToast(error.message); } finally { save.disabled = false; }
  });
  form.addEventListener('submit', addTask);
  filters.forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.filter; render(); }));
  $('#clear-completed').addEventListener('click', async () => { const completed = tasks.filter(task => task.completed); if (!completed.length) { showToast('No completed tasks to clear'); return; } try { const result = await api('/api/tasks/completed', { method: 'DELETE' }); tasks = tasks.filter(task => !task.completed); render(); showToast(`Cleared ${result.deleted} completed ${result.deleted === 1 ? 'task' : 'tasks'}`); } catch (error) { showToast(error.message); } });
  $('#search-input').addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); render(); });
  $('#category-filter').addEventListener('change', event => { categoryFilter = event.target.value; render(); });
  document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName) && !dialog.open) { event.preventDefault(); $('#search-input').focus(); } });
  $('#theme-toggle').addEventListener('click', () => { const dark = !document.body.classList.contains('dark'); document.body.classList.toggle('dark', dark); try { localStorage.setItem('taskflow.theme', dark ? 'dark' : 'light'); } catch {} $('#theme-toggle').textContent = dark ? '☀' : '☾'; $('#theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`); });
  try { if (localStorage.getItem('taskflow.theme') === 'dark') { document.body.classList.add('dark'); $('#theme-toggle').textContent = '☀'; } } catch {}

  async function checkSession() {
    let sessionError = null;
    try { const result = await api('/api/auth/me'); user = result.user; }
    catch (error) { user = null; if (error.status !== 401) sessionError = error; }
    authScreen.hidden = Boolean(user); $('.app-shell').hidden = !user; $('#boot-screen').hidden = true; $('#logout-button').hidden = !user;
    const account = $('#account-label'); account.replaceChildren(); const accountDot = document.createElement('span'); accountDot.className = 'dot'; accountDot.setAttribute('aria-hidden', 'true'); account.append(accountDot, document.createTextNode(user ? user.email : 'Secure workspace'));
    if (sessionError) announceError($('#auth-error'), 'We couldn’t reach your workspace. Check your connection and try signing in again.');
    if (user) { try { await loadTasks(); } catch (error) { showToast(error.message); } }
  }
  function updateAuthMode() { const create = authMode === 'register'; $('#auth-heading').innerHTML = create ? 'A fresh start,<br/><span>just for you.</span>' : 'Your focus,<br/><span>in one place.</span>'; $('#auth-submit').textContent = create ? 'Create account' : 'Sign in'; $('#auth-switch-label').textContent = create ? 'Already have an account?' : 'New to TaskFlow?'; $('#auth-switch').textContent = create ? 'Sign in' : 'Create an account'; $('#auth-password').autocomplete = create ? 'new-password' : 'current-password'; $('#auth-error').hidden = true; }
  $('#auth-switch').addEventListener('click', () => { authMode = authMode === 'login' ? 'register' : 'login'; updateAuthMode(); });
  authForm.addEventListener('submit', async event => { event.preventDefault(); const submit = $('#auth-submit'), errorBox = $('#auth-error'); submit.disabled = true; errorBox.hidden = true;
    try { const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ email: $('#auth-email').value, password: $('#auth-password').value }) }); user = result.user; authScreen.hidden = true; $('.app-shell').hidden = false; $('#logout-button').hidden = false; const account = $('#account-label'); account.replaceChildren(); const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true'); account.append(dot, document.createTextNode(user.email)); authForm.reset(); await loadTasks(); showToast(authMode === 'register' ? 'Your workspace is ready' : 'Welcome back'); }
    catch (error) { announceError(errorBox, error.message); } finally { submit.disabled = false; }
  });
  $('#logout-button').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); user = null; tasks = []; render(); await checkSession(); } catch (error) { showToast(error.message); } });
  checkSession();
})();
