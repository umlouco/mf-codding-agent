import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

/**
 * An OpenAI-compatible `/v1/chat/completions` endpoint over `vscode.lm`.
 *
 * The Go core speaks two wire protocols — Anthropic's and OpenAI's — and it
 * cannot call VS Code APIs at all: it is a separate process. The editor's own
 * language models (Copilot's, and any vendor another extension registers
 * through `registerLanguageModelChatProvider`) are reachable only through
 * `vscode.lm.selectChatModels`, inside the extension host. This server is the
 * adapter between the two. It listens on a loopback port with a per-process
 * bearer token, translates each request into `LanguageModelChat.sendRequest`,
 * and streams the reply back as the SSE chunks the core already parses (see
 * core/internal/llm/openai.go). Tool calls round-trip the same way, so every
 * core tool — files, shells, browser, memory, MCP — works unchanged on an
 * editor model, and so does the queue's per-role process isolation.
 *
 * Nothing here is configurable, on purpose. The port is whatever the OS hands
 * out, the token is minted per extension host, and the server accepts only
 * loopback connections. It exists for the core processes this extension
 * spawns, and for nothing else.
 */

export interface ProxyEndpoint {
  /** `http://127.0.0.1:<port>/v1` — what a core dials as its base URL. */
  baseURL: string;
  /** The bearer token every request must carry; unique to this extension host. */
  apiKey: string;
}

/** The request shapes the core sends — see convert() in openai.go. */
interface OaiContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

