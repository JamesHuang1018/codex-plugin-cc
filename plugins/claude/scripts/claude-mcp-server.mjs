#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(ROOT_DIR, "scripts", "claude-companion.mjs");

const TOOLS = [
  {
    name: "claude_task",
    description: "Start a Claude Code task from Codex. Defaults to plan-first mode unless write is true.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task prompt to send to Claude Code" },
        background: { type: "boolean", description: "Start as a background job" },
        write: { type: "boolean", description: "Allow Claude Code to modify the workspace" },
        resume: { type: "boolean", description: "Resume the latest Claude Code task for this workspace" },
        fresh: { type: "boolean", description: "Force a fresh Claude Code task" },
        model: { type: "string", description: "Optional Claude model" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Optional Claude effort" },
        cwd: { type: "string", description: "Workspace directory" }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "claude_status",
    description: "Show active and recent Claude Code jobs for the current workspace.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional job id or prefix" },
        wait: { type: "boolean", description: "Wait for a specific job to finish" },
        all: { type: "boolean", description: "Include jobs from other sessions" },
        cwd: { type: "string", description: "Workspace directory" }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "claude_result",
    description: "Read the stored final output for a Claude Code job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional job id or prefix" },
        cwd: { type: "string", description: "Workspace directory" }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "claude_cancel",
    description: "Cancel an active background Claude Code job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional job id or prefix" },
        cwd: { type: "string", description: "Workspace directory" }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(text, structuredContent = null, isError = false) {
  const result = {
    content: [{ type: "text", text }]
  };
  if (structuredContent !== null) {
    result.structuredContent = structuredContent;
  }
  if (isError) {
    result.isError = true;
  }
  return result;
}

function runCompanion(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: error.message });
    });
    child.on("exit", (code, signal) => {
      resolve({ status: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

function addOptional(args, name, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(name, String(value));
  }
}

async function callTool(name, input = {}) {
  if (name === "claude_task") {
    const args = ["task", "--json"];
    if (input.background) {
      args.push("--background");
    }
    if (input.write) {
      args.push("--write");
    }
    if (input.resume) {
      args.push("--resume");
    }
    if (input.fresh) {
      args.push("--fresh");
    }
    addOptional(args, "--cwd", input.cwd);
    addOptional(args, "--model", input.model);
    addOptional(args, "--effort", input.effort);
    args.push(input.prompt ?? "");
    const result = await runCompanion(args, { cwd: input.cwd });
    return parseCompanionResult(result);
  }

  if (name === "claude_status") {
    const args = ["status", "--json"];
    if (input.wait) {
      args.push("--wait");
    }
    if (input.all) {
      args.push("--all");
    }
    addOptional(args, "--cwd", input.cwd);
    if (input.job_id) {
      args.push(input.job_id);
    }
    const result = await runCompanion(args, { cwd: input.cwd });
    return parseCompanionResult(result);
  }

  if (name === "claude_result") {
    const args = ["result", "--json"];
    addOptional(args, "--cwd", input.cwd);
    if (input.job_id) {
      args.push(input.job_id);
    }
    const result = await runCompanion(args, { cwd: input.cwd });
    return parseCompanionResult(result);
  }

  if (name === "claude_cancel") {
    const args = ["cancel", "--json"];
    addOptional(args, "--cwd", input.cwd);
    if (input.job_id) {
      args.push(input.job_id);
    }
    const result = await runCompanion(args, { cwd: input.cwd });
    return parseCompanionResult(result);
  }

  return toolResult(`Unknown tool: ${name}`, null, true);
}

function parseCompanionResult(result) {
  if (result.status !== 0) {
    return toolResult((result.stderr || result.stdout || `Claude companion exited ${result.status}`).trim(), null, true);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return toolResult(JSON.stringify(parsed, null, 2), parsed);
  } catch {
    return toolResult(result.stdout);
  }
}

function handleRequest(message) {
  const id = message.id;
  const method = message.method;

  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-mcp-server", version: "0.1.0" }
      }
    });
    return;
  }

  if (method === "tools/list") {
    send({
      id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === "tools/call") {
    callTool(message.params?.name, message.params?.arguments ?? {})
      .then((result) => send({ id, result }))
      .catch((error) => send({ id, result: toolResult(error instanceof Error ? error.message : String(error), null, true) }));
    return;
  }

  if (id !== undefined) {
    send({
      id,
      error: {
        code: -32601,
        message: `Unsupported method: ${method}`
      }
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  try {
    handleRequest(JSON.parse(line));
  } catch (error) {
    send({
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});
