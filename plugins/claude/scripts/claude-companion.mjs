#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATE_VERSION = 1;
const MAX_JOBS = 50;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const SESSION_ID_ENVS = ["CLAUDE_COMPANION_SESSION_ID", "CODEX_SESSION_ID", "CODEX_COMPANION_SESSION_ID"];
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current Claude Code task state. Pick the next highest-value step and follow through until the task is resolved.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/claude-companion.mjs setup [--json]",
      "  node scripts/claude-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/claude-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/claude-companion.mjs result [job-id] [--json]",
      "  node scripts/claude-companion.mjs cancel [job-id] [--json]",
      "  node scripts/claude-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function splitRawArgumentString(raw) {
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of String(raw ?? "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  const normalized = normalizeArgv(argv);
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--") {
      positionals.push(...normalized.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const trimmed = arg.replace(/^-+/, "");
    const equalIndex = trimmed.indexOf("=");
    const rawName = equalIndex === -1 ? trimmed : trimmed.slice(0, equalIndex);
    const name = aliasMap[rawName] ?? rawName;
    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }
    if (valueOptions.has(name)) {
      if (equalIndex !== -1) {
        options[name] = trimmed.slice(equalIndex + 1);
      } else {
        index += 1;
        if (index >= normalized.length) {
          throw new Error(`Missing value for --${name}.`);
        }
        options[name] = normalized[index];
      }
      continue;
    }
    positionals.push(arg);
  }
  return { options, positionals };
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

function binaryAvailable(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    return {
      available: false,
      detail: result.error.message
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      detail: (result.stderr || result.stdout || `${command} exited ${result.status}`).trim()
    };
  }
  return {
    available: true,
    detail: (result.stdout || result.stderr || `${command} available`).trim()
  };
}

function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

function resolveStateRoot() {
  return (
    process.env.CODEX_PLUGIN_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.tmpdir(), "claude-companion")
  );
}

function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slug = (path.basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), "state", `${slug}-${hash}`);
}

function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function defaultState() {
  return {
    version: STATE_VERSION,
    jobs: []
  };
}

function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function saveState(cwd, state) {
  ensureStateDir(cwd);
  const jobs = [...(state.jobs ?? [])]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  const nextState = {
    version: STATE_VERSION,
    jobs
  };
  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

function upsertJob(cwd, patch) {
  updateState(cwd, (state) => {
    const timestamp = new Date().toISOString();
    const existingIndex = state.jobs.findIndex((job) => job.id === patch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...patch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...patch,
      updatedAt: timestamp
    };
  });
}

function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  fs.writeFileSync(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJobFile(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  return fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, "utf8")) : null;
}

function generateJobId(prefix = "claude") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function appendLogLine(logFile, line) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
}

