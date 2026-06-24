import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildClaudeEnv, installFakeClaude } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "claude", "scripts", "claude-companion.mjs");
const MCP_SERVER = path.join(ROOT, "plugins", "claude", "scripts", "claude-mcp-server.mjs");

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeRepo() {
  const repo = makeTempDir("claude-plugin-test-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("claude setup reports ready when the CLI is available", () => {
  const binDir = makeTempDir();
  installFakeClaude(binDir);
  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildClaudeEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.claude.detail, /claude-code test/);
});

test("claude task defaults to plan permission mode", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = installFakeClaude(binDir);
  const stateRoot = makeTempDir();
  const result = run("node", [SCRIPT, "task", "plan the migration"], {
    cwd: repo,
    env: buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: stateRoot })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude handled: plan the migration/);
  const fakeState = readFakeState(statePath);
  assert.deepEqual(fakeState.calls[0].args.slice(0, 6), ["--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "plan"]);
  assert.equal(fakeState.calls[0].args.includes("--dangerously-skip-permissions"), false);
});

test("claude task enables write-capable non-interactive permissions when write is requested", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = installFakeClaude(binDir);
  const result = run("node", [SCRIPT, "task", "--write", "apply the fix"], {
    cwd: repo,
    env: buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: makeTempDir() })
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(statePath);
  assert.deepEqual(fakeState.calls[0].args.slice(0, 6), ["--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits"]);
  assert.equal(fakeState.calls[0].args.includes("--dangerously-skip-permissions"), true);
});

test("claude task can resume the latest stored Claude session", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = installFakeClaude(binDir);
  const env = buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: makeTempDir() });

  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const second = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Resumed Claude task/);

  const fakeState = readFakeState(statePath);
  assert.equal(fakeState.calls[1].args.includes("--resume"), true);
  assert.equal(fakeState.calls[1].args[fakeState.calls[1].args.indexOf("--resume") + 1], "sess_1");
});

test("claude status and result read stored job output", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeClaude(binDir);
  const env = buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: makeTempDir() });
  const task = run("node", [SCRIPT, "task", "inspect status"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.jobs.length, 1);

  const result = run("node", [SCRIPT, "result", statusPayload.jobs[0].id], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude handled: inspect status/);
});

test("claude MCP server lists tools and maps task permission modes", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = installFakeClaude(binDir);
  const env = buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: makeTempDir() });
  const child = spawn("node", [MCP_SERVER], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lines.push(...chunk.split(/\r?\n/).filter(Boolean));
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function waitFor(id) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const matchIndex = lines.findIndex((line) => {
        try {
          return JSON.parse(line).id === id;
        } catch {
          return false;
        }
      });
      if (matchIndex !== -1) {
        return JSON.parse(lines.splice(matchIndex, 1)[0]);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${id}`);
  }

  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  const initialized = await waitFor(1);
  assert.equal(initialized.jsonrpc, "2.0");
  assert.equal(initialized.result.serverInfo.name, "claude-mcp-server");

  send({ id: 2, method: "tools/list", params: {} });
  const listed = await waitFor(2);
  assert.equal(listed.jsonrpc, "2.0");
  assert.equal(listed.result.tools.some((tool) => tool.name === "claude_status"), true);

  send({ id: 3, method: "tools/call", params: { name: "claude_status", arguments: { cwd: repo } } });
  const called = await waitFor(3);
  assert.equal(called.jsonrpc, "2.0");
  assert.equal(called.result.content[0].type, "text");

  send({ id: 4, method: "tools/call", params: { name: "claude_task", arguments: { cwd: repo, prompt: "apply the fix" } } });
  const defaultTask = await waitFor(4);
  assert.equal(defaultTask.jsonrpc, "2.0");
  assert.match(defaultTask.result.content[0].text, /Claude handled: apply the fix/);

  send({ id: 5, method: "tools/call", params: { name: "claude_task", arguments: { cwd: repo, prompt: "plan only", write: false } } });
  const planTask = await waitFor(5);
  assert.equal(planTask.jsonrpc, "2.0");
  assert.match(planTask.result.content[0].text, /Claude handled: plan only/);

  const fakeState = readFakeState(statePath);
  assert.deepEqual(fakeState.calls[0].args.slice(0, 6), ["--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits"]);
  assert.equal(fakeState.calls[0].args.includes("--dangerously-skip-permissions"), true);
  assert.deepEqual(fakeState.calls[1].args.slice(0, 6), ["--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "plan"]);
  assert.equal(fakeState.calls[1].args.includes("--dangerously-skip-permissions"), false);

  child.stdin.end();
  child.kill();
});

test("claude MCP server cancels an active task process", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = installFakeClaude(binDir, "slow");
  const env = buildClaudeEnv(binDir, { CODEX_PLUGIN_DATA: makeTempDir() });
  const child = spawn("node", [MCP_SERVER], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stdout.resume();

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  try {
    send({ id: 1, method: "tools/call", params: { name: "claude_task", arguments: { cwd: repo, prompt: "slow task" } } });
    await waitUntil(() => {
      if (!fs.existsSync(statePath)) {
        return false;
      }
      try {
        return readFakeState(statePath).calls.length === 1;
      } catch {
        return false;
      }
    }, "fake Claude call");

    const pid = readFakeState(statePath).calls[0].pid;
    assert.equal(processIsRunning(pid), true);

    send({ method: "notifications/cancelled", params: { requestId: 1, reason: "test cancellation" } });
    await waitUntil(() => !processIsRunning(pid), "fake Claude process exit");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
