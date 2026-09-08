// @ts-check
/* Task queue UI. Vanilla DOM, same as the chat view: no framework, no bundle. */
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const tasksEl = $('tasks');
  const runbarEl = $('runbar');
  const countsEl = $('counts');
  const dbinfoEl = $('dbinfo');

  let state = null;
  const send = (msg) => vscode.postMessage(msg);
  const getState = () => state;
  const { mountTerm, terminalBlock, onLogs } = window.MFQueueUI.terminal({ send });
  const { renderTasks, liveLabel, tokenLabel, compact } = window.MFQueueUI.tasks({
    send, getState, tasksEl, mountTerm, terminalBlock,
  });
  const { drawContext } = window.MFQueueUI.context({ send, getState, $ });
  let testingDirty = false;
  let testingInitialized = false;
  let testingNames = "";
  const removedCredentials = new Set();

  function credentialRow(name = '', saved = false) {
    const row = document.createElement('div');
    row.className = 'testing-credential';
    const key = document.createElement('input');
    key.value = name; key.placeholder = 'Name'; key.setAttribute('aria-label', 'Credential name');
    if (saved) key.readOnly = true;
    const value = document.createElement('input');
    value.type = 'password'; value.autocomplete = 'new-password';
    value.placeholder = saved ? 'Saved — leave blank to keep' : 'Value';
    value.setAttribute('aria-label', name ? `${name} value` : 'Credential value');
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      if (saved) removedCredentials.add(name);
      row.remove(); testingDirty = true;
    });
    row.addEventListener('input', () => { testingDirty = true; });
    row.append(key, value, remove);
    $('testingCredentials').appendChild(row);
  }

  $('testingUrl').addEventListener('input', () => { testingDirty = true; });
  $('addTestingCredential').addEventListener('click', () => { credentialRow(); testingDirty = true; });
  $('saveTestingEnvironment').addEventListener('click', () => {
    const credentials = Array.from($('testingCredentials').children).map(row => {
      const inputs = row.querySelectorAll('input');
      return { name: inputs[0].value, value: inputs[1].value };
    });
    send({ type: 'setTestingEnvironment', url: $('testingUrl').value, credentials, remove: [...removedCredentials] });
  });

  // ---- tabs ----

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('active', t === tab);
      }
      const want = tab.getAttribute('data-pane');
      $('pane-run').hidden = want !== 'run';
      $('pane-plan').hidden = want !== 'plan';
      $('pane-context').hidden = want !== 'context';
    });
  }

  // ---- controls ----


  $('generate').addEventListener('click', () =>
    send({
      type: 'generate',
      goal: /** @type {HTMLTextAreaElement} */ ($('goal')).value,
      append: /** @type {HTMLInputElement} */ ($('append')).checked,
    }),
  );

  $('applyEdit').addEventListener('click', () =>
    send({
      type: 'editTasks',
      instruction: /** @type {HTMLTextAreaElement} */ ($('editInstruction')).value,
    }),
  );

  $('cron').addEventListener('change', () =>
    send({ type: 'setInterval', seconds: Number(/** @type {HTMLSelectElement} */ ($('cron')).value) }),
  );

  // Commit on blur, like the per-task fields below: a re-render mid-edit —
  // which an executor appending its own note can trigger at any time — would
  // otherwise fight the caret.
  $('instructions').addEventListener('blur', () => {
    const el = /** @type {HTMLTextAreaElement} */ ($('instructions'));
    if (el.value !== (state?.instructions || '')) send({ type: 'setInstructions', text: el.value });
  });

  for (const [id, type] of [
    ['retry', 'retry'],
    ['openFolder', 'openFolder'],
    ['showLog2', 'showLog'],
    ['start', 'start'],
    ['pause', 'pause'],
    ['stop', 'stop'],
    ['reset', 'reset'],
    ['runNow', 'runNow'],
    ['addTask', 'addTask'],
    ['clearQueue', 'clearQueue'],
    ['openSettings', 'openSettings'],
    ['showLog', 'showLog'],
  ]) {
    $(id).addEventListener('click', () => send({ type }));
  }

  $('genDocs').addEventListener('click', () => send({ type: 'generateDocs' }));

  // The Context tab's one filter runs over all three of its trees, in the
  // webview: the lists are already here, and a round trip per keystroke
  // would make typing feel like waiting.
  $('ctxFilter').addEventListener('input', () => drawContext());
  $('ctxDefaults').addEventListener('click', () => send({ type: 'resetEditorTools' }));

  // ---- state ----

  /**
   * The queue could not be opened. Show why — an unresolved view is just a
   * spinner, which says nothing about a missing driver or an unwritable folder.
   */
  function showUnavailable(m) {
    $('pane-unavailable').hidden = false;
    $('pane-run').hidden = true;
    $('pane-plan').hidden = true;
    $('pane-context').hidden = true;
    document.querySelector('.tabs').hidden = true;
    $('reason').textContent = m.reason || 'The task queue is not open in this window.';
    $('host').textContent = m.host || '';
    $('openFolder').hidden = !m.needsFolder;
  }

  function showQueue() {
    if ($('pane-unavailable').hidden) return;
    $('pane-unavailable').hidden = true;
    document.querySelector('.tabs').hidden = false;
    const active = document.querySelector('.tab.active');
    const want = active ? active.getAttribute('data-pane') : 'run';
    $('pane-run').hidden = want !== 'run';
    $('pane-plan').hidden = want !== 'plan';
    $('pane-context').hidden = want !== 'context';
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'testingEnvironmentSaved') {
      testingDirty = false; testingInitialized = false; removedCredentials.clear();
      $('testingSaved').textContent = 'Testing environment saved.';
    }
    if (e.data?.type === 'unavailable') {
      state = null;
      showUnavailable(e.data);
    }
    if (e.data?.type === 'state') {
      showQueue();
      state = e.data;
      render();
    }
    // Role models are resolved against the keychain, so they arrive just after
    // the rest of the state rather than inside it.
    if (e.data?.type === 'models' && state) {
      state.models = e.data.models;
      render();
    }
    if (e.data?.type === 'logs') {
      onLogs(e.data);
    }
    if (e.data?.type === 'pulse' && state) {
      onPulse(e.data);
    }
  });

  /**
   * The sub-second heartbeat: what each live task is doing and what it has
   * cost, patched into the rows in place. A full re-render is reserved for
   * state that changed shape — that one rebuilds the list and would fight
   * anyone editing a task.
   */
  function onPulse(m) {
    for (const p of m.tasks || []) {
      const row = tasksEl.querySelector(`.task[data-id="${p.id}"]`);
      if (!row) continue;
      const t = { ...(state.tasks.find((x) => x.id === p.id) || {}), ...p };
      row.querySelector('.live').textContent = liveLabel(t);
      row.querySelector('.tokens').textContent = tokenLabel(t);
    }
    if (m.status) {
      state.status = m.status;
      renderRunbar(m.status);
    }
  }

  function render() {
    if (!state) return;
    if (!testingDirty && (!testingInitialized || testingNames !== JSON.stringify(state.testingCredentialNames || []) || $('testingUrl').value !== (state.testingUrl || ''))) {
      $('testingUrl').value = state.testingUrl || '';
      $('testingCredentials').replaceChildren();
      const names = state.testingCredentialNames || [];
      for (const name of names) credentialRow(name, true);
      if (!names.length) { credentialRow('username'); credentialRow('password'); }
      testingInitialized = true;
      testingNames = JSON.stringify(names);
    }

    /** @type {HTMLButtonElement} */ ($('generate')).disabled = state.generating;
    /** @type {HTMLButtonElement} */ ($('generate')).textContent = state.generating
      ? 'Generating…'
      : 'Generate plan';
    /** @type {HTMLButtonElement} */ ($('applyEdit')).disabled = state.generating;
    /** @type {HTMLButtonElement} */ ($('applyEdit')).textContent = state.generating
      ? 'Working…'
      : 'Apply edit';

    const st = state.status;
    /** @type {HTMLButtonElement} */ ($('start')).disabled = st.running;
    /** @type {HTMLButtonElement} */ ($('pause')).disabled = !st.running;
    /** @type {HTMLButtonElement} */ ($('stop')).disabled = !st.running;
    /** @type {HTMLButtonElement} */ ($('runNow')).disabled = !st.running || st.supervising;

    renderCron(st);
    renderRunbar(st);
    renderCounts(state.stats);
    renderTasks(state.tasks, st);
    drawContext();

    // Not just on first render: an executor can append to this at any time
    // while the run is going, so it has to stay live — but never while the
    // user is mid-edit in the same box.
    $('agentObservations').textContent = state.agentObservations || 'No generated findings yet.';
    const notesEl = /** @type {HTMLTextAreaElement} */ ($('instructions'));
    if (document.activeElement !== notesEl) {
      notesEl.value = state.instructions || '';
    }

    dbinfoEl.textContent = `${state.dbPath} · ${state.driver} · exec ${state.models.executor || 'default'} · supervisor ${state.models.supervisor || 'default'}`;
  }

  /**
   * The interval belongs to this task list, so the select shows what the queue
   * itself says — falling back to the settings.json value, named on the first
   * option so "Use setting" is never a mystery.
   */
  function renderCron(st) {
    const sel = /** @type {HTMLSelectElement} */ ($('cron'));
    sel.options[0].textContent = `Use setting (${humanInterval(st.settingIntervalSeconds)})`;

    const want = String(st.intervalOwn ? Math.round(st.intervalMs / 1000) : 0);
    if (!Array.prototype.some.call(sel.options, (o) => o.value === want)) {
      // An interval typed straight into the database or an older preset: keep
      // it selectable rather than silently snapping to a neighbour.
      const opt = document.createElement('option');
      opt.value = want;
      opt.textContent = `every ${humanInterval(Number(want))}`;
      sel.appendChild(opt);
    }
    sel.value = want;
  }

  function humanInterval(secs) {
    if (!secs) return '—';
    if (secs < 60) return `${secs}s`;
    if (secs % 60 === 0) return `${secs / 60} min`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  function renderRunbar(st) {
    const bits = [];
    if (st.executing) {
      bits.push('<span class="live">● executing</span>');
    }
    if (st.supervising) {
      bits.push('<span class="live">● supervising</span>');
    }
    if (!st.running) {
      bits.push(state.stats.runState.toLowerCase());
    } else if (bits.length === 0) {
      bits.push('idle');
    }
    if (st.running && st.nextTickAt) {
      const secs = Math.max(0, Math.round((st.nextTickAt - Date.now()) / 1000));
      bits.push(`next check in ~${secs}s`);
    }
    bits.push(`${st.mode} · every ${humanInterval(Math.round(st.intervalMs / 1000))}`);
    runbarEl.innerHTML = bits.join(' &nbsp;·&nbsp; ');
  }

  function renderCounts(stats) {
    const order = ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'PAUSED'];
    countsEl.innerHTML = order
      .filter((s) => stats.byStatus[s] > 0)
      .map((s) => `<span class="${s}">${s} ${stats.byStatus[s]}</span>`)
      .join('');

    // What the whole run has cost, next to what it has produced. Cached input
    // is called out separately because it is the cheap half of the bill and
    // folding it into the input total would misrepresent the spend.
    const u = stats.usage || {};
    const total = (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
    if (total > 0) {
      const bits = [`${compact(u.input || 0)} in`, `${compact(u.output || 0)} out`];
      if (u.cacheRead) bits.push(`${compact(u.cacheRead)} cached`);
      const span = document.createElement('span');
      span.className = 'tokentotal';
      span.title =
        `${(u.input || 0).toLocaleString()} input · ` +
        `${(u.output || 0).toLocaleString()} output · ` +
        `${(u.cacheRead || 0).toLocaleString()} cache read · ` +
        `${(u.cacheWrite || 0).toLocaleString()} cache write`;
      span.textContent = bits.join(' · ');
      countsEl.appendChild(span);
    }
  }

  // Keeps the "next check in ~Ns" countdown honest between state pushes.
  setInterval(() => {
    if (state?.status?.running) renderRunbar(state.status);
  }, 1000);

  // The planner's terminal has no row to open; it is always mounted.
  mountTerm('planner', $('plannerTerm'));

  send({ type: 'ready' });
})();
