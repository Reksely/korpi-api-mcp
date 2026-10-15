import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { loadConfig, redact } from '../src/config.mjs';
import { createMcpServer, runStdio } from '../src/server.mjs';

const KEY = `korpi_api_${'A1b2C3d4E5'.repeat(4)}xyz`;
const BASE = 'https://api.test/v1';
const MODELS = {
  object: 'list',
  data: [
    { id: 'grok-imagine', type: 'video', name: 'Grok Imagine', price: { usd_per_second: 0.03 } },
    { id: 'nano-banana', type: 'image', name: 'Nano Banana', price: { usd_per_image: 0.03 } },
    { id: 'auto', type: 'text', name: 'Auto', price: { usd_per_request: 0.01 } },
  ],
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url.replace(BASE, '')}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (!route) return json(404, { error: { code: 'not_found', message: 'Unknown endpoint.' } });
    return typeof route === 'function' ? route(calls.length) : json(200, route);
  };
  return { fetchImpl, calls };
}

function server(routes, extra = {}) {
  const mock = mockFetch(routes);
  const mcp = createMcpServer({ config: { apiKey: KEY, baseUrl: BASE, keySource: 'env' }, fetchImpl: mock.fetchImpl, pollMs: 1, ...extra });
  return { ...mock, mcp };
}

const call = (mcp, name, args) => mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.result);

test('initialize negotiates the protocol and lists the five tools', async () => {
  const { mcp } = server({});
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  const old = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(old.result.protocolVersion, '2025-11-25');
  const list = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_models', 'generate_video', 'generate_image', 'generate_text', 'get_job_status']);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const missing = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'nope' });
  assert.equal(missing.error.code, -32601);
});