interface OaiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OaiMessage {
  role: string;
  content?: string | OaiContentPart[] | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

interface OaiTool {
  function?: { name?: string; description?: string; parameters?: object };
}

interface OaiRequest {
  model?: string;
  messages?: OaiMessage[];
  tools?: OaiTool[];
  stream?: boolean;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Largest request body accepted. A long agent conversation with tool output
 * in it runs to megabytes; this is well past anything honest.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const JUSTIFICATION =
  'MF Agent runs its coding agents on the language models available in VS Code.';

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class LmProxy implements vscode.Disposable {
  private server: http.Server | undefined;
  private listening: Promise<ProxyEndpoint> | undefined;
  private readonly token = crypto.randomBytes(24).toString('hex');

  constructor(private readonly output: vscode.OutputChannel) {}

  /** Starts the server on first use and reports where it listens. */
  endpoint(): Promise<ProxyEndpoint> {
    if (!this.listening) {
      this.listening = this.start().catch((e) => {
        this.listening = undefined;
        throw e;
      });
    }
    return this.listening;
  }

  private start(): Promise<ProxyEndpoint> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      // Node's defaults cap how long a *request* may take to arrive, which is
      // fine: the core sends its body in one piece. Nothing caps the reply. A
      // model takes as long as it takes, and the core judges liveness from
      // the bytes it sees rather than from a clock — see the core's wire.go.
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('the language-model proxy did not report a port'));
          return;
        }
        this.server = server;
        const ep: ProxyEndpoint = { baseURL: `http://127.0.0.1:${addr.port}/v1`, apiKey: this.token };
        this.output.appendLine(`[lm] proxy for VS Code language models listening on ${ep.baseURL}`);
        resolve(ep);
      });
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
  }

  // ---- routing ---------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        throw new ProxyError(
          401,
          'missing or invalid bearer token for the MF Agent language-model proxy',
          'invalid_api_key',
        );
      }
      const url = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        await this.models(res);
        return;
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        await this.chat(await readJson(req), res);
        return;
      }
      throw new ProxyError(404, `no route for ${req.method} ${url}`, 'not_found');
    } catch (e: unknown) {
      this.fail(res, e);
    }
  }

  private fail(res: http.ServerResponse, e: unknown): void {
    const err = e instanceof ProxyError ? e : new ProxyError(500, describe(e), 'server_error');
    if (err.status >= 500) {
      this.output.appendLine(`[lm] ${err.message}`);
    }
    if (res.headersSent) {
      // Mid-stream. The status line is gone, so the one honest signal left is
      // to drop the connection: the core reads that as a failed turn rather
      // than as a reply that happened to end here.
      res.destroy(err);
      return;
    }
    res.writeHead(err.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message, type: err.code, code: err.code } }));
  }

  private async models(res: http.ServerResponse): Promise<void> {
    const models = await vscode.lm.selectChatModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          object: 'model',
          owned_by: m.vendor,
          name: m.name,
          family: m.family,
          context_window: m.maxInputTokens,
        })),
      }),
    );
  }

  /**
   * The model a request names. Exact id first; then the looser handles a
   * person might have typed on the Roles tab — a family, a display name, or
   * `vendor/id` — so a model chosen from the list keeps working after the
   * vendor renames its id, as long as one of the others still matches.
   */
  private async pick(id: string | undefined): Promise<vscode.LanguageModelChat> {
    const all = await vscode.lm.selectChatModels();
    if (all.length === 0) {
      throw new ProxyError(
        503,
        'no language models are available in this VS Code — install and sign in to a provider ' +
          'such as GitHub Copilot, then pick a model on the Roles tab',
        'model_not_found',
      );
    }
    const want = (id ?? '').trim();
    if (!want) {
      return all[0];
    }
    const exact = all.find((m) => m.id === want);
    if (exact) {
      return exact;
    }
    const loose = all.find(
      (m) => m.family === want || m.name === want || `${m.vendor}/${m.id}` === want,
    );
    if (loose) {
      return loose;
    }
    throw new ProxyError(
      404,
      `no VS Code language model matches "${want}"; available: ${all.map((m) => m.id).join(', ')}`,
      'model_not_found',
    );
  }

  private async chat(body: OaiRequest, res: http.ServerResponse): Promise<void> {
    const model = await this.pick(body.model);
    const messages = toLmMessages(body.messages ?? []);
    if (messages.length === 0) {
      throw new ProxyError(400, 'the request carries no messages', 'invalid_request');
    }
    const tools = toLmTools(body.tools ?? []);
    const streaming = body.stream !== false;

    const cts = new vscode.CancellationTokenSource();
    let done = false;
    // The response closing early is the client going away: the core killed
    // the turn, or died. Cancelling the token is what stops the model.
    res.on('close', () => {
      if (!done) {
        cts.cancel();
      }
    });

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        messages,
        {
          tools: tools.length ? tools : undefined,
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          justification: JUSTIFICATION,
        },
        cts.token,
      );
    } catch (e) {
      throw fromLmError(e, model);
    }

    const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: object, finish: string | null): string =>
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: model.id,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const send = (json: string): void => {
      res.write(`data: ${json}\n\n`);
    };

    if (streaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
    }

    let text = '';
    const calls: ToolCall[] = [];
    try {
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          if (streaming) {
            send(chunk({ content: part.value }, null));
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const index = calls.length;
          const args = JSON.stringify(part.input ?? {});
          calls.push({ id: part.callId, name: part.name, args });
          if (streaming) {
            send(
              chunk(
                {
                  tool_calls: [
                    { index, id: part.callId, type: 'function', function: { name: part.name, arguments: args } },
                  ],
                },
                null,
              ),
            );
          }
        }
        // Data parts — images and the like — have no place in the core's
        // text protocol and are dropped.
      }
    } catch (e) {
      throw fromLmError(e, model);
    } finally {
      done = true;
    }

    const finish = calls.length ? 'tool_calls' : 'stop';
    const usage = await estimateUsage(model, messages, text, calls);
    if (streaming) {
      send(chunk({}, finish));
      // What the core's stream_options.include_usage asks for: a final chunk
      // with no choices and the usage block.
      send(JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [], usage }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: model.id,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              ...(calls.length
                ? {
                    tool_calls: calls.map((c) => ({
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: c.args },
                    })),
                  }
                : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
  }
}

// ---- translation ---------------------------------------------------------

