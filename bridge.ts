import 'dotenv/config';
import express, { Request, Response } from 'express';
import { Agent, Cursor } from '@cursor/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.CURSOR_API_KEY!;
const CWD = process.env.CURSOR_CWD || process.cwd();
const PORT = parseInt(process.env.PORT || '8765', 10);
const STATE_FILE = path.join(__dirname, 'state.json');
const WORKSPACES_FILE = path.join(__dirname, 'workspaces.json');
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

if (!API_KEY) {
  console.error('CURSOR_API_KEY is not set');
  process.exit(1);
}

// ── Workspace config ───────────────────────────────────────────────────────────
// workspaces.json (gitignored) maps short names to absolute paths:
// { "workspaces": { "myproject": "/path/to/project" } }

function loadWorkspaces(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    return parsed.workspaces ?? {};
  } catch {
    return {};
  }
}

const WORKSPACES: Record<string, string> = loadWorkspaces();

// ── State persistence ──────────────────────────────────────────────────────────

interface SessionRecord {
  agentId: string;
  systemPrompt: string;
  cwd?: string;
}

function loadState(): Record<string, SessionRecord> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, SessionRecord>) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

type SDKAgent = Awaited<ReturnType<typeof Agent.create>>;

// In-memory cache: sessionKey → { agent, lastUsed }
const agentCache = new Map<string, { agent: SDKAgent; lastUsed: number }>();
const persistedState = loadState();

const AGENT_TTL_MS = 20 * 60 * 1000; // 20 minutes

function evictStaleAgents() {
  const now = Date.now();
  for (const [k, entry] of agentCache.entries()) {
    if (now - entry.lastUsed > AGENT_TTL_MS) {
      console.log(`[session:${k}] Evicting stale agent from cache (idle > 20min)`);
      agentCache.delete(k);
    }
  }
}

function touchAgent(key: string) {
  const entry = agentCache.get(key);
  if (entry) entry.lastUsed = Date.now();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function hashStr(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function genId(): string {
  return `chatcmpl-${crypto.randomBytes(6).toString('hex')}`;
}

function sessionKey(req: Request, systemPrompt: string, cwd: string): string {
  const header = req.headers['x-session-id'];
  if (header && typeof header === 'string' && header.trim()) return header.trim();
  return hashStr(systemPrompt + '|' + cwd);
}

function extractMessages(body: any): { systemPrompt: string; lastUserMessage: string } {
  const messages: Array<{ role: string; content: string }> = body.messages ?? [];
  const systemPrompt = messages.find(m => m.role === 'system')?.content ?? '';
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserMessage = lastUser?.content ?? '';
  return { systemPrompt, lastUserMessage };
}

// ── MCP server loading ─────────────────────────────────────────────────────────
// Reads ~/.cursor/mcp.json (user-level) and <cwd>/.cursor/mcp.json (project-level).
// Project-level wins on conflict. Commands are resolved to absolute paths using
// CMD_OVERRIDES (env vars) to work around stripped PATH in non-interactive shells.

function buildCmdAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^BRIDGE_CMD_(.+)$/);
    if (m && v) aliases[m[1].toLowerCase()] = v;
  }
  return aliases;
}

const CMD_ALIASES = buildCmdAliases();

function resolveCmd(cmd: string): string {
  return CMD_ALIASES[cmd] ?? cmd;
}

function expandEnvValue(val: string): string {
  const home = process.env.HOME || '';
  return val.replace(/^~(?=\/|$)/, home).replace(/\$HOME(?=\/|$)/g, home);
}

function normalizeMcpServer(server: any): any {
  const result = { ...server };
  if (result.command) result.command = resolveCmd(result.command);
  if (result.env && typeof result.env === 'object') {
    const expanded: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.env)) {
      expanded[k] = typeof v === 'string' ? expandEnvValue(v) : (v as string);
    }
    result.env = expanded;
  }
  return result;
}

