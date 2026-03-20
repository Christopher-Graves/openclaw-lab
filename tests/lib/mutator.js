/**
 * mutator.js — Mutation strategy engine for workspace prompt hardening
 *
 * Generates and applies single targeted mutations to workspace files,
 * informed by test failures and the full context of all current failures.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Generate a single targeted mutation to fix a failing scenario.
 *
 * @param {object} failure - The primary failure to target
 * @param {object[]} allFailures - All current failures (for regression awareness)
 * @param {object} workspaceFiles - Map of filename -> content
 * @param {object} agentConfig - Agent configuration from agent.json
 * @param {object} [opts]
 * @param {string} [opts.model] - Model to use (default: "sonnet")
 * @param {object[]} [opts.previousMutations] - Past mutations for this scenario (to avoid repeats)
 * @returns {object} { file, search, replace, description, reasoning, type }
 */
export function generateMutation(failure, allFailures, workspaceFiles, agentConfig, opts = {}) {
  const model = opts.model || "sonnet";
  const agentName = agentConfig.displayName || agentConfig.name;

  const otherFailures = allFailures
    .filter((f) => f.id !== failure.id)
    .map((f) => `- ${f.id}: ${f.name} — ${f.llmScore?.reasoning || "fail pattern matched"}`)
    .join("\n");

  const previousAttempts = (opts.previousMutations || [])
    .map((m, i) => `${i + 1}. [${m.status}] ${m.description} (${m.file}, ${m.type})`)
    .join("\n");

  const wsFileList = Object.entries(workspaceFiles)
    .map(([name, content]) => `=== ${name} ===\n${content.slice(0, 4000)}\n`)
    .join("\n");

  const mutationPrompt = `You are a prompt engineering expert hardening an AI assistant called ${agentName}.
Your job is to generate ONE minimal mutation to fix a specific test failure.

IMPORTANT CONSTRAINTS:
- Make the SMALLEST possible change — one rule, one example, one reword
- Do NOT remove existing behavior — augment or refine
- Do NOT over-specify — keep instructions general enough to handle similar cases
- Consider ALL other current failures and avoid introducing regressions
- If previous attempts for this scenario failed, try a DIFFERENT approach

TARGET FAILURE:
- Test: ${failure.id} — ${failure.name}
- Prompt sent: "${failure.prompt}"
- Response: "${(failure.response || "").slice(0, 500)}"
- Why it failed: ${failure.llmScore?.reasoning || "matched a fail pattern"}
- Pass criteria: ${JSON.stringify(failure.pass_criteria || [])}
${failure.binary_criteria ? `- Binary criteria: ${JSON.stringify(failure.binary_criteria)}` : ""}

${otherFailures ? `OTHER CURRENT FAILURES (do not break these):\n${otherFailures}` : "No other failures."}

${previousAttempts ? `PREVIOUS ATTEMPTS ON THIS SCENARIO (try something different):\n${previousAttempts}` : ""}

CURRENT WORKSPACE FILES:
${wsFileList}

Generate your mutation as a JSON object:
{
  "file": "SOUL.md or AGENTS.md or TOOLS.md or MEMORY.md",
  "search": "exact text to find in the file (empty string to append)",
  "replace": "replacement text",
  "description": "one-line description of what this mutation does",
  "reasoning": "why this should fix the target failure without breaking others",
  "type": "add_rule | add_example | refine_instruction | add_guardrail | reorder | remove_bloat"
}

Respond with ONLY the JSON object.`;

  try {
    const result = execSync(`claude -p --model ${model}`, {
      input: mutationPrompt,
      encoding: "utf-8",
      timeout: 60000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error(`  Mutation generation failed: ${err.message}`);
    return null;
  }
}

/**
 * Apply a mutation to a workspace file.
 *
 * @param {object} mutation - { file, search, replace }
 * @param {string} workspaceDir - Path to workspace directory
 * @returns {boolean} Whether the mutation was successfully applied
 */
export function applyMutation(mutation, workspaceDir) {
  if (!mutation || !mutation.file || mutation.replace == null) {
    return false;
  }

  const targetFile = path.join(workspaceDir, mutation.file);
  if (!fs.existsSync(targetFile)) {
    console.log(`  WARNING: Target file ${mutation.file} does not exist`);
    return false;
  }

  let content = fs.readFileSync(targetFile, "utf-8");

  if (mutation.search && content.includes(mutation.search)) {
    // Search and replace
    content = content.replace(mutation.search, mutation.replace);
    fs.writeFileSync(targetFile, content);
    return true;
  } else if (!mutation.search || mutation.search === "") {
    // Append
    content += "\n" + mutation.replace;
    fs.writeFileSync(targetFile, content);
    return true;
  } else {
    console.log(`  WARNING: Could not find search text in ${mutation.file}`);
    return false;
  }
}

/**
 * Read all workspace files into a map.
 *
 * @param {string} workspaceDir - Path to workspace directory
 * @returns {object} Map of filename -> content
 */
export function readWorkspaceFiles(workspaceDir) {
  const files = {};
  if (!fs.existsSync(workspaceDir)) return files;

  for (const file of fs.readdirSync(workspaceDir)) {
    const filePath = path.join(workspaceDir, file);
    if (fs.statSync(filePath).isFile()) {
      files[file] = fs.readFileSync(filePath, "utf-8");
    }
  }
  return files;
}
