// @ts-check
/* Cohesive queue view helpers; loaded before queue.js under the webview nonce. */
window.MFQueueUI = window.MFQueueUI || {};
window.MFQueueUI.tasks = function ({ send, getState, tasksEl, mountTerm, terminalBlock }) {
  const open = new Set();
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
        field('Solution verification', t.solutionVerifyPrompt, (v) =>
          patch(t.id, { solutionVerifyPrompt: v }),
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
    for (const s of ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'PAUSED']) {
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
    const ids = getState().tasks.map((t) => t.id);
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

  return { renderTasks, liveLabel, tokenLabel, compact };
};