function readMcpServers(cwd: string): Record<string, any> | undefined {
  const home = process.env.HOME || '';
  const userMcpPath = path.join(home, '.cursor', 'mcp.json');
  const projectMcpPath = path.join(cwd, '.cursor', 'mcp.json');

  let userServers: Record<string, any> = {};
  let projectServers: Record<string, any> = {};

  try {
    const parsed = JSON.parse(fs.readFileSync(userMcpPath, 'utf8'));
    userServers = parsed.mcpServers ?? {};
    console.log(`[mcp] Loaded ${Object.keys(userServers).length} user-level MCP servers from ${userMcpPath}`);
  } catch {
    // not found or invalid — fine
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8'));
    projectServers = parsed.mcpServers ?? {};
    console.log(`[mcp] Loaded ${Object.keys(projectServers).length} project-level MCP servers from ${projectMcpPath}`);
  } catch {
    // not found or invalid — fine
  }

  const raw = { ...userServers, ...projectServers };
  if (Object.keys(raw).length === 0) return undefined;

  const merged: Record<string, any> = {};
  for (const [name, server] of Object.entries(raw)) {
    merged[name] = normalizeMcpServer(server);
  }

  console.log(`[mcp] Using MCP servers: ${Object.keys(merged).join(', ')}`);
  for (const [name, s] of Object.entries(merged)) {
    console.log(`[mcp]   ${name}: cmd=${s.command} args=${JSON.stringify(s.args ?? [])}`);
  }
  return merged;
}

// ── Agent management ───────────────────────────────────────────────────────────

async function getOrCreateAgent(
  key: string,
  systemPrompt: string,
  modelId: string,
  cwd: string
): Promise<SDKAgent> {
  evictStaleAgents();

  if (agentCache.has(key)) {
    return agentCache.get(key)!.agent;
  }

  const record = persistedState[key];
  if (record) {
    try {
      console.log(`[session:${key}] Resuming agent ${record.agentId}`);
      const resumeCwd = record.cwd ?? CWD;
      const resumeMcpServers = readMcpServers(resumeCwd);
      const agent = await Agent.resume(record.agentId, {
        apiKey: API_KEY,
        ...(resumeMcpServers ? { mcpServers: resumeMcpServers } : {}),
      });
      agentCache.set(key, { agent, lastUsed: Date.now() });
      return agent;
    } catch (err) {
      console.warn(`[session:${key}] Resume failed, creating new agent:`, (err as Error).message);
      delete persistedState[key];
    }
  }

  console.log(`[session:${key}] Creating new agent (model=${modelId})`);
  const mcpServers = readMcpServers(cwd);
  const createOpts: Parameters<typeof Agent.create>[0] = {
    apiKey: API_KEY,
    model: { id: modelId || 'default' },
    local: { cwd, settingSources: ['project', 'user'] },
    ...(mcpServers ? { mcpServers } : {}),
    ...(systemPrompt ? { system_prompt: systemPrompt } as any : {}),
  };
  const agent = await Agent.create(createOpts);
  console.log(`[session:${key}] Created agent ${agent.agentId}`);

  persistedState[key] = { agentId: agent.agentId, systemPrompt, cwd };
  saveState(persistedState);

  agentCache.set(key, { agent, lastUsed: Date.now() });
  return agent;
}

// ── Event logging helper ───────────────────────────────────────────────────────

function logStreamEvent(event: any, prefix: string) {
  const type = event.type ?? '(no type)';
  if (type === 'assistant') {
    const blocks = event.message?.content ?? [];
    const summary = blocks.map((b: any) => {
      if (b.type === 'text') return `text(${JSON.stringify(b.text?.slice(0, 80))})`;
      return b.type;
    }).join(', ');
    console.log(`[stream:${prefix}] event=assistant blocks=[${summary}]`);
  } else if (type === 'tool_call') {
    console.log(`[stream:${prefix}] event=tool_call raw=${JSON.stringify(event).slice(0, 200)}`);
  } else if (type === 'status') {
    console.log(`[stream:${prefix}] event=status status=${event.status ?? '?'}`);
  } else if (type === 'thinking') {
    console.log(`[stream:${prefix}] event=thinking raw=${JSON.stringify(event).slice(0, 150)}`);
  } else if (type === 'user') {
    console.log(`[stream:${prefix}] event=user`);
  } else if (type === 'task') {
    console.log(`[stream:${prefix}] event=task`);
  } else {
    console.log(`[stream:${prefix}] event=${type} (raw=${JSON.stringify(event).slice(0, 120)})`);
  }
}

