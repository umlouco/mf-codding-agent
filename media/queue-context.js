// @ts-check
/* Cohesive queue view helpers; loaded before queue.js under the webview nonce. */
window.MFQueueUI = window.MFQueueUI || {};
window.MFQueueUI.context = function ({ send, getState, $ }) {
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
    const state = getState();
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

  return { drawContext };
};
