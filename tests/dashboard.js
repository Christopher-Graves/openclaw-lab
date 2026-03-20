#!/usr/bin/env node
/**
 * dashboard.js — Generate progress visualization for hardening loops
 *
 * Reads results.tsv and generates an HTML dashboard with:
 * - Pass rate over time (SVG line chart)
 * - Keep/discard ratio
 * - Failing scenarios heatmap
 * - Auto-refresh for live monitoring
 *
 * Usage:
 *   node tests/dashboard.js --agent <name>
 */

import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Generate dashboard HTML for an agent's hardening results.
 * @param {string} agentName - Agent directory name
 * @returns {string} Path to generated dashboard HTML
 */
export function generateDashboard(agentName) {
  const resultsDir = path.join(LAB_ROOT, "agents", agentName, "results");
  const tsvPath = path.join(resultsDir, "results.tsv");

  if (!fs.existsSync(tsvPath)) {
    throw new Error(`No results.tsv found for agent "${agentName}"`);
  }

  const lines = fs.readFileSync(tsvPath, "utf-8").trim().split("\n");
  if (lines.length <= 1) {
    throw new Error("No experiment data in results.tsv");
  }

  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const values = line.split("\t");
    const obj = {};
    headers.forEach((h, i) => (obj[h] = values[i]));
    return obj;
  });

  // Compute stats
  const passRates = rows.map((r) => parseFloat(r.pass_rate));
  const maxRate = Math.max(...passRates);
  const minRate = Math.min(...passRates);
  const kept = rows.filter((r) => r.status === "KEEP").length;
  const discarded = rows.filter((r) => r.status === "DISCARD").length;
  const totalIterations = rows.length - 1; // exclude baseline
  const baseline = passRates[0];
  const current = passRates[passRates.length - 1];

  // Scenario failure heatmap data
  const scenarioFailCounts = {};
  for (const row of rows) {
    if (row.status === "DISCARD" && row.target_scenario !== "-") {
      scenarioFailCounts[row.target_scenario] = (scenarioFailCounts[row.target_scenario] || 0) + 1;
    }
  }
  const sortedScenarios = Object.entries(scenarioFailCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // SVG chart
  const chartWidth = 800;
  const chartHeight = 300;
  const padding = 50;
  const plotWidth = chartWidth - padding * 2;
  const plotHeight = chartHeight - padding * 2;

  const xScale = (i) => padding + (i / (passRates.length - 1 || 1)) * plotWidth;
  const yMin = Math.max(0, minRate - 5);
  const yMax = Math.min(100, maxRate + 5);
  const yScale = (v) => padding + plotHeight - ((v - yMin) / (yMax - yMin || 1)) * plotHeight;

  const pathPoints = passRates.map((rate, i) => `${xScale(i).toFixed(1)},${yScale(rate).toFixed(1)}`);
  const linePath = pathPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");

  // Color dots by status
  const dots = rows.map((row, i) => {
    const color = row.status === "BASELINE" ? "#666" : row.status === "KEEP" ? "#22c55e" : "#ef4444";
    return `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(parseFloat(row.pass_rate)).toFixed(1)}" r="4" fill="${color}" />`;
  }).join("\n        ");

  // Y axis labels
  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    return `<text x="${padding - 10}" y="${y.toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${val.toFixed(0)}%</text>
        <line x1="${padding}" y1="${y.toFixed(1)}" x2="${padding + plotWidth}" y2="${y.toFixed(1)}" stroke="#333" stroke-dasharray="2,4" />`;
  }).join("\n        ");

  // Heatmap bars
  const maxFails = sortedScenarios.length > 0 ? sortedScenarios[0][1] : 1;
  const heatmapBars = sortedScenarios.map(([id, count], i) => {
    const barWidth = (count / maxFails) * 300;
    const intensity = Math.min(255, Math.round((count / maxFails) * 255));
    const color = `rgb(${intensity}, ${Math.max(0, 80 - intensity / 3)}, ${Math.max(0, 80 - intensity / 3)})`;
    return `<div style="display:flex;align-items:center;margin:2px 0">
          <span style="width:100px;font-size:12px;color:#aaa;text-align:right;margin-right:8px">${id}</span>
          <div style="width:${barWidth}px;height:18px;background:${color};border-radius:3px"></div>
          <span style="font-size:11px;color:#888;margin-left:6px">${count}</span>
        </div>`;
  }).join("\n        ");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <title>Hardening Dashboard — ${agentName}</title>
  <style>
    body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, sans-serif; padding: 20px; margin: 0; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat { background: #16213e; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; }
    .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
    .stat-green { color: #22c55e; }
    .stat-red { color: #ef4444; }
    .stat-blue { color: #3b82f6; }
    .stat-yellow { color: #eab308; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; margin: 0 0 12px 0; color: #ccc; }
    .legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: #888; }
    .legend span { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #888; padding: 6px 8px; border-bottom: 1px solid #333; }
    td { padding: 6px 8px; border-bottom: 1px solid #222; }
    .keep { color: #22c55e; }
    .discard { color: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Hardening Dashboard</h1>
    <p class="subtitle">${agentName} — ${new Date().toISOString().slice(0, 19).replace("T", " ")}</p>

    <div class="stats">
      <div class="stat">
        <div class="stat-value stat-blue">${current.toFixed(1)}%</div>
        <div class="stat-label">Pass Rate</div>
      </div>
      <div class="stat">
        <div class="stat-value stat-green">+${(current - baseline).toFixed(1)}%</div>
        <div class="stat-label">Improvement</div>
      </div>
      <div class="stat">
        <div class="stat-value stat-yellow">${totalIterations}</div>
        <div class="stat-label">Iterations</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color:#ccc">${totalIterations > 0 ? ((kept / totalIterations) * 100).toFixed(0) : 0}%</div>
        <div class="stat-label">Keep Rate</div>
      </div>
    </div>

    <div class="card">
      <h2>Pass Rate Over Time</h2>
      <svg width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">
        ${yLabels}
        <path d="${linePath}" fill="none" stroke="#3b82f6" stroke-width="2" />
        ${dots}
        <text x="${chartWidth / 2}" y="${chartHeight - 5}" text-anchor="middle" font-size="12" fill="#888">Iteration</text>
      </svg>
      <div class="legend">
        <span><span class="legend-dot" style="background:#666"></span> Baseline</span>
        <span><span class="legend-dot" style="background:#22c55e"></span> Keep</span>
        <span><span class="legend-dot" style="background:#ef4444"></span> Discard</span>
      </div>
    </div>

    ${sortedScenarios.length > 0 ? `
    <div class="card">
      <h2>Most Targeted Failing Scenarios</h2>
      ${heatmapBars}
    </div>` : ""}

    <div class="card">
      <h2>Experiment Log</h2>
      <table>
        <tr><th>#</th><th>Pass Rate</th><th>Status</th><th>Target</th><th>Mutation</th></tr>
        ${rows.slice(-20).reverse().map((r) => `
        <tr>
          <td>${r.iteration}</td>
          <td>${parseFloat(r.pass_rate).toFixed(1)}%</td>
          <td class="${r.status === "KEEP" ? "keep" : r.status === "DISCARD" ? "discard" : ""}">${r.status}</td>
          <td>${r.target_scenario}</td>
          <td>${(r.description || "").slice(0, 60)}</td>
        </tr>`).join("")}
      </table>
    </div>
  </div>
</body>
</html>`;

  const dashboardPath = path.join(resultsDir, "dashboard.html");
  fs.writeFileSync(dashboardPath, html);
  return dashboardPath;
}

// CLI entrypoint
if (process.argv[1]?.endsWith("dashboard.js")) {
  const args = process.argv.slice(2);
  let agentName = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") agentName = args[++i];
  }
  if (!agentName) {
    console.error("Usage: node tests/dashboard.js --agent <name>");
    process.exit(1);
  }
  try {
    const p = generateDashboard(agentName);
    console.log(`Dashboard generated: ${p}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
