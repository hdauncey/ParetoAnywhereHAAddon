(() => {
  'use strict';

  // Everything is relative to the page URL so it works under the ingress path prefix.
  const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  const $ = (id) => document.getElementById(id);

  async function api(path, options) {
    const res = await fetch(BASE + 'api/' + path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || text || res.statusText);
      err.details = json && json.details;
      throw err;
    }
    return json;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return el;
  }

  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function showMessage(id, kind, text, details) {
    const el = $(id);
    if (!text) { el.hidden = true; return; }
    el.className = 'message ' + kind;
    el.textContent = text + (details && details.length ? '\n• ' + details.join('\n• ') : '');
    el.hidden = false;
  }

  // ----------------------------------------------------------------- tabs --

  const loaders = {};
  let activeTab = 'mappings';

  function selectTab(name) {
    activeTab = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (loaders[name]) loaders[name]();
  }
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) selectTab(e.target.dataset.tab); });

  // ------------------------------------------------------------- mappings --

  const ID_RE = /^[0-9a-f]{8}$/;
  const EEP_RE = /^[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}$/;
  let rows = [];
  let dirty = false;

  function normId(v) {
    let s = String(v || '').trim().toLowerCase();
    if (s.endsWith('/7')) s = s.slice(0, -2);
    return s.replace(/^0x/, '').replace(/[\s:\-_]/g, '');
  }
  const normEep = (v) => String(v || '').trim().toUpperCase().replace(/[_\s]/g, '-');

  function setDirty(v) { dirty = v; $('dirty').hidden = !v; }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  function renderRows(focusIndex) {
    const tbody = $('mapTable').querySelector('tbody');
    tbody.replaceChildren();
    rows.forEach((row, i) => {
      const idInput = h('input', { class: 'mono', value: row.id, placeholder: '05174fc4', 'aria-label': 'Device ID', autocomplete: 'off', spellcheck: 'false' });
      const eepInput = h('input', { class: 'mono', value: row.eepType, placeholder: 'A5-04-03', list: 'eepList', 'aria-label': 'EEP type', autocomplete: 'off', spellcheck: 'false' });
      const labelInput = h('input', { value: row.label, placeholder: 'e.g. Server room temperature', maxlength: '100', 'aria-label': 'Label' });

      const validate = () => {
        const id = normId(idInput.value);
        const eep = normEep(eepInput.value);
        const dup = rows.some((r, j) => j !== i && normId(r.id) === id && id);
        idInput.setAttribute('aria-invalid', String(!!idInput.value && (!ID_RE.test(id) || dup)));
        eepInput.setAttribute('aria-invalid', String(!!eepInput.value && !EEP_RE.test(eep)));
      };
      idInput.addEventListener('input', () => { row.id = idInput.value; setDirty(true); validate(); });
      eepInput.addEventListener('input', () => { row.eepType = eepInput.value; setDirty(true); validate(); });
      labelInput.addEventListener('input', () => { row.label = labelInput.value; setDirty(true); });
      idInput.addEventListener('blur', () => { const n = normId(idInput.value); if (ID_RE.test(n)) { idInput.value = n; row.id = n; validate(); } });
      eepInput.addEventListener('blur', () => { const n = normEep(eepInput.value); if (EEP_RE.test(n)) { eepInput.value = n; row.eepType = n; validate(); } });

      const del = h('button', { class: 'danger secondary', title: 'Remove', onclick: () => { rows.splice(i, 1); setDirty(true); renderRows(); } }, 'Remove');
      tbody.append(h('tr', {}, h('td', {}, idInput), h('td', {}, eepInput), h('td', {}, labelInput), h('td', { class: 'actions' }, del)));
      validate();
      if (focusIndex === i) setTimeout(() => (row.id ? eepInput : idInput).focus(), 0);
    });
    $('mapEmpty').hidden = rows.length > 0;
    $('mapTable').hidden = rows.length === 0;
  }

  function applyResponse(data) {
    rows = data.mappings.map((m) => ({ id: m.id.replace(/\/7$/, ''), eepType: m.eepType, label: m.label || '' }));
    setDirty(false);
    renderRows();
    if (data.parseError) {
      showMessage('mapMessage', 'error', 'enocean.json on disk is not valid JSON (' + data.parseError + '). Fix it in the Raw JSON tab.');
    } else if (data.warnings && data.warnings.length) {
      showMessage('mapMessage', 'warn', 'Some entries in enocean.json were not recognised and are hidden here:', data.warnings);
    } else {
      showMessage('mapMessage', 'ok', '');
    }
    $('rawText').value = data.raw;
  }

  loaders.mappings = async () => {
    if (dirty) return;
    try { applyResponse(await api('enocean')); } catch (e) { showMessage('mapMessage', 'error', e.message); }
  };

  function addRow(id) {
    const clean = id ? id.replace(/\/7$/, '') : '';
    if (clean && rows.some((r) => normId(r.id) === clean)) { toast('Already in the list'); return; }
    rows.push({ id: clean, eepType: '', label: '' });
    setDirty(true);
    renderRows(rows.length - 1);
  }

  async function saveMappings(restart) {
    showMessage('mapMessage', 'ok', '');
    try {
      const data = await api('enocean' + (restart ? '?restart=1' : ''), { method: 'PUT', body: JSON.stringify({ mappings: rows }) });
      applyResponse(data);
      showMessage('mapMessage', 'ok', restart ? 'Saved. Pareto Anywhere restarted.' : 'Saved. Restart Pareto Anywhere to apply.');
    } catch (e) {
      showMessage('mapMessage', 'error', e.message, e.details);
    }
  }

  $('addRow').addEventListener('click', () => addRow());
  $('saveBtn').addEventListener('click', () => saveMappings(false));
  $('saveRestartBtn').addEventListener('click', () => saveMappings(true));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('File must be a JSON object');
      const imported = Object.entries(obj).map(([k, v]) => ({ id: k, eepType: (v && v.eepType) || '', label: '' }));
      const existing = new Map(rows.map((r) => [normId(r.id), r]));
      imported.forEach((r) => { const n = normId(r.id); if (existing.has(n)) existing.get(n).eepType = r.eepType; else rows.push(r); });
      setDirty(true);
      renderRows();
      showMessage('mapMessage', 'warn', `Imported ${imported.length} entries (merged into the list). Review, then Save.`);
    } catch (err) {
      showMessage('mapMessage', 'error', 'Import failed: ' + err.message);
    }
  });

  // ----------------------------------------------------------- discovered --

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    return isNaN(d) ? '' : d.toLocaleString();
  }

  loaders.discovered = async () => {
    try {
      const data = await api('discovered');
      const tbody = $('discTable').querySelector('tbody');
      tbody.replaceChildren();
      if (!data.reachable) showMessage('discMessage', 'warn', 'Pareto Anywhere is not reachable yet: ' + (data.error || ''));
      else if (data.error) showMessage('discMessage', 'warn', data.error);
      else showMessage('discMessage', 'ok', '');
      data.devices.forEach((d) => {
        const status = d.mapped ? h('span', {}, 'Mapped: ', h('code', {}, d.eepType)) : h('span', { style: 'color:var(--warn)' }, 'Unmapped');
        const action = d.mapped ? '' : h('button', { onclick: () => { selectTab('mappings'); addRow(d.id); } }, 'Add mapping');
        tbody.append(h('tr', {}, h('td', {}, h('code', {}, d.id)), h('td', {}, status, d.lastSeen ? '  ' + fmtTime(d.lastSeen) : ''), h('td', { class: 'actions' }, action)));
      });
      $('discEmpty').hidden = data.devices.length > 0;
      $('discTable').hidden = data.devices.length === 0;
    } catch (e) {
      showMessage('discMessage', 'error', e.message);
    }
  };
  $('refreshDiscovered').addEventListener('click', loaders.discovered);
  setInterval(() => { if (activeTab === 'discovered') loaders.discovered(); }, 10000);

  // ------------------------------------------------------------------ raw --

  loaders.raw = async () => {
    try { $('rawText').value = (await api('enocean')).raw; showMessage('rawMessage', 'ok', ''); } catch (e) { showMessage('rawMessage', 'error', e.message); }
  };
  $('reloadRaw').addEventListener('click', loaders.raw);
  $('formatRaw').addEventListener('click', () => {
    try { $('rawText').value = JSON.stringify(JSON.parse($('rawText').value), null, 2) + '\n'; showMessage('rawMessage', 'ok', ''); } catch (e) { showMessage('rawMessage', 'error', 'Invalid JSON: ' + e.message); }
  });
  async function saveRaw(restart) {
    try {
      const data = await api('enocean/raw' + (restart ? '?restart=1' : ''), { method: 'PUT', body: JSON.stringify({ text: $('rawText').value }) });
      $('rawText').value = data.raw;
      applyResponse(data);
      showMessage('rawMessage', 'ok', restart ? 'Saved. Pareto Anywhere restarted.' : 'Saved. Restart Pareto Anywhere to apply.');
    } catch (e) {
      showMessage('rawMessage', 'error', e.message, e.details);
    }
  }
  $('saveRaw').addEventListener('click', () => saveRaw(false));
  $('saveRawRestart').addEventListener('click', () => saveRaw(true));

  // -------------------------------------------------------------- backups --

  loaders.backups = async () => {
    try {
      const { backups } = await api('backups');
      const tbody = $('backupTable').querySelector('tbody');
      tbody.replaceChildren();
      backups.forEach((b) => {
        const restore = h('button', {
          onclick: async () => {
            if (!confirm('Restore ' + b.name + '? The current file is backed up first.')) return;
            try { applyResponse(await api('backups/' + encodeURIComponent(b.name) + '/restore', { method: 'POST' })); showMessage('backupMessage', 'ok', 'Restored. Restart Pareto Anywhere to apply.'); loaders.backups(); }
            catch (e) { showMessage('backupMessage', 'error', e.message, e.details); }
          },
        }, 'Restore');
        const dl = h('a', { class: 'button secondary', href: BASE + 'api/backups/' + encodeURIComponent(b.name) }, 'Download');
        tbody.append(h('tr', {}, h('td', {}, h('code', {}, b.name)), h('td', {}, b.size + ' B'), h('td', { class: 'actions' }, dl, ' ', restore)));
      });
      $('backupEmpty').hidden = backups.length > 0;
      $('backupTable').hidden = backups.length === 0;
    } catch (e) { showMessage('backupMessage', 'error', e.message); }
  };

  // --------------------------------------------------------------- status --

  let lastLog = 0;
  async function refreshStatus() {
    try {
      const s = await api('status');
      const pill = $('statusPill');
      pill.textContent = s.running ? (s.reachable ? 'Running' : 'Starting…') : 'Stopped';
      pill.className = 'pill ' + (s.running && s.reachable ? 'ok' : 'bad');
      if (activeTab !== 'status') return;
      const items = [
        ['Pareto Anywhere', s.paretoVersion ? 'v' + s.paretoVersion : 'unknown'],
        ['Process', s.running ? 'running (pid ' + s.pid + ', up ' + s.uptimeSeconds + ' s)' : 'stopped'],
        ['HTTP(S) listener', s.reachable ? 'reachable on ' + s.protocol + '://…:' + s.port : 'not reachable'],
        ['Crash restarts', String(s.restarts)],
        ['TLS', s.protocol === 'https' ? 'enabled (wss://)' : (s.tlsRequested ? 'requested but certificate not found: see log' : 'disabled (ws://)')],
        ['enocean.json', s.enoceanFile],
      ];
      if (s.lastExit) items.push(['Last exit', 'code ' + s.lastExit.code + ' / ' + s.lastExit.signal + ' at ' + fmtTime(s.lastExit.at)]);
      $('statusList').replaceChildren(...items.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
      const ws = s.protocol === 'https' ? 'wss' : 'ws';
      $('arubaUrls').textContent =
        'AOS 8:  ' + ws + '://<HA-HOST>:' + s.port + '/aruba/aos8\n' +
        'AOS 10: wss://<HA-HOST>:' + s.port + '/aruba/aos10   (secure WebSockets only: enable TLS in the add-on options)';
      $('directPort').textContent = String(s.port);
    } catch (e) { $('statusPill').textContent = 'Unavailable'; $('statusPill').className = 'pill bad'; }
  }

  async function refreshLogs() {
    if (activeTab !== 'status') return;
    try {
      const { lines, last } = await api('logs?since=' + lastLog);
      lastLog = last;
      if (!lines.length) return;
      const view = $('logView');
      const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
      view.append(lines.map((l) => new Date(l.t).toLocaleTimeString() + ' [' + l.src + '] ' + l.text).join('\n') + '\n');
      if (atBottom) view.scrollTop = view.scrollHeight;
    } catch (e) { /* transient */ }
  }

  loaders.status = () => { refreshStatus(); refreshLogs(); };
  $('restartBtn').addEventListener('click', async () => {
    if (!confirm('Restart Pareto Anywhere? Live data will pause for a few seconds.')) return;
    try { await api('restart', { method: 'POST' }); toast('Pareto Anywhere restarted'); refreshStatus(); } catch (e) { toast(e.message); }
  });
  setInterval(refreshStatus, 5000);
  setInterval(refreshLogs, 2000);

  // ------------------------------------------------------------ pareto ui --

  loaders.pareto = () => { const f = $('paretoFrame'); if (!f.getAttribute('src')) f.setAttribute('src', 'pareto/'); };

  // ----------------------------------------------------------------- init --

  const initial = location.hash.replace('#', '');
  loaders.mappings().then(() => selectTab(document.getElementById('tab-' + initial) ? initial : 'mappings'));
  refreshStatus();
})();