function listJobs(cwd) {
  return loadState(cwd).jobs;
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function currentSessionId() {
  for (const envName of SESSION_ID_ENVS) {
    if (process.env[envName]) {
      return process.env[envName];
    }
  }
  return null;
}

function filterJobsForCurrentSession(jobs) {
  const sessionId = currentSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return jobs.find((job) => job.jobClass === "task" && job.claudeSessionId && job.status !== "queued" && job.status !== "running") ?? null;
}

function normalizeEffort(effort) {
  if (effort == null || effort === "") {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported Claude effort "${effort}". Use one of: low, medium, high, xhigh, max.`);
  }
  return normalized;
}

function readPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  if (positionalPrompt) {
    return positionalPrompt;
  }
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }
  return "";
}

function firstMeaningfulLine(text, fallback) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? fallback;
}

function buildTaskTitle(prompt, resumeLast) {
  return resumeLast ? "Claude Code Resume" : "Claude Code Task";
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function createTaskJob(workspaceRoot, prompt, resumeLast, write) {
  const id = generateJobId("claude");
  return {
    id,
    kind: "task",
    kindLabel: "claude-task",
    title: buildTaskTitle(prompt, resumeLast),
    workspaceRoot,
    jobClass: "task",
    summary: shorten(prompt || DEFAULT_CONTINUE_PROMPT),
    write: Boolean(write),
    sessionId: currentSessionId(),
    status: "queued",
    phase: "queued"
  };
}

function resolveLatestClaudeSession(cwd, excludeJobId = null) {
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(cwd))).filter((job) => job.id !== excludeJobId);
  const active = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (active) {
    throw new Error(`Task ${active.id} is still running. Check status before resuming.`);
  }
  const latest = findLatestResumableTaskJob(jobs);
  return latest?.claudeSessionId ?? null;
}

function buildClaudeArgs(request, claudeSessionId) {
  const args = ["--print", "--output-format", "stream-json", "--permission-mode", request.write ? "acceptEdits" : "plan"];
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.effort) {
    args.push("--effort", request.effort);
  }
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }
  args.push(request.prompt?.trim() || DEFAULT_CONTINUE_PROMPT);
  return args;
}

function extractText(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.result === "string") {
      return value.result;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    if (Array.isArray(value.content)) {
      return extractText(value.content);
    }
    if (value.message) {
      return extractText(value.message.content ?? value.message);
    }
  }
  return "";
}

function extractClaudeSessionId(value) {
  return value?.session_id ?? value?.sessionId ?? value?.session?.id ?? value?.conversation_id ?? null;
}

function parseClaudeStdout(stdout) {
  const textParts = [];
  let claudeSessionId = null;
  const rawLines = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    rawLines.push(line);
    try {
      const parsed = JSON.parse(line);
      claudeSessionId = extractClaudeSessionId(parsed) ?? claudeSessionId;
      const text = extractText(parsed);
      if (text) {
        textParts.push(text);
      }
    } catch {
      textParts.push(line);
    }
  }
  return {
    claudeSessionId,
    rawOutput: textParts.length ? textParts.join("\n") : rawLines.join("\n")
  };
}

async function runClaude(request, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const resumeSessionId = request.resumeLast ? resolveLatestClaudeSession(workspaceRoot, request.jobId) : null;
  if (request.resumeLast && !resumeSessionId) {
    throw new Error("No previous Claude Code task session was found for this repository.");
  }
  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const args = buildClaudeArgs(request, resumeSessionId);
  appendLogLine(options.logFile, `Starting claude ${args.slice(0, -1).join(" ")}`);
  const child = spawn("claude", args, {
    cwd: workspaceRoot,
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
    appendLogLine(options.logFile, chunk.trimEnd());
  });

  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  const parsed = parseClaudeStdout(stdout);
  if (parsed.rawOutput) {
    appendLogLine(options.logFile, parsed.rawOutput);
  }

  return {
    status,
    claudeSessionId: parsed.claudeSessionId ?? resumeSessionId,
    rawOutput: parsed.rawOutput,
    stderr: stderr.trim(),
    touchedFiles: []
  };
}

function renderTaskResult(payload, title) {
  if (payload.rawOutput) {
    return `${payload.rawOutput.trimEnd()}\n`;
  }
  if (payload.stderr) {
    return `${title} failed.\n${payload.stderr.trimEnd()}\n`;
  }
  return `${title} completed without output.\n`;
}

async function executeTaskRun(request, job, logFile) {
  const availability = binaryAvailable("claude", ["--version"], { cwd: request.cwd });
  if (!availability.available) {
    throw new Error(`Claude Code CLI is not installed or unavailable: ${availability.detail}`);
  }

  const startedAt = new Date().toISOString();
  upsertJob(job.workspaceRoot, {
    ...job,
    status: "running",
    phase: request.write ? "editing" : "planning",
    pid: process.pid,
    logFile,
    startedAt,
    request
  });
  writeJobFile(job.workspaceRoot, job.id, {
    ...job,
    status: "running",
    phase: request.write ? "editing" : "planning",
    pid: process.pid,
    logFile,
    startedAt,
    request
  });

  const result = await runClaude(request, { logFile });
  const completedAt = new Date().toISOString();
  const exitStatus = result.status === 0 ? 0 : result.status || 1;
  const payload = {
    status: exitStatus,
    claudeSessionId: result.claudeSessionId,
    rawOutput: result.rawOutput,
    stderr: result.stderr,
    touchedFiles: result.touchedFiles
  };
  const rendered = renderTaskResult(payload, job.title);
  const finalJob = {
    ...job,
    status: exitStatus === 0 ? "completed" : "failed",
    phase: exitStatus === 0 ? "completed" : "failed",
    pid: null,
    logFile,
    request,
    payload,
    rendered,
    claudeSessionId: result.claudeSessionId,
    summary: firstMeaningfulLine(result.rawOutput, firstMeaningfulLine(result.stderr, job.summary)),
    completedAt
  };
  upsertJob(job.workspaceRoot, finalJob);
  writeJobFile(job.workspaceRoot, job.id, finalJob);
  return {
    exitStatus,
    payload,
    rendered
  };
}

function spawnDetachedWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "claude-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const logFile = resolveJobLogFile(job.workspaceRoot, job.id);
  appendLogLine(logFile, "Queued for background execution.");
  const child = spawnDetachedWorker(cwd, job.id);
  const queuedJob = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  upsertJob(job.workspaceRoot, queuedJob);
  writeJobFile(job.workspaceRoot, job.id, queuedJob);
  return {
    jobId: job.id,
    status: "queued",
    title: job.title,
    summary: job.summary,
    logFile
  };
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(String(value));
  }
}

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const claude = binaryAvailable("claude", ["--version"], { cwd });
  const payload = {
    ready: claude.available,
    claude,
    workspaceRoot: resolveWorkspaceRoot(cwd)
  };
  outputResult(options.json ? payload : `Claude Code: ${claude.available ? "ready" : "not ready"}\n${claude.detail}\n`, options.json);
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = readPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const effort = normalizeEffort(options.effort);
  const request = {
    cwd,
    model: options.model ?? null,
    effort,
    prompt,
    write: Boolean(options.write),
    resumeLast,
    jobId: null
  };
  const job = createTaskJob(workspaceRoot, prompt, resumeLast, request.write);
  request.jobId = job.id;

  if (options.background) {
    const availability = binaryAvailable("claude", ["--version"], { cwd });
    if (!availability.available) {
      throw new Error(`Claude Code CLI is not installed or unavailable: ${availability.detail}`);
    }
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    const payload = enqueueBackgroundTask(cwd, job, request);
    outputResult(options.json ? payload : `Claude Code task started in the background as ${payload.jobId}. Check claude_status for progress.\n`, options.json);
    return;
  }

  const logFile = resolveJobLogFile(workspaceRoot, job.id);
  const execution = await executeTaskRun(request, job, logFile);
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readJobFile(workspaceRoot, options["job-id"]);
  if (!storedJob?.request) {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }
  await executeTaskRun(storedJob.request, { ...storedJob, workspaceRoot }, storedJob.logFile ?? resolveJobLogFile(workspaceRoot, storedJob.id));
}

function jobDuration(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? job.updatedAt ?? "");
  const end = Date.parse(job.completedAt ?? new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return `${seconds}s`;
}

function renderJob(job) {
  return [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase ?? ""}`,
    `Title: ${job.title ?? ""}`,
    `Summary: ${job.summary ?? ""}`,
    `Duration: ${jobDuration(job)}`,
    job.claudeSessionId ? `Claude session: ${job.claudeSessionId}` : null,
    job.logFile ? `Log: ${job.logFile}` : null
  ].filter(Boolean).join("\n") + "\n";
}

function renderStatusReport(cwd, jobs) {
  if (!jobs.length) {
    return "No Claude Code jobs found.\n";
  }
  const lines = ["| job | status | phase | duration | summary |", "| --- | --- | --- | --- | --- |"];
  for (const job of jobs) {
    lines.push(`| ${job.id} | ${job.status ?? ""} | ${job.phase ?? ""} | ${jobDuration(job)} | ${String(job.summary ?? "").replace(/\|/g, "\\|")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function resolveJob(cwd, reference = "") {
  const jobs = sortJobsNewestFirst(listJobs(cwd));
  if (!jobs.length) {
    throw new Error("No Claude Code jobs found.");
  }
  if (!reference) {
    return jobs[0];
  }
  const job = jobs.find((candidate) => candidate.id === reference || candidate.id.startsWith(reference));
  if (!job) {
    throw new Error(`No Claude Code job found for ${reference}.`);
  }
  return job;
}

async function waitForJob(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let job = resolveJob(cwd, reference);
  while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    job = resolveJob(cwd, reference);
  }
  return job;
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveWorkspaceRoot(resolveCommandCwd(options));
  const reference = positionals[0] ?? "";
  if (reference) {
    const job = options.wait
      ? await waitForJob(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : resolveJob(cwd, reference);
    outputResult(options.json ? job : renderJob(job), options.json);
    return;
  }
  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }
  const jobs = sortJobsNewestFirst(options.all ? listJobs(cwd) : filterJobsForCurrentSession(listJobs(cwd)));
  outputResult(options.json ? { jobs } : renderStatusReport(cwd, jobs), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveWorkspaceRoot(resolveCommandCwd(options));
  const job = resolveJob(cwd, positionals[0] ?? "");
  const storedJob = readJobFile(cwd, job.id) ?? job;
  outputResult(options.json ? storedJob : (storedJob.rendered ?? renderJob(storedJob)), options.json);
}

function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return result.status === 0;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveWorkspaceRoot(resolveCommandCwd(options));
  const job = resolveJob(cwd, positionals[0] ?? "");
  const storedJob = readJobFile(cwd, job.id) ?? job;
  const killed = terminateProcessTree(storedJob.pid ?? Number.NaN);
  const completedAt = new Date().toISOString();
  const nextJob = {
    ...storedJob,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  upsertJob(cwd, nextJob);
  writeJobFile(cwd, nextJob.id, nextJob);
  const payload = {
    jobId: nextJob.id,
    status: "cancelled",
    killed
  };
  outputResult(options.json ? payload : `Cancelled ${nextJob.id}.\n`, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveWorkspaceRoot(resolveCommandCwd(options));
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(cwd)));
  const candidate = findLatestResumableTaskJob(jobs);
  const payload = {
    available: Boolean(candidate),
    sessionId: currentSessionId(),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          claudeSessionId: candidate.claudeSessionId,
          completedAt: candidate.completedAt ?? null,
          updatedAt: candidate.updatedAt ?? null
        }
      : null
  };
  outputResult(options.json ? payload : (candidate ? `Resumable Claude Code task found: ${candidate.id}.\n` : "No resumable Claude Code task found.\n"), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
