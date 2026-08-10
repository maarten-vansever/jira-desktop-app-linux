/* Jira Desktop — renderer application logic. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = ADF.esc;

  // ---------------------------------------------------------------- state --
  const FILTERS = [
    { id: 'sprint', glyph: '⚑', label: 'Current sprint', jql: 'sprint in openSprints() ORDER BY updated DESC' },
    { id: 'backlog', glyph: '⧗', label: 'Backlog', jql: 'statusCategory != Done AND (sprint is EMPTY OR sprint not in (openSprints(), futureSprints())) ORDER BY updated DESC' },
    { id: 'my-open', glyph: '◉', label: 'My open issues', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
    { id: 'assigned', glyph: '☰', label: 'All my issues', jql: 'assignee = currentUser() ORDER BY updated DESC' },
    { id: 'reported', glyph: '✎', label: 'Reported by me', jql: 'reporter = currentUser() ORDER BY updated DESC' },
    { id: 'recent', glyph: '◷', label: 'Recently updated', jql: 'updated >= -14d ORDER BY updated DESC' },
  ];

  const LIST_FIELDS = 'summary,status,assignee,priority,issuetype,updated,labels';
  const DETAIL_FIELDS = 'summary,description,status,assignee,reporter,priority,issuetype,labels,created,updated,duedate,parent,subtasks,project,attachment';

  function loadStarredBoards() {
    try { return new Set(JSON.parse(localStorage.getItem('starredBoards') || '[]')); } catch { return new Set(); }
  }

  const state = {
    settings: null,
    me: null,
    apiVersion: '3',        // '3' (cloud) or '2' (server/DC fallback)
    useJqlEndpoint: true,   // cloud /search/jql vs legacy /search
    projects: [],
    filterId: 'my-open',
    listTitle: 'My open issues',
    jql: FILTERS[0].jql,
    issues: [],
    cursor: null,           // nextPageToken (cloud) or startAt (legacy)
    loading: false,
    selectedKey: null,
    detail: null,
    view: 'list',
    board: { key: null, mode: 'quick', boards: [], boardId: null, boardName: '', columns: null, issues: [], loading: false, pinned: false },
    boards: [],
    starredBoards: loadStarredBoards(),
    allLabels: null,
    issueTypes: [],
    priorities: null,
    projectTypes: {},
    dashboards: [],
    assignee: null, // null=everyone | 'me' | 'unassigned' | {accountId?, name?, displayName}
  };

  const api = {
    async call(method, path, query, body) {
      const res = await window.api.jira({ method, path, query, body });
      return res;
    },
    get(path, query) { return this.call('GET', path, query); },
    post(path, body, query) { return this.call('POST', path, query, body); },
    put(path, body) { return this.call('PUT', path, undefined, body); },
  };

  const V = () => `/rest/api/${state.apiVersion}`;

  // ---------------------------------------------------------------- utils --
  function toast(msg, kind = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}`;
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
  }

  function fmtRel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  const fmtFull = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

  function avatarHTML(user, lg) {
    if (!user) return `<span class="avatar none ${lg ? 'lg' : ''}" title="Unassigned">·</span>`;
    const name = user.displayName || user.name || '?';
    const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="avatar ${lg ? 'lg' : ''}" title="${esc(name)}" style="background:hsl(${h},42%,66%)">${esc(initials)}</span>`;
  }

  function typeGlyph(type) {
    const n = (type && type.name ? type.name : '').toLowerCase();
    let g = '▣', c = 'var(--blue)', t = type ? type.name : '';
    if (n.includes('bug')) { g = '◈'; c = 'var(--red)'; }
    else if (n.includes('story')) { g = '▤'; c = 'var(--green)'; }
    else if (n.includes('epic')) { g = '⚡'; c = '#b58cff'; }
    else if (n.includes('sub')) { g = '↳'; c = 'var(--slate)'; }
    else if (n.includes('task')) { g = '✓'; c = 'var(--blue)'; }
    return `<span class="type-glyph" style="color:${c}" title="${esc(t)}">${g}</span>`;
  }

  function prioGlyph(p) {
    if (!p) return '';
    const n = (p.name || '').toLowerCase();
    let g = '=', c = 'var(--accent)';
    if (n.includes('highest') || n.includes('blocker')) { g = '⇈'; c = 'var(--red)'; }
    else if (n.includes('high') || n.includes('critical')) { g = '↑'; c = '#ff9f43'; }
    else if (n.includes('lowest') || n.includes('trivial')) { g = '⇊'; c = 'var(--blue)'; }
    else if (n.includes('low') || n.includes('minor')) { g = '↓'; c = 'var(--green)'; }
    return `<span class="prio" style="color:${c}" title="Priority: ${esc(p.name)}">${g}</span>`;
  }

  function statusPill(status) {
    const cat = status && status.statusCategory ? status.statusCategory.key : 'new';
    const cls = cat === 'done' ? 'cat-done' : cat === 'indeterminate' ? 'cat-indeterminate' : 'cat-new';
    return `<span class="status-pill ${cls}">${esc(status ? status.name : '?')}</span>`;
  }

  // ---------------------------------------------------------- menus/modals --
  let openMenuEl = null;
  function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }

  function showMenu(anchor, build) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    $('#menu-root').appendChild(menu);
    openMenuEl = menu;
    build(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = Math.min(r.left, window.innerWidth - mw - 12);
    let y = r.bottom + 6;
    if (y + mh > window.innerHeight - 10) y = Math.max(10, r.top - mh - 6);
    menu.style.left = `${Math.max(10, x)}px`;
    menu.style.top = `${y}px`;
  }

  document.addEventListener('mousedown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  });

  function menuItems(menu, items, note) {
    const wrap = document.createElement('div');
    if (!items.length) {
      wrap.innerHTML = `<div class="menu-note">${esc(note || 'Nothing here')}</div>`;
    }
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'menu-item';
      el.innerHTML = `${it.icon || ''}<span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}`;
      el.addEventListener('click', () => { closeMenu(); it.onClick(); });
      wrap.appendChild(el);
    }
    menu.appendChild(wrap);
    return wrap;
  }

  function openModal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">${html}</div>`;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    $('#modal-root').appendChild(overlay);
    return overlay;
  }

  // ------------------------------------------------------------- settings --
  async function showSettings(cancellable) {
    const s = await window.api.getSettings();
    $('#onboarding').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#set-url').value = s.baseUrl || '';
    $('#set-email').value = s.email || '';
    $('#set-token').value = '';
    $('#set-token').placeholder = s.hasToken ? '•••••••• (saved — leave blank to keep)' : 'Paste your API token';
    $('#enc-note').textContent = s.encryptionAvailable === false ? ' (system keyring unavailable — token stored obfuscated)' : ', token encrypted via your system keyring';
    $('#set-error').classList.add('hidden');
    $('#set-cancel').classList.toggle('hidden', !cancellable);
  }

  async function saveSettings() {
    const btn = $('#set-save');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const res = await window.api.saveSettings({
      baseUrl: $('#set-url').value,
      email: $('#set-email').value,
      token: $('#set-token').value,
    });
    btn.disabled = false;
    btn.innerHTML = 'Save &amp; connect';
    if (!res.ok) {
      const err = $('#set-error');
      err.textContent = res.error || 'Could not connect.';
      err.classList.remove('hidden');
      return;
    }
    toast(`Connected as ${res.myself.displayName}`, 'ok');
    boot();
  }

  // ----------------------------------------------------------------- boot --
  async function boot() {
    state.settings = await window.api.getSettings();
    $('#onboarding').classList.add('hidden');
    $('#app').classList.remove('hidden');

    let me = await api.get('/rest/api/3/myself');
    if (!me.ok && (me.status === 404 || me.status === 410)) {
      state.apiVersion = '2';
      state.useJqlEndpoint = false;
      me = await api.get('/rest/api/2/myself');
    }
    if (!me.ok) {
      toast(me.error || 'Could not load your profile', 'error');
      $('#user-chip').innerHTML = `<span class="avatar none">!</span><div>Not connected</div>`;
      return;
    }
    state.me = me.data;
    $('#user-chip').innerHTML = `${avatarHTML(state.me, true)}<div><b>${esc(state.me.displayName)}</b><br/><span style="font-size:11px">${esc(state.me.emailAddress || '')}</span></div>`;

    renderFilterNav();
    loadProjects();
    loadIssueTypes();
    loadDashboards();
    loadBoards();
    applyFilter(state.filterId);
  }

  async function loadIssueTypes() {
    const el = $('#nav-types');
    const res = await api.get(`${V()}/issuetype`);
    if (!res.ok || !Array.isArray(res.data)) { el.innerHTML = `<div class="nav-loading">${esc(res.error || 'Unavailable')}</div>`; return; }
    // dedupe by name (each project defines its own copy), subtasks last
    const byName = new Map();
    for (const t of res.data) {
      if (!byName.has(t.name)) byName.set(t.name, t);
    }
    const order = ['epic', 'story', 'task', 'bug', 'improvement', 'new feature', 'sub-task', 'subtask'];
    const rank = (n) => { const i = order.indexOf(n.toLowerCase()); return i === -1 ? 50 : i; };
    const types = [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    state.issueTypes = types;
    el.innerHTML = '';
    for (const t of types) {
      const item = document.createElement('div');
      item.className = 'nav-item' + (state.filterId === `type:${t.name}` ? ' active' : '');
      item.dataset.filter = `type:${t.name}`;
      item.innerHTML = `${typeGlyph(t)}<span class="label">${esc(t.name)}</span>`;
      item.addEventListener('click', () => applyFilter(`type:${t.name}`));
      el.appendChild(item);
    }
  }

  async function loadDashboards() {
    const el = $('#nav-dashboards');
    const res = await api.get(`${V()}/dashboard`, { maxResults: 50 });
    if (!res.ok) { el.innerHTML = `<div class="nav-loading">${esc(res.error)}</div>`; return; }
    const dashboards = res.data.dashboards || [];
    state.dashboards = dashboards;
    el.innerHTML = dashboards.length ? '' : '<div class="nav-loading">No dashboards</div>';
    for (const d of dashboards) {
      const url = /^https?:\/\//i.test(d.view || '') ? d.view : `${state.settings.baseUrl}/jira/dashboards/${d.id}`;
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.title = 'Open dashboard in browser';
      item.innerHTML = `<span class="glyph">${d.isFavourite ? '★' : '▤'}</span><span class="label">${esc(d.name)}</span><span class="pkey">↗</span>`;
      item.addEventListener('click', () => window.api.openExternal(url));
      el.appendChild(item);
    }
  }

  async function loadBoards() {
    const el = $('#nav-boards');
    let boards = [];
    for (let startAt = 0, page = 0; page < 4; page++) {
      const res = await api.get('/rest/agile/1.0/board', { startAt, maxResults: 50 });
      if (!res.ok) {
        if (!boards.length) { el.innerHTML = `<div class="nav-loading">${esc(res.error)}</div>`; return; }
        break;
      }
      boards = boards.concat(res.data.values || []);
      if (res.data.isLast || !(res.data.values || []).length) break;
      startAt = boards.length;
    }
    state.boards = boards;
    renderBoardNav();
  }

  function sortedBoards(boards) {
    const starred = state.starredBoards;
    return [...boards].sort((a, b) =>
      (starred.has(b.id) - starred.has(a.id)) || a.name.localeCompare(b.name));
  }

  function renderBoardNav() {
    const el = $('#nav-boards');
    el.innerHTML = state.boards.length ? '' : '<div class="nav-loading">No boards</div>';
    for (const bd of sortedBoards(state.boards)) {
      const isStar = state.starredBoards.has(bd.id);
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.dataset.board = String(bd.id);
      item.title = `${bd.name} (${bd.type})`;
      item.innerHTML = `
        <span class="glyph">▦</span>
        <span class="label">${esc(bd.name)}</span>
        <span class="pkey">${esc(bd.location?.projectKey || '')}</span>
        <button class="star${isStar ? ' on' : ''}" title="${isStar ? 'Unstar board' : 'Star board'}">${isStar ? '★' : '☆'}</button>`;
      item.querySelector('.star').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBoardStar(bd.id);
      });
      item.addEventListener('click', () => openBoardFromNav(bd));
      el.appendChild(item);
    }
    markActiveNav();
  }

  function toggleBoardStar(id) {
    const s = state.starredBoards;
    if (s.has(id)) s.delete(id); else s.add(id);
    try { localStorage.setItem('starredBoards', JSON.stringify([...s])); } catch {}
    renderBoardNav();
    if (state.view === 'board') renderBoardToolbar();
  }

  function renderFilterNav() {
    const el = $('#nav-filters');
    el.innerHTML = '';
    for (const f of FILTERS) {
      const item = document.createElement('div');
      item.className = 'nav-item' + (state.filterId === f.id ? ' active' : '');
      item.dataset.filter = f.id;
      item.innerHTML = `<span class="glyph">${f.glyph}</span><span class="label">${esc(f.label)}</span>`;
      item.addEventListener('click', () => applyFilter(f.id));
      el.appendChild(item);
    }
  }

  async function loadProjects() {
    const el = $('#nav-projects');
    el.innerHTML = '<div class="nav-loading">Loading…</div>';
    let projects = [];
    if (state.apiVersion === '3') {
      const res = await api.get('/rest/api/3/project/search', { maxResults: 100, orderBy: 'lastIssueUpdatedTime' });
      if (res.ok) projects = res.data.values || [];
      else { el.innerHTML = `<div class="nav-loading">${esc(res.error)}</div>`; return; }
    } else {
      const res = await api.get('/rest/api/2/project');
      if (res.ok) projects = res.data || [];
      else { el.innerHTML = `<div class="nav-loading">${esc(res.error)}</div>`; return; }
    }
    state.projects = projects;
    el.innerHTML = projects.length ? '' : '<div class="nav-loading">No projects visible</div>';
    for (const p of projects) {
      const item = document.createElement('div');
      item.className = 'nav-item' + (state.filterId === `proj:${p.key}` ? ' active' : '');
      item.dataset.filter = `proj:${p.key}`;
      item.innerHTML = `<span class="glyph">▦</span><span class="label">${esc(p.name)}</span><span class="pkey">${esc(p.key)}</span>`;
      item.addEventListener('click', () => applyFilter(`proj:${p.key}`));
      el.appendChild(item);
    }
  }

  function markActiveNav() {
    document.querySelectorAll('.nav-item').forEach((el) => {
      if (el.dataset.board !== undefined) {
        el.classList.toggle('active',
          state.view === 'board' && state.board.pinned && String(state.board.boardId) === el.dataset.board);
      } else {
        el.classList.toggle('active', el.dataset.filter === state.filterId);
      }
    });
  }

  function applyFilter(id) {
    state.filterId = id;
    state.board.pinned = false; // sidebar navigation releases an explicitly opened board
    if (id.startsWith('proj:')) {
      const key = id.slice(5);
      const proj = state.projects.find((p) => p.key === key);
      state.jql = `project = "${key}" ORDER BY updated DESC`;
      state.listTitle = proj ? proj.name : key;
    } else if (id.startsWith('type:')) {
      const name = id.slice(5);
      state.jql = `issuetype = "${name.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
      state.listTitle = name;
    } else if (id === 'sprint') {
      state.jql = sprintJql();
      state.listTitle = 'Current sprint' + assigneeLabelSuffix();
    } else if (id === 'search') {
      // jql/title already set by runSearch
    } else {
      const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
      state.jql = f.jql;
      state.listTitle = f.label;
    }
    markActiveNav();
    renderSubbar();
    loadIssues(false);
    if (state.view === 'board') openBoard();
  }

  // ------------------------------------------------------- assignee filter --
  function assigneeClause() {
    const a = state.assignee;
    if (a === 'me') return ' AND assignee = currentUser()';
    if (a === 'unassigned') return ' AND assignee is EMPTY';
    if (a && a.accountId) return ` AND assignee = "${a.accountId}"`;
    if (a && a.name) return ` AND assignee = "${a.name.replace(/"/g, '\\"')}"`;
    return '';
  }
  function sprintJql() { return `sprint in openSprints()${assigneeClause()} ORDER BY updated DESC`; }
  function assigneeLabelSuffix() {
    const a = state.assignee;
    if (a === 'me') return ' · me';
    if (a === 'unassigned') return ' · unassigned';
    if (a && a.displayName) return ` · ${a.displayName}`;
    return '';
  }

  function renderSubbar() {
    const bar = $('#subbar');
    if (state.filterId !== 'sprint') { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const a = state.assignee;
    const isEveryone = !a;
    const isMe = a === 'me';
    const isUnassigned = a === 'unassigned';
    const isPerson = a && typeof a === 'object';
    bar.innerHTML = `
      <span class="subbar-label">Assignee</span>
      <button class="fchip ${isEveryone ? 'on' : ''}" data-a="all">Everyone</button>
      <button class="fchip ${isMe ? 'on' : ''}" data-a="me">${avatarHTML(state.me)} Me</button>
      <button class="fchip ${isUnassigned ? 'on' : ''}" data-a="unassigned">Unassigned</button>
      <button class="fchip ${isPerson ? 'on' : ''}" id="fchip-person">${isPerson ? `${avatarHTML(a)} ${esc(a.displayName)}` : '＋ Person'} <span class="caret">▾</span></button>`;
    bar.querySelector('[data-a="all"]').addEventListener('click', () => setAssignee(null));
    bar.querySelector('[data-a="me"]').addEventListener('click', () => setAssignee('me'));
    bar.querySelector('[data-a="unassigned"]').addEventListener('click', () => setAssignee('unassigned'));
    $('#fchip-person', bar).addEventListener('click', (e) => openPersonPicker(e.currentTarget));
  }

  function setAssignee(a) {
    state.assignee = a;
    applyFilter('sprint');
  }

  function openPersonPicker(anchor) {
    showMenu(anchor, (menu) => {
      const sw = document.createElement('div');
      sw.className = 'menu-search';
      sw.innerHTML = '<input type="text" placeholder="Search people by name or email…"/>';
      menu.appendChild(sw);
      const listWrap = document.createElement('div');
      menu.appendChild(listWrap);
      const input = sw.querySelector('input');
      let seq = 0;
      const load = async (q) => {
        const my = ++seq;
        const query = state.apiVersion === '3' ? { query: q || '', maxResults: 15 } : { username: q || '.', maxResults: 15 };
        const res = await api.get(`${V()}/user/search`, query);
        if (my !== seq || openMenuEl !== menu) return;
        const users = (res.ok && Array.isArray(res.data) ? res.data : []).filter((u) => u.accountType !== 'app');
        const items = users.slice(0, 15).map((u) => ({
          label: u.displayName || u.name,
          sub: u.emailAddress || '',
          icon: avatarHTML(u),
          onClick: () => setAssignee({ accountId: u.accountId, name: u.name, displayName: u.displayName || u.name }),
        }));
        listWrap.innerHTML = '';
        menuItems(listWrap, items, res.ok ? 'No people found' : res.error);
      };
      input.addEventListener('input', () => load(input.value));
      setTimeout(() => input.focus(), 30);
      menuItems(listWrap, [], 'Type to search…');
      load('');
    });
  }

  // --------------------------------------------------------------- search --
  async function searchPage(jql, cursor) {
    if (state.useJqlEndpoint) {
      const res = await api.get('/rest/api/3/search/jql', {
        jql, maxResults: 50, fields: LIST_FIELDS, nextPageToken: cursor || undefined,
      });
      if (res.ok) {
        return { ok: true, issues: res.data.issues || [], cursor: res.data.isLast ? null : res.data.nextPageToken };
      }
      if (res.status === 404 || res.status === 410) {
        state.useJqlEndpoint = false; // fall through to legacy below
      } else {
        return { ok: false, error: res.error };
      }
    }
    const startAt = typeof cursor === 'number' ? cursor : 0;
    const res = await api.get(`${V()}/search`, { jql, startAt, maxResults: 50, fields: LIST_FIELDS });
    if (!res.ok) return { ok: false, error: res.error };
    const d = res.data;
    const next = d.startAt + d.issues.length < d.total ? d.startAt + d.issues.length : null;
    return { ok: true, issues: d.issues || [], cursor: next };
  }

  async function loadIssues(append) {
    if (state.loading) return;
    state.loading = true;
    const listEl = $('#issue-list');
    if (!append) {
      state.issues = [];
      state.cursor = null;
      listEl.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      $('#list-header').innerHTML = `<b>${esc(state.listTitle)}</b><span class="jql" title="${esc(state.jql)}">${esc(state.jql)}</span>`;
    }
    const page = await searchPage(state.jql, append ? state.cursor : null);
    state.loading = false;
    if (!page.ok) {
      listEl.innerHTML = `<div class="list-error">${esc(page.error || 'Search failed')}</div>`;
      return;
    }
    state.issues = append ? state.issues.concat(page.issues) : page.issues;
    state.cursor = page.cursor;
    renderIssueList();
    if (state.view === 'board') renderBoard();
  }

  function renderIssueList() {
    const listEl = $('#issue-list');
    listEl.innerHTML = '';
    if (!state.issues.length) {
      listEl.innerHTML = '<div class="list-empty">No issues match this view.<br/>Try another filter or search.</div>';
      return;
    }
    for (const issue of state.issues) {
      const f = issue.fields || {};
      const row = document.createElement('div');
      row.className = 'issue-row' + (issue.key === state.selectedKey ? ' active' : '');
      row.dataset.key = issue.key;
      row.innerHTML = `
        <div class="row-top">
          ${typeGlyph(f.issuetype)}
          <span class="ikey">${esc(issue.key)}</span>
          ${prioGlyph(f.priority)}
          <span class="meta-dim">${fmtRel(f.updated)}</span>
        </div>
        <div class="summary">${esc(f.summary || '')}</div>
        <div class="row-bottom">
          ${statusPill(f.status)}
          <span class="meta-dim">${avatarHTML(f.assignee)}</span>
        </div>`;
      row.addEventListener('click', () => selectIssue(issue.key));
      listEl.appendChild(row);
    }
    if (state.cursor !== null && state.cursor !== undefined) {
      const more = document.createElement('div');
      more.className = 'list-more';
      more.innerHTML = '<button class="btn wide">Load more</button>';
      more.querySelector('button').addEventListener('click', () => loadIssues(true));
      listEl.appendChild(more);
    }
  }

  // --------------------------------------------------------------- detail --
  async function selectIssue(key) {
    state.selectedKey = key;
    document.querySelectorAll('.issue-row').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
    if (state.view === 'board') setView('list');
    const detail = $('#detail');
    detail.innerHTML = '<div class="detail-inner"><div class="skel" style="margin:0 0 12px;height:30px"></div><div class="skel" style="margin:0 0 12px;height:90px"></div><div class="skel" style="margin:0;height:200px"></div></div>';

    const [issueRes, transRes, commentsRes] = await Promise.all([
      api.get(`${V()}/issue/${key}`, { fields: DETAIL_FIELDS }),
      api.get(`${V()}/issue/${key}/transitions`),
      api.get(`${V()}/issue/${key}/comment`, { maxResults: 100 }),
    ]);
    if (state.selectedKey !== key) return; // user moved on
    if (!issueRes.ok) {
      detail.innerHTML = `<div class="detail-empty"><p>${esc(issueRes.error)}</p></div>`;
      return;
    }
    state.detail = {
      issue: issueRes.data,
      transitions: transRes.ok ? transRes.data.transitions || [] : [],
      comments: commentsRes.ok ? commentsRes.data.comments || [] : [],
    };
    renderDetail();
  }

  function renderDetail() {
    const { issue, transitions, comments } = state.detail;
    const f = issue.fields || {};
    const detail = $('#detail');
    const browseUrl = `${state.settings.baseUrl}/browse/${issue.key}`;

    const parentHtml = f.parent
      ? `<span class="ikey" style="cursor:pointer" data-open="${esc(f.parent.key)}" title="${esc(f.parent.fields?.summary || '')}">↰ ${esc(f.parent.key)}</span>`
      : '';

    const subtasks = (f.subtasks || []).map((st) => `
      <div class="subtask-row" data-open="${esc(st.key)}">
        ${typeGlyph(st.fields?.issuetype)}
        <span class="ikey">${esc(st.key)}</span>
        <span class="summary">${esc(st.fields?.summary || '')}</span>
        ${statusPill(st.fields?.status)}
      </div>`).join('');

    const attachments = f.attachment || [];
    const commentsHtml = comments.map((c) => `
      <div class="comment">
        ${avatarHTML(c.author, true)}
        <div class="comment-body">
          <div class="comment-head"><b>${esc(c.author?.displayName || 'Unknown')}</b><time title="${esc(fmtFull(c.created))}">${fmtRel(c.created)}</time></div>
          <div class="adf">${ADF.toHTML(c.body, { attachments })}</div>
        </div>
      </div>`).join('');

    detail.innerHTML = `
      <div class="detail-inner">
        <div class="detail-crumbs">
          ${typeGlyph(f.issuetype)}
          <span class="ikey">${esc(f.project?.name || '')}</span>
          <button class="key-badge" id="d-copy-key" title="Click to copy ${esc(issue.key)}">${esc(issue.key)} <span class="copy-glyph">⧉</span></button>
          ${parentHtml}
          <span class="spacer"></span>
          <button class="chip-btn" id="d-refresh" title="Reload issue">⟳</button>
          <button class="chip-btn" id="d-browse" title="Open in browser">⧉ Browser</button>
        </div>
        <h2 class="detail-title" id="d-title" title="Click to edit summary">${esc(f.summary || '')} <span class="edit-hint">✎</span></h2>

        <div class="detail-actions">
          <button class="chip-btn" id="d-status">${statusPill(f.status)} <span class="caret">▾</span></button>
          <button class="chip-btn" id="d-assignee">${avatarHTML(f.assignee)} ${esc(f.assignee?.displayName || 'Unassigned')} <span class="caret">▾</span></button>
        </div>

        <div class="field-grid">
          <div class="fg-item"><span class="k">Reporter</span><span class="v editable" id="d-reporter" title="Click to change reporter">${avatarHTML(f.reporter)}<span class="txt">${esc(f.reporter?.displayName || '—')}</span><span class="caret">▾</span></span></div>
          <div class="fg-item"><span class="k">Priority</span><span class="v editable" id="d-priority" title="Click to change priority">${prioGlyph(f.priority)}<span class="txt">${esc(f.priority?.name || '—')}</span><span class="caret">▾</span></span></div>
          <div class="fg-item"><span class="k">Type</span><span class="v editable" id="d-type" title="Click to change type">${typeGlyph(f.issuetype)}<span class="txt">${esc(f.issuetype?.name || '—')}</span><span class="caret">▾</span></span></div>
          <div class="fg-item"><span class="k">Due date</span><span class="v editable" id="d-due" title="Click to change due date"><span class="txt">${esc(f.duedate || '—')}</span><span class="caret">▾</span></span></div>
          <div class="fg-item"><span class="k">Created</span><span class="v"><span class="txt" title="${esc(fmtFull(f.created))}">${fmtRel(f.created)}</span></span></div>
          <div class="fg-item"><span class="k">Updated</span><span class="v"><span class="txt" title="${esc(fmtFull(f.updated))}">${fmtRel(f.updated)}</span></span></div>
          <div class="fg-item" style="grid-column:1/-1"><span class="k">Labels</span><span class="v" style="flex-wrap:wrap;row-gap:5px" id="d-labels-chips"></span></div>
        </div>

        <div class="sect-title">Description <button class="chip-btn mini" id="d-edit-desc" title="Edit description">✎ Edit</button> <button class="chip-btn mini" id="d-copy-desc" title="Copy description as Markdown">⧉ Copy</button></div>
        <div class="adf" id="d-desc">${ADF.toHTML(f.description, { attachments }) || '<p class="adf-empty">No description</p>'}</div>

        ${subtasks ? `<div class="sect-title">Subtasks</div>${subtasks}` : ''}

        <div class="sect-title">Comments (${comments.length})</div>
        ${commentsHtml || '<p class="adf-empty" style="font-size:13px;color:var(--faint)">No comments yet</p>'}

        <div class="comment-new">
          ${avatarHTML(state.me, true)}
          <div class="cwrap">
            <textarea id="new-comment" placeholder="Add a comment… (paste or drop images)"></textarea>
            <div class="pending-atts" id="pending-atts" hidden></div>
            <div class="comment-actions">
              <button class="chip-btn" id="btn-attach" title="Attach an image">🖼 Add image</button>
              <input type="file" id="comment-file" accept="image/*" multiple hidden />
              <span class="spacer"></span>
              <button class="btn primary" id="btn-comment">Comment</button>
            </div>
          </div>
        </div>
      </div>`;

    renderLabels();
    hydrateImages(detail);

    $('#d-browse', detail).addEventListener('click', () => window.api.openExternal(browseUrl));
    $('#d-copy-key', detail).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(issue.key);
        toast(`${issue.key} copied to clipboard`, 'ok', 1800);
      } catch {
        toast('Could not copy to clipboard', 'error');
      }
    });
    $('#d-copy-desc', detail).addEventListener('click', async () => {
      const md = ADF.toMarkdown(f.description);
      if (!md) { toast('No description to copy', 'error'); return; }
      try {
        await navigator.clipboard.writeText(md);
        toast('Description copied as Markdown', 'ok', 1800);
      } catch {
        toast('Could not copy to clipboard', 'error');
      }
    });
    $('#d-refresh', detail).addEventListener('click', () => selectIssue(issue.key));
    detail.querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', () => selectIssue(el.dataset.open)));

    // status transitions menu
    $('#d-status', detail).addEventListener('click', (e) => {
      showMenu(e.currentTarget, (menu) => {
        menuItems(menu, transitions.map((t) => ({
          label: t.name,
          sub: t.to ? t.to.name : '',
          onClick: () => doTransition(issue.key, t),
        })), 'No transitions available');
      });
    });

    // assignee menu
    $('#d-assignee', detail).addEventListener('click', (e) => {
      const anchor = e.currentTarget;
      showMenu(anchor, (menu) => {
        const sw = document.createElement('div');
        sw.className = 'menu-search';
        sw.innerHTML = '<input type="text" placeholder="Search people…"/>';
        menu.appendChild(sw);
        const listWrap = document.createElement('div');
        menu.appendChild(listWrap);
        const input = sw.querySelector('input');
        let seq = 0;
        const load = async (q) => {
          const my = ++seq;
          const query = state.apiVersion === '3' ? { issueKey: issue.key, query: q || '' } : { issueKey: issue.key, username: q || '' };
          const res = await api.get(`${V()}/user/assignable/search`, query);
          if (my !== seq) return;
          listWrap.innerHTML = '';
          const users = res.ok ? res.data : [];
          const items = [{ label: 'Unassigned', icon: '<span class="avatar none">·</span>', onClick: () => doAssign(issue.key, null) }]
            .concat((users || []).slice(0, 12).map((u) => ({
              label: u.displayName,
              icon: avatarHTML(u),
              onClick: () => doAssign(issue.key, u),
            })));
          menuItems(listWrap, items);
        };
        input.addEventListener('input', () => load(input.value));
        setTimeout(() => input.focus(), 30);
        load('');
      });
    });

    // summary edit (click title)
    $('#d-title', detail).addEventListener('click', () => {
      const h = $('#d-title', detail);
      if (h.dataset.editing) return;
      h.dataset.editing = '1';
      const cur = f.summary || '';
      h.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'title-input';
      input.value = cur;
      h.appendChild(input);
      input.focus();
      input.select();
      let closed = false;
      const done = (save) => {
        if (closed) return;
        closed = true;
        const v = input.value.trim();
        if (save && v && v !== cur) updateIssueFields(issue.key, { summary: v }, 'Summary updated');
        else renderDetail();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(false));
    });

    // priority menu
    $('#d-priority', detail).addEventListener('click', async (e) => {
      const anchor = e.currentTarget;
      if (!state.priorities) {
        const res = await api.get(`${V()}/priority`);
        state.priorities = res.ok && Array.isArray(res.data) ? res.data : [];
      }
      showMenu(anchor, (menu) => {
        menuItems(menu, state.priorities.map((p) => ({
          label: p.name,
          icon: prioGlyph(p),
          sub: p.id === f.priority?.id ? '✓' : '',
          onClick: () => updateIssueFields(issue.key, { priority: { id: p.id } }, `Priority → ${p.name}`),
        })), 'No priorities available');
      });
    });

    // issue type menu (same-project types; subtask ↔ standard conversion not allowed by Jira)
    $('#d-type', detail).addEventListener('click', async (e) => {
      const anchor = e.currentTarget;
      const projKey = f.project?.key;
      if (!state.projectTypes) state.projectTypes = {};
      if (projKey && !state.projectTypes[projKey]) {
        const res = await api.get(`${V()}/project/${projKey}`);
        state.projectTypes[projKey] = res.ok ? res.data.issueTypes || [] : [];
      }
      const all = (projKey && state.projectTypes[projKey].length ? state.projectTypes[projKey] : state.issueTypes) || [];
      const isSub = Boolean(f.issuetype?.subtask);
      const choices = all.filter((t) => Boolean(t.subtask) === isSub);
      showMenu(anchor, (menu) => {
        menuItems(menu, choices.map((t) => ({
          label: t.name,
          icon: typeGlyph(t),
          sub: t.id === f.issuetype?.id ? '✓' : '',
          onClick: () => {
            if (t.id !== f.issuetype?.id) updateIssueFields(issue.key, { issuetype: { id: t.id } }, `Type → ${t.name}`);
          },
        })), 'No other types available');
      });
    });

    // due date menu
    $('#d-due', detail).addEventListener('click', (e) => {
      showMenu(e.currentTarget, (menu) => {
        const wrap = document.createElement('div');
        wrap.className = 'menu-date';
        wrap.innerHTML = `
          <input type="date" value="${esc(f.duedate || '')}"/>
          <div class="row">
            <button class="btn primary sm" data-act="set">Set</button>
            <button class="btn sm" data-act="clear">Clear</button>
          </div>`;
        const input = wrap.querySelector('input');
        wrap.querySelector('[data-act="set"]').addEventListener('click', () => {
          if (!input.value) return;
          closeMenu();
          updateIssueFields(issue.key, { duedate: input.value }, 'Due date set');
        });
        wrap.querySelector('[data-act="clear"]').addEventListener('click', () => {
          closeMenu();
          updateIssueFields(issue.key, { duedate: null }, 'Due date cleared');
        });
        menu.appendChild(wrap);
        setTimeout(() => input.focus(), 30);
      });
    });

    // reporter menu (user search)
    $('#d-reporter', detail).addEventListener('click', (e) => {
      const anchor = e.currentTarget;
      showMenu(anchor, (menu) => {
        const sw = document.createElement('div');
        sw.className = 'menu-search';
        sw.innerHTML = '<input type="text" placeholder="Search people…"/>';
        menu.appendChild(sw);
        const listWrap = document.createElement('div');
        menu.appendChild(listWrap);
        const input = sw.querySelector('input');
        let seq = 0;
        const load = async (q) => {
          const my = ++seq;
          const query = state.apiVersion === '3' ? { query: q || '' } : { username: q || '.' };
          const res = await api.get(`${V()}/user/search`, query);
          if (my !== seq) return;
          listWrap.innerHTML = '';
          const users = res.ok && Array.isArray(res.data) ? res.data : [];
          menuItems(listWrap, users.slice(0, 12).map((u) => ({
            label: u.displayName,
            icon: avatarHTML(u),
            onClick: () => updateIssueFields(
              issue.key,
              { reporter: state.apiVersion === '3' ? { accountId: u.accountId } : { name: u.name } },
              `Reporter → ${u.displayName}`
            ),
          })), 'No matches');
        };
        input.addEventListener('input', () => load(input.value));
        setTimeout(() => input.focus(), 30);
        load('');
      });
    });

    // description edit
    $('#d-edit-desc', detail).addEventListener('click', () => {
      if ($('#desc-editor', detail)) return;
      const box = $('#d-desc', detail);
      box.style.display = 'none';
      const ed = document.createElement('div');
      ed.id = 'desc-editor';
      ed.className = 'desc-editor';
      ed.innerHTML = `
        <textarea></textarea>
        <div class="row">
          <button class="btn primary" data-act="save">Save</button>
          <button class="btn" data-act="cancel">Cancel</button>
          <span class="hint">Plain text — rich formatting and embedded images are replaced on save.</span>
        </div>`;
      box.after(ed);
      const dta = ed.querySelector('textarea');
      dta.value = state.apiVersion === '3' ? ADF.toText(f.description) : (f.description || '');
      dta.style.minHeight = '160px';
      dta.focus();
      ed.querySelector('[data-act="cancel"]').addEventListener('click', () => { ed.remove(); box.style.display = ''; });
      ed.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const saveBtn = ed.querySelector('[data-act="save"]');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        const v = dta.value;
        const body = v.trim() ? (state.apiVersion === '3' ? ADF.fromText(v) : v) : null;
        const ok = await updateIssueFields(issue.key, { description: body }, 'Description updated');
        if (!ok) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      });
    });

    // add comment (text + optional images)
    const pending = [];
    const ta = $('#new-comment', detail);
    const fileInput = $('#comment-file', detail);
    const pendingWrap = $('#pending-atts', detail);
    const cwrap = detail.querySelector('.comment-new .cwrap');
    let imgSeq = 0;

    function renderPending() {
      pendingWrap.hidden = !pending.length;
      pendingWrap.innerHTML = '';
      pending.forEach((p) => {
        const chip = document.createElement('div');
        chip.className = 'pending-att';
        chip.innerHTML = `<img src="${p.previewUrl}" alt=""/><span class="name" title="${esc(p.name)}">${esc(p.name)}</span><button class="x" title="Remove">×</button>`;
        chip.querySelector('.x').addEventListener('click', () => {
          URL.revokeObjectURL(p.previewUrl);
          pending.splice(pending.indexOf(p), 1);
          renderPending();
        });
        pendingWrap.appendChild(chip);
      });
    }

    function addPendingImage(file) {
      if (!file || !file.type.startsWith('image/')) return;
      // Unique filename per upload so `!name!` embeds reference the right file.
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + (++imgSeq);
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = file.name
        ? file.name.replace(/(\.[^.]+)?$/, (_, e) => `-${stamp}${e || ''}`)
        : `image-${stamp}.${ext}`;
      pending.push({ file, name, previewUrl: URL.createObjectURL(file) });
      renderPending();
    }

    $('#btn-attach', detail).addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      Array.from(fileInput.files).forEach(addPendingImage);
      fileInput.value = '';
    });
    ta.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      files.forEach(addPendingImage);
    });
    cwrap.addEventListener('dragover', (e) => { e.preventDefault(); cwrap.classList.add('drag'); });
    cwrap.addEventListener('dragleave', () => cwrap.classList.remove('drag'));
    cwrap.addEventListener('drop', (e) => {
      e.preventDefault();
      cwrap.classList.remove('drag');
      Array.from(e.dataTransfer?.files || []).forEach(addPendingImage);
    });

    $('#btn-comment', detail).addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text && !pending.length) return;
      const btn = $('#btn-comment', detail);
      btn.disabled = true;
      try {
        const uploadedNames = [];
        for (let i = 0; i < pending.length; i++) {
          btn.textContent = pending.length > 1 ? `Uploading ${i + 1}/${pending.length}…` : 'Uploading…';
          const p = pending[i];
          const data = new Uint8Array(await p.file.arrayBuffer());
          const up = await window.api.jiraUpload({
            path: `${V()}/issue/${issue.key}/attachments`,
            filename: p.name,
            mimeType: p.file.type,
            data,
          });
          if (!up.ok) { toast(`Image upload failed: ${up.error}`, 'error'); return; }
          uploadedNames.push(up.data?.[0]?.filename || p.name);
        }
        btn.textContent = 'Posting…';
        let res;
        if (uploadedNames.length) {
          // Post via the v2 endpoint with wiki markup: `!file!` embeds the uploaded
          // attachment inline, which ADF can't do without internal media IDs.
          const wiki = [text, ...uploadedNames.map((n) => `!${n}!`)].filter(Boolean).join('\n\n');
          res = await api.post(`/rest/api/2/issue/${issue.key}/comment`, { body: wiki });
        } else {
          const body = state.apiVersion === '3' ? { body: ADF.fromText(text) } : { body: text };
          res = await api.post(`${V()}/issue/${issue.key}/comment`, body);
        }
        if (!res.ok) { toast(res.error, 'error'); return; }
        pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        toast('Comment added', 'ok');
        selectIssue(issue.key);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Comment';
      }
    });
  }

  // Fetch attachment images through the main process (adds auth) and swap them in.
  const imgCache = new Map();
  function hydrateImages(root) {
    root.querySelectorAll('img[data-att-src]').forEach((img) => {
      const url = img.dataset.attSrc;
      if (!imgCache.has(url)) {
        if (imgCache.size > 40) imgCache.clear();
        imgCache.set(url, window.api.jiraDownload(url));
      }
      imgCache.get(url).then((res) => {
        if (!img.isConnected) return;
        if (res && res.ok) {
          img.src = res.dataUrl;
          img.removeAttribute('data-att-src');
        } else {
          const ph = document.createElement('div');
          ph.className = 'media-ph';
          ph.textContent = `🖼 ${img.alt || 'Attachment'} (could not load)`;
          img.replaceWith(ph);
        }
      });
    });
  }

  // ---------------------------------------------------------------- labels --
  function renderLabels() {
    const wrap = $('#d-labels-chips');
    if (!wrap || !state.detail) return;
    const labels = state.detail.issue.fields.labels || [];
    wrap.innerHTML =
      labels.map((l) => `<span class="label-chip removable" data-label="${esc(l)}" title="Click to remove">${esc(l)} <span class="x">×</span></span>`).join('') +
      `<button class="label-add" id="d-add-label" title="Add label">+ label</button>`;
    wrap.querySelectorAll('.label-chip.removable').forEach((chip) =>
      chip.addEventListener('click', () => setLabels(labels.filter((l) => l !== chip.dataset.label))));
    $('#d-add-label', wrap).addEventListener('click', (e) => openLabelPicker(e.currentTarget, labels));
  }

  async function fetchAllLabels() {
    if (state.allLabels) return state.allLabels;
    const acc = [];
    for (let startAt = 0, page = 0; page < 10; page++) {
      const res = await api.get(`${V()}/label`, { startAt, maxResults: 1000 });
      if (!res.ok) break;
      acc.push(...(res.data.values || []));
      if (res.data.isLast || !(res.data.values || []).length) break;
      startAt += res.data.maxResults || 1000;
    }
    state.allLabels = acc;
    return acc;
  }

  function openLabelPicker(anchor, current) {
    showMenu(anchor, (menu) => {
      const sw = document.createElement('div');
      sw.className = 'menu-search';
      sw.innerHTML = '<input type="text" placeholder="Filter or type a new label…"/>';
      menu.appendChild(sw);
      const listWrap = document.createElement('div');
      menu.appendChild(listWrap);
      const input = sw.querySelector('input');

      const draw = (all) => {
        const q = input.value.trim();
        const ql = q.toLowerCase();
        const available = all.filter((l) => !current.includes(l));
        const matches = available.filter((l) => l.toLowerCase().includes(ql)).slice(0, 30);
        const items = matches.map((l) => ({ label: l, icon: '<span class="glyph">🏷</span>', onClick: () => setLabels(current.concat(l)) }));
        const exact = all.some((l) => l.toLowerCase() === ql) || current.some((l) => l.toLowerCase() === ql);
        if (q && !exact && /^[^\s]+$/.test(q)) {
          items.unshift({ label: `Create "${q}"`, icon: '<span class="glyph">＋</span>', onClick: () => setLabels(current.concat(q)) });
        }
        listWrap.innerHTML = '';
        menuItems(listWrap, items, q ? 'No matches (labels can\'t contain spaces)' : 'No more labels');
      };

      input.addEventListener('input', () => draw(state.allLabels || []));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = input.value.trim();
          if (q && /^[^\s]+$/.test(q) && !current.includes(q)) { closeMenu(); setLabels(current.concat(q)); }
        }
      });
      setTimeout(() => input.focus(), 30);
      menuItems(listWrap, [], 'Loading labels…');
      fetchAllLabels().then((all) => { if (openMenuEl === menu) draw(all); });
    });
  }

  async function setLabels(labels) {
    closeMenu();
    const key = state.detail.issue.key;
    const uniq = [...new Set(labels)];
    const res = await api.put(`${V()}/issue/${key}`, { fields: { labels: uniq } });
    if (!res.ok) { toast(res.error, 'error'); return; }
    state.detail.issue.fields.labels = uniq;
    renderLabels();
    // learn newly-created labels for future suggestions
    if (state.allLabels) for (const l of uniq) if (!state.allLabels.includes(l)) state.allLabels.push(l);
    refreshIssueInList(key);
    toast('Labels updated', 'ok');
  }

  async function updateIssueFields(key, fields, okMsg) {
    const res = await api.put(`${V()}/issue/${key}`, { fields });
    if (!res.ok) { toast(res.error, 'error'); return false; }
    toast(okMsg || 'Updated', 'ok');
    refreshIssueInList(key);
    if (state.selectedKey === key) selectIssue(key);
    return true;
  }

  async function doTransition(key, transition) {
    const res = await api.post(`${V()}/issue/${key}/transitions`, { transition: { id: transition.id } });
    if (!res.ok) { toast(res.error, 'error'); return false; }
    toast(`${key} → ${transition.to ? transition.to.name : transition.name}`, 'ok');
    refreshIssueInList(key);
    if (state.selectedKey === key) selectIssue(key);
    return true;
  }

  async function doAssign(key, user) {
    const body = user
      ? (state.apiVersion === '3' ? { accountId: user.accountId } : { name: user.name })
      : (state.apiVersion === '3' ? { accountId: null } : { name: null });
    const res = await api.put(`${V()}/issue/${key}/assignee`, body);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(user ? `Assigned to ${user.displayName}` : 'Unassigned', 'ok');
    refreshIssueInList(key);
    if (state.selectedKey === key) selectIssue(key);
  }

  async function refreshIssueInList(key) {
    const res = await api.get(`${V()}/issue/${key}`, { fields: LIST_FIELDS });
    if (!res.ok) return;
    const li = state.issues.findIndex((i) => i.key === key);
    if (li >= 0) state.issues[li] = res.data;
    const bi = state.board.issues.findIndex((i) => i.key === key);
    if (bi >= 0) state.board.issues[bi] = res.data;
    renderIssueList();
    if (state.view === 'board') renderBoard();
  }

  // ---------------------------------------------------------------- board --
  // Two modes: 'agile' uses the real Jira board for the selected project
  // (columns + issues from /rest/agile/1.0); 'quick' groups the current
  // issue list by status when no project/board is available.

  function setView(view, opts = {}) {
    state.view = view;
    $('#view-list').classList.toggle('active', view === 'list');
    $('#view-board').classList.toggle('active', view === 'board');
    $('#content-list').classList.toggle('hidden', view !== 'list');
    $('#content-board').classList.toggle('hidden', view !== 'board');
    if (view === 'board' && !opts.skipOpen) openBoard();
    markActiveNav();
  }

  // open a specific board from the sidebar, independent of the project filter
  async function openBoardFromNav(bd) {
    const b = state.board;
    b.pinned = true;
    b.key = null;
    b.boards = state.boards;
    setView('board', { skipOpen: true });
    markActiveNav();
    await selectBoard(bd.id);
  }

  async function openBoard(force) {
    const b = state.board;
    if (b.pinned && b.boardId) {
      if (force || !b.columns) await selectBoard(b.boardId);
      else { renderBoardToolbar(); renderBoard(); }
      return;
    }
    const projKey = state.filterId.startsWith('proj:') ? state.filterId.slice(5) : null;
    if (!projKey) {
      b.mode = 'quick';
      renderBoardToolbar();
      renderBoard();
      return;
    }
    if (!force && b.key === projKey && b.mode === 'agile' && b.columns) {
      renderBoardToolbar();
      renderBoard();
      return;
    }
    b.key = projKey;
    b.loading = true;
    b.boardName = '';
    renderBoardToolbar();
    boardSkeleton();
    const res = await api.get('/rest/agile/1.0/board', { projectKeyOrId: projKey, maxResults: 50 });
    if (state.board.key !== projKey || state.view !== 'board') return;
    b.boards = res.ok ? res.data.values || [] : [];
    if (!b.boards.length) {
      b.mode = 'quick';
      b.loading = false;
      renderBoardToolbar();
      renderBoard();
      return;
    }
    // prefer a kanban board if the project has several
    const preferred = b.boards.find((x) => x.type === 'kanban') || b.boards[0];
    await selectBoard(preferred.id);
  }

  async function selectBoard(boardId) {
    const b = state.board;
    b.mode = 'agile';
    b.boardId = boardId;
    const meta = b.boards.find((x) => x.id === boardId);
    b.boardName = meta ? meta.name : `Board ${boardId}`;
    b.loading = true;
    renderBoardToolbar();
    markActiveNav();
    boardSkeleton();

    const cfg = await api.get(`/rest/agile/1.0/board/${boardId}/configuration`);
    let columns = null;
    if (cfg.ok && cfg.data.columnConfig && Array.isArray(cfg.data.columnConfig.columns)) {
      columns = cfg.data.columnConfig.columns.map((c) => ({
        name: c.name,
        statusIds: (c.statuses || []).map((s) => String(s.id)),
      }));
    }

    let issues = [];
    for (let startAt = 0, page = 0; page < 6; page++) {
      const r = await api.get(`/rest/agile/1.0/board/${boardId}/issue`, { startAt, maxResults: 100, fields: LIST_FIELDS });
      if (!r.ok) {
        if (!issues.length) {
          b.mode = 'quick';
          b.loading = false;
          renderBoardToolbar();
          renderBoard();
          toast(r.error, 'error');
          return;
        }
        break;
      }
      issues = issues.concat(r.data.issues || []);
      const total = r.data.total;
      if (!(r.data.issues || []).length || (typeof total === 'number' && issues.length >= total)) break;
      startAt = issues.length;
    }
    if (b.boardId !== boardId) return; // user switched boards meanwhile
    b.columns = columns;
    b.issues = issues;
    b.loading = false;
    renderBoardToolbar();
    renderBoard();
  }

  function boardSkeleton() {
    $('#board-cols').innerHTML =
      '<div class="board-col"><div class="skel" style="height:120px;margin:10px"></div><div class="skel" style="height:80px;margin:10px"></div></div>'.repeat(3);
  }

  function renderBoardToolbar() {
    const b = state.board;
    const bar = $('#board-toolbar');
    if (b.mode === 'agile' || (b.loading && (b.key || b.pinned))) {
      const isStar = state.starredBoards.has(b.boardId);
      bar.innerHTML = `
        <button class="chip-btn" id="bt-board">▦ ${esc(b.boardName || 'Board')} <span class="caret">▾</span></button>
        <button class="chip-btn" id="bt-star" title="${isStar ? 'Unstar board' : 'Star board'}">${isStar ? '★' : '☆'}</button>
        <span class="meta-dim" style="margin:0">${b.loading ? 'Loading board…' : `${b.issues.length} issues · ${(b.columns || []).length || '?'} columns`}</span>
        <span class="spacer"></span>
        <button class="chip-btn" id="bt-refresh" title="Reload board">⟳ Refresh</button>`;
      $('#bt-board').addEventListener('click', (e) => {
        // pick from every board the user can see, starred first
        const all = state.boards.length ? state.boards : b.boards;
        showMenu(e.currentTarget, (menu) => {
          menuItems(menu, sortedBoards(all).map((bd) => ({
            label: `${state.starredBoards.has(bd.id) ? '★ ' : ''}${bd.name}`,
            sub: [bd.location?.projectKey, bd.type].filter(Boolean).join(' · '),
            onClick: () => {
              b.pinned = true;
              b.boards = all;
              selectBoard(bd.id);
            },
          })), 'No boards');
        });
      });
      $('#bt-star').addEventListener('click', () => {
        if (b.boardId != null) toggleBoardStar(b.boardId);
      });
    } else {
      bar.innerHTML = `
        <span style="font-weight:600">${esc(state.listTitle)}</span>
        <span class="meta-dim" style="margin:0">quick board — grouped by status · select a project in the sidebar for its real board</span>
        <span class="spacer"></span>
        <button class="chip-btn" id="bt-refresh" title="Reload">⟳ Refresh</button>`;
    }
    $('#bt-refresh').addEventListener('click', () => {
      if (state.board.mode === 'agile') openBoard(true);
      else loadIssues(false);
    });
  }

  function renderBoard() {
    if (state.view !== 'board') return;
    if (state.board.mode === 'agile' && state.board.columns) renderAgileBoard();
    else renderQuickBoard();
  }

  function makeBoardCard(issue, showStatus) {
    const f = issue.fields || {};
    const card = document.createElement('div');
    card.className = 'board-card';
    card.draggable = true;
    card.dataset.key = issue.key;
    card.innerHTML = `
      <div class="row-top">${typeGlyph(f.issuetype)}<span class="ikey">${esc(issue.key)}</span>${prioGlyph(f.priority)}<span class="meta-dim">${avatarHTML(f.assignee)}</span></div>
      <div class="summary">${esc(f.summary || '')}</div>
      ${showStatus ? `<div class="card-foot">${statusPill(f.status)}<span class="meta-dim">${fmtRel(f.updated)}</span></div>` : ''}`;
    card.addEventListener('click', () => selectIssue(issue.key));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', issue.key);
      e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  // opts: { label, alreadyThere(issue), match(transitions) }
  function attachDrop(colEl, opts) {
    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const key = e.dataTransfer.getData('text/plain');
      if (!key) return;
      const pool = state.board.mode === 'agile' ? state.board.issues : state.issues;
      const issue = pool.find((i) => i.key === key);
      if (!issue || opts.alreadyThere(issue)) return;
      const tr = await api.get(`${V()}/issue/${key}/transitions`);
      if (!tr.ok) { toast(tr.error, 'error'); return; }
      const match = opts.match(tr.data.transitions || []);
      if (!match) {
        toast(`No workflow transition from "${issue.fields.status?.name}" to "${opts.label}"`, 'error');
        return;
      }
      await doTransition(key, match);
    });
  }

  function renderAgileBoard() {
    const b = state.board;
    const root = $('#board-cols');
    root.innerHTML = '';
    const used = new Set();
    const cols = b.columns.map((c) => ({ ...c, issues: [] }));
    for (const issue of b.issues) {
      const sid = String(issue.fields?.status?.id || '');
      const col = cols.find((c) => c.statusIds.includes(sid));
      if (col) { col.issues.push(issue); used.add(issue.key); }
    }
    const leftovers = b.issues.filter((i) => !used.has(i.key));
    if (leftovers.length) cols.push({ name: 'Other', statusIds: [], issues: leftovers });

    for (const col of cols) {
      const colEl = document.createElement('div');
      colEl.className = 'board-col';
      colEl.innerHTML = `
        <div class="board-col-head"><span class="col-name">${esc(col.name)}</span><span class="count">${col.issues.length}</span></div>
        <div class="board-cards"></div>`;
      const cards = colEl.querySelector('.board-cards');
      for (const issue of col.issues) cards.appendChild(makeBoardCard(issue, col.statusIds.length > 1));
      if (!col.issues.length) cards.innerHTML = '<div class="board-empty">No issues</div>';
      if (col.statusIds.length) {
        attachDrop(colEl, {
          label: col.name,
          alreadyThere: (issue) => col.statusIds.includes(String(issue.fields.status?.id || '')),
          match: (transitions) => transitions.find((t) => t.to && col.statusIds.includes(String(t.to.id))),
        });
      }
      root.appendChild(colEl);
    }
  }

  function renderQuickBoard() {
    const root = $('#board-cols');
    root.innerHTML = '';
    const cols = new Map();
    for (const issue of state.issues) {
      const st = issue.fields?.status;
      if (!st) continue;
      const id = st.id || st.name;
      if (!cols.has(id)) cols.set(id, { status: st, issues: [] });
      cols.get(id).issues.push(issue);
    }
    const catOrder = { new: 0, indeterminate: 1, done: 2 };
    const sorted = [...cols.values()].sort((a, b) =>
      (catOrder[a.status.statusCategory?.key] ?? 1) - (catOrder[b.status.statusCategory?.key] ?? 1) ||
      a.status.name.localeCompare(b.status.name));

    if (!sorted.length) {
      root.innerHTML = '<div class="list-empty" style="width:100%">No issues loaded for this view.</div>';
      return;
    }

    for (const col of sorted) {
      const colEl = document.createElement('div');
      colEl.className = 'board-col';
      colEl.innerHTML = `
        <div class="board-col-head">${statusPill(col.status)}<span class="count">${col.issues.length}</span></div>
        <div class="board-cards"></div>`;
      const cards = colEl.querySelector('.board-cards');
      for (const issue of col.issues) cards.appendChild(makeBoardCard(issue, false));
      if (!col.issues.length) cards.innerHTML = '<div class="board-empty">No issues</div>';
      attachDrop(colEl, {
        label: col.status.name,
        alreadyThere: (issue) => issue.fields.status?.id === col.status.id,
        match: (transitions) => transitions.find((t) => t.to && (t.to.id === col.status.id || t.to.name === col.status.name)),
      });
      root.appendChild(colEl);
    }
  }

  // --------------------------------------------------------- create issue --
  async function openCreateModal() {
    if (!state.projects.length) { toast('No projects available', 'error'); return; }
    const currentProj = state.filterId.startsWith('proj:') ? state.filterId.slice(5) : state.projects[0].key;

    const overlay = openModal(`
      <div class="modal-head"><h3>Create issue</h3><button class="icon-btn" id="cm-close" style="font-size:18px">×</button></div>
      <div class="modal-body">
        <div class="row2">
          <label class="field"><span>Project</span>
            <select id="cm-project">${state.projects.map((p) =>
              `<option value="${esc(p.key)}" ${p.key === currentProj ? 'selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select>
          </label>
          <label class="field"><span>Issue type</span>
            <select id="cm-type"><option>Loading…</option></select>
          </label>
        </div>
        <label class="field"><span>Summary *</span><input id="cm-summary" type="text" placeholder="What needs to be done?"/></label>
        <label class="field"><span>Description</span><textarea id="cm-desc" rows="6" placeholder="Add more detail… (plain text)"></textarea></label>
        <div class="row2">
          <label class="field"><span>Priority</span><select id="cm-priority"><option value="">Default</option></select></label>
          <label class="field"><span>Labels</span><input id="cm-labels" type="text" placeholder="comma, separated"/></label>
        </div>
        <div id="cm-error" class="form-error hidden"></div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="cm-cancel">Cancel</button>
        <button class="btn primary" id="cm-create">Create issue</button>
      </div>`);

    const close = () => overlay.remove();
    $('#cm-close', overlay).addEventListener('click', close);
    $('#cm-cancel', overlay).addEventListener('click', close);
    setTimeout(() => $('#cm-summary', overlay).focus(), 50);

    async function loadTypes(projectKey) {
      const sel = $('#cm-type', overlay);
      sel.innerHTML = '<option>Loading…</option>';
      let types = [];
      if (state.apiVersion === '3') {
        const res = await api.get(`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { maxResults: 50 });
        if (res.ok) types = res.data.issueTypes || res.data.values || [];
      }
      if (!types.length) {
        const res = await api.get(`${V()}/issue/createmeta`, { projectKeys: projectKey, expand: 'projects.issuetypes' });
        if (res.ok && res.data.projects && res.data.projects[0]) types = res.data.projects[0].issuetypes || [];
      }
      types = types.filter((t) => !t.subtask);
      sel.innerHTML = types.length
        ? types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')
        : '<option value="">No types found</option>';
    }

    async function loadPriorities() {
      let list = [];
      if (state.apiVersion === '3') {
        const res = await api.get('/rest/api/3/priority/search', { maxResults: 50 });
        if (res.ok) list = res.data.values || [];
      }
      if (!list.length) {
        const res = await api.get(`${V()}/priority`);
        if (res.ok && Array.isArray(res.data)) list = res.data;
      }
      const sel = $('#cm-priority', overlay);
      sel.innerHTML = '<option value="">Default</option>' + list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    }

    $('#cm-project', overlay).addEventListener('change', (e) => loadTypes(e.target.value));
    loadTypes(currentProj);
    loadPriorities();

    $('#cm-create', overlay).addEventListener('click', async () => {
      const summary = $('#cm-summary', overlay).value.trim();
      const errEl = $('#cm-error', overlay);
      errEl.classList.add('hidden');
      if (!summary) { errEl.textContent = 'Summary is required.'; errEl.classList.remove('hidden'); return; }
      const typeId = $('#cm-type', overlay).value;
      if (!typeId) { errEl.textContent = 'Pick an issue type.'; errEl.classList.remove('hidden'); return; }

      const fields = {
        project: { key: $('#cm-project', overlay).value },
        issuetype: { id: typeId },
        summary,
      };
      const desc = $('#cm-desc', overlay).value.trim();
      if (desc) fields.description = state.apiVersion === '3' ? ADF.fromText(desc) : desc;
      const prio = $('#cm-priority', overlay).value;
      if (prio) fields.priority = { id: prio };
      const labels = $('#cm-labels', overlay).value.split(',').map((s) => s.trim()).filter(Boolean);
      if (labels.length) fields.labels = labels;

      const btn = $('#cm-create', overlay);
      btn.disabled = true; btn.textContent = 'Creating…';
      const res = await api.post(`${V()}/issue`, { fields });
      btn.disabled = false; btn.textContent = 'Create issue';
      if (!res.ok) { errEl.textContent = res.error; errEl.classList.remove('hidden'); return; }
      close();
      toast(`Created ${res.data.key}`, 'ok');
      loadIssues(false);
      selectIssue(res.data.key);
    });
  }

  // --------------------------------------------------------------- search --
  function runSearch(raw) {
    const q = raw.trim();
    if (!q) { applyFilter('my-open'); return; }
    const keyMatch = q.match(/^([A-Za-z][A-Za-z0-9_]+-\d+)$/);
    if (keyMatch) {
      const key = keyMatch[1].toUpperCase();
      state.filterId = 'search';
      state.jql = `key = ${key}`;
      state.listTitle = key;
      markActiveNav();
      loadIssues(false);
      selectIssue(key);
      return;
    }
    const looksLikeJql = /(=|~|!=|>|<| in \(| IN \(|ORDER BY|order by| AND | OR )/.test(q);
    state.filterId = 'search';
    state.jql = looksLikeJql ? q : `text ~ "${q.replace(/"/g, '\\"')}*" ORDER BY updated DESC`;
    state.listTitle = looksLikeJql ? 'JQL search' : `Search: ${q}`;
    markActiveNav();
    loadIssues(false);
  }

  // ---------------------------------------------------------------- wires --
  function wire() {
    $('#set-save').addEventListener('click', saveSettings);
    $('#set-cancel').addEventListener('click', () => {
      $('#onboarding').classList.add('hidden');
      $('#app').classList.remove('hidden');
    });
    $('#token-help').addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens');
    });
    document.querySelectorAll('#onboarding input').forEach((inp) =>
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); }));

    $('#btn-settings').addEventListener('click', () => showSettings(true));
    $('#btn-refresh').addEventListener('click', () => { loadIssues(false); if (state.selectedKey) selectIssue(state.selectedKey); });
    $('#btn-create').addEventListener('click', openCreateModal);
    $('#btn-reload-projects').addEventListener('click', loadProjects);
    $('#btn-reload-boards').addEventListener('click', loadBoards);
    $('#view-list').addEventListener('click', () => setView('list'));
    $('#view-board').addEventListener('click', () => setView('board'));

    const search = $('#search');
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch(search.value);
      if (e.key === 'Escape') { search.value = ''; search.blur(); }
    });

    // open external links from rendered ADF content
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && /^https?:\/\//i.test(a.getAttribute('href'))) {
        e.preventDefault();
        window.api.openExternal(a.href);
      }
    });

    document.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (e.key === 'Escape') {
        closeMenu();
        const overlay = $('#modal-root .modal-overlay');
        if (overlay) overlay.remove();
        return;
      }
      if (inField) return;
      if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
      else if (e.key === 'r') loadIssues(false);
      else if (e.key === 'c') openCreateModal();
      else if (e.key === 'j' || e.key === 'k') {
        const idx = state.issues.findIndex((i) => i.key === state.selectedKey);
        const next = e.key === 'j' ? Math.min(idx + 1, state.issues.length - 1) : Math.max(idx - 1, 0);
        if (state.issues[next]) selectIssue(state.issues[next].key);
      }
    });
  }

  // ----------------------------------------------------------------- init --
  async function init() {
    wire();
    const s = await window.api.getSettings();
    state.settings = s;
    if (!s.configured) {
      showSettings(false);
    } else {
      boot();
    }
  }

  init();
})();
