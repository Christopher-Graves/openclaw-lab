/**
 * tracker.js — Experiment tracking for hardening loops
 *
 * Manages two audit trail files per agent:
 * - results.tsv: one row per experiment (machine-readable)
 * - changelog.md: detailed mutation log (human-readable)
 */

import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "../..");

const TSV_HEADER = "iteration\tpass_rate\tpassed\ttotal\tstatus\ttarget_scenario\tmutation_file\tmutation_type\tdescription";

export class ExperimentTracker {
  /**
   * @param {string} agentName - Agent directory name
   */
  constructor(agentName) {
    this.agentName = agentName;
    this.resultsDir = path.join(LAB_ROOT, "agents", agentName, "results");
    fs.mkdirSync(this.resultsDir, { recursive: true });

    this.tsvPath = path.join(this.resultsDir, "results.tsv");
    this.changelogPath = path.join(this.resultsDir, "changelog.md");
  }

  /**
   * Initialize tracking files for a new loop run.
   * @param {object} baseline - { passRate, passed, total }
   */
  initRun(baseline) {
    // Write TSV header + baseline row
    const baselineRow = [
      0,
      baseline.passRate.toFixed(1),
      baseline.passed,
      baseline.total,
      "BASELINE",
      "-",
      "-",
      "-",
      "baseline",
    ].join("\t");

    fs.writeFileSync(this.tsvPath, TSV_HEADER + "\n" + baselineRow + "\n");

    // Write changelog header
    const dateStr = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = [
      `# Hardening Loop Changelog — ${this.agentName}`,
      "",
      `Started: ${dateStr}`,
      `Baseline pass rate: ${baseline.passRate.toFixed(1)}% (${baseline.passed}/${baseline.total})`,
      "",
      "---",
      "",
    ].join("\n");

    fs.writeFileSync(this.changelogPath, header);
  }

  /**
   * Log an experiment result.
   * @param {object} experiment
   * @param {number} experiment.iteration
   * @param {number} experiment.passRate
   * @param {number} experiment.passed
   * @param {number} experiment.total
   * @param {string} experiment.status - "KEEP" or "DISCARD"
   * @param {string} experiment.targetScenario - Scenario ID targeted
   * @param {object} experiment.mutation - { file, type, description, reasoning, search, replace }
   * @param {number} [experiment.previousPassRate] - Pass rate before this experiment
   * @param {string[]} [experiment.sideEffects] - Scenarios that changed state
   */
  logExperiment(experiment) {
    const {
      iteration,
      passRate,
      passed,
      total,
      status,
      targetScenario,
      mutation,
      previousPassRate,
      sideEffects,
    } = experiment;

    // Append TSV row
    const row = [
      iteration,
      passRate.toFixed(1),
      passed,
      total,
      status,
      targetScenario,
      mutation.file || "-",
      mutation.type || "-",
      (mutation.description || "").replace(/\t/g, " ").replace(/\n/g, " "),
    ].join("\t");

    fs.appendFileSync(this.tsvPath, row + "\n");

    // Append changelog entry
    const prevStr = previousPassRate != null ? `${previousPassRate.toFixed(1)}%` : "?";
    const arrow = status === "KEEP" ? `${prevStr} -> ${passRate.toFixed(1)}%` : `${prevStr} (unchanged)`;

    const lines = [
      `## Experiment ${iteration} (${status}) — ${arrow}`,
      `- **Target:** ${targetScenario}`,
      `- **Mutation:** ${mutation.description || "no description"}`,
      `- **File:** ${mutation.file || "none"}`,
      `- **Type:** ${mutation.type || "unknown"}`,
    ];

    if (mutation.reasoning) {
      lines.push(`- **Reasoning:** ${mutation.reasoning}`);
    }

    if (sideEffects && sideEffects.length > 0) {
      lines.push(`- **Side effects:** ${sideEffects.join(", ")}`);
    } else {
      lines.push(`- **Side effects:** None`);
    }

    lines.push("");
    fs.appendFileSync(this.changelogPath, lines.join("\n") + "\n");
  }

  /**
   * Log a proposed scenario.
   * @param {object} scenario - The proposed scenario object
   */
  logProposedScenario(scenario) {
    const lines = [
      `## PROPOSED SCENARIO: ${scenario.id}`,
      `- **Name:** ${scenario.name}`,
      `- **Category:** ${scenario.category}`,
      `- **Prompt:** ${scenario.prompt}`,
      `- **Criteria:** ${(scenario.binary_criteria || scenario.pass_criteria || []).join("; ")}`,
      "",
    ];
    fs.appendFileSync(this.changelogPath, lines.join("\n") + "\n");
  }

  /**
   * Log final summary when loop completes.
   * @param {object} summary
   * @param {string} summary.reason - Why loop stopped
   * @param {number} summary.iterations - Total iterations run
   * @param {number} summary.finalPassRate
   * @param {number} summary.baselinePassRate
   * @param {number} summary.kept - Number of kept mutations
   * @param {number} summary.discarded - Number of discarded mutations
   */
  logSummary(summary) {
    const lines = [
      "---",
      "",
      `## Final Summary`,
      `- **Stop reason:** ${summary.reason}`,
      `- **Iterations:** ${summary.iterations}`,
      `- **Baseline:** ${summary.baselinePassRate.toFixed(1)}%`,
      `- **Final:** ${summary.finalPassRate.toFixed(1)}%`,
      `- **Improvement:** +${(summary.finalPassRate - summary.baselinePassRate).toFixed(1)}%`,
      `- **Kept:** ${summary.kept}`,
      `- **Discarded:** ${summary.discarded}`,
      `- **Keep rate:** ${summary.iterations > 0 ? ((summary.kept / summary.iterations) * 100).toFixed(0) : 0}%`,
      "",
    ];
    fs.appendFileSync(this.changelogPath, lines.join("\n") + "\n");
  }

  /**
   * Read the results TSV as an array of objects.
   * @returns {object[]}
   */
  readResults() {
    if (!fs.existsSync(this.tsvPath)) return [];
    const lines = fs.readFileSync(this.tsvPath, "utf-8").trim().split("\n");
    if (lines.length <= 1) return [];

    const headers = lines[0].split("\t");
    return lines.slice(1).map((line) => {
      const values = line.split("\t");
      const obj = {};
      headers.forEach((h, i) => (obj[h] = values[i]));
      return obj;
    });
  }
}
