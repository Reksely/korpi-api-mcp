import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://backend.korpi.ai/v1';
export const API_KEY_PATTERN = /^korpi_api_[A-Za-z0-9_-]{43}$/;
const KEY_IN_TEXT = /korpi_api_[A-Za-z0-9_-]+/g;

export function defaultConfigPath(env = process.env) {
  if (env.KORPI_MCP_CONFIG) return env.KORPI_MCP_CONFIG;
  return path.join(env.HOME || os.homedir(), '.korpi', 'api.json');
}

function readConfigFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('KORPI_API_BASE_URL is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('KORPI_API_BASE_URL must use https.');
  }
  return value;
}

/** Resolves the key and base URL. Env wins over the config file. Never logs the key. */
export function loadConfig(env = process.env) {
  const file = defaultConfigPath(env);
  const fileConfig = readConfigFile(file);
  const apiKey = String(env.KORPI_API_KEY || fileConfig.apiKey || fileConfig.api_key || '').trim();
  const baseUrl = normalizeBaseUrl(env.KORPI_API_BASE_URL || fileConfig.baseUrl || fileConfig.base_url);
  return { apiKey, baseUrl, configFile: file, keySource: env.KORPI_API_KEY ? 'env' : apiKey ? 'config' : 'none' };
}

export function keyProblem(apiKey) {
  if (!apiKey) return 'No API key. Set KORPI_API_KEY to a korpi_api_ key from https://korpi.ai/developers?section=keys.';
  if (!API_KEY_PATTERN.test(apiKey)) return 'KORPI_API_KEY is not a valid korpi_api_ key.';
  return null;
}

/** Removes anything shaped like a Korpi API key from text that leaves the process. */
export function redact(text, apiKey = '') {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('korpi_api_[redacted]');
  return out.replace(KEY_IN_TEXT, 'korpi_api_[redacted]');
}
