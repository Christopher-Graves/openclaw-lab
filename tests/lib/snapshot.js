/**
 * snapshot.js — Workspace snapshot save/restore
 *
 * File-based snapshots for fast save/restore during hardening loops.
 * No git — just fs.copyFileSync for ~50KB of markdown files.
 */

import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Save a snapshot of workspace files.
 * @param {string} agentName - Agent directory name
 * @param {string} label - Snapshot label (e.g., "best", "baseline", "iter-5")
 * @param {string} [sourceDir] - Source workspace dir (defaults to agent workspace)
 * @returns {string} Path to snapshot directory
 */
export function saveSnapshot(agentName, label, sourceDir) {
  const agentDir = path.join(LAB_ROOT, "agents", agentName);
  const wsDir = sourceDir || path.join(agentDir, "workspace");
  const snapshotDir = path.join(agentDir, "snapshots", label);

  fs.mkdirSync(snapshotDir, { recursive: true });

  // Clear existing snapshot contents
  for (const file of fs.readdirSync(snapshotDir)) {
    fs.unlinkSync(path.join(snapshotDir, file));
  }

  // Copy all workspace files
  if (fs.existsSync(wsDir)) {
    for (const file of fs.readdirSync(wsDir)) {
      const src = path.join(wsDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(snapshotDir, file));
      }
    }
  }

  return snapshotDir;
}

/**
 * Restore a snapshot to a target directory.
 * @param {string} agentName - Agent directory name
 * @param {string} label - Snapshot label to restore
 * @param {string} [targetDir] - Target workspace dir (defaults to agent workspace)
 * @returns {boolean} Whether restore succeeded
 */
export function restoreSnapshot(agentName, label, targetDir) {
  const agentDir = path.join(LAB_ROOT, "agents", agentName);
  const snapshotDir = path.join(agentDir, "snapshots", label);
  const wsDir = targetDir || path.join(agentDir, "workspace");

  if (!fs.existsSync(snapshotDir)) {
    return false;
  }

  fs.mkdirSync(wsDir, { recursive: true });

  for (const file of fs.readdirSync(snapshotDir)) {
    const src = path.join(snapshotDir, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(wsDir, file));
    }
  }

  return true;
}

/**
 * List available snapshots for an agent.
 * @param {string} agentName - Agent directory name
 * @returns {string[]} Snapshot labels
 */
export function listSnapshots(agentName) {
  const snapshotDir = path.join(LAB_ROOT, "agents", agentName, "snapshots");
  if (!fs.existsSync(snapshotDir)) return [];
  return fs.readdirSync(snapshotDir).filter((f) => {
    return fs.statSync(path.join(snapshotDir, f)).isDirectory();
  });
}

/**
 * Delete a snapshot.
 * @param {string} agentName - Agent directory name
 * @param {string} label - Snapshot label to delete
 */
export function deleteSnapshot(agentName, label) {
  const snapshotDir = path.join(LAB_ROOT, "agents", agentName, "snapshots", label);
  if (fs.existsSync(snapshotDir)) {
    fs.rmSync(snapshotDir, { recursive: true });
  }
}
