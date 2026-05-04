# After 4 Days of Usage

Honest notes from running cursor-bridge in production as a backend for an AI agent harness. If you're thinking about using this for something similar, read this first.

---

## The SDK is not a chat interface

The `@cursor/sdk` is designed for **delegation, not conversation**. The mental model it expects is:

> Write a thorough prompt → hand it off → come back when it's done.

It is not designed for back-and-forth exchanges. If you try to use it as a drop-in replacement for a conversational LLM API (the way you'd use the OpenAI or Anthropic APIs), you will have a bad time. The SDK shines when you give it a well-crafted, self-contained task and leave it alone for an hour or two.

---

## There is no real streaming

This is the most surprising limitation. The bridge emits SSE chunks and the code correctly listens for tool call events, status events, and assistant text blocks — but **Cursor buffers everything internally** and only flushes the full response when the task is complete.

In practice:
- While Cursor is working, you are blind. No progress, no partial output.
- When it finishes, you get thousands of characters dumped in one shot.
- All the progress lines the bridge emits (📖 Reading, ✏️ Editing, 🖥️ cmd…) arrive at the end as a wall of text, not in real time.

This makes the bridge unsuitable for interactive use in a chat UI. It works fine for automated pipelines where the consumer just waits for the final result.

---

## Instability and timeouts

The SDK was very recently released and it shows. During these four days we hit:
- Requests that simply never responded
- Timeouts with no clear cause
- Empty responses (`content: ""`) requiring a `force: true` retry

The bridge already handles all of these cases (retry logic, 5-minute timeout, abort on disconnect), but you should expect reliability to be lower than a stable API. This is likely to improve as the SDK matures.

---

## Tools and MCPs are tied to a single directory

Cursor agents operate on **one working directory**. The SDK's `local: { cwd }` option sets that directory at agent creation time and it does not change.

Consequences:
- MCPs must be declared in `.cursor/mcp.json` inside that directory (or user-level `~/.cursor/mcp.json`) and passed explicitly to `Agent.create()`. They are not auto-discovered at runtime.
- If you need to work across **multiple repositories**, you have two options:
  1. Use a **parent directory** that contains all repos as subdirectories, and configure the agent's `cwd` to that parent.
  2. Create separate named workspaces (one per repo), but then each workspace has its own isolated agent state — they don't share context.
- For multi-repo setups, a well-defined `agent.md` (or equivalent context file) at the root of the working directory becomes essential. Cursor has no other way to understand your project hierarchy.

---

## External harness features are invisible to the bridge

If you're running cursor-bridge as the model backend for a more capable harness (like [Hermes](https://github.com/hermesagent/hermes) or similar tools), be aware:

- **Memory systems** (persistent facts injected into the system prompt) are not understood by the Cursor agent — the bridge passes the system prompt as text, but Cursor treats it as background context, not structured memory it can update.
- **SOUL files, agent identity, and persona** — ignored. Cursor sees only the task.
- **Skills and procedural knowledge** injected by the harness — Cursor has no awareness of them beyond what ends up as text in the prompt.
- **Session continuity** is maintained via the Cursor `agentId` stored in `state.json`. If that ID is lost or expires, the agent starts fresh with no memory of prior interactions.

The bridge is effectively a **task dispatcher**: send a task, get a result. Any agent identity or statefulness you want has to be encoded entirely in the prompt you send.

---

## What it is actually good for

Despite the above, the bridge is genuinely useful for a specific use case:

**Sending well-defined, self-contained coding tasks to Cursor programmatically, from outside the IDE.**

If you have:
- A clear task with all the context baked into the prompt
- A single working directory with the relevant code
- No need for real-time feedback
- Patience for occasional retries

...then the bridge works well. Cursor's underlying models are high quality, its file editing and terminal tools are solid, and the per-project MCP setup (Jira, GitHub, etc.) integrates cleanly once configured.

Think of it as a **background worker for coding tasks**, not an interactive assistant.

---

## Summary

| Expectation | Reality |
|---|---|
| Streaming progress in real time | Buffered — everything arrives at the end |
| Conversational back-and-forth | Not supported — fire-and-forget only |
| Multi-repo workspace | Requires parent dir + careful agent.md setup |
| Harness features (memory, persona) | Ignored — only the raw prompt reaches Cursor |
| API stability | Rough — SDK is new, expect timeouts and empty responses |
| Coding task delegation (async) | ✅ Works well |