test('list_models is unauthenticated and filters by type', async () => {
  const { mcp, calls } = server({ 'GET /models': MODELS });
  const result = await call(mcp, 'list_models', { type: 'image' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.models.map((m) => m.id), ['nano-banana']);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('generate_image sends the key as a bearer token and returns the URL', async () => {
  const { mcp, calls } = server({ 'POST /images/generations': { id: 'img1', data: [{ url: 'https://cdn.test/a.png' }], amount_usd: 0.03 } });
  const result = await call(mcp, 'generate_image', { prompt: 'A ceramic mug', aspect_ratio: '9:16' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, { prompt: 'A ceramic mug', model: 'nano-banana', aspect_ratio: '9:16' });
  assert.match(result.content[0].text, /https:\/\/cdn\.test\/a\.png/);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('generate_video returns the job id without waiting by default', async () => {
  const { mcp, calls } = server({ 'POST /videos/generations': { id: 'vid1', status: 'queued' } });
  const result = await call(mcp, 'generate_video', { prompt: 'A fox in snow', duration: 8 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { prompt: 'A fox in snow', model: 'grok-imagine', duration: 8 });
  assert.equal(result.structuredContent.id, 'vid1');
  assert.match(result.content[0].text, /get_job_status/);
});

test('generate_video polls until completed when wait_seconds is set', async () => {
  let polls = 0;
  const { mcp } = server({
    'POST /videos/generations': { id: 'vid2', status: 'queued' },
    'GET /videos/generations/vid2': () => json(200, ++polls < 3 ? { id: 'vid2', status: 'in_progress' } : { id: 'vid2', status: 'completed', url: 'https://cdn.test/v.mp4' }),
  });
  const result = await call(mcp, 'generate_video', { prompt: 'A fox', wait_seconds: 30 });
  assert.equal(polls, 3);
  assert.equal(result.structuredContent.status, 'completed');
  assert.match(result.content[0].text, /v\.mp4/);
});

test('generate_video stops polling at the deadline and reports the job id', async () => {
  let clock = 0;
  const { mcp } = server({
    'POST /videos/generations': { id: 'vid3', status: 'queued' },
    'GET /videos/generations/vid3': () => { clock += 10_000; return json(200, { id: 'vid3', status: 'in_progress' }); },
  }, { now: () => clock });
  const result = await call(mcp, 'generate_video', { prompt: 'A fox', wait_seconds: 25 });
  assert.equal(result.structuredContent.status, 'in_progress');
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /vid3/);
});

test('get_job_status reports failures as tool errors', async () => {
  const { mcp } = server({ 'GET /videos/generations/vid%2F4': { id: 'vid/4', status: 'failed', error: { code: 'generation_failed', message: 'Blocked prompt' } } });
  const result = await call(mcp, 'get_job_status', { id: 'vid/4' });
  assert.match(result.content[0].text, /failed: Blocked prompt/);
});

test('generate_text builds messages from prompt and system', async () => {
  const { mcp, calls } = server({ 'POST /chat/completions': { choices: [{ message: { role: 'assistant', content: 'Hello hook' } }] } });
  const result = await call(mcp, 'generate_text', { prompt: 'Write a hook', system: 'Be brief', model: 'claude-sonnet-5', max_tokens: 50 });
  assert.deepEqual(calls[0].body, { model: 'claude-sonnet-5', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Write a hook' }], max_tokens: 50 });
  assert.equal(result.content[0].text, 'Hello hook');
});

test('API errors become tool errors with hints and no key', async () => {
  const { mcp } = server({ 'POST /chat/completions': () => json(402, { error: { code: 'insufficient_balance', message: `Not enough API balance for ${KEY}.`, required_cents: 1 } }) });
  const result = await call(mcp, 'generate_text', { prompt: 'hi' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'insufficient_balance');
  assert.equal(result.structuredContent.error.required_cents, 1);
  assert.match(result.content[0].text, /Add API funds/);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('missing or malformed keys fail before any network call', async () => {
  for (const apiKey of ['', 'sk-not-korpi']) {
    const mock = mockFetch({});
    const mcp = createMcpServer({ config: { apiKey, baseUrl: BASE, keySource: 'env' }, fetchImpl: mock.fetchImpl });
    const result = await call(mcp, 'generate_image', { prompt: 'x' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'missing_api_key');
    assert.equal(mock.calls.length, 0);
    assert.ok(!result.content[0].text.includes('sk-not-korpi'));
  }
});

test('network errors and timeouts are redacted and warn against resubmitting', async () => {
  const mcp = createMcpServer({
    config: { apiKey: KEY, baseUrl: BASE, keySource: 'env' },
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
  });
  const result = await call(mcp, 'generate_video', { prompt: 'x' });
  assert.equal(result.structuredContent.error.code, 'timeout');
  assert.match(result.content[0].text, /check before retrying/);
  const leaky = createMcpServer({
    config: { apiKey: KEY, baseUrl: BASE, keySource: 'env' },
    fetchImpl: async () => { throw new Error(`connect failed with ${KEY}`); },
  });
  const leak = await call(leaky, 'generate_image', { prompt: 'x' });
  assert.ok(!JSON.stringify(leak).includes(KEY));
});

test('invalid tool input is rejected locally', async () => {
  const { mcp, calls } = server({});
  const result = await call(mcp, 'generate_image', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /prompt is required/);
  assert.equal(calls.length, 0);
  const unknown = await call(mcp, 'delete_everything', {});
  assert.equal(unknown.isError, true);
});

test('config: env wins over file, file works alone, non-https base is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'korpi-mcp-'));
  const file = path.join(dir, 'api.json');
  fs.writeFileSync(file, JSON.stringify({ apiKey: KEY }));
  assert.equal(loadConfig({ KORPI_MCP_CONFIG: file }).apiKey, KEY);
  assert.equal(loadConfig({ KORPI_MCP_CONFIG: file }).keySource, 'config');
  assert.equal(loadConfig({ KORPI_MCP_CONFIG: file, KORPI_API_KEY: 'korpi_api_other' }).apiKey, 'korpi_api_other');
  assert.equal(loadConfig({ KORPI_MCP_CONFIG: file }).baseUrl, 'https://backend.korpi.ai/v1');
  assert.equal(loadConfig({ KORPI_MCP_CONFIG: file, KORPI_API_BASE_URL: 'http://localhost:9/v1/' }).baseUrl, 'http://localhost:9/v1');
  assert.throws(() => loadConfig({ KORPI_MCP_CONFIG: file, KORPI_API_BASE_URL: 'http://evil.test/v1' }), /https/);
  assert.equal(redact(`a ${KEY} b korpi_api_zzz`), 'a korpi_api_[redacted] b korpi_api_[redacted]');
});

test('stdio transport frames newline-delimited JSON and never prints the key', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (c) => { out += c; });
  errorOutput.on('data', (c) => { err += c; });
  const mock = mockFetch({ 'GET /models': MODELS });
  runStdio({ input, output, errorOutput, config: { apiKey: KEY, baseUrl: BASE, keySource: 'env' }, fetchImpl: mock.fetchImpl });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  input.write('not json\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_models","arguments":{}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lines = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'korpi-api');
  assert.equal(lines.find((l) => l.error?.code === -32700).id, null);
  assert.equal(lines.find((l) => l.id === 2).result.structuredContent.models.length, 3);
  assert.match(err, /key from env/);
  assert.ok(!out.includes(KEY) && !err.includes(KEY));
});
