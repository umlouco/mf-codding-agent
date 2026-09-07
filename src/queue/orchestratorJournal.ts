import { cognitionRecord } from './cognition';
import { LiveLog } from './liveLog';
import { OrchestratorProgress } from './orchestratorProgress';
import { formatToolEvent } from './orchestratorState';

export abstract class OrchestratorJournal extends OrchestratorProgress {

  /** Runtime observations are durable evidence of execution, never liveness heartbeats. */
  protected observerEvents(taskId: number, actor: string, live: LiveLog, accepts = () => true) {
    let lastCognition = '';
    const pendingTools = new Map<string, { name: string; input: unknown }>();
    return (method: string, params: any): void => {
      if (!accepts()) return;
      live.onEvent(method, params);
      if (method === 'stream/tool' && params?.id && params.status !== 'start') {
        if (params.status === 'running') {
          pendingTools.set(params.id, { name: String(params.name ?? 'tool'), input: params.input });
          this.queue.log(taskId, actor, 'tool', `${String(params.name ?? 'tool')}() → start`);
        } else {
          const started = pendingTools.get(params.id);
          pendingTools.delete(params.id);
          this.queue.log(taskId, actor, 'tool', formatToolEvent(
            started?.name ?? String(params.name ?? 'tool'), started?.input,
            String(params.status ?? ''), params.output, params.elapsedMs));
        }
      }
      if (method === 'agent/cognition') {
        const record = cognitionRecord(params);
        if (record && record !== lastCognition) {
          this.queue.log(taskId, actor, 'cognition', record);
          lastCognition = record;
        }
      }
    };
  }

  /**
   * Journals one agent's stream into the task as it happens.
   *
   * Both the worker and the validator write through this, and it exists because
   * that journal is the supervisor's starting evidence. Reasoning recorded here
   * lets a routine review assess direction without reconstructing every step. Tool
   * calls alone do not carry a wrong premise or a rabbit hole; the model saying
   * what it thinks it is doing does.
   *
   * Text is buffered rather than written per delta: a token is not a journal
   * entry, and one row per token would bury the tool trail it sits beside. The
   * buffer is flushed when the agent switches between thinking and answering,
   * when it starts a tool call, and by the caller when the turn ends — that last
   * one is not optional, or the tail of every reply is lost.
   */
  protected streamJournal(taskId: number, actor: 'executor' | 'validator', accepts = () => true) {
    const pendingTools = new Map<string, { name: string; input: unknown }>();
    let kind = '';
    let buffer = '';
    let lastCognition = '';
    // The same stream at token granularity, for the view — see liveLog.ts.
    const live = new LiveLog(this.queue, taskId, actor);

    const flush = (): void => {
      if (!accepts()) { buffer = ''; return; }
      live.flush();
      if (!buffer.trim()) {
        buffer = '';
        return;
      }
      this.queue.log(taskId, actor, kind || 'stream', buffer.slice(0, 8000));
      buffer = '';
    };

    const onEvent = (method: string, params: any): void => {
      if (!accepts()) return;
      live.onEvent(method, params);
      if (method === 'agent/cognition') {
        flush();
        const record = cognitionRecord(params);
        if (record && record !== lastCognition) {
          this.queue.log(taskId, actor, 'cognition', record);
          lastCognition = record;
        }
        return;
      }
      if (method === 'stream/text' || method === 'stream/thinking') {
        const next = method === 'stream/thinking' ? 'reasoning' : 'response';
        if (kind && kind !== next) {
          flush();
        }
        kind = next;
        buffer += String(params?.delta ?? '');
        if (buffer.length >= 1200) {
          flush();
        }
        return;
      }
      // stream/tool fires twice per call — once on "running" (carries the
      // input, not the output), once on completion (carries the output, not
      // the input) — matched by id. Correlating them here is what turns the
      // liveness pings elsewhere into a diagnostic trail with actual content:
      // which file, which command, and what came back.
      if (method !== 'stream/tool' || !params?.id) {
        return;
      }
      if (params.status === 'start') return;
      if (params.status === 'running') {
        flush();
        pendingTools.set(params.id, { name: String(params.name ?? 'tool'), input: params.input });
        this.queue.log(taskId, actor, 'tool', `${String(params.name ?? 'tool')}() → start`);
        return;
      }
      const started = pendingTools.get(params.id);
      pendingTools.delete(params.id);
      this.queue.log(taskId, actor, 'tool', formatToolEvent(
        started?.name ?? String(params.name ?? 'tool'),
        started?.input,
        String(params.status ?? ''),
        params.output,
        params.elapsedMs,
      ));
    };

    return { flush, onEvent, live };
  }
}
