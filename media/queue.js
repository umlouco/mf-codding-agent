// @ts-check
/* Task queue UI. Vanilla DOM, same as the chat view: no framework, no bundle. */
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const tasksEl = $('tasks');
  const runbarEl = $('runbar');
  const countsEl = $('counts');
  const dbinfoEl = $('dbinfo');

  /** Ids of tasks the user has expanded, kept across re-renders. */
  const open = new Set();
  let state = null;

  // ---- tabs ----

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('active', t === tab);
      }
      const want = tab.getAttribute('data-pane');
      $('pane-run').hidden = want !== 'run';
      $('pane-plan').hidden = want !== 'plan';
    });
  }

  // ---- controls ----

  const send = (msg) => vscode.postMessage(msg);

  $('generate').addEventListener('click', () =>
    send({
      type: 'generate',
      goal: /** @type {HTMLTextAreaElement} */ ($('goal')).value,
      append: /** @type {HTMLInputElement} */ ($('append')).checked,
    }),
  );

  $('cron').addEventListener('change', () =>
    send({ type: 'setInterval', seconds: Number(/** @type {HTMLSelectElement} */ ($('cron')).value) }),
  );

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

  // ---- state ----

  /**
   * The queue could not be opened. Show why — an unresolved view is just a
   * spinner, which says nothing about a missing driver or an unwritable folder.
   */
  function showUnavailable(m) {
    $('pane-unavailable').hidden = false;
    $('pane-run').hidden = true;
    $('pane-plan').hidden = true;
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
  }

  window.addEventListener('message', (e) => {
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
  });

  function render() {
    if (!state) return;

    /** @type {HTMLButtonElement} */ ($('generate')).disabled = state.generating;
    /** @type {HTMLButtonElement} */ ($('generate')).textContent = state.generating
      ? 'Generating…'
      : 'Generate plan';

    const st = state.status;
    /** @type {HTMLButtonElement} */ ($('start')).disabled = st.running;
    /** @type {HTMLButtonElement} */ ($('pause')).disabled = !st.running;
    /** @type {HTMLButtonElement} */ ($('stop')).disabled = !st.running;
    /** @type {HTMLButtonElement} */ ($('runNow')).disabled = !st.running || st.supervising;

    renderCron(st);
    renderRunbar(st);
    renderCounts(state.stats);
    renderTasks(state.tasks, st);

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
    const order = ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'FAILED', 'PAUSED'];
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

  function renderTasks(tasks, st) {
    if (!tasks.length) {
      tasksEl.innerHTML =
        '<div class="empty">No tasks yet.<br>Use the <strong>Plan</strong> tab to generate a queue.</div>';
      return;
    }
    tasksEl.textContent = '';
    for (const t of tasks) {
      tasksEl.appendChild(taskEl(t, st));
    }
  }

  const PHASE_LABELS = {
    claimed: 'starting',
    model_wait: 'waiting on the model',
    model_stream: 'reading the reply',
    tool: 'running a tool',
    report: 'writing its report',
    stalled: 'connection dropped',
    stopped: 'stopped',
    error: 'error',
    done: 'finishing',
  };

  /** "waiting on the model · 12m ago" — the evidence the worker is still alive. */
  function liveLabel(t) {
    const label = PHASE_LABELS[t.activityPhase] || t.activityPhase || '';
    if (!label) {
      return '';
    }
    const ago = Date.now() - (t.lastActivityAt || 0);
    if (!t.lastActivityAt || ago < 60_000) {
      return label;
    }
    return `${label} · ${Math.round(ago / 60_000)}m ago`;
  }

  /**
   * Deleting a task cannot be undone, so anything that already cost something —
   * a run, a review, tokens — is confirmed on the extension side first. A task
   * nobody has touched goes straight away: asking there is just a second click.
   */
  function removeTask(t) {
    const worked = t.attempts > 0 || t.status === 'VERIFIED' || t.tokensIn > 0;
    send({ type: 'deleteTask', id: t.id, confirm: worked });
  }

  /** "12.4k ↓ · 3.1k ↑" — what this task has cost so far, or nothing yet. */
  function tokenLabel(t) {
    const total = (t.tokensIn || 0) + (t.tokensCacheRead || 0);
    if (!total && !t.tokensOut) {
      return '';
    }
    return `${compact(total)} ↓ · ${compact(t.tokensOut || 0)} ↑`;
  }

  /** The paths and file count a phase was scoped to — see TaskKind in db.ts. */
  function regionSummary(raw) {
    try {
      const r = JSON.parse(raw || '{}');
      const paths = Array.isArray(r.paths) ? r.paths : [];
      if (!paths.length) return '(no region recorded)';
      return `${paths.join('\n')}\n\n${r.fileCount || 0} file(s) total`;
    } catch {
      return '(no region recorded)';
    }
  }

  /** 1234 → "1.2k". Exact counts past a thousand are noise on a summary row. */
  function compact(n) {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  /** "phase — awaiting expansion" / "phase — expanding…" next to the status pill. */
  function phaseLabel(t) {
    if (t.status === 'EXECUTING') return 'phase — expanding…';
    if (t.status === 'PENDING') return 'phase — awaiting expansion';
    return 'phase';
  }

  function taskEl(t, st) {
    const isPhase = t.kind === 'phase';
    const d = document.createElement('details');
    d.className =
      `task ${t.status}` + (isPhase ? ' phase' : '') + (st.currentTaskId === t.id ? ' current' : '');
    d.open = open.has(t.id);
    d.addEventListener('toggle', () => (d.open ? open.add(t.id) : open.delete(t.id)));

    const s = document.createElement('summary');
    s.innerHTML =
      `<span class="seq">${t.seq}</span>` +
      `<span class="title"></span>` +
      `<span class="live"></span>` +
      `<span class="tokens"></span>` +
      (isPhase
        ? `<span class="pill phasepill">${phaseLabel(t)}</span>`
        : `<span class="pill ${t.status}">${t.status}</span>`);
    s.querySelector('.title').textContent = t.title;
    // What the worker is doing right now, and how long ago it said so. A task
    // that is simply slow keeps refreshing this; one that has stopped does not.
    s.querySelector('.live').textContent = t.status === 'EXECUTING' ? liveLabel(t) : '';
    s.querySelector('.tokens').textContent = tokenLabel(t);

    // Removing a task is one click from the list, because that is where you
    // decide you do not want it. It sits inside the summary, so it has to stop
    // the click from also toggling the row open.
    const del = document.createElement('button');
    del.className = 'rowdel';
    del.type = 'button';
    del.title = `Remove task ${t.seq}`;
    del.setAttribute('aria-label', `Remove task ${t.seq}: ${t.title}`);
    del.textContent = '✕';
    del.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeTask(t);
    });
    s.appendChild(del);
    d.appendChild(s);

    const body = document.createElement('div');
    body.className = 'body';

    body.appendChild(field('Description', t.description, (v) => patch(t.id, { description: v })));

    if (isPhase) {
      // A phase has no verify prompts of its own — those belong to the tasks
      // it expands into — but it does have the workspace slice it was scoped
      // to, which is the thing worth showing here instead.
      body.appendChild(readonlyBlock('Region', regionSummary(t.region), false));
    } else {
      body.appendChild(
        field('Implementation verification', t.implVerifyPrompt, (v) =>
          patch(t.id, { implVerifyPrompt: v }),
        ),
      );
      body.appendChild(
        field('Solution verification', t.solutionVerifyPrompt, (v) =>
          patch(t.id, { solutionVerifyPrompt: v }),
        ),
      );
      body.appendChild(
        field(
          'Verification command',
          t.solutionVerifyCommand,
          (v) => patch(t.id, { solutionVerifyCommand: v }),
          true,
        ),
      );
    }

    if (t.supervisorFeedback) {
      body.appendChild(readonlyBlock('Supervisor feedback', t.supervisorFeedback, false));
    }
    if (t.errorLog) {
      body.appendChild(readonlyBlock('Error log', t.errorLog, true));
    }
    if (t.output) {
      body.appendChild(readonlyBlock('Last agent report', t.output, false));
    }

    const meta = document.createElement('p');
    meta.className = 'hint';
    meta.textContent = `attempt ${t.attempts} of ${t.maxAttempts}`;
    body.appendChild(meta);

    body.appendChild(taskActions(t));
    d.appendChild(body);
    return d;
  }

  function taskActions(t) {
    const row = document.createElement('div');
    row.className = 'row';

    const sel = document.createElement('select');
    for (const s of ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'FAILED', 'PAUSED']) {
      const o = document.createElement('option');
      o.value = o.textContent = s;
      o.selected = s === t.status;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () =>
      send({ type: 'setStatus', id: t.id, status: sel.value }),
    );
    row.appendChild(sel);

    row.appendChild(spacer());
    row.appendChild(btn('Up', 'ghost', () => move(t.id, -1)));
    row.appendChild(btn('Down', 'ghost', () => move(t.id, 1)));
    row.appendChild(btn('Delete', 'ghost', () => send({ type: 'deleteTask', id: t.id })));
    return row;
  }

  function move(id, delta) {
    const ids = state.tasks.map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    send({ type: 'reorder', ids });
  }

  // ---- small builders ----

  function field(label, value, onCommit, single) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = label;
    wrap.appendChild(l);

    const input = single ? document.createElement('input') : document.createElement('textarea');
    if (single) {
      /** @type {HTMLInputElement} */ (input).type = 'text';
    } else {
      /** @type {HTMLTextAreaElement} */ (input).rows = 3;
    }
    input.value = value || '';
    // Commit on blur rather than per keystroke: a re-render mid-edit would
    // otherwise fight the caret.
    input.addEventListener('blur', () => {
      if (input.value !== (value || '')) onCommit(input.value);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function readonlyBlock(label, text, isError) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = label;
    wrap.appendChild(l);

    const pre = document.createElement('pre');
    pre.className = 'out' + (isError ? ' err' : '');
    pre.textContent = text;
    wrap.appendChild(pre);
    return wrap;
  }

  function btn(text, cls, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function spacer() {
    const s = document.createElement('span');
    s.className = 'spacer';
    return s;
  }

  function patch(id, p) {
    send({ type: 'updateTask', id, patch: p });
  }

  // Keeps the "next check in ~Ns" countdown honest between state pushes.
  setInterval(() => {
    if (state?.status?.running) renderRunbar(state.status);
  }, 1000);

  send({ type: 'ready' });
})();
