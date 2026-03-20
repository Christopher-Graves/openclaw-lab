#!/usr/bin/env node
/**
 * scorer.js — Rubric scoring engine for workspace files
 *
 * Scores workspace files against rubric definitions using LLM evaluation.
 * Can be used standalone or imported by cycle.js.
 *
 * Usage:
 *   node tests/scorer.js --agent <name>              Score all rubric files
 *   node tests/scorer.js --agent <name> --file SOUL.md  Score single file
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");

function resolvePath(p) {
  const HOME = process.env.USERPROFILE || process.env.HOME;
  return p.replace(/^~/, HOME);
}

/**
 * Score a single workspace file against its rubric.
 * @param {string} filePath - Path to the workspace file
 * @param {string} filename - Name of the file (e.g., "SOUL.md")
 * @param {object} rubric - Rubric definition { maxScore, criteria: [...] }
 * @param {string} agentName - Display name of the agent
 * @param {string} scoringModel - Model to use for scoring (e.g., "haiku")
 * @returns {object} Score result
 */
export function scoreFile(filePath, filename, rubric, agentName, scoringModel = "haiku") {
  if (!fs.existsSync(filePath)) {
    return { total: 0, max: rubric.maxScore, grade: "N/A", error: "File not found" };
  }

  const content = fs.readFileSync(filePath, "utf-8");

  const scoringPrompt = `You are evaluating a workspace file for an AI assistant called ${agentName}.
Score each criterion from 0 to its max weight.

FILE: ${filename}
CONTENT:
---
${content.slice(0, 8000)}
---

RUBRIC:
${rubric.criteria.map((c) => `- ${c.name} (max ${c.weight}): ${c.desc}`).join("\n")}

Respond in JSON:
{
  "total": <number>,
  "max": ${rubric.maxScore},
  "grade": "A/B/C/D/F",
  "criteria": [{"name": "...", "score": <n>, "max": <n>, "notes": "..."}],
  "recommendations": ["..."]
}

Grading: A=90%+, B=75%+, C=60%+, D=40%+, F=<40%`;

  try {
    // Use stdin pipe to avoid Windows command line length limits
    const result = execSync(`claude -p --model ${scoringModel}`, {
      input: scoringPrompt,
      encoding: "utf-8",
      timeout: 60000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { total: 0, max: rubric.maxScore, grade: "ERR", error: "Failed to parse response" };
  } catch (err) {
    return { total: 0, max: rubric.maxScore, grade: "ERR", error: err.message };
  }
}

/**
 * Score all workspace files for an agent against their rubrics.
 * @param {string} agentName - Agent directory name
 * @param {string} workspaceDir - Path to workspace files to score
 * @param {object} [options] - Options
 * @param {string} [options.file] - Score only this file
 * @param {string} [options.scoringModel] - Model to use
 * @returns {object} Scores keyed by filename
 */
export function scoreAllFiles(agentName, workspaceDir, options = {}) {
  const agentDir = path.join(LAB_ROOT, "agents", agentName);
  const rubricsPath = path.join(agentDir, "rubrics.json");

  if (!fs.existsSync(rubricsPath)) {
    console.error(`No rubrics.json found for agent "${agentName}"`);
    return {};
  }

  const rubrics = JSON.parse(fs.readFileSync(rubricsPath, "utf-8"));
  const agentConfig = JSON.parse(
    fs.readFileSync(path.join(agentDir, "agent.json"), "utf-8")
  );
  const displayName = agentConfig.displayName || agentConfig.name;
  const scoringModel = options.scoringModel || "haiku";

  const filesToScore = options.file
    ? { [options.file]: rubrics[options.file] }
    : rubrics;

  const scores = {};

  for (const [filename, rubric] of Object.entries(filesToScore)) {
    if (!rubric) {
      console.log(`  No rubric defined for ${filename}, skipping`);
      continue;
    }

    const filePath = path.join(workspaceDir, filename);
    console.log(`  Scoring ${filename}...`);

    const score = scoreFile(filePath, filename, rubric, displayName, scoringModel);
    scores[filename] = score;

    if (score.error) {
      console.log(`  ${filename}: ERROR — ${score.error}`);
    } else {
      console.log(`  ${filename}: ${score.total}/${score.max} (${score.grade})`);
      if (score.recommendations?.length) {
        for (const rec of score.recommendations.slice(0, 3)) {
          console.log(`    → ${rec}`);
        }
      }
    }
  }

  return scores;
}

/**
 * Compare scores against previous run and report deltas.
 */
export function reportDeltas(scores, previousScores) {
  if (!previousScores) return;

  console.log("\n  Score Deltas vs Last Run:");
  for (const [file, score] of Object.entries(scores)) {
    const prev = previousScores[file];
    if (prev && typeof prev.total === "number" && typeof score.total === "number") {
      const delta = score.total - prev.total;
      const sign = delta > 0 ? "+" : "";
      console.log(`    ${file}: ${prev.total} → ${score.total} (${sign}${delta})`);
    }
  }
}

/**
 * Save scores and return path to scores file.
 */
export function saveScores(agentName, scores) {
  const scoresDir = path.join(LAB_ROOT, "agents", agentName, "scores");
  fs.mkdirSync(scoresDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const scoreFile = path.join(scoresDir, `${dateStr}.json`);
  fs.writeFileSync(scoreFile, JSON.stringify(scores, null, 2));

  return scoreFile;
}

/**
 * Load the most recent previous scores for comparison.
 */
export function loadPreviousScores(agentName) {
  const scoresDir = path.join(LAB_ROOT, "agents", agentName, "scores");
  if (!fs.existsSync(scoresDir)) return null;

  const dateStr = new Date().toISOString().slice(0, 10);
  const existing = fs
    .readdirSync(scoresDir)
    .filter((f) => f.endsWith(".json") && f !== `${dateStr}.json`)
    .sort()
    .reverse();

  if (existing.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(scoresDir, existing[0]), "utf-8"));
}

// ── CLI entrypoint ──

if (process.argv[1]?.endsWith("scorer.js")) {
  const args = process.argv.slice(2);
  let agentName = null;
  let file = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") agentName = args[++i];
    if (args[i] === "--file") file = args[++i];
  }

  if (!agentName) {
    console.error("Usage: node tests/scorer.js --agent <name> [--file <filename>]");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, "lab.config.json"), "utf-8"));
  const stageDir = path.join(LAB_ROOT, ".lab-staging", agentName, "workspace");
  const agentWorkspace = path.join(LAB_ROOT, "agents", agentName, "workspace");
  const workspaceDir = fs.existsSync(stageDir) ? stageDir : agentWorkspace;

  console.log(`\n=== Scoring ${agentName} workspace files ===\n`);

  const scores = scoreAllFiles(agentName, workspaceDir, {
    file,
    scoringModel: config.scoring?.model || "haiku",
  });

  const previous = loadPreviousScores(agentName);
  reportDeltas(scores, previous);

  const savedPath = saveScores(agentName, scores);
  console.log(`\n  Scores saved to ${savedPath}`);
}
