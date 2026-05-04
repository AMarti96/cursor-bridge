# cursor-bridge

An OpenAI-compatible HTTP server that wraps [Cursor's local SDK](https://www.npmjs.com/package/@cursor/sdk), letting you use your Cursor Pro subscription as an LLM backend from any tool that speaks the OpenAI Chat Completions API.

## Why

Cursor Pro gives you access to powerful models (Claude, GPT-4o, etc.) with generous limits. This bridge exposes those models as a local OpenAI-compatible endpoint, so you can use them from CLIs, scripts, agents, or any tool that supports custom OpenAI-compatible providers — without paying per-token OpenAI/Anthropic bills.

**Key features:**
- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints
- Named workspaces: each workspace pins a working directory so Cursor's tools (file editing, terminal, repo search) operate in the right project
- MCP server auto-loading from `.cursor/mcp.json` (user-level and per-project)
- Session persistence: agents are resumed across restarts
- Streaming (SSE) + non-streaming modes
- Clean abort on client disconnect and 5-minute request timeout

## Requirements

- [Cursor Pro](https://cursor.com) subscription
- Node.js 18+
- A Cursor API key (Settings → Account → API Keys)

## Setup

```bash
# 1. Clone and install
git clone https://github.com/youruser/cursor-bridge
cd cursor-bridge
npm install

# 2. Configure
cp .env.example .env
# Edit .env: fill in CURSOR_API_KEY and CURSOR_CWD

# 3. (Optional) configure named workspaces
cp workspaces.example.json workspaces.json
# Edit workspaces.json: map short names to absolute paths

# 4. Start
./start.sh
# or: npm start
```

## Endpoints

### `POST /v1/chat/completions`

Standard OpenAI chat completions. Supports streaming (`"stream": true`).

The working directory defaults to `CURSOR_CWD`. Override per-request with the `X-Cursor-Cwd` header:

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-string" \
  -H "X-Cursor-Cwd: /path/to/project" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

### `GET /v1/models`

Lists available Cursor models.

### `POST /:workspace/v1/chat/completions`
### `GET  /:workspace/v1/models`

Per-workspace routes. The workspace name comes from `workspaces.json`. The working directory is baked in — no header needed. Useful when you have multiple projects and want each to have its own Cursor context.

```bash
# Using a named workspace (cwd is /path/to/myproject)
curl http://localhost:8765/myproject/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-string" \
  -d '{"model":"auto","messages":[{"role":"user","content":"What files are here?"}]}'
```

### `GET /health`

Returns `{"status":"ok"}`.

## Session management

Sessions are keyed by `X-Session-Id` header (if present) or a hash of the system prompt + cwd. Agents are cached in memory (20-minute TTL) and persisted to `state.json` for resume across restarts.

## MCP servers

The bridge loads MCP servers from:
1. `~/.cursor/mcp.json` (user-level)
2. `<cwd>/.cursor/mcp.json` (project-level, wins on conflict)

These are passed directly to `Agent.create()`. Commands are resolved to absolute paths using `BRIDGE_CMD_*` env vars (see `.env.example`) — important when running as a system service where `PATH` is stripped.

> **Note:** MCP servers that rely on Cursor's OAuth (IDE-managed tokens) will not work via the bridge. Only servers with credentials in `mcp.json` (plain text or env vars) are supported.

## Running as a system service (macOS launchd)

A template plist is provided in `launchd/com.cursor-bridge.plist.example`. Copy and edit it:

```bash
cp launchd/com.cursor-bridge.plist.example ~/Library/LaunchAgents/com.cursor-bridge.plist
# Edit: replace YOUR_NODE_PATH, YOUR_BRIDGE_DIR, YOUR_API_KEY, YOUR_CWD
launchctl load ~/Library/LaunchAgents/com.cursor-bridge.plist
```

To restart:
```bash
launchctl kickstart -k gui/$(id -u)/com.cursor-bridge
```

## Configuration reference

| Env var | Required | Default | Description |
|---|---|---|---|
| `CURSOR_API_KEY` | ✅ | — | Cursor API key |
| `CURSOR_CWD` | — | `process.cwd()` | Default working directory |
| `PORT` | — | `8765` | Listen port |
| `BRIDGE_CMD_<name>` | — | — | Resolve `<name>` to absolute path (e.g. `BRIDGE_CMD_uvx=/home/user/.local/bin/uvx`) |

## Notes

- **Local mode only.** This bridge uses `@cursor/sdk` in local mode (`local: { cwd }`). The Cursor REST API does not expose `local.cwd`, so a Python/REST equivalent is not possible.
- **Cursor Pro required.** The SDK authenticates via your Cursor API key and bills against your Pro subscription.
- **Vision.** The Cursor SDK may not support image inputs. Describe images in text before passing them.
- **TypeScript lint noise.** `@cursor/sdk` has some unresolved internal type imports. These are SDK packaging issues — `tsx` ignores them at runtime. The bridge works correctly.

## License

MIT
