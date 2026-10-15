import { keyProblem, redact } from './config.mjs';

export class KorpiApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'KorpiApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const HINTS = {
  401: 'Check KORPI_API_KEY. Create a key at https://korpi.ai/developers?section=keys.',
  402: 'Add API funds at https://korpi.ai/developers?section=billing, then try again.',
  429: 'The API is at capacity. Wait a moment, then try again.',
};

export function createKorpiClient({ apiKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 240_000 }) {
  async function request(method, path, { body, auth = true } = {}) {
    if (auth) {
      const problem = keyProblem(apiKey);
      if (problem) throw new KorpiApiError(401, 'missing_api_key', problem);
    }
    const headers = { Accept: 'application/json', 'User-Agent': 'korpi-api-mcp/0.1.0' };
    if (auth) headers.Authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new KorpiApiError(0, timedOut ? 'timeout' : 'network_error', redact(
        timedOut
          ? `The request timed out. ${method === 'POST' ? 'It may still have started work; check before retrying.' : ''}`.trim()
          : `Could not reach the Korpi API: ${err?.message || err}`,
        apiKey,
      ));
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = payload?.error || {};
      const { code, message, ...details } = error;
      const hint = HINTS[response.status];
      const base = message || `Request failed with HTTP ${response.status}.`;
      throw new KorpiApiError(
        response.status,
        code || `http_${response.status}`,
        redact(hint ? `${base} ${hint}` : base, apiKey),
        JSON.parse(redact(JSON.stringify(details), apiKey)),
      );
    }
    if (payload === null) throw new KorpiApiError(response.status, 'invalid_response', 'The API returned an empty or non-JSON response.');
    return payload;
  }

  return {
    listModels: () => request('GET', '/models', { auth: false }),
    getAccount: () => request('GET', '/account'),
    generateImage: (body) => request('POST', '/images/generations', { body }),
    startVideo: (body) => request('POST', '/videos/generations', { body }),
    getVideo: (id) => request('GET', `/videos/generations/${encodeURIComponent(id)}`),
    chat: (body) => request('POST', '/chat/completions', { body }),
  };
}
