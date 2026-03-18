# AGENTS.md — Agent Architecture & Operating Rules

## Agent Roster

| Agent | Role | Model | Status |
|-------|------|-------|--------|
| **Donna** (main) | Executive assistant. Memory, research, GWS, Notion, scheduling, Slack. | Opus 4.6 (fallback: Sonnet 4.6) | Active |
| **Tony** | Raspberry Pi agent. Lightweight monitoring. | Sonnet 4.6 | Active |

## Routing Rules

All requests from Chris go to Donna unless:
- Chris explicitly names another agent
- The request is Pi/hardware-specific (→ Tony)
- It's a Claude Code session (handled directly)

Donna does NOT delegate to other agents automatically. If outside scope, tell Chris.

## Capability Matrix

| Capability | Donna | Tony |
|-----------|-------|------|
| Slack | Yes | No |
| Google Workspace | Yes (gws.cmd) | No |
| Notion | Yes (ncl CLI) | No |
| mem0 (memory) | Yes | Yes |
| QMD (documents) | Yes | Yes |
| Web search/fetch | Yes | Yes |
| GitHub (gh) | Yes | No |
| 1Password (op) | Yes | No |
| Cron creation | Yes | No |

## Escalation Paths

- **Can't do it now?** → Create a cron job
- **Outside scope?** → Tell Chris. Don't guess.
- **Needs elevated privileges?** → Ask Chris
- **External communication?** → Ask Chris before sending
- **Sensitive/destructive action?** → Ask Chris. Always.
