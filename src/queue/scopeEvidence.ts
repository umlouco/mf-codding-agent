/** Tool footprints are evidence for a supervisor, never an edit allowance. */
export class ScopeEvidence {
  private pending = new Map<string, { name: string; input: any }>();
  private reads = new Set<string>();
  private edits = new Set<string>();
  private recent: { name: string; status: string; targets: string[]; command?: string }[] = [];
  private completed = 0;
  private opaque = 0;
  private capped = false;
  private activityRevision = 0;
  private focus = '';

  observe(method: string, params: any): void {
    if (method === 'agent/cognition' || method === 'stream/text' || method === 'stream/thinking') {
      const text = method === 'agent/cognition' ? JSON.stringify(params) : String(params?.delta ?? '');
      this.focus = (this.focus + text).slice(-2400);
      this.activityRevision++;
      return;
    }
    if (method !== 'stream/tool' || !params?.id || params.status === 'start') return;
    if (params.status === 'running') {
      let input = params.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { patch: input }; } }
      // Extract immediately: do not retain whole source files in pending tool inputs.
      const name = String(params.name ?? '');
      this.pending.set(params.id, { name, input: this.targets(name, input) });
      this.activityRevision++;
      return;
    }
    const started = this.pending.get(params.id);
    this.pending.delete(params.id);
    if (!started) return;
    this.completed++;
    this.activityRevision++;
    const { name, input } = started;
    const success = ['ok', 'done'].includes(params.status);
    const read = /(?:^|__)(?:read_file|read_files|Read|read_text_file|read_multiple_files)$/.test(name);
    const edit = /(?:^|__)(?:write_file|edit_file|multi_edit|apply_patch|apply_diff|replace_in_file|Write|Edit|MultiEdit|delete_file|move_file|rename_file)$/.test(name);
    if (success && (read || edit)) for (const target of input.paths) {
      const set = edit ? this.edits : this.reads;
      if (set.size < 512) set.add(target); else this.capped = true;
    }
    if (!read && !edit) this.opaque++;
    this.recent.push({ name, status: params.status, targets: input.paths.slice(0, 8),
      ...(input.command ? { command: input.command } : {}) });
    this.recent = this.recent.slice(-12);
  }

  private targets(name: string, input: any): { paths: string[]; command: string } {
    const paths: string[] = [];
    const add = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) paths.push(v.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
    };
    for (const key of ['path', 'file_path', 'filePath', 'source', 'destination']) add(input?.[key]);
    if (Array.isArray(input?.paths)) input.paths.forEach(add);
    if (Array.isArray(input?.edits)) input.edits.forEach((e: any) => add(e?.file_path ?? e?.path));
    if (/patch|diff/i.test(name)) {
      const patch = input?.patch ?? input?.diff ?? input?.input;
      if (typeof patch === 'string') for (const line of patch.split(/\r?\n/)) {
        const match = /^(?:\*\*\* (?:Update|Add|Delete) File: |\*\*\* Move to: |\+\+\+ b\/)(.+)$/.exec(line);
        if (match) add(match[1]);
      }
    }
    return { paths: [...new Set(paths)], command: String(input?.command ?? input?.cmd ?? '').slice(0, 1200) };
  }

  get revision(): number { return this.activityRevision; }
  get breadthSignal(): boolean { return this.edits.size > 3 || this.reads.size >= 12; }
  snapshot() {
    return { completedTools: this.completed, distinctReadTargets: this.reads.size,
      distinctEditTargets: this.edits.size, countsAreLowerBounds: true, trackingCapped: this.capped,
      readSample: [...this.reads].slice(-20), editSample: [...this.edits].slice(-20),
      opaqueTools: this.opaque, recentTools: this.recent, currentFocus: this.focus,
      inFlight: [...this.pending.values()].slice(-5) };
  }
}
