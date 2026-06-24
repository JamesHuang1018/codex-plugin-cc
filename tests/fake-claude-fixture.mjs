import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeClaude(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-claude-state.json");
  const scriptPath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { calls: [], nextSessionId: 1 };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("claude-code test");
  process.exit(0);
}

process.on("SIGTERM", () => {
  process.exit(143);
});

const state = loadState();
const sessionIdIndex = args.indexOf("--resume");
const resumedSessionId = sessionIdIndex === -1 ? null : args[sessionIdIndex + 1];
const sessionId = resumedSessionId || "sess_" + state.nextSessionId++;
state.calls.push({ args, cwd: process.cwd(), sessionId, pid: process.pid });
saveState(state);

if (args.includes("--print") && args.includes("stream-json") && !args.includes("--verbose")) {
  console.error("When using --print, --output-format=stream-json requires --verbose");
  process.exit(1);
}

if (args.includes("acceptEdits") && !args.includes("--dangerously-skip-permissions")) {
  console.error("tool permission denied");
  process.exit(1);
}

if (BEHAVIOR === "fail") {
  console.error("claude failed intentionally");
  process.exit(2);
}

if (BEHAVIOR === "slow") {
  setInterval(() => {}, 1000);
}

const prompt = args[args.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: resumedSessionId ? "Resumed Claude task" : "Claude handled: " + prompt }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: "Done" }) + "\\n");
`;
  writeExecutable(scriptPath, source);
  return statePath;
}

export function buildClaudeEnv(binDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
  };
}