function contentText(content: OaiMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

function parseArgs(raw: string | undefined): object {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI messages → `LanguageModelChatMessage`s.
 *
 * Two things do not map one-to-one. `vscode.lm` has no system role, so the
 * system prompt travels as the opening user message — the way every
 * extension built on this API sends its instructions. And the core emits one
 * `tool` message per result, while the model wants every result of a batch
 * back in a single user message; splitting them trains the model out of
 * parallel tool use, so consecutive results are folded into one.
 */
function toLmMessages(messages: OaiMessage[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  let results: vscode.LanguageModelToolResultPart[] = [];
  const flush = (): void => {
    if (results.length) {
      out.push(vscode.LanguageModelChatMessage.User(results));
      results = [];
    }
  };

  for (const m of messages) {
    const text = contentText(m.content);
    switch (m.role) {
      case 'tool':
        results.push(
          new vscode.LanguageModelToolResultPart(String(m.tool_call_id ?? ''), [
            new vscode.LanguageModelTextPart(text),
          ]),
        );
        break;
      case 'assistant': {
        flush();
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        if (text) {
          parts.push(new vscode.LanguageModelTextPart(text));
        }
        for (const tc of m.tool_calls ?? []) {
          const name = tc.function?.name ?? '';
          if (!name) {
            continue;
          }
          parts.push(
            new vscode.LanguageModelToolCallPart(
              String(tc.id ?? `call_${parts.length}`),
              name,
              parseArgs(tc.function?.arguments),
            ),
          );
        }
        if (parts.length) {
          out.push(vscode.LanguageModelChatMessage.Assistant(parts));
        }
        break;
      }
      default:
        // 'user', and 'system' / 'developer' as explained above.
        flush();
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];
        if (text.trim()) parts.push(new vscode.LanguageModelTextPart(text));
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part.type !== 'image_url') continue;
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url ?? '');
          if (!match) throw new Error('Vision requires an inline PNG, JPEG, or WebP image.');
          parts.push(vscode.LanguageModelDataPart.image(Buffer.from(match[2], 'base64'), match[1]));
        }
        if (parts.length) out.push(vscode.LanguageModelChatMessage.User(parts));
        break;
    }
  }
  flush();
  return out;
}

function toLmTools(tools: OaiTool[]): vscode.LanguageModelChatTool[] {
  const out: vscode.LanguageModelChatTool[] = [];
  for (const t of tools) {
    const name = t.function?.name?.trim();
    if (!name) {
      continue;
    }
    out.push({
      name,
      description: t.function?.description ?? '',
      inputSchema: t.function?.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

function messageText(m: vscode.LanguageModelChatMessage): string {
  const bits: string[] = [];
  for (const part of m.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      bits.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      bits.push(`${part.name} ${JSON.stringify(part.input)}`);
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      for (const c of part.content) {
        if (c instanceof vscode.LanguageModelTextPart) {
          bits.push(c.value);
        }
      }
    }
  }
  return bits.join('\n');
}

/**
 * `vscode.lm` reports no token counts on a reply. The model's own tokenizer
 * is available, though, so what the queue shows for an editor model is
 * counted rather than guessed — over the text of the prompt and the reply,
 * which is close enough for a running total and for the context ceiling the
 * core enforces. A tokenizer that fails just reports zero, as an HTTP
 * provider that omits usage does.
 */
async function estimateUsage(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  text: string,
  calls: ToolCall[],
): Promise<Usage> {
  try {
    const prompt = messages.map(messageText).join('\n');
    const completion = [text, ...calls.map((c) => `${c.name} ${c.args}`)].join('\n').trim();
    const [p, c] = await Promise.all([
      model.countTokens(prompt),
      completion ? model.countTokens(completion) : Promise.resolve(0),
    ]);
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  } catch {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
}

function readJson(req: http.IncomingMessage): Promise<OaiRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ProxyError(413, 'request body too large', 'invalid_request'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new ProxyError(400, `malformed JSON body: ${describe(e)}`, 'invalid_request'));
      }
    });
    req.on('error', (e) => reject(new ProxyError(400, describe(e), 'invalid_request')));
  });
}

function fromLmError(e: unknown, model: vscode.LanguageModelChat): ProxyError {
  if (e instanceof ProxyError) {
    return e;
  }
  if (e instanceof vscode.CancellationError) {
    return new ProxyError(499, 'the request was cancelled', 'cancelled');
  }
  if (e instanceof vscode.LanguageModelError) {
    switch (e.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return new ProxyError(
          403,
          `VS Code has not granted MF Agent access to ${model.name}. Accept the consent prompt VS Code ` +
            "shows on first use — the Test button on the provider's settings page triggers it — then try again.",
          'no_permissions',
        );
      case vscode.LanguageModelError.NotFound.name:
        return new ProxyError(
          404,
          `the language model ${model.id} is no longer available in VS Code`,
          'model_not_found',
        );
      case vscode.LanguageModelError.Blocked.name:
        return new ProxyError(
          429,
          `VS Code blocked the request to ${model.name}: ${e.message || 'quota exceeded or content blocked'}`,
          'blocked',
        );
      default:
        return new ProxyError(
          502,
          `${model.name} failed: ${e.message || e.code}${causeText(e)}`,
          'upstream_error',
        );
    }
  }
  return new ProxyError(502, `${model.name} failed: ${describe(e)}`, 'upstream_error');
}

function causeText(e: Error): string {
  const cause = (e as { cause?: unknown }).cause;
  return cause ? ` (${describe(cause)})` : '';
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
