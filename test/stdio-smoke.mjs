// Spawns the real bin over stdio against a local mock Korpi API and calls every tool.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = `korpi_api_${'Smoke1234'.repeat(4)}abcdefg`;
const seen = [];

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ route: `${req.method} ${req.url}`, auth: req.headers.authorization === `Bearer ${KEY}` });
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'grok-imagine', type: 'video', name: 'Grok Imagine' }, { id: 'nano-banana', type: 'image', name: 'Nano Banana' }, { id: 'auto', type: 'text', name: 'Auto' }] });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: 'invalid_api_key', message: 'Invalid or revoked API key.' } });
    if (req.url === '/v1/images/generations') return send(200, { id: 'img_1', data: [{ url: 'https://example.com/i.png' }] });
    if (req.url === '/v1/videos/generations') return send(202, { id: 'vid_1', status: 'queued' });
    if (req.url === '/v1/videos/generations/vid_1') return send(200, { id: 'vid_1', status: 'completed', url: 'https://example.com/v.mp4' });
    if (req.url === '/v1/chat/completions') return send(200, { choices: [{ message: { role: 'assistant', content: 'A fox outruns winter.' } }] });
    return send(404, { error: { code: 'not_found', message: 'Unknown endpoint.' } });
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}/v1`;

const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'korpi-api-mcp.mjs')], {
  env: { PATH: process.env.PATH, HOME: here, KORPI_API_KEY: KEY, KORPI_API_BASE_URL: base },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let pending = '';
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg);
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk; });

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

const report = [];
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
report.push(`initialize -> ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
const tools = await rpc('tools/list', {});
report.push(`tools/list -> ${tools.result.tools.map((t) => t.name).join(', ')}`);
const calls = [
  ['list_models', {}],
  ['generate_image', { prompt: 'A ceramic mug on a desk' }],
  ['generate_video', { prompt: 'A fox running through snow', wait_seconds: 10 }],
  ['get_job_status', { id: 'vid_1' }],
  ['generate_text', { prompt: 'Write a hook' }],
];
let failed = false;
for (const [name, args] of calls) {
  const res = await rpc('tools/call', { name, arguments: args });
  const ok = res.result && !res.result.isError;
  failed ||= !ok;
  report.push(`tools/call ${name} -> ${ok ? 'ok' : 'ERROR'}: ${res.result?.content?.[0]?.text?.split('\n')[0]}`);
}
child.kill();
api.close();
const leaked = stdout.includes(KEY) || stderr.includes(KEY);
const authed = seen.filter((s) => s.route !== 'GET /v1/models').every((s) => s.auth);
report.push(`stderr -> ${stderr.trim()}`);
report.push(`key printed to stdout/stderr: ${leaked ? 'YES' : 'no'}; authenticated API calls: ${authed ? 'all' : 'MISSING'}`);
console.log(report.join('\n'));
if (failed || leaked || !authed || tools.result.tools.length !== 5) process.exit(1);
