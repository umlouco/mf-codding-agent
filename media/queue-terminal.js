// @ts-check
/* Cohesive queue view helpers; loaded before queue.js under the webview nonce. */
window.MFQueueUI = window.MFQueueUI || {};
window.MFQueueUI.terminal = function ({ send }) {
  // ---- live output ----
  //
  // One terminal per open task, plus one for the planner (keyed 'planner'), fed by
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
    const chunk = String(row.chunk).slice(-MAX_CHARS);
    const last = t.blocks[t.blocks.length - 1];
    const folds = row.kind === 'response' || row.kind === 'reasoning';
    if (folds && last && last.actor === row.actor && last.kind === row.kind) {
      last.text += chunk;
      if (last.el) appendText(last, chunk);
    } else {
      const block = { actor: row.actor, kind: row.kind, text: chunk, el: null };
      t.blocks.push(block);
      if (t.el) mountBlock(t, block);
    }
    t.chars += chunk.length;
    while (t.blocks.length > MAX_BLOCKS || (t.chars > MAX_CHARS && t.blocks.length > 1)) {
      const gone = t.blocks.shift();
      t.chars -= gone.text.length;
      if (gone.el) gone.el.remove();
    }
    // A single continuous response must obey the limit too.
    if (t.chars > MAX_CHARS) {
      const block = t.blocks[0];
      block.text = block.text.slice(-MAX_CHARS);
      t.chars = block.text.length;
      if (block.el) block.el.querySelector('.tb-t').textContent = block.text;
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
      const t = terms.get(termKey(m.taskId));
      if (!t) return; // A tail reply can arrive after the row was closed.
      t.blocks = [];
      t.chars = 0;
      if (t.el) t.el.textContent = '';
    }
    for (const row of m.rows || []) {
      const t = terms.get(termKey(row.taskId));
      if (t) pushRow(t, row);
    }
  }

  function unmountTerm(key) {
    const t = terms.get(key);
    if (!t) return;
    if (t.el) t.el.textContent = '';
    terms.delete(key);
  }

  // Drop references into the old task tree before rebuilding it. Only open
  // rows retain text; closed/deleted rows reload their tail from SQLite.
  function prepareTasks(keys) {
    const keep = new Set(keys);
    for (const [key, t] of terms) {
      if (key === 'planner') continue;
      if (!keep.has(key)) unmountTerm(key);
      else {
        t.el = null;
        for (const block of t.blocks) block.el = null;
      }
    }
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

  return { mountTerm, unmountTerm, prepareTasks, terminalBlock, onLogs };
};
