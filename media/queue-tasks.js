// @ts-check
/* Cohesive queue view helpers; loaded before queue.js under the webview nonce. */
window.MFQueueUI = window.MFQueueUI || {};
window.MFQueueUI.tasks = function ({ send, getState, tasksEl, mountTerm, terminalBlock }) {
  const open = new Set();
  // Owner edits are staged here until Save rather than written per keystroke.
  // A state push is frequent while agents run, and rebuilding a row mid-edit
  // used to discard text that had not been committed yet — the edit "did not
  // take effect". The draft is restored on every re-render; Save commits it.
  const editing = new Set();
  const drafts = new Map();
  const saved = new Map();

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

    // Edit and remove are one click from the list, because that is where you
    // decide. Both sit inside the summary, so they have to stop the click from
    // also toggling the row open. They stay visible on every row: a control you
    // can only find by hovering is a control you do not have.
    const edit = document.createElement('button');
    edit.className = 'rowedit';
    edit.type = 'button';
    edit.title = `Edit task ${t.seq}`;
    edit.setAttribute('aria-label', `Edit task ${t.seq}: ${t.title}`);
    edit.textContent = '✎';
    edit.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startEdit(t);
    });
    s.appendChild(edit);

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

    // Read-only by default, editable only after Edit. The two fields the agent
    // actually reads as instructions are the ones worth staging behind Save.
    if (editing.has(t.id)) {
      const draft = draftFor(t);
      body.appendChild(editField('Description', draft.description, (v) => { draft.description = v; }));
      if (!isPhase) {
        body.appendChild(editField('Solution verification', draft.solutionVerifyPrompt, (v) => {
          draft.solutionVerifyPrompt = v;
        }));
      }
    } else {
      body.appendChild(readonlyBlock('Description',
        String(t.description || '').trim() || '(empty)', false));
      if (!isPhase) {
        body.appendChild(readonlyBlock('Solution verification',
          String(t.solutionVerifyPrompt || '').trim() || '(empty)', false));
      }
    }

    if (isPhase) {
      // A phase has no verify prompts of its own — those belong to the tasks
      // it expands into — but it does have the workspace slice it was scoped
      // to, which is the thing worth showing here instead.
      body.appendChild(readonlyBlock('Region', regionSummary(t.region), false));
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
    const status = saved.get(t.id);
    if (status) {
      meta.className = 'hint saved';
    }
    // The denominator is real again: at `maxAttempts` the supervisor must split
    // or rebuild the task, and the counter restarts on whatever replaces it. So
    // this cannot read "7 of 3" — if it ever does, the escalation in
    // superviseTask stopped firing rather than the label being wrong.
    meta.textContent = `attempt ${t.attempts} of ${t.maxAttempts}` + (status ? ` · ${status}` : '');
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

    if (editing.has(t.id)) {
      row.appendChild(btn('Save', 'primary', () => saveTask(t)));
      row.appendChild(btn('Cancel', 'ghost', () => cancelEdit(t)));
    } else {
      row.appendChild(btn('Edit', 'ghost', () => startEdit(t)));
    }

    row.appendChild(spacer());
    row.appendChild(btn('Up', 'ghost', () => move(t.id, -1)));
    row.appendChild(btn('Down', 'ghost', () => move(t.id, 1)));
    row.appendChild(btn('Delete', 'ghost', () => removeTask(t)));
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

  // ---- edit mode -------------------------------------------------------

  /** The staged text for a task; seeded from the row the first time Edit is hit. */
  function draftFor(t) {
    let d = drafts.get(t.id);
    if (!d) {
      d = { description: t.description || '', solutionVerifyPrompt: t.solutionVerifyPrompt || '' };
      drafts.set(t.id, d);
    }
    return d;
  }

  function startEdit(t) {
    draftFor(t);
    editing.add(t.id);
    // Open the row so the fields being edited are the ones on screen.
    open.add(t.id);
    rerender();
  }

  function cancelEdit(t) {
    editing.delete(t.id);
    drafts.delete(t.id);
    rerender();
  }

  function saveTask(t) {
    const d = drafts.get(t.id) || draftFor(t);
    const patch = { description: d.description };
    if (t.kind !== 'phase') {
      patch.solutionVerifyPrompt = d.solutionVerifyPrompt;
    }
    const changed = patch.description !== (t.description || '') ||
      (patch.solutionVerifyPrompt !== undefined && patch.solutionVerifyPrompt !== (t.solutionVerifyPrompt || ''));
    editing.delete(t.id);
    drafts.delete(t.id);
    if (!changed) {
      saved.set(t.id, 'No changes');
    } else {
      saved.set(t.id, 'Saved — the next worker reads this text.');
      send({ type: 'updateTask', id: t.id, patch });
    }
    rerender();
    const at = saved.get(t.id);
    setTimeout(() => {
      if (saved.get(t.id) === at) {
        saved.delete(t.id);
        rerender();
      }
    }, 4000);
  }

  /** Draw the list from the last pushed state without waiting for the next push. */
  function rerender() {
    const st = getState();
    if (st && st.tasks) renderTasks(st.tasks, st.status || {});
  }

  // ---- small builders ----

  function editField(label, value, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'field editing';

    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = label;
    wrap.appendChild(l);

    const input = document.createElement('textarea');
    input.rows = 3;
    input.value = value || '';
    // Update the draft on every keystroke, so a re-render triggered by a live
    // agent mid-edit restores what has been typed instead of dropping it.
    input.addEventListener('input', () => onInput(input.value));
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

  return {
    renderTasks,
    liveLabel,
    tokenLabel,
    compact,
    // queue.js skips a list rebuild while a field is open, so an incoming
    // state push cannot destroy the caret or an uncommitted draft.
    hasOpenEditor: () => editing.size > 0,
  };
};
