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

  // ---- live output ----
  //
  // One terminal per task, plus one for the planner (keyed 'planner'), fed by
  // the extension's 200 ms poll of the agent_logs table. The buffer lives
  // here rather than in the DOM because the task list is rebuilt on every
  // state push, and a terminal that emptied itself each time a token count
  // changed would be no terminal at all.
  const MAX_BLOCKS = 400;
  const MAX_CHARS = 120_000;
  /** key → { blocks: [{actor, kind, text, el}], chars, el, requested } */
  const terms = new Map();

  function termKey(taskId) {
    return taskId === null || taskId === undefined ? 'planner' : String(taskId);
  }

  function termFor(key) {
    let t = terms.get(key);
    if (!t) {
      t = { blocks: [], chars: 0, el: null, requested: false };
      terms.set(key, t);
    }
    return t;
  }

  /** Streamed text folds into the previous block; everything else starts one. */
  function pushRow(t, row) {
    const last = t.blocks[t.blocks.length - 1];
    const folds = row.kind === 'response' || row.kind === 'reasoning';
    if (folds && last && last.actor === row.actor && last.kind === row.kind) {
      last.text += row.chunk;
      if (last.el) appendText(last, row.chunk);
    } else {
      const block = { actor: row.actor, kind: row.kind, text: row.chunk, el: null };
      t.blocks.push(block);
      if (t.el) mountBlock(t, block);
    }
    t.chars += row.chunk.length;
    while (t.blocks.length > MAX_BLOCKS || (t.chars > MAX_CHARS && t.blocks.length > 1)) {
      const gone = t.blocks.shift();
      t.chars -= gone.text.length;
      if (gone.el) gone.el.remove();
    }
  }

  function blockEl(block) {
    const div = document.createElement('div');
    div.className = `tb tb-${String(block.kind).replace(/[^a-z0-9-]/gi, '-')}`;
    const h = document.createElement('span');
    h.className = 'tb-h';
    h.textContent = `${block.actor} · ${block.kind}`;
    const body = document.createElement('span');
    body.className = 'tb-t';
    body.textContent = block.text;
    div.appendChild(h);
    div.appendChild(body);
    block.el = div;
    return div;
  }

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  function mountBlock(t, block) {
    const stick = nearBottom(t.el);
    t.el.appendChild(blockEl(block));
    if (stick) t.el.scrollTop = t.el.scrollHeight;
  }

  function appendText(block, chunk) {
    const pre = block.el.parentElement;
    const stick = pre ? nearBottom(pre) : true;
    block.el.querySelector('.tb-t').textContent += chunk;
    if (stick && pre) pre.scrollTop = pre.scrollHeight;
  }

  /** Attaches a <pre> to a stream, drawing what is buffered so far. */
  function mountTerm(key, pre) {
    const t = termFor(key);
    t.el = pre;
    pre.textContent = '';
    for (const b of t.blocks) pre.appendChild(blockEl(b));
    pre.scrollTop = pre.scrollHeight;
    if (!t.requested) {
      t.requested = true;
      send({ type: 'logTail', id: key === 'planner' ? null : Number(key) });
    }
  }

  function onLogs(m) {
    if (m.reset) {
      const t = termFor(termKey(m.taskId));
      t.blocks = [];
      t.chars = 0;
      if (t.el) t.el.textContent = '';
    }
    for (const row of m.rows || []) pushRow(termFor(termKey(row.taskId)), row);
  }

  /** The collapsible terminal inside a task row. Mounted only while the row is open. */
  function terminalBlock() {
    const wrap = document.createElement('details');
    wrap.className = 'termwrap';
    wrap.open = true;
    const s = document.createElement('summary');
    s.className = 'lbl';
    s.textContent = 'Live output';
    const pre = document.createElement('pre');
    pre.className = 'term';
    wrap.appendChild(s);
    wrap.appendChild(pre);
    return { wrap, pre };
  }

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

  const send = (msg) => vscode.postMessage(msg);

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

  // ---- context tab: the picker ----
  //
  // Three trees over one filter box: the editor's language-model tools grouped
  // by where they come from, the MCP servers the core dials itself, and the
  // skill groups. They share a renderer because they are the same gesture —
  // check a group, get all of it — and because the whole point of the rewrite
  // was that a flat list of a hundred and twenty checkboxes is not a choice
  // anyone can actually make.

  /** Group ids the user has unfolded. The built-in tools start open. */
  const expanded = new Set(['grp:builtin']);

  /** 16px line icons, drawn rather than fetched: the webview has no icon font. */
  const ICONS = {
    chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    agent:
      '<rect x="3" y="5.5" width="10" height="7" rx="2"/><path d="M8 2.4v3.1"/>' +
      '<circle cx="6.1" cy="9" r=".85" fill="currentColor" stroke="none"/>' +
      '<circle cx="9.9" cy="9" r=".85" fill="currentColor" stroke="none"/>',
    browser:
      '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>' +
      '<circle cx="4.1" cy="4.5" r=".55" fill="currentColor" stroke="none"/>',
    edit: '<path d="M11.2 2.4l2.4 2.4-8 8-3.1.7.7-3.1z"/><path d="M9.9 3.7l2.4 2.4"/>',
    execute: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.9 6.4L7.1 8.5 4.9 10.6M8.6 10.9h2.9"/>',
    read:
      '<path d="M8 4.6S6.8 3 4.6 3H2.4v9h2.5c2 0 3.1 1.1 3.1 1.1s1.1-1.1 3.1-1.1h2.5V3h-2.2C9.2 3 8 4.6 8 4.6z"/>' +
      '<path d="M8 4.6v8.5"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.1 10.1L13.9 13.9"/>',
    todo: '<path d="M2.4 4.3l1.2 1.2 2.1-2.1M2.4 9.3l1.2 1.2 2.1-2.1"/><path d="M8.2 4.4h5.4M8.2 9.4h5.4"/>',
    vscode: '<path d="M5.6 4.4L2.1 8l3.5 3.6M10.4 4.4L13.9 8l-3.5 3.6"/>',
    web:
      '<circle cx="8" cy="8" r="5.6"/><path d="M2.5 8h11"/>' +
      '<path d="M8 2.4c1.6 1.7 2.4 3.5 2.4 5.6S9.6 11.9 8 13.6C6.4 11.9 5.6 10.1 5.6 8s.8-3.9 2.4-5.6z"/>',
    tools: '<path d="M8 2.2l5.2 2.7v6.2L8 13.8l-5.2-2.7V4.9z"/><path d="M2.8 4.9L8 7.6l5.2-2.7M8 7.6v6.2"/>',
    tool: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.7v1.9M8 12.4v1.9M14.3 8h-1.9M3.6 8H1.7"/>',
    server:
      '<rect x="2.4" y="2.8" width="11.2" height="4.2" rx="1.2"/>' +
      '<rect x="2.4" y="9" width="11.2" height="4.2" rx="1.2"/>' +
      '<circle cx="4.8" cy="4.9" r=".6" fill="currentColor" stroke="none"/>' +
      '<circle cx="4.8" cy="11.1" r=".6" fill="currentColor" stroke="none"/>',
    ext: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2"/><path d="M6.2 2.6v2.6M9.8 2.6v2.6M2.6 9.9h2.6"/>',
    skill: '<path d="M8 2.5L14.4 6 8 9.5 1.6 6z"/><path d="M4.6 7.7v3.1c0 1 1.5 1.8 3.4 1.8s3.4-.8 3.4-1.8V7.7"/>',
    doc: '<path d="M4 2.3h5l3 3v8.4H4z"/><path d="M9 2.3v3h3"/>',
  };

  /** An <svg> for one of the glyphs above. */
  function icon(name, cls) {
    const svg = document.createElement('span');
    svg.className = cls || 'tr-icon';
    svg.innerHTML = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;
    return svg;
  }

  /**
   * One row of a tree.
   *
   * `checked` is a boolean for a row that carries its own switch, and null for
   * a group that borrows the state of everything under it — which is what
   * makes the parent box tri-state. `detail` rows have no switch at all: the
   * skills inside a group are shown so a group can be read before it is
   * turned on, not so they can be picked one by one.
   */
  function node(opts) {
    return {
      id: opts.id,
      label: opts.label,
      hint: opts.hint || '',
      icon: opts.icon || 'tool',
      checked: opts.checked === undefined ? null : opts.checked,
      children: opts.children || [],
      detail: !!opts.detail,
      failed: !!opts.failed,
      action: opts.action,
      onToggle: opts.onToggle,
    };
  }

  /** 'on' | 'off' | 'mixed' — a group's own switch, or the sum of its children's. */
  function nodeState(n) {
    if (n.detail) return null;
    if (n.checked !== null) return n.checked ? 'on' : 'off';
    const kids = n.children.filter((c) => !c.detail);
    if (!kids.length) return 'off';
    let on = 0;
    let off = 0;
    for (const k of kids) {
      const s = nodeState(k);
      if (s === 'on') on++;
      else if (s === 'off') off++;
      else return 'mixed';
    }
    return off === 0 ? 'on' : on === 0 ? 'off' : 'mixed';
  }

  /** How many switchable leaves under `n` are on — the header count. */
  function countOn(n) {
    if (n.detail) return 0;
    const kids = n.children.filter((c) => !c.detail);
    if (!kids.length) return nodeState(n) === 'on' ? 1 : 0;
    return kids.reduce((sum, k) => sum + countOn(k), 0);
  }

  /** A row is kept when it matches the filter itself or has a match under it. */
  function matches(n, q) {
    if (!q) return true;
    if (`${n.label} ${n.hint}`.toLowerCase().includes(q)) return true;
    return n.children.some((c) => matches(c, q));
  }

  function rowEl(n, depth, q) {
    const kids = n.children.filter((c) => matches(c, q));
    // A search opens everything it kept: a hit three levels down is no use
    // behind two folded parents.
    const open = kids.length > 0 && (q ? true : expanded.has(n.id));

    const row = document.createElement('div');
    row.className = `tree-row depth-${Math.min(depth, 3)}`;
    if (open) row.classList.add('open');
    if (n.failed) row.classList.add('tr-failed');

    const twisty = document.createElement('button');
    twisty.type = 'button';
    twisty.className = kids.length ? 'twisty' : 'twisty leaf';
    twisty.innerHTML = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true">${ICONS.chevron}</svg>`;
    twisty.tabIndex = kids.length ? 0 : -1;
    twisty.setAttribute('aria-expanded', String(open));
    twisty.setAttribute('aria-label', open ? `Collapse ${n.label}` : `Expand ${n.label}`);
    twisty.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!kids.length) return;
      if (expanded.has(n.id)) expanded.delete(n.id);
      else expanded.add(n.id);
      drawContext();
    });
    row.appendChild(twisty);

    let box = null;
    const st = nodeState(n);
    if (st !== null) {
      box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = st === 'on';
      box.indeterminate = st === 'mixed';
      box.setAttribute('aria-label', n.label);
      box.addEventListener('click', (ev) => ev.stopPropagation());
      box.addEventListener('change', () => n.onToggle && n.onToggle(box.checked));
      row.appendChild(box);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'tr-nobox';
      row.appendChild(spacer);
    }

    row.appendChild(icon(n.icon));

    const label = document.createElement('span');
    label.className = 'tr-name';
    label.textContent = n.label;
    row.appendChild(label);

    if (n.hint) {
      const hint = document.createElement('span');
      hint.className = 'tr-hint';
      hint.textContent = n.hint;
      hint.title = n.hint;
      row.appendChild(hint);
    }

    if (n.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost tr-action';
      btn.textContent = n.action.label;
      btn.title = n.action.title || n.action.label;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        n.action.onClick();
      });
      row.appendChild(btn);
    }

    // Anywhere else on the row: switch it if it has a switch, unfold it if it
    // does not — the two things a row is for.
    row.addEventListener('click', () => {
      if (box) {
        box.checked = !box.checked;
        box.indeterminate = false;
        if (n.onToggle) n.onToggle(box.checked);
      } else if (kids.length) {
        twisty.click();
      }
    });

    const out = [row];
    if (open) {
      for (const kid of kids) out.push(...rowEl(kid, depth + 1, q));
    }
    return out;
  }

  function renderTree(host, nodes, empty, q) {
    host.textContent = '';
    const kept = nodes.filter((n) => matches(n, q));
    if (!kept.length) {
      host.appendChild(emptyRow(q ? 'Nothing here matches the filter.' : empty));
      return;
    }
    for (const n of kept) {
      for (const row of rowEl(n, 0, q)) host.appendChild(row);
    }
  }

  function emptyRow(text) {
    const n = document.createElement('div');
    n.className = 'empty';
    n.textContent = text;
    return n;
  }

  // ---- the three trees -------------------------------------------------

  /** Every tool name under a tool group, so a parent can switch all of it at once. */
  function groupToolNames(g) {
    return [...g.tools.map((t) => t.name), ...g.groups.flatMap(groupToolNames)];
  }

  const GROUP_ICONS = { builtin: 'tools', mcp: 'server', extension: 'ext' };

  function toolGroupNode(g) {
    const names = groupToolNames(g);
    return node({
      id: `grp:${g.id}`,
      label: g.label,
      hint: g.hint,
      icon: g.kind === 'set' ? g.label : GROUP_ICONS[g.kind] || 'tools',
      children: [
        ...g.groups.map(toolGroupNode),
        ...g.tools.map((t) =>
          node({
            id: `tool:${t.name}`,
            label: t.name,
            hint: t.description.length > 120 ? `${t.description.slice(0, 120)}…` : t.description,
            icon: 'tool',
            checked: t.enabled,
            onToggle: (on) => send({ type: 'setEditorToolEnabled', names: [t.name], enabled: on }),
          }),
        ),
      ],
      onToggle: (on) => send({ type: 'setEditorToolEnabled', names, enabled: on }),
    });
  }

  function mcpNode(s) {
    // What went wrong comes first: a row's dim half is one line ending in an
    // ellipsis, and the half worth reading is the failure, not where the
    // server was configured. The verdict is the last core start's, so a server
    // that rejects its key is visibly failing right where it is switched on.
    const bits = [];
    if (s.connection?.status === 'failed') {
      const err = String(s.connection.error || '').replace(/\s+/g, ' ');
      bits.push(`failed: ${err.length > 160 ? `${err.slice(0, 160)}…` : err}`);
    }
    if (s.problem) bits.push(`not connected: ${s.problem}`);
    if (!s.configured) bits.push('missing command/url');
    if (s.serverEnabled === false) bits.push('switched off in Settings');
    if (s.connection?.status === 'connected') bits.push('connected');
    bits.push(
      s.source === 'user'
        ? 'user mcp.json'
        : s.source === 'store'
          ? 'Settings › MCP Servers'
          : 'mfagent.mcpServers',
    );

    return node({
      id: `mcp:${s.name}`,
      label: s.name,
      hint: bits.join(' · '),
      icon: 'server',
      checked: s.enabled,
      failed: s.connection?.status === 'failed',
      onToggle: (on) => send({ type: 'setMcpEnabled', names: [s.name], enabled: on }),
      action: s.canSetKey
        ? {
            label: 'Set key…',
            title: `Give ${s.name} an API key of its own, kept in the OS keychain`,
            onClick: () => send({ type: 'setMcpKey', name: s.name }),
          }
        : undefined,
    });
  }

  function skillNode(g) {
    const skills = g.skills || [];
    return node({
      id: `skill:${g.id}`,
      label: g.name,
      hint:
        g.source === 'installed'
          ? `installed via npx skills · ${skills.length} skill(s)`
          : `${skills.length} skill(s)`,
      icon: 'skill',
      checked: g.enabled,
      children: skills.map((s, i) =>
        node({
          id: `skill:${g.id}:${i}`,
          label: s.name,
          hint: s.description || '',
          icon: 'doc',
          detail: true,
        }),
      ),
      onToggle: (on) => send({ type: 'setSkillGroupEnabled', ids: [g.id], enabled: on }),
    });
  }

  /** Redraws all three trees from `state` — on a new state, a filter, a fold. */
  function drawContext() {
    if (!state) return;
    const q = ($('ctxFilter').value || '').trim().toLowerCase();

    const tools = (state.editorTools || []).map(toolGroupNode);
    const servers = (state.mcpServers || []).map(mcpNode);
    const skills = (state.skillGroups || []).map(skillNode);

    renderTree($('editorToolTree'), tools, 'No language-model tools are registered in this VS Code yet.', q);
    renderTree(
      $('mcpList'),
      servers,
      'No MCP servers found. Add one on the Settings page (MCP Servers tab), under mfagent.mcpServers, or in your VS Code user mcp.json.',
      q,
    );
    renderTree(
      $('skillGroupList'),
      skills,
      'No skill groups yet. Create skills in Settings, or use "MF Agent: Install Skill Pack".',
      q,
    );

    const on = [...tools, ...servers, ...skills].reduce((sum, n) => sum + countOn(n), 0);
    $('ctxCount').textContent = `${on} selected`;
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
    const phase = PHASE_LABELS[t.activityPhase] || t.activityPhase || '';
    const detail = String(t.activityDetail || '').replace(/\s+/g, ' ').trim();
    const label = detail || phase;
    if (!label) {
      return '';
    }
    const ago = Date.now() - (t.lastActivityAt || 0);
    if (!t.lastActivityAt || ago < 60_000) {
      return label;
    }
    return `${label} · ${humanAgo(ago)} ago`;
  }

  /** "12m", "3h", "2d" — a record from days ago should not read as thousands of minutes. */
  function humanAgo(ms) {
    if (ms < 120 * 60_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 86_400_000)}d`;
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
    // Show cache reads separately. OpenAI counts them inside prompt_tokens,
    // while Anthropic reports them beside input_tokens, so combining the two
    // into one unlabeled number is misleading for at least one provider.
    const input = t.tokensIn || 0;
    const cached = t.tokensCacheRead || 0;
    if (!input && !cached && !t.tokensOut) {
      return '';
    }
    const bits = [`${compact(input)} ↓`, `${compact(t.tokensOut || 0)} ↑`];
    if (cached) bits.push(`${compact(cached)} cached`);
    return bits.join(' · ');
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
    d.dataset.id = String(t.id);
    d.open = open.has(t.id);
    // The terminal is drawn only while the row is open: a closed row's stream
    // keeps buffering in `terms`, and appears the moment the row opens.
    const term = terminalBlock();
    d.addEventListener('toggle', () => {
      if (d.open) {
        open.add(t.id);
        mountTerm(String(t.id), term.pre);
      } else {
        open.delete(t.id);
      }
    });

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
    //
    // VERIFYING counts as live work: the validator and the supervisor both
    // record activity against the task the same way an executor does (see
    // orchestrator.ts's verifyWithExecutor and supervise). Reading this as an
    // executor-only field left a verifying task looking frozen for the whole
    // length of a review, which is the slowest part of a run.
    s.querySelector('.live').textContent =
      t.status === 'EXECUTING' || t.status === 'VERIFYING' ? liveLabel(t) : '';
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

    // Every agent that touches this task — executor, validator, supervisor,
    // and for a phase the planner — streams here as it works.
    body.appendChild(term.wrap);

    const meta = document.createElement('p');
    meta.className = 'hint';
    // The denominator is real again: at `maxAttempts` the supervisor must split
    // or rebuild the task, and the counter restarts on whatever replaces it. So
    // this cannot read "7 of 3" — if it ever does, the escalation in
    // superviseTask stopped firing rather than the label being wrong.
    meta.textContent = `attempt ${t.attempts} of ${t.maxAttempts}`;
    body.appendChild(meta);

    body.appendChild(taskActions(t));
    d.appendChild(body);
    if (d.open) {
      mountTerm(String(t.id), term.pre);
    }
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

  // The planner's terminal has no row to open; it is always mounted.
  mountTerm('planner', $('plannerTerm'));

  send({ type: 'ready' });
})();
