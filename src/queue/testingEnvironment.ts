import { createHash } from 'crypto';
import type * as vscode from 'vscode';
import type { TaskQueue } from './db';

export interface TestingEnvironment {
  url: string;
  credentials: Record<string, string>;
}

function secretKey(queue: Pick<TaskQueue, 'path'>): string {
  return 'mfagent.testing.' + createHash('sha256').update(queue.path).digest('hex');
}

export function testingURL(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('Testing URL must be a complete HTTP or HTTPS address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS testing URL. Put account details in Credentials.');
  }
  return url.href;
}

export async function loadTestingEnvironment(
  context: Pick<vscode.ExtensionContext, 'secrets'>,
  queue?: TaskQueue,
  allowMissingCredentials = false,
): Promise<TestingEnvironment> {
  if (!queue) return { url: '', credentials: {} };
  const saved = await context.secrets.get(secretKey(queue));
  let credentials: Record<string, string>;
  try {
    const parsed = saved ? JSON.parse(saved) : {};
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.entries(parsed).some(([key, value]) => !/^[a-z][a-z0-9_]{0,47}$/.test(key) || typeof value !== "string")) throw new Error();
    credentials = parsed;
  } catch { throw new Error("Saved testing credentials are invalid; repair the workspace secret storage before running tasks."); }
  if (!allowMissingCredentials) {
    const missing = (queue.testingCredentialNames ?? []).filter(name => !credentials[name]);
    if (missing.length) throw new Error(`Testing credentials unavailable on this host/profile: ${missing.join(', ')}. Enter their values in Task Queue > Plan > Testing environment.`);
  }
  return { url: queue.testingUrl, credentials };
}

export async function saveTestingEnvironment(
  context: Pick<vscode.ExtensionContext, 'secrets'>,
  queue: TaskQueue,
  value: { url?: unknown; credentials?: unknown; remove?: unknown },
): Promise<void> {
  const url = testingURL(value.url);
  if (!Array.isArray(value.credentials) || !Array.isArray(value.remove)) throw new Error('Invalid credential changes.');
  const current = await loadTestingEnvironment(context, queue, true);
  const credentials = { ...current.credentials };
  for (const name of value.remove) delete credentials[String(name).toLowerCase()];
  const seen = new Set<string>();
  for (const row of value.credentials) {
    const name = String(row?.name ?? '').trim().toLowerCase();
    const secret = String(row?.value ?? '');
    if (!name && !secret) continue;
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name)) throw new Error('Credential names must start with a letter and contain only letters, numbers, and underscores.');
    if (seen.has(name)) throw new Error(`Credential name ${name} is duplicated.`);
    seen.add(name);
    if (secret) credentials[name] = secret;
  }
  const removed = new Set(value.remove.map(name => String(name).toLowerCase()));
  const missing = (queue.testingCredentialNames ?? []).filter(name => !credentials[name] && !removed.has(name));
  if (missing.length) throw new Error(`Supply or explicitly remove unavailable credentials: ${missing.join(', ')}.`);
  await context.secrets.store(secretKey(queue), JSON.stringify(credentials));
  queue.setMeta('testingUrl', url);
  queue.setMeta('testingCredentialNames', JSON.stringify(Object.keys(credentials).sort()));
}

/** Child processes get credential references; prompts and the queue DB get names only. */
export function testingProcessEnvironment(testing: TestingEnvironment): Record<string, string> {
  const result: Record<string, string> = { MFAGENT_TEST_URL: testing.url };
  for (const [name, value] of Object.entries(testing.credentials)) {
    result[`MFAGENT_CREDENTIAL_${name.toUpperCase()}`] = value;
  }
  return result;
}

export function redactTestingSecrets(text: string, testing?: TestingEnvironment): string {
  for (const value of Object.entries(testing?.credentials ?? {}).filter(([name]) => !["username", "user"].includes(name)).map(([,value]) => value).filter(Boolean).sort((a,b) => b.length-a.length)) text = text.split(value).join('[REDACTED]');
  return text;
}

export function testingPrompt(text: string, testing: TestingEnvironment): string {
  for (const [name, value] of Object.entries(testing.credentials).filter(([name]) => !["username", "user"].includes(name)).sort((a,b) => b[1].length-a[1].length)) {
    if (value) text = text.split(value).join(`(configured credential ${name}; use MFAGENT_CREDENTIAL_${name.toUpperCase()})`);
  }
  return text;
}

/** Extract explicit owner input before logs, planning, or durable goal storage. */
export async function preparePlanningGoal(
  context: Pick<vscode.ExtensionContext, 'secrets'>, queue: TaskQueue, prompt: string,
): Promise<string> {
  const text = prompt.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$2');
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"'`\])]+/g) ?? [])
    .map(value => value.replace(/[.,;]+$/, '')))];
  const targeted = urls.filter(url => {
    const before = text.slice(Math.max(0, text.indexOf(url) - 100), text.indexOf(url));
    return /(?:\btest(?:ing)?\b|\bplaywright\b)[^\n.!?]*$/i.test(before);
  });
  const detectedURL = targeted.length === 1 ? targeted[0] : urls.length === 1 ? urls[0] : '';
  const detected: Record<string, string> = {};
  const value = '(?:"([^"\\n]+)"|\'([^\'\\n]+)\'|`([^`\\n]+)`|([^\\s,;]+))';
  const unquote = (match: RegExpMatchArray, start = 1) => match.slice(start, start + 4).find(part => part !== undefined) || '';
  const pair = text.match(new RegExp('\\bcredentials?\\s*(?::|=)?\\s*' + value + '\\s*/\\s*' + value, 'i'));
  if (pair) { detected.username = unquote(pair); detected.password = unquote(pair, 5); }
  for (const [name, label] of [['username', '(?:username|user|login)'], ['password', '(?:password|passwd)']]) {
    const found = text.match(new RegExp('\\b' + label + '\\s*[:=]\\s*' + value, 'i'));
    if (found) detected[name] = unquote(found);
  }
  const current = await loadTestingEnvironment(context, queue, true);
  const additions = Object.entries(detected).filter(([name]) => !current.credentials[name]);
  // An existing target is a manual/previously confirmed selection. Do not attach
  // credentials from a different URL to that account.
  const differentTarget = !!current.url && !!detectedURL && testingURL(detectedURL) !== current.url;
  if ((!current.url && detectedURL) || (additions.length && !differentTarget)) {
    await saveTestingEnvironment(context, queue, { url: current.url || detectedURL,
      credentials: differentTarget ? [] : additions.map(([name, value]) => ({ name, value })), remove: [] });
  }
  const safe = testingPrompt(prompt, { url: detectedURL, credentials: detected });
  return testingPrompt(safe, await loadTestingEnvironment(context, queue, true));
}
