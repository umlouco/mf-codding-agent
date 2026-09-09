import * as net from 'net';
import type { Output } from './coreTransport';

export interface LocalModelWaitConfig {
  /** Zero means no whole-turn limit: each tool round may require another long inference. */
  localTurnTimeoutMs?: number;
  localModelIdleSeconds?: number;
  localModelAvailabilityWaitMs?: number;
  localModelConnectTimeoutMs?: number;
  localModelRetryDelayMs?: number;
}
export function localModelTiming(config: LocalModelWaitConfig) {
  const value = (configured: number | undefined, fallback: number, zero = false) => {
    const n = configured ?? fallback;
    if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1) || n > 2147483647) {
      throw new Error('Local model wait settings must be valid nonnegative timer values');
    }
    return n;
  };
  return {
    requestTimeoutMs: value(config.localTurnTimeoutMs, 0, true),
    idleSeconds: value(config.localModelIdleSeconds, 35 * 60),
    availabilityWaitMs: value(config.localModelAvailabilityWaitMs, 35 * 60 * 1000),
    connectTimeoutMs: value(config.localModelConnectTimeoutMs, 10000),
    retryDelayMs: value(config.localModelRetryDelayMs, 30000),
  };
}

function connect(host: string, port: number, timeout: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.removeAllListeners(); socket.on('error', () => {}); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const abort = () => done(new Error('Local model wait cancelled'));
    socket.setTimeout(timeout, () => done(new Error('TCP connection timed out')));
    socket.once('connect', () => done());
    socket.once('error', done);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Local model wait cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Wait for connectivity without submitting or duplicating an inference request. */
export async function waitForLocalEndpoint(baseURL: string, config: LocalModelWaitConfig,
  output: Output, signal?: AbortSignal): Promise<void> {
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Local model endpoint must use HTTP(S)');
  const timing = localModelTiming(config);
  const started = Date.now();
  let lastError = '';
  for (;;) {
    if (signal?.aborted) throw new Error('Local model wait cancelled');
    const remaining = timing.availabilityWaitMs - (Date.now() - started);
    if (remaining <= 0) throw new Error(`No connection to ${url.origin} after ${Math.round(timing.availabilityWaitMs / 60000)} minutes: ${lastError}. No inference request was submitted.`);
    try {
      await connect(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        Math.min(timing.connectTimeoutMs, remaining), signal);
      output.appendLine(`[local-model] ${url.origin} accepts connections; inference idle allowance ${timing.idleSeconds}s; whole-turn limit ${timing.requestTimeoutMs || 'none'}`);
      return;
    } catch (error) {
      if (signal?.aborted) throw new Error('Local model wait cancelled');
      lastError = String(error);
      output.appendLine(`[local-model] waiting for ${url.origin}; ${Math.floor((Date.now() - started) / 1000)}s elapsed; no inference submitted (${lastError})`);
      await delay(Math.min(timing.retryDelayMs, Math.max(1, timing.availabilityWaitMs - (Date.now() - started))), signal);
    }
  }
}
