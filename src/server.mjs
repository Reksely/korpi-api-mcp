import { createKorpiClient, KorpiApiError } from './client.mjs';
import { keyProblem, loadConfig, redact } from './config.mjs';
import { createToolHandlers, TOOLS } from './tools.mjs';

export const SERVER_INFO = { name: 'korpi-api', title: 'Korpi API', version: '0.1.0' };
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = 'Korpi puts top AI video, image and text models behind one API, one key and one bill. Call list_models first for ids, options and prices. generate_video returns a job id: poll get_job_status until completed or failed, and never resubmit a paid request after a timeout without checking.';

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createMcpServer({ env = process.env, fetchImpl = globalThis.fetch, config, pollMs, now } = {}) {
  const settings = config || loadConfig(env);
  const client = createKorpiClient({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, fetchImpl });
  const handlers = createToolHandlers(client, { pollMs, now });

  async function callTool(name, args) {
    const handler = handlers[name];
    if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    try {
      const result = await handler(args && typeof args === 'object' ? args : {});
      const structured = JSON.parse(redact(JSON.stringify(result.data ?? {}), settings.apiKey));
      return {
        content: [
          { type: 'text', text: redact(result.text, settings.apiKey) },
          { type: 'text', text: JSON.stringify(structured, null, 2) },
        ],
        structuredContent: structured,
        isError: Boolean(result.isError),
      };
    } catch (err) {
      const known = err instanceof KorpiApiError;
      const error = {
        code: known ? err.code : 'internal_error',
        status: known ? err.status : undefined,
        message: redact(known ? err.message : `Unexpected error: ${err?.message || err}`, settings.apiKey),
        ...(known ? err.details : {}),
      };
      return {
        content: [{ type: 'text', text: `Error (${error.code}): ${error.message}` }],
        structuredContent: { error },
        isError: true,
      };
    }
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return rpcError(message?.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (isNotification) return null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        const warning = keyProblem(settings.apiKey);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: warning ? `${INSTRUCTIONS} Setup: ${warning}` : INSTRUCTIONS,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required.');
        return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments) };
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle, callTool, settings };
}

/** Newline-delimited JSON-RPC over stdio, per the MCP stdio transport. Logs go to stderr only. */
export function runStdio({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, ...options } = {}) {
  const server = createMcpServer(options);
  const write = (payload) => { if (payload) output.write(`${JSON.stringify(payload)}\n`); };
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, 'Parse error'));
        continue;
      }
      const batch = Array.isArray(message) ? message : [message];
      for (const item of batch) {
        server.handle(item).then(write).catch((err) => {
          errorOutput.write(`korpi-api-mcp: ${redact(err?.message || err, server.settings.apiKey)}\n`);
          write(rpcError(item?.id, -32603, 'Internal error'));
        });
      }
    }
  });
  const source = server.settings.keySource === 'none' ? 'no key' : `key from ${server.settings.keySource}`;
  errorOutput.write(`korpi-api-mcp ${SERVER_INFO.version} ready (${source}, ${server.settings.baseUrl})\n`);
  return server;
}
