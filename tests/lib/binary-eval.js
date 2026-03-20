/**
 * binary-eval.js — Binary pass/fail evaluation for test scenarios
 *
 * More reliable than 0-100 scoring: asks "Does this pass ALL criteria? YES or NO"
 */

import { execSync } from "child_process";

/**
 * Evaluate a response with binary pass/fail criteria.
 *
 * @param {string} response - The agent's response text
 * @param {string[]} criteria - Array of binary criteria (must ALL be met to pass)
 * @param {object} [opts]
 * @param {string} [opts.model] - Scoring model (default: "haiku")
 * @param {string} [opts.prompt] - The prompt that was sent
 * @param {string} [opts.agentName] - Agent display name
 * @returns {object} { pass: boolean, reasoning: string, criteria_results: [] }
 */
export function evaluateBinary(response, criteria, opts = {}) {
  const model = opts.model || "haiku";
  const agentName = opts.agentName || "the agent";

  const evalPrompt = `You are evaluating whether an AI assistant's response passes ALL of the following criteria.
Be strict — ALL criteria must be met for a PASS.

${opts.prompt ? `PROMPT SENT TO ${agentName}: "${opts.prompt}"` : ""}

RESPONSE:
---
${response}
---

CRITERIA (ALL must be met):
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Evaluate each criterion, then give a final verdict.
Respond in JSON:
{
  "pass": true or false,
  "reasoning": "brief explanation of overall verdict",
  "criteria_results": [
    {"criterion": "...", "met": true/false, "note": "brief note"}
  ]
}`;

  try {
    const result = execSync(`claude -p --model ${model}`, {
      input: evalPrompt,
      encoding: "utf-8",
      timeout: 30000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { pass: false, reasoning: "Failed to parse binary eval response", criteria_results: [] };
  } catch {
    return { pass: false, reasoning: "Binary evaluation failed", criteria_results: [] };
  }
}
