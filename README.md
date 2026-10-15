# Korpi API MCP server

Local stdio MCP server for the Korpi API: every top AI video, image and text model behind one API, one key and one bill. It gives Claude, Cursor and other MCP clients five tools:

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_models` | Model ids, options and prices | Free |
| `generate_video` | Starts a video job, optionally waits for it | Per second |
| `generate_image` | Generates an image and returns its URL | Per image |
| `generate_text` | Chat completion with any text model | Per request |
| `get_job_status` | Checks a video job | Free |

Paid tools charge the prepaid API balance. Prices come from `list_models`.

## Key

Create a `korpi_api_` key at https://korpi.ai/developers?section=keys and pass it as `KORPI_API_KEY`, or save it in `~/.korpi/api.json`:

```json
{ "apiKey": "korpi_api_..." }
```

The server never logs or prints the key, sends it only to the Korpi API over HTTPS, and redacts anything shaped like a key from tool output and errors.

| Variable | Default |
| --- | --- |
| `KORPI_API_KEY` | none |
| `KORPI_API_BASE_URL` | `https://backend.korpi.ai/v1` (must be https) |
| `KORPI_MCP_CONFIG` | `~/.korpi/api.json` |

## Install

Claude Code:

```bash
claude mcp add korpi -e KORPI_API_KEY=korpi_api_... -- npx @korpiai/api-mcp
```

Other clients (`.cursor/mcp.json`, `claude_desktop_config.json`, Windsurf, VS Code):

```json
{
  "mcpServers": {
    "korpi": {
      "command": "npx",
      "args": ["@korpiai/api-mcp"],
      "env": { "KORPI_API_KEY": "korpi_api_..." }
    }
  }
}
```

From a checkout: `node bin/korpi-api-mcp.mjs`.

## Develop

```bash
npm test            # unit tests, mocked API
npm run smoke       # spawns the bin over stdio against a local mock API
npx -y @modelcontextprotocol/inspector --cli node bin/korpi-api-mcp.mjs --method tools/list
```

Release: bump `version` in `package.json`, `server.json`, the bin, `src/server.mjs` and `src/client.mjs` together, then `npm publish` (`prepublishOnly` runs the tests and the stdio smoke) and `mcp-publisher publish` to update the MCP registry entry `io.github.Reksely/korpi-api-mcp`.

## License

MIT, see [LICENSE](LICENSE).