// Format a stream event as a human-readable progress line, or null if not worth surfacing.
function progressText(event: any): string | null {
  const type = event.type ?? '';

  if (type === 'tool_call') {
    const hasResult = event.result !== undefined || event.output !== undefined;
    if (hasResult) return null;

    const toolName: string = event.toolName ?? event.tool_name ?? event.name ?? '';
    const args = event.args ?? event.input ?? {};
    if (toolName === 'read' || toolName === 'ReadFile') {
      const p = args.path ?? args.file_path ?? '';
      return p ? `📖 Reading \`${p}\`` : null;
    }
    if (toolName === 'edit' || toolName === 'EditFile' || toolName === 'write' || toolName === 'WriteFile') {
      const p = args.path ?? args.file_path ?? '';
      return p ? `✏️ Editing \`${p}\`` : null;
    }
    if (toolName === 'shell' || toolName === 'Shell' || toolName === 'run_terminal_cmd') {
      const cmd: string = (args.command ?? args.cmd ?? '').slice(0, 120);
      return cmd ? `🖥️ \`${cmd}\`` : null;
    }
    if (toolName === 'grep' || toolName === 'Grep') {
      const pattern = args.pattern ?? args.query ?? '';
      return pattern ? `🔍 Searching \`${pattern}\`` : null;
    }
    if (toolName === 'mcp' || toolName === 'Mcp') {
      const server = args.server_name ?? args.serverName ?? '';
      const tool = args.tool_name ?? args.toolName ?? '';
      return (server || tool) ? `🔌 MCP: ${server}/${tool}` : null;
    }
    return toolName ? `🔧 Tool: \`${toolName}\`` : null;
  }

  if (type === 'status') {
    const status: string = event.status ?? '';
    if (status === 'running') return `⚙️ Working…`;
    if (status === 'complete' || status === 'done') return `✅ Done`;
    if (status === 'error') return `❌ Error`;
    return null;
  }

  return null;
}

// ── Streaming helpers ──────────────────────────────────────────────────────────

async function drainStreamToText(run: any, prefix: string, signal?: AbortSignal): Promise<string> {
  let fullText = '';
  for await (const event of run.stream()) {
    if (signal?.aborted) {
      console.log(`[stream:${prefix}] Aborted, stopping drain`);
      break;
    }
    logStreamEvent(event, prefix);
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) fullText += block.text;
      }
    }
  }
  return fullText;
}

async function drainStreamToChunks(run: any, prefix: string, sendChunk: (text: string) => void, signal?: AbortSignal): Promise<number> {
  let chunkCount = 0;
  for await (const event of run.stream()) {
    if (signal?.aborted) {
      console.log(`[stream:${prefix}] Aborted, stopping drain`);
      break;
    }
    logStreamEvent(event, prefix);
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          sendChunk(block.text);
          chunkCount++;
        }
      }
    } else {
      const progress = progressText(event);
      if (progress) {
        sendChunk('\n' + progress + '\n');
      }
    }
  }
  return chunkCount;
}

// ── Shared chat completions handler ───────────────────────────────────────────

