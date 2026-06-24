---
name: claude-code-delegate
description: Delegate planning, diagnosis, or implementation work from Codex to Claude Code through the local Claude companion MCP tools. Use when Codex should ask Claude Code for a second pass, plan-first implementation handoff, repository diagnosis, or follow-up work.
---

# Claude Code Delegate

Use this skill when Codex should call Claude Code instead of completing the work directly.

## Runtime

Use the MCP tools exposed by `claude-code-delegate`:

- `claude_task` starts a Claude Code task
- `claude_status` checks active and recent Claude jobs
- `claude_result` reads stored final output
- `claude_cancel` cancels a background Claude job

Do not hand-roll direct `claude` shell commands while these tools are available.

## Delegation Rules

- Default to plan-first delegation
- Unless the user explicitly asks for implementation or passes `write: true`, call `claude_task` with `write: false`
- When `write: false`, Claude runs with `--permission-mode plan`
- When `write: true`, Claude may modify the workspace and must be prompted to keep edits scoped
- Preserve the user's task text except for routing controls such as resume, fresh, background, model, and effort
- Leave `model` and `effort` unset unless the user explicitly chooses them
- Prefer `background: true` for broad, long-running, multi-step, or open-ended work
- Prefer foreground for small and bounded planning requests
- Use `resume: true` when the user clearly asks to continue previous Claude work
- Use `fresh: true` when the user explicitly asks for a new thread
- Do not summarize a failed or incomplete Claude run into a substitute answer

## Output Handling

- Return Claude's output faithfully
- If Claude made edits, report the touched files when the tool provides them
- If Claude only produced a plan, keep it as a plan and do not implement it unless the user asks Codex to continue
- If a background job was started, tell the user the job id and use `claude_status` or `claude_result` for follow-up
- If setup or authentication is missing, direct the user to run the setup check through `claude_task` or the CLI fallback

## CLI Fallback

If MCP tools are unavailable, use:

```bash
node plugins/claude/scripts/claude-companion.mjs task "<prompt>"
```

Only use this fallback when the MCP server is not available.
