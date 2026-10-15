#!/usr/bin/env node
import { runStdio } from '../src/server.mjs';

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  process.stdout.write(`korpi-api-mcp: MCP server for the Korpi API (stdio)

Environment:
  KORPI_API_KEY        korpi_api_ key (or "apiKey" in ~/.korpi/api.json)
  KORPI_API_BASE_URL   Override the API base (default https://backend.korpi.ai/v1)
  KORPI_MCP_CONFIG     Override the config file path
`);
  process.exit(0);
}
if (arg === '--version') {
  process.stdout.write('0.1.0\n');
  process.exit(0);
}

try {
  runStdio();
} catch (err) {
  process.stderr.write(`korpi-api-mcp: ${err?.message || err}\n`);
  process.exit(1);
}
