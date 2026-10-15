import { KorpiApiError } from './client.mjs';

const VIDEO_TERMINAL = new Set(['completed', 'failed']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TOOLS = [
  {
    name: 'list_models',
    title: 'List Korpi models',
    description: 'List the Korpi API models with their ids, type (video, image or text), options and current per-use price in USD. Free; no key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['video', 'image', 'text'], description: 'Only return models of this type.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'generate_video',
    title: 'Generate a video',
    description: 'Start a paid video generation (charged per second from the API balance; see list_models). Returns a job id. Poll get_job_status until status is completed or failed. Do not resubmit after a timeout: the first job may already be running.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'What happens in the video.' },
        model: { type: 'string', default: 'grok-imagine', description: 'Video model id from list_models.' },
        duration: { type: 'integer', enum: [6, 8, 10], default: 6, description: 'Length in seconds.' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
        image_url: { type: 'string', description: 'Optional https URL of a start image.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, default: 0, description: 'Wait up to this many seconds for the video to finish before returning.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'generate_image',
    title: 'Generate an image',
    description: 'Generate a paid image (charged per image from the API balance; see list_models). Returns the image URL when done.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'What the image shows.' },
        model: { type: 'string', default: 'nano-banana', description: 'Image model id from list_models.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '9:16', '16:9', '4:3', '3:4'], default: '1:1' },
        image_urls: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Optional https reference images.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'generate_text',
    title: 'Generate text',
    description: 'Run a paid chat completion (charged per request from the API balance; see list_models). Pass a prompt, or a full messages array.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User message. Ignored when messages is set.' },
        system: { type: 'string', description: 'Optional system message used with prompt.' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
        model: { type: 'string', default: 'auto', description: 'Text model id from list_models.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: 4096, default: 1024 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_job_status',
    title: 'Check a video job',
    description: 'Check a video job started with generate_video. Returns status (queued, in_progress, completed or failed) and the video URL once completed. Free.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'Job id returned by generate_video.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function requireString(args, field) {
  const value = args?.[field];
  if (typeof value !== 'string' || !value.trim()) throw new KorpiApiError(400, 'invalid_request', `${field} is required.`);
  return value.trim();
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
}

function summarizeVideo(job) {
  if (job.status === 'completed') return `Video ${job.id} is ready: ${job.url}`;
  if (job.status === 'failed') return `Video ${job.id} failed: ${job.error?.message || 'unknown error'}`;
  return `Video ${job.id} is ${job.status}. Call get_job_status with id "${job.id}" to check again.`;
}

async function waitForVideo(client, job, waitSeconds, { pollMs, now }) {
  const deadline = now() + waitSeconds * 1000;
  let current = job;
  while (!VIDEO_TERMINAL.has(current.status) && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    current = await client.getVideo(current.id);
  }
  return current;
}

export function createToolHandlers(client, { pollMs = 5000, now = Date.now } = {}) {
  return {
    async list_models(args = {}) {
      const result = await client.listModels();
      const models = Array.isArray(result?.data) ? result.data : [];
      const filtered = args.type ? models.filter((model) => model.type === args.type) : models;
      const lines = filtered.map((model) => `${model.id} (${model.type}) ${model.name || ''}`.trim());
      return { text: lines.length ? lines.join('\n') : 'No models found.', data: { models: filtered } };
    },

    async generate_video(args = {}) {
      const body = { prompt: requireString(args, 'prompt'), model: args.model || 'grok-imagine', ...pick(args, ['duration', 'aspect_ratio', 'image_url']) };
      let job = await client.startVideo(body);
      const waitSeconds = Math.max(0, Math.min(600, Number(args.wait_seconds) || 0));
      if (waitSeconds > 0) job = await waitForVideo(client, job, waitSeconds, { pollMs, now });
      return { text: summarizeVideo(job), data: job, isError: job.status === 'failed' };
    },

    async generate_image(args = {}) {
      const body = { prompt: requireString(args, 'prompt'), model: args.model || 'nano-banana', ...pick(args, ['aspect_ratio', 'image_urls']) };
      const result = await client.generateImage(body);
      const urls = (result?.data || []).map((item) => item.url).filter(Boolean);
      return { text: urls.length ? `Image ready: ${urls.join(' ')}` : 'The image finished without a URL.', data: result };
    },

    async generate_text(args = {}) {
      let messages = args.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        const prompt = requireString(args, 'prompt');
        messages = [...(args.system ? [{ role: 'system', content: String(args.system) }] : []), { role: 'user', content: prompt }];
      }
      const body = { model: args.model || 'auto', messages, max_tokens: args.max_tokens ?? 1024 };
      const result = await client.chat(body);
      const content = result?.choices?.[0]?.message?.content ?? '';
      return { text: content || '(empty response)', data: result };
    },

    async get_job_status(args = {}) {
      const job = await client.getVideo(requireString(args, 'id'));
      return { text: summarizeVideo(job), data: job };
    },
  };
}
