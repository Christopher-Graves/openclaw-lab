/**
 * skill-detector.js — Detect skill gaps from hardening loop patterns
 *
 * When the loop detects recurring failures that prompt changes alone can't fix,
 * this module flags them as potential skill gaps requiring new tools or capabilities.
 */

import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Analyze changelog and failure patterns to detect skill gaps.
 *
 * @param {object[]} tsvResults - Parsed results.tsv rows
 * @param {object[]} failures - Current failing scenarios
 * @param {object} workspaceFiles - Map of filename -> content
 * @returns {object[]} Detected skill gaps with confidence and evidence
 */
export function detectSkillGaps(tsvResults, failures, workspaceFiles) {
  const gaps = [];

  // Count how many times each scenario was targeted and discarded
  const scenarioAttempts = {};
  for (const row of tsvResults) {
    if (row.status === "BASELINE") continue;
    const sid = row.target_scenario;
    if (!scenarioAttempts[sid]) {
      scenarioAttempts[sid] = { total: 0, discarded: 0, types: new Set() };
    }
    scenarioAttempts[sid].total++;
    scenarioAttempts[sid].types.add(row.mutation_type);
    if (row.status === "DISCARD") {
      scenarioAttempts[sid].discarded++;
    }
  }

  // Scenarios targeted 5+ times with mostly discards suggest a skill gap
  for (const [sid, stats] of Object.entries(scenarioAttempts)) {
    if (stats.total >= 5 && stats.discarded / stats.total >= 0.8) {
      const failure = failures.find((f) => f.id === sid);
      const skillHints = detectSkillHints(failure, workspaceFiles);

      gaps.push({
        scenario: sid,
        name: failure?.name || sid,
        confidence: stats.total >= 8 ? "high" : "medium",
        attempts: stats.total,
        discarded: stats.discarded,
        mutationTypes: [...stats.types],
        hints: skillHints,
        evidence: `${stats.total} mutations attempted, ${stats.discarded} discarded`,
      });
    }
  }

  return gaps;
}

/**
 * Look for hints about what kind of skill/tool might be needed.
 */
function detectSkillHints(failure, workspaceFiles) {
  if (!failure) return [];
  const hints = [];
  const prompt = (failure.prompt || "").toLowerCase();
  const response = (failure.response || "").toLowerCase();
  const reasoning = (failure.llmScore?.reasoning || "").toLowerCase();

  const skillPatterns = [
    { pattern: /search|google|look up|find online|browse/i, skill: "Web Search" },
    { pattern: /calendar|schedul|meeting|appointment/i, skill: "Calendar Integration" },
    { pattern: /email|send.*message|notify/i, skill: "Email/Messaging" },
    { pattern: /database|sql|query.*data/i, skill: "Database Access" },
    { pattern: /api|endpoint|fetch.*data|http/i, skill: "API Integration" },
    { pattern: /file|upload|download|attachment/i, skill: "File Management" },
    { pattern: /calculat|math|compute|formula/i, skill: "Computation" },
    { pattern: /image|photo|screenshot|visual/i, skill: "Image Processing" },
  ];

  const combined = `${prompt} ${response} ${reasoning}`;
  for (const { pattern, skill } of skillPatterns) {
    if (pattern.test(combined)) {
      hints.push(skill);
    }
  }

  return [...new Set(hints)];
}

/**
 * Write skill gaps analysis to a markdown file.
 *
 * @param {string} agentName - Agent directory name
 * @param {object[]} gaps - Detected skill gaps
 */
export function writeSkillsNeeded(agentName, gaps) {
  if (gaps.length === 0) return;

  const agentDir = path.join(LAB_ROOT, "agents", agentName);
  const lines = [
    "# Detected Skill Gaps",
    "",
    `Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    "",
    "These scenarios consistently fail despite multiple prompt mutation attempts,",
    "suggesting the agent may need new tools or capabilities rather than prompt changes.",
    "",
  ];

  for (const gap of gaps) {
    const hintsStr = gap.hints.length > 0
      ? gap.hints.join(", ")
      : "no specific skill detected";

    lines.push(`## ${hintsStr} (${gap.confidence} confidence)`);
    lines.push(`- **Scenario:** ${gap.scenario} — ${gap.name}`);
    lines.push(`- **Evidence:** ${gap.evidence}`);
    lines.push(`- **Mutation types tried:** ${gap.mutationTypes.join(", ")}`);
    lines.push(`- **Recommendation:** ${getRecommendation(gap)}`);
    lines.push("");
  }

  fs.writeFileSync(path.join(agentDir, "skills-needed.md"), lines.join("\n"));
}

function getRecommendation(gap) {
  if (gap.hints.length > 0) {
    return `Consider adding ${gap.hints.join(" / ")} capability to TOOLS.md or creating a dedicated skill file`;
  }
  return "Review the scenario requirements — this failure pattern suggests a capability gap that prompt engineering alone cannot solve";
}
