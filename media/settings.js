// @ts-check
/* MF Agent settings. Vanilla DOM, same house style as the chat and queue views. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (msg) => vscode.postMessage(msg);

  /** Last full state pushed by the extension. */
  let S = null;
  /** Model lists keyed by profile id: { models, fetchedAt, error, loading }. */
  const modelsByProfile = {};
  /** Test-connection results keyed by profile id. */
  const testByProfile = {};
  let selectedId = null;
  let selectedSkillId = null;
  let selectedMcpId = null;

  // ---- tabs -------------------------------------------------------------

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const want = tab.getAttribute('data-tab');
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('active', t === tab);
      }
      for (const p of document.querySelectorAll('.panel')) {
        p.hidden = p.getAttribute('data-panel') !== want;
      }
    });
  }

  $('exportBtn').addEventListener('click', () => send({ type: 'export' }));
  $('importBtn').addEventListener('click', () => send({ type: 'import' }));
  $('addBtn').addEventListener('click', () => {
    const sel = /** @type {HTMLSelectElement} */ ($('addProvider'));
    if (sel.value) send({ type: 'addProfile', providerId: sel.value });
  });
  $('addSkillBtn').addEventListener('click', () => send({ type: 'addSkill' }));
  $('addMcpBtn').addEventListener('click', () => send({ type: 'addMcpServer' }));

  // ---- messages ---------------------------------------------------------

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case 'state':
        S = m;
        // The extension's cache is the source of truth. Taking it wholesale
        // matters when a profile is retargeted at a different endpoint: the
        // previous provider's models must not linger until the refetch lands.
        for (const [id, list] of Object.entries(m.cachedModels || {})) {
          modelsByProfile[id] = { ...list, loading: (modelsByProfile[id] || {}).loading };
        }
        if (m.selectProfileId) selectedId = m.selectProfileId;
        if (!S.settings.profiles.some((p) => p.id === selectedId)) {
          selectedId = S.settings.profiles.length ? S.settings.profiles[0].id : null;
        }
        if (m.selectSkillId) selectedSkillId = m.selectSkillId;
        if (!S.settings.skills.some((s) => s.id === selectedSkillId)) {
          selectedSkillId = S.settings.skills.length ? S.settings.skills[0].id : null;
        }
        if (m.selectMcpId) selectedMcpId = m.selectMcpId;
        if (!(S.settings.mcpServers || []).some((s) => s.id === selectedMcpId)) {
          selectedMcpId = (S.settings.mcpServers || []).length ? S.settings.mcpServers[0].id : null;
        }
        render();
        break;
      case 'modelsLoading':
        modelsByProfile[m.profileId] = { ...(modelsByProfile[m.profileId] || { models: [] }), loading: true };
        render();
        break;
      case 'models':
        modelsByProfile[m.profileId] = { ...m.list, loading: false };
        render();
        break;
      case 'testing':
        testByProfile[m.profileId] = { testing: true };
        render();
        break;
      case 'testResult':
        testByProfile[m.profileId] = { ok: m.ok, message: m.message };
        render();
        break;
      case 'toast':
        toast(m.level, m.text);
        break;
    }
  });

  let toastTimer = 0;
  function toast(level, text) {
    const node = $('toast');
    node.className = level || 'info';
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (node.hidden = true), 5000);
  }

  // ---- helpers ----------------------------------------------------------

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') /** @type {any} */ (node).value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'multiple')
        /** @type {any} */ (node)[k] = !!v;
      else node.setAttribute(k, String(v));
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const providerDef = (id) => (S.providers || []).find((p) => p.id === id) || S.providers[0];
  const profileById = (id) => S.settings.profiles.find((p) => p.id === id);

  /**
   * A labelled control. Deliberately a div rather than a <label>: some of these
   * wrap a whole row of buttons, and a <label> would forward those clicks to
   * the input inside it.
   */
  function labeled(labelText, control, note) {
    return el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: labelText }),
      control,
      note ? el('span', { class: 'note', text: note }) : null,
    ]);
  }

  function fmtCount(n) {
    if (!n) return '';
    // Million-token windows are common enough that "1000K" would look wrong.
    if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(n);
  }

  function fmtAge(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  /** One-line summary of a model, used under every model picker. */
  function describeModel(info) {
    if (!info) return '';
    const bits = [];
    if (info.contextWindow) bits.push(`${fmtCount(info.contextWindow)} ctx`);
    if (info.maxOutputTokens) bits.push(`${fmtCount(info.maxOutputTokens)} out`);
    if (info.inputPrice !== undefined || info.outputPrice !== undefined) {
      const inp = info.inputPrice !== undefined ? `$${info.inputPrice.toFixed(2)}` : '?';
      const out = info.outputPrice !== undefined ? `$${info.outputPrice.toFixed(2)}` : '?';
      bits.push(`${inp} / ${out} per 1M`);
    }
    if (info.vision) bits.push('vision');
    if (info.embedding) bits.push('embeddings');
    return bits.join(' · ');
  }

  // ---- render -----------------------------------------------------------

  /**
   * Re-renders everything, then puts the caret back.
   *
   * The page redraws whenever the extension pushes state, and a model list
   * landing mid-keystroke used to blow away what you were typing. Every input
   * carries a stable `data-k`, so the focused field, its caret and any
   * uncommitted text survive the redraw.
   */
  function render() {
    if (!S) return;

    const active = /** @type {any} */ (document.activeElement);
    const key = active && active.getAttribute ? active.getAttribute('data-k') : null;
    const caret = key && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const caretEnd = key && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
    const typed = key && typeof active.value === 'string' ? active.value : null;

    renderAddProviderSelect();
    renderProfileList();
    renderProfileEditor();
    renderRoles();
    renderSkillList();
    renderSkillEditor();
    renderSkillGroups();
    renderMcpList();
    renderMcpEditor();
    renderWorkspace();
    renderDetected();

    if (!key) return;
    const next = /** @type {any} */ (document.querySelector(`[data-k="${key}"]`));
    if (!next) return;
    if (typed !== null && next.value !== typed) next.value = typed;
    next.focus();
    if (caret !== null && next.setSelectionRange) {
      try {
        next.setSelectionRange(caret, caretEnd);
      } catch {
        // Not a text-like input; focus alone is enough.
      }
    }
  }

  function renderAddProviderSelect() {
    const sel = /** @type {HTMLSelectElement} */ ($('addProvider'));
    if (sel.options.length) return; // static list; build it once
    const groups = {};
    for (const p of S.providers) (groups[p.group] = groups[p.group] || []).push(p);
    for (const group of ['Editor', 'Hosted', 'Router', 'Local', 'CLI', 'Embeddings', 'Custom']) {
      if (!groups[group]) continue;
      const og = el('optgroup', { label: group });
      for (const p of groups[group]) og.appendChild(el('option', { value: p.id, text: p.label }));
      sel.appendChild(og);
    }
  }

  function renderProfileList() {
    const host = $('profileList');
    host.textContent = '';

    if (!S.settings.profiles.length) {
      host.appendChild(
        el('div', { class: 'hint', text: 'No providers yet. Add one below to get started.' }),
      );
      return;
    }

    for (const p of S.settings.profiles) {
      const def = providerDef(p.providerId);
      const status = S.keyStatus[p.id];
      host.appendChild(
        el(
          'button',
          {
            class: 'profile-item' + (p.id === selectedId ? ' active' : ''),
            onclick: () => {
              selectedId = p.id;
              render();
            },
          },
          [
            el('span', { class: 'pi-text' }, [
              el('span', { class: 'pi-name', text: p.name }),
              el('span', { class: 'pi-sub', text: def ? def.label : p.providerId }),
            ]),
            status === 'missing' ? el('span', { class: 'pill bad', text: 'no key' }) : null,
          ],
        ),
      );
    }
  }

  function renderProfileEditor() {
    const host = $('profileEditor');
    host.textContent = '';

    const p = selectedId ? profileById(selectedId) : null;
    if (!p) {
      host.appendChild(
        el('div', { class: 'empty' }, [
          'Pick a provider on the left, or add one.',
          el('br', {}),
          'API keys go to the OS keychain — never to settings.json.',
        ]),
      );
      return;
    }

    const def = providerDef(p.providerId);
    const list = modelsByProfile[p.id] || { models: [], fetchedAt: 0 };
    const status = S.keyStatus[p.id];

    // --- connection card ---
    const head = el('div', { class: 'card-head' }, [
      el('h2', { text: 'Connection' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost',
        text: 'Duplicate',
        onclick: () => send({ type: 'duplicateProfile', id: p.id }),
      }),
      el('button', {
        class: 'danger',
        text: 'Delete',
        onclick: () => send({ type: 'removeProfile', id: p.id }),
      }),
    ]);

    const nameInput = el('input', {
      type: 'text',
      'data-k': `${p.id}:name`,
      value: p.name,
      onchange: (e) => send({ type: 'updateProfile', id: p.id, patch: { name: e.target.value } }),
    });

    const providerSelect = el('select', {
      'data-k': `${p.id}:provider`,
      onchange: (e) =>
        // An empty base URL clears the override; `undefined` would be dropped
        // in transit and leave the previous provider's endpoint behind.
        send({
          type: 'updateProfile',
          id: p.id,
          patch: { providerId: e.target.value, baseURL: '' },
        }),
    });
    const groups = {};
    for (const d of S.providers) (groups[d.group] = groups[d.group] || []).push(d);
    for (const group of ['Editor', 'Hosted', 'Router', 'Local', 'CLI', 'Embeddings', 'Custom']) {
      if (!groups[group]) continue;
      const og = el('optgroup', { label: group });
      for (const d of groups[group]) {
        const opt = el('option', { value: d.id, text: d.label });
        if (d.id === p.providerId) opt.selected = true;
        og.appendChild(opt);
      }
      providerSelect.appendChild(og);
    }

    const fields = [
      labeled('Name', nameInput, 'How this connection is listed on the Roles tab.'),
      labeled('Provider', providerSelect),
    ];

    if (def.notes) {
      fields.unshift(el('p', { class: 'notice', text: def.notes }));
    }

    // --- API key ---
    if (def.apiKey !== 'none') {
      const keyInput = el('input', {
        type: 'password',
        'data-k': `${p.id}:key`,
        placeholder:
          status === 'stored'
            ? '•••••••••••• stored in the keychain'
            : status === 'env'
              ? `using $${def.apiKeyEnv[0]}`
              : def.apiKey === 'optional'
                ? 'optional'
                : 'paste your API key',
        onkeydown: (e) => {
          if (e.key === 'Enter') saveKey();
        },
      });
      const saveKey = () => {
        send({ type: 'setApiKey', id: p.id, key: keyInput.value });
        keyInput.value = '';
      };

      const keyRow = el('div', { class: 'row' }, [
        keyInput,
        el('button', { text: 'Save', onclick: saveKey }),
        status === 'stored'
          ? el('button', {
              class: 'ghost',
              text: 'Clear',
              onclick: () => send({ type: 'setApiKey', id: p.id, key: '' }),
            })
          : null,
      ]);

      const keyNote =
        status === 'stored'
          ? 'Stored in the OS keychain. Type a new key to replace it.'
          : status === 'env'
            ? `Falling back to the ${def.apiKeyEnv.join(' / ')} environment variable.`
            : def.apiKeyEnv && def.apiKeyEnv.length
              ? `Leave blank to use $${def.apiKeyEnv[0]}.`
              : undefined;

      fields.push(labeled('API key', keyRow, keyNote));

      if (def.docsURL) {
        fields.push(
          el('p', { class: 'note pull-up' }, [
            el('button', {
              class: 'link',
              text: `Get a key from ${def.label} →`,
              onclick: () => send({ type: 'openExternal', url: def.docsURL }),
            }),
          ]),
        );
      }
    }

    // --- base URL ---
    if (def.baseURLEditable) {
      fields.push(
        labeled(
          'Base URL',
          el('input', {
            type: 'text',
            'data-k': `${p.id}:baseURL`,
            value: p.baseURL || '',
            placeholder: def.defaultBaseURL || 'https://…/v1',
            onchange: (e) =>
              send({
                type: 'updateProfile',
                id: p.id,
                patch: { baseURL: e.target.value.trim() },
              }),
          }),
          def.baseURLRequired
            ? 'Required for this provider.'
            : `Blank uses ${def.defaultBaseURL}.`,
        ),
      );
    }

    for (const f of def.extraFields || []) {
      fields.push(
        labeled(
          f.label,
          el('input', {
            type: f.secret ? 'password' : 'text',
            'data-k': `${p.id}:x:${f.key}`,
            value: (p.extra || {})[f.key] || '',
            placeholder: f.placeholder || '',
            onchange: (e) =>
              send({
                type: 'updateProfile',
                id: p.id,
                patch: { extra: { ...(p.extra || {}), [f.key]: e.target.value } },
              }),
          }),
          f.description,
        ),
      );
    }

    // --- test + model list state ---
    const test = testByProfile[p.id];
    fields.push(
      el('div', { class: 'row mt-sm' }, [
        el('button', {
          class: 'ghost',
          text: test && test.testing ? 'Testing…' : 'Test connection',
          disabled: !!(test && test.testing),
          onclick: () => send({ type: 'testProfile', id: p.id }),
        }),
        el('span', { class: 'spacer' }),
      ]),
    );
    if (test && !test.testing) {
      fields.push(
        el('div', { class: 'status-line ' + (test.ok ? 'ok' : 'bad'), text: test.message }),
      );
    }

    host.appendChild(el('div', { class: 'card' }, [head].concat(fields)));

    // --- models card ---
    const modelsHead = el('div', { class: 'card-head' }, [
      el('h2', { text: 'Models' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost',
        text: list.loading ? 'Loading…' : 'Refresh',
        disabled: !!list.loading,
        onclick: () => send({ type: 'refreshModels', id: p.id }),
      }),
    ]);

    const body = [];
    if (list.error) {
      body.push(el('div', { class: 'status-line bad', text: list.error }));
    }
    if (list.models.length) {
      body.push(
        el('div', { class: 'status-line muted' }, [
          `${list.models.length} model(s)`,
          el('span', { text: ' · ' }),
          list.fallback ? 'built-in list' : `fetched ${fmtAge(list.fetchedAt)}`,
        ]),
      );
      const vision = list.models.filter((m) => m.vision).length;
      const embed = list.models.filter((m) => m.embedding).length;
      body.push(
        el('div', { class: 'tag-row mt-sm' }, [
          el('span', { class: 'pill muted', text: `${vision} vision-capable` }),
          el('span', { class: 'pill muted', text: `${embed} embeddings` }),
        ]),
      );
    } else if (!list.error) {
      body.push(
        el('div', {
          class: 'status-line muted',
          text: list.loading ? 'Fetching the model list…' : 'No models discovered yet.',
        }),
      );
    }
    body.push(
      el('p', {
        class: 'note mt-md',
        text: 'Assign these models to roles on the Roles tab.',
      }),
    );

    host.appendChild(el('div', { class: 'card' }, [modelsHead].concat(body)));
  }

  // ---- roles ------------------------------------------------------------

  function renderRoles() {
    const host = $('roleList');
    host.textContent = '';

    if (!S.settings.profiles.length) {
      host.appendChild(
        el('div', { class: 'empty', text: 'Add a provider first — roles bind to a provider.' }),
      );
      return;
    }

    for (const role of S.roles) {
      host.appendChild(renderRole(role));
    }
  }

  /** Can this provider serve this role at all? */
  function serves(def, roleId) {
    if (def.rolesAllowed && !def.rolesAllowed.includes(roleId)) return false;
    if (roleId === 'embedding') return def.serves.embedding;
    if (roleId === 'vision') return def.serves.vision;
    return def.serves.chat;
  }

  /** Reasoning-effort choices offered in the role editor. Support and exact
   *  vocabulary vary by provider and model; this is a hint, passed through
   *  rather than validated, and "Default" always means "send nothing". */
  const EFFORT_CHOICES = [
    ['', 'Default'],
    ['minimal', 'Minimal'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max (Anthropic)'],
  ];

  function renderRole(role) {
    const binding = S.settings.roles[role.id] || { profileId: '', model: '', effort: '' };
    const inheritable = role.id !== 'coding' && role.id !== 'embedding';
    const inheritsProvider = !binding.profileId && inheritable;
    const effectiveId = binding.profileId || (inheritable ? S.settings.roles.coding.profileId : '');
    const profile = effectiveId ? profileById(effectiveId) : null;
    const inherited = inheritsProvider && !!profile;

    // Provider column.
    const select = el('select', {
      onchange: (e) =>
        send({
          type: 'setRole',
          role: role.id,
          profileId: e.target.value,
          // Switching provider invalidates the model id, so clear it rather
          // than send a model the new endpoint has never heard of.
          model: e.target.value === binding.profileId ? binding.model : '',
          effort: binding.effort || '',
        }),
    });
    if (inheritable) {
      const opt = el('option', { value: '', text: 'Same as Coding' });
      if (!binding.profileId) opt.selected = true;
      select.appendChild(opt);
    } else if (!binding.profileId) {
      const opt = el('option', { value: '', text: 'Not configured' });
      opt.selected = true;
      select.appendChild(opt);
    }
    for (const p of S.settings.profiles) {
      const def = providerDef(p.providerId);
      const bound = p.id === binding.profileId;
      // Only offer providers that can serve this role — but never hide the one
      // already bound, or the select would silently show something else.
      if (!serves(def, role.id) && !bound) continue;
      const opt = el('option', {
        value: p.id,
        text: serves(def, role.id) ? p.name : `${p.name} (no ${role.id} support)`,
      });
      if (bound) opt.selected = true;
      select.appendChild(opt);
    }

    // Model column.
    const list = profile ? modelsByProfile[profile.id] || { models: [] } : { models: [] };
    const wanted = role.id === 'embedding' ? 'embedding' : role.id === 'vision' ? 'vision' : null;
    let choices = list.models;
    if (wanted) {
      const filtered = list.models.filter((m) => m[wanted]);
      // Falling back to the full list matters: the capability flags are
      // heuristics for most providers, and hiding a model the user knows works
      // would be worse than showing one that does not.
      if (filtered.length) choices = filtered;
    }

    const listId = `models-${role.id}`;
    const datalist = el('datalist', { id: listId });
    for (const m of choices.slice(0, 500)) {
      // Only set `label` when there is one: an empty label attribute makes
      // Chromium render a blank row instead of the model id.
      datalist.appendChild(
        el('option', m.name && m.name !== m.id ? { value: m.id, label: m.name } : { value: m.id }),
      );
    }

    const currentModel =
      binding.model || (inherited ? S.settings.roles.coding.model : '') || '';

    const modelInput = el('input', {
      type: 'text',
      list: listId,
      'data-k': `role:${role.id}:model`,
      value: currentModel,
      placeholder: profile ? 'Type or pick a model id' : 'Choose a provider first',
      disabled: !profile,
      onchange: (e) =>
        send({
          type: 'setRole',
          role: role.id,
          // Keep the provider as it was: an empty profileId means "inherit",
          // and a model typed against an inherited provider stays an override
          // of the model alone.
          profileId: binding.profileId,
          model: e.target.value.trim(),
          effort: binding.effort || '',
        }),
    });

    // Effort column. Embeddings never reason, so the control would be pure
    // noise there; every other role can point at a reasoning model.
    const currentEffort = binding.effort || (inherited ? S.settings.roles.coding.effort || '' : '') || '';
    const effortSelect =
      role.id === 'embedding'
        ? null
        : el(
            'select',
            {
              disabled: !profile,
              onchange: (e) =>
                send({
                  type: 'setRole',
                  role: role.id,
                  profileId: binding.profileId,
                  model: binding.model,
                  effort: e.target.value,
                }),
            },
            EFFORT_CHOICES.map(([value, label]) => {
              const opt = el('option', { value, text: label });
              if (value === currentEffort) opt.selected = true;
              return opt;
            }),
          );

    const info = list.models.find((m) => m.id === currentModel);

    const meta = [];
    if (!profile) {
      meta.push(
        role.id === 'embedding'
          ? 'Not set — memory search falls back to keyword matching.'
          : 'Not set.',
      );
    } else {
      if (inherited && !binding.model) meta.push('Following the Coding model.');
      else if (inherited) meta.push('Coding provider, own model.');
      if (!currentModel) meta.push('No model chosen — this role cannot run.');
      if (inherited && !binding.effort && currentEffort) {
        meta.push(`Following the Coding effort (${currentEffort}).`);
      }
      const described = describeModel(info);
      if (described) meta.push(described);
      if (role.id === 'vision' && currentModel && info && info.vision === false) {
        meta.push('Not marked as vision-capable.');
      }
      if (role.id === 'embedding' && currentModel && info && info.embedding === false) {
        meta.push('This does not look like an embeddings model.');
      }
      if (list.loading) meta.push('Loading models…');
    }

    const bad = role.id === 'coding' && (!profile || !currentModel);

    return el('div', { class: 'role' }, [
      el('div', {}, [
        el('div', { class: 'role-title', text: role.title }),
        el('div', { class: 'role-blurb', text: role.blurb }),
      ]),
      el('div', {}, [select]),
      el('div', {}, [
        modelInput,
        datalist,
        el('div', { class: 'meta' + (bad ? ' bad' : ''), text: meta.join(' · ') }),
      ]),
      el(
        'div',
        {},
        effortSelect
          ? [el('div', { class: 'effort-label', text: 'Reasoning effort' }), effortSelect]
          : [],
      ),
    ]);
  }

  // ---- skills -------------------------------------------------------------

  function renderSkillList() {
    const host = $('skillList');
    host.textContent = '';

    if (!S.settings.skills.length) {
      host.appendChild(el('div', { class: 'hint', text: 'No skills yet. Add one below.' }));
      return;
    }

    for (const s of S.settings.skills) {
      host.appendChild(
        el(
          'button',
          {
            class: 'profile-item' + (s.id === selectedSkillId ? ' active' : ''),
            onclick: () => {
              selectedSkillId = s.id;
              render();
            },
          },
          [
            el('span', { class: 'pi-text' }, [
              el('span', { class: 'pi-name', text: s.name }),
              s.description ? el('span', { class: 'pi-sub', text: s.description }) : null,
            ]),
          ],
        ),
      );
    }
  }

  function renderSkillEditor() {
    const host = $('skillEditor');
    host.textContent = '';

    const s = selectedSkillId ? S.settings.skills.find((x) => x.id === selectedSkillId) : null;
    if (!s) {
      host.appendChild(
        el('div', { class: 'empty' }, ['Pick a skill on the left, or add one.']),
      );
      return;
    }

    const head = el('div', { class: 'card-head' }, [
      el('h2', { text: 'Skill' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'danger',
        text: 'Delete',
        onclick: () => send({ type: 'removeSkill', id: s.id }),
      }),
    ]);

    const nameInput = el('input', {
      type: 'text',
      'data-k': `skill:${s.id}:name`,
      value: s.name,
      onchange: (e) => send({ type: 'updateSkill', id: s.id, patch: { name: e.target.value } }),
    });

    const descInput = el('input', {
      type: 'text',
      'data-k': `skill:${s.id}:desc`,
      value: s.description || '',
      placeholder: 'Optional — shown in lists, not sent to the model',
      onchange: (e) =>
        send({ type: 'updateSkill', id: s.id, patch: { description: e.target.value } }),
    });

    const contentInput = el('textarea', {
      rows: 12,
      'data-k': `skill:${s.id}:content`,
      value: s.content,
      placeholder:
        "Markdown or plain text — injected into the agent's system prompt when an enabling group is switched on.",
      onchange: (e) => send({ type: 'updateSkill', id: s.id, patch: { content: e.target.value } }),
    });

    host.appendChild(
      el('div', { class: 'card' }, [
        head,
        labeled('Name', nameInput),
        labeled('Description', descInput),
        labeled('Content', contentInput, `${(s.content || '').length} character(s)`),
      ]),
    );
  }

  function renderSkillGroups() {
    const host = $('skillGroups');
    host.textContent = '';

    host.appendChild(
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Skill groups' }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost',
          text: 'Add group',
          onclick: () => send({ type: 'addSkillGroup' }),
        }),
      ]),
    );

    if (!S.settings.skillGroups.length) {
      host.appendChild(
        el('p', {
          class: 'hint',
          text: 'A group is what gets switched on or off per project, from the Task Queue view’s Context tab.',
        }),
      );
      return;
    }

    for (const g of S.settings.skillGroups) {
      host.appendChild(renderSkillGroup(g));
    }
  }

  function renderSkillGroup(g) {
    const nameInput = el('input', {
      type: 'text',
      'data-k': `skillgroup:${g.id}:name`,
      value: g.name,
      onchange: (e) =>
        send({ type: 'updateSkillGroup', id: g.id, patch: { name: e.target.value } }),
    });

    const head = el('div', { class: 'card-head' }, [
      nameInput,
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'danger',
        text: 'Delete',
        onclick: () => send({ type: 'removeSkillGroup', id: g.id }),
      }),
    ]);

    const checks = !S.settings.skills.length
      ? el('p', { class: 'hint', text: 'No skills to add yet.' })
      : el(
          'div',
          { class: 'skill-check-list' },
          S.settings.skills.map((s) =>
            el('label', { class: 'check' }, [
              el('input', {
                type: 'checkbox',
                checked: g.skillIds.includes(s.id),
                onchange: (e) => {
                  const skillIds = e.target.checked
                    ? [...g.skillIds, s.id]
                    : g.skillIds.filter((id) => id !== s.id);
                  send({ type: 'updateSkillGroup', id: g.id, patch: { skillIds } });
                },
              }),
              s.name,
            ]),
          ),
        );

    return el('div', { class: 'card skill-group' }, [head, checks]);
  }

  // ---- mcp servers --------------------------------------------------------

  function renderMcpList() {
    const host = $('mcpList');
    host.textContent = '';
    const servers = S.settings.mcpServers || [];
    if (!servers.length) {
      host.appendChild(el('div', { class: 'hint', text: 'No servers defined here yet. Add one below.' }));
      return;
    }
    for (const s of servers) {
      host.appendChild(
        el(
          'button',
          {
            class: 'profile-item' + (s.id === selectedMcpId ? ' active' : ''),
            onclick: () => {
              selectedMcpId = s.id;
              render();
            },
          },
          [
            el('span', { class: 'pi-text' }, [
              el('span', { class: 'pi-name', text: s.name }),
              el('span', {
                class: 'pi-sub',
                text:
                  s.transport === 'http'
                    ? s.url || 'http — no URL yet'
                    : s.command || 'stdio — no command yet',
              }),
            ]),
            s.enabled === false ? el('span', { class: 'pill muted', text: 'off' }) : null,
          ],
        ),
      );
    }
  }

  /** "KEY<sep>value" lines ↔ an object, for a server's env and headers. */
  function parseKv(text, sep) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const i = line.indexOf(sep);
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      if (k) out[k] = line.slice(i + 1).trim();
    }
    return out;
  }

  function formatKv(obj, sep) {
    return Object.entries(obj || {})
      .map(([k, v]) => `${k}${sep}${v}`)
      .join('\n');
  }

  function opt(value, text, selected) {
    const o = el('option', { value, text });
    if (selected) o.selected = true;
    return o;
  }

  function renderMcpEditor() {
    const host = $('mcpEditor');
    host.textContent = '';

    const s = selectedMcpId ? (S.settings.mcpServers || []).find((x) => x.id === selectedMcpId) : null;
    if (!s) {
      host.appendChild(
        el('div', { class: 'empty' }, [
          'Pick a server on the left, or add one.',
          el('br', {}),
          'Keys go to the OS keychain — never to a file.',
        ]),
      );
      return;
    }

    const patch = (p) => send({ type: 'updateMcpServer', id: s.id, patch: p });
    const http = s.transport === 'http';
    const hasKey = !!(S.mcpKeyStatus || {})[s.id];

    // --- server card ---
    const head = el('div', { class: 'card-head' }, [
      el('h2', { text: 'Server' }),
      el('span', { class: 'spacer' }),
      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          checked: s.enabled !== false,
          onchange: (e) => patch({ enabled: e.target.checked }),
        }),
        'Enabled',
      ]),
      el('button', {
        class: 'danger',
        text: 'Delete',
        onclick: () => send({ type: 'removeMcpServer', id: s.id }),
      }),
    ]);

    const fields = [
      labeled(
        'Name',
        el('input', {
          type: 'text',
          'data-k': `mcp:${s.id}:name`,
          value: s.name,
          onchange: (e) => patch({ name: e.target.value.trim() }),
        }),
        'How the server is listed, and the prefix its tools carry.',
      ),
      labeled(
        'Transport',
        el('select', { onchange: (e) => patch({ transport: e.target.value }) }, [
          opt('stdio', 'stdio — a local process', !http),
          opt('http', 'http — streamable HTTP', http),
        ]),
      ),
    ];

    if (http) {
      fields.push(
        labeled(
          'URL',
          el('input', {
            type: 'text',
            'data-k': `mcp:${s.id}:url`,
            value: s.url || '',
            placeholder: 'https://…/mcp',
            onchange: (e) => patch({ url: e.target.value.trim() }),
          }),
        ),
      );
      fields.push(
        labeled(
          'Headers',
          el('textarea', {
            rows: 3,
            'data-k': `mcp:${s.id}:headers`,
            value: formatKv(s.headers, ': '),
            placeholder: 'X-Client: mfagent',
            onchange: (e) => patch({ headers: parseKv(e.target.value, ':') }),
          }),
          'One per line, as Name: value. Not the key — that has its own card below.',
        ),
      );
    } else {
      fields.push(
        labeled(
          'Command',
          el('input', {
            type: 'text',
            'data-k': `mcp:${s.id}:command`,
            value: s.command || '',
            placeholder: 'npx',
            onchange: (e) => patch({ command: e.target.value.trim() }),
          }),
        ),
      );
      fields.push(
        labeled(
          'Arguments',
          el('textarea', {
            rows: 3,
            'data-k': `mcp:${s.id}:args`,
            value: (s.args || []).join('\n'),
            placeholder: '-y\n@bytebase/dbhub',
            onchange: (e) =>
              patch({
                args: e.target.value
                  .split(/\r?\n/)
                  .map((a) => a.trim())
                  .filter(Boolean),
              }),
          }),
          'One argument per line.',
        ),
      );
      fields.push(
        labeled(
          'Environment',
          el('textarea', {
            rows: 3,
            'data-k': `mcp:${s.id}:env`,
            value: formatKv(s.env, '='),
            placeholder: 'LOG_LEVEL=info',
            onchange: (e) => patch({ env: parseKv(e.target.value, '=') }),
          }),
          'One per line, as NAME=value. Not the key — that has its own card below.',
        ),
      );
    }

    host.appendChild(el('div', { class: 'card' }, [head].concat(fields)));

    // --- key card ---
    const keyInput = el('input', {
      type: 'password',
      'data-k': `mcp:${s.id}:key`,
      placeholder: hasKey ? '•••••••••••• stored in the keychain' : 'paste the key',
      onkeydown: (e) => {
        if (e.key === 'Enter') saveKey();
      },
    });
    const saveKey = () => {
      send({ type: 'setMcpKey', id: s.id, key: keyInput.value });
      keyInput.value = '';
    };

    const keyFields = [
      labeled(
        http ? 'Header the key goes in' : 'Environment variable the key goes in',
        el('input', {
          type: 'text',
          'data-k': `mcp:${s.id}:keyName`,
          value: s.keyName || '',
          placeholder: http ? 'Authorization' : 'API_KEY',
          onchange: (e) => patch({ keyName: e.target.value.trim() }),
        }),
        'Leave blank for a server that takes no key.',
      ),
    ];
    if (http) {
      keyFields.push(
        labeled(
          'Prefix',
          el('input', {
            type: 'text',
            'data-k': `mcp:${s.id}:keyPrefix`,
            value: s.keyPrefix || '',
            placeholder: 'Bearer ',
            onchange: (e) => patch({ keyPrefix: e.target.value }),
          }),
          'Put in front of the key inside the header — almost always "Bearer ".',
        ),
      );
    }
    keyFields.push(
      labeled(
        'Key',
        el('div', { class: 'row' }, [
          keyInput,
          el('button', { text: 'Save', onclick: saveKey }),
          hasKey
            ? el('button', {
                class: 'ghost',
                text: 'Clear',
                onclick: () => send({ type: 'setMcpKey', id: s.id, key: '' }),
              })
            : null,
        ]),
        hasKey
          ? 'Stored in the OS keychain. Type a new key to replace it.'
          : 'Stored in the OS keychain and injected only when the server starts.',
      ),
    );

    host.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'API key' }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'pill ' + (hasKey ? 'ok' : 'muted'), text: hasKey ? 'key stored' : 'no key' }),
        ]),
      ].concat(keyFields)),
    );
  }

  // ---- workspace --------------------------------------------------------

  function renderWorkspace() {
    const host = $('workspacePanel');
    host.textContent = '';

    const langs = S.settings.languages;
    const detectedLangs = S.detected.languages || [];

    const autoToggle = el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox',
        checked: langs.auto,
        onchange: (e) =>
          send({ type: 'setLanguages', auto: e.target.checked, list: langs.list }),
      }),
      'Detect the languages in this workspace automatically',
    ]);

    const manual = el('input', {
      type: 'text',
      'data-k': 'languages',
      value: (langs.auto ? detectedLangs : langs.list).join(', '),
      disabled: langs.auto,
      placeholder: 'PHP, TypeScript, Go',
      onchange: (e) =>
        send({
          type: 'setLanguages',
          auto: false,
          list: e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
    });

    host.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h2', { text: 'Languages' }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'ghost',
            text: 'Rescan',
            onclick: () => send({ type: 'rescanLanguages' }),
          }),
        ]),
        el('p', {
          class: 'hint',
          text: 'The agent is told which languages this project uses so its system prompt matches the code it is editing.',
        }),
        autoToggle,
        el('div', { class: 'gap-md' }),
        labeled(
          langs.auto ? 'Detected' : 'Languages',
          manual,
          langs.auto ? 'Read-only while auto-detection is on.' : 'Comma separated.',
        ),
      ]),
    );

    host.appendChild(
      el('div', { class: 'card' }, [
        el('h2', { text: 'Browser' }),
        el('p', {
          class: 'hint',
          text: 'Chrome is located automatically, and downloaded into the extension cache when the machine has none.',
        }),
        el('label', { class: 'check' }, [
          el('input', {
            type: 'checkbox',
            checked: S.settings.browser.headless,
            onchange: (e) => send({ type: 'setHeadless', headless: e.target.checked }),
          }),
          'Run the test browser headless',
        ]),
        S.detected.remote
          ? el('p', {
              class: 'note',
              text: `Forced on: this is a ${S.detected.remote} remote workspace.`,
            })
          : null,
      ]),
    );

    host.appendChild(
      el('div', { class: 'card' }, [
        el('h2', { text: 'Elsewhere' }),
        el('p', {
          class: 'hint',
          text: 'Memory and the autonomous-run timings are plain values, so they stay in the VS Code settings editor where it can validate them. MCP servers have their own tab here; the mfagent.mcpServers setting and your VS Code user mcp.json are read as well — pick which are active for a project from the Task Queue view’s Context tab.',
        }),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'ghost',
            text: 'Open VS Code settings',
            onclick: () => send({ type: 'openVsSettings' }),
          }),
          el('button', {
            class: 'ghost',
            text: 'Restart core',
            onclick: () => send({ type: 'restartCore' }),
          }),
          el('button', {
            class: 'ghost',
            text: 'Show core log',
            onclick: () => send({ type: 'showLog' }),
          }),
        ]),
      ]),
    );
  }

  // ---- detected ---------------------------------------------------------

  function renderDetected() {
    const host = $('detectedPanel');
    host.textContent = '';
    const d = S.detected;

    const rows = [
      ['Workspace root', d.workspaceRoot || '(no folder open)'],
      ['Languages', (d.languages || []).join(', ') || '(none detected)'],
      ['Graph memory DB', d.memoryDb || '(needs a workspace folder)'],
      ['Task queue DB', d.queueDb || '(needs a workspace folder)'],
      ['Screenshots', d.screenshotDir || '(needs a workspace folder)'],
      [
        'Agent core binary',
        d.core.path ? `${d.core.path}  (${d.core.source})` : 'not found — run `npm run build:core`',
      ],
      ['Chrome / Chromium', d.chromium || 'not resolved — browser tools are disabled'],
      ['Remote', d.remote || 'local'],
    ];

    const table = el('table', { class: 'kv' });
    for (const [k, v] of rows) {
      table.appendChild(
        el('tr', {}, [el('td', { text: k }), el('td', { class: 'val mono', text: v })]),
      );
    }

    host.appendChild(el('div', { class: 'card' }, [table]));

    if (!d.core.path) {
      host.appendChild(
        el('div', { class: 'card' }, [
          el('h2', { text: 'Core binary search path' }),
          el(
            'table',
            { class: 'kv' },
            (d.core.searched || []).map((s) =>
              el('tr', {}, [el('td', { text: 'looked in' }), el('td', { class: 'val mono', text: s })]),
            ),
          ),
        ]),
      );
    }
  }

  send({ type: 'ready' });
})();