async function handleChatCompletions(req: Request, res: Response, cwd: string) {
  const body = req.body;
  console.log(`[chat] model=${body.model} cwd=${cwd} stream=${body.stream ?? false}`);

  const { systemPrompt, lastUserMessage } = extractMessages(body);
  const rawModel: string = body.model || 'default';
  const modelId: string = rawModel === 'auto' || rawModel === 'gpt-4o' ? 'default' : rawModel;
  const stream: boolean = body.stream ?? false;
  const key = sessionKey(req, systemPrompt, cwd);
  const completionId = genId();

  if (!lastUserMessage) {
    res.status(400).json({ error: 'No user message found' });
    return;
  }

  const controller = new AbortController();
  const { signal } = controller;

  res.on('close', () => {
    if (!signal.aborted && !res.writableEnded) {
      console.log(`[chat:${key}] Client disconnected before response — aborting run`);
      controller.abort();
    }
  });

  const timeoutHandle = setTimeout(() => {
    if (!signal.aborted) {
      console.warn(`[chat:${key}] Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — aborting`);
      controller.abort();
    }
  }, REQUEST_TIMEOUT_MS);

  let agent: SDKAgent;
  try {
    agent = await getOrCreateAgent(key, systemPrompt, modelId, cwd);
  } catch (err) {
    clearTimeout(timeoutHandle);
    console.error('Agent init error:', err);
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  // ── Streaming ──────────────────────────────────────────────────────────────
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendChunk = (content: string) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      }
    };

    const sendDone = () => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    const sendError = (msg: string) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    const doStreamWithForce = async (force: boolean, prefix: string): Promise<number> => {
      const opts: any = { model: { id: modelId } };
      if (force) opts.local = { force: true };
      if (signal) opts.signal = signal;
      const run = await agent.send(lastUserMessage, opts);
      return drainStreamToChunks(run, prefix, sendChunk, signal);
    };

    try {
      let chunkCount = await doStreamWithForce(false, `stream:${key}`);

      if (!signal.aborted && chunkCount === 0) {
        console.log(`[retry:${key}] Stream returned empty content, retrying with force...`);
        chunkCount = await doStreamWithForce(true, `stream-empty-retry:${key}`);
      }

      touchAgent(key);
      if (!signal.aborted) sendDone();
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) {
        console.log(`[chat:${key}] Stream aborted cleanly`);
      } else if (err?.isRetryable || /busy|409/i.test(err?.message ?? '')) {
        console.log(`[retry:${key}] Agent busy, retrying with force...`);
        try {
          const chunkCount = await doStreamWithForce(true, `stream-retry:${key}`);
          if (chunkCount === 0) console.warn(`[retry:${key}] Force retry also returned empty content`);
          touchAgent(key);
          if (!signal.aborted) sendDone();
        } catch (retryErr: any) {
          if (retryErr?.name !== 'AbortError') {
            console.error('Retry error:', retryErr);
            sendError((retryErr as Error).message);
          }
        }
      } else {
        console.error('Stream error:', err);
        sendError(err.message);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
    return;
  }

  // ── Non-streaming ──────────────────────────────────────────────────────────
  try {
    if (signal.aborted) { res.status(499).json({ error: 'Request cancelled' }); return; }

    const run = await agent.send(lastUserMessage, { model: { id: modelId }, signal } as any);
    let fullText = await drainStreamToText(run, `non-stream:${key}`, signal);

    if (!signal.aborted && !fullText) {
      console.warn(`[non-stream:${key}] Empty response, retrying with force...`);
      const retryRun = await agent.send(lastUserMessage, { model: { id: modelId }, local: { force: true } as any, signal } as any);
      fullText = await drainStreamToText(retryRun, `non-stream-retry:${key}`, signal);
      if (!fullText) console.warn(`[non-stream-retry:${key}] Force retry also returned empty content`);
    }

    if (signal.aborted) { res.status(499).json({ error: 'Request cancelled' }); return; }

    console.log(`[non-stream:${key}] Finished, length=${fullText.length}`);
    touchAgent(key);

    res.json({
      id: completionId,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || signal.aborted) {
      console.log(`[chat:${key}] Non-stream aborted cleanly`);
      if (!res.headersSent) res.status(499).json({ error: 'Request cancelled' });
    } else {
      console.error('Completion error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── POST /v1/chat/completions ──────────────────────────────────────────────────

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const cwd = (req.headers['x-cursor-cwd'] as string | undefined)?.trim() || CWD;
  await handleChatCompletions(req, res, cwd);
});

// ── Named workspace routes (loaded from workspaces.json) ──────────────────────
// Routes: /:workspace/v1/chat/completions and /:workspace/v1/models
// workspaces.json: { "workspaces": { "myproject": "/path/to/project" } }

for (const [name, workspaceCwd] of Object.entries(WORKSPACES)) {
  console.log(`[workspaces] Registering /${name}/v1/* → ${workspaceCwd}`);

  app.post(`/${name}/v1/chat/completions`, async (req: Request, res: Response) => {
    await handleChatCompletions(req, res, workspaceCwd);
  });

  app.get(`/${name}/v1/models`, async (_req: Request, res: Response) => {
    try {
      const models = await Cursor.models.list({ apiKey: API_KEY });
      res.json({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', owned_by: 'cursor', display_name: m.displayName })) });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
}

// ── GET /v1/models ─────────────────────────────────────────────────────────────

app.get('/v1/models', async (_req: Request, res: Response) => {
  try {
    const models = await Cursor.models.list({ apiKey: API_KEY });
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        owned_by: 'cursor',
        display_name: m.displayName,
      })),
    });
  } catch (err) {
    console.error('Models error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Process signal handling ────────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`[bridge] Received ${signal}, shutting down cleanly...`);
  agentCache.clear();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[bridge] Uncaught exception (bridge stays alive):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[bridge] Unhandled rejection (bridge stays alive):', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`cursor-bridge listening on http://localhost:${PORT}`);
  console.log(`  CWD=${CWD}`);
  console.log(`  Workspaces: ${Object.keys(WORKSPACES).join(', ') || '(none)'}`);
  console.log(`  API_KEY=${API_KEY.slice(0, 12)}...`);
});
