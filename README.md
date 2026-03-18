# OpenClaw Lab

A workshop for designing, testing, and iterating on [OpenClaw](https://github.com/openclaw/openclaw) agents. Collaborate with Claude Code to go from concept to production-ready agent.

## What It Does

1. **Design** — Interactive workshop creates agent workspace files (persona, tools, memory rules)
2. **Test** — Run scenarios against a real OpenClaw instance in Docker
3. **Score** — Grade workspace files against rubrics using LLM evaluation
4. **Fix** — Auto-fix failing tests with minimal prompt engineering edits
5. **Promote** — Diff and copy tested changes to production

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Node.js 22+
- [OpenClaw](https://github.com/openclaw/openclaw) installed at `~/.openclaw`
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude` command available)
- Anthropic API key in `~/.openclaw/.env`

## Quick Start

```bash
# Clone the repo
git clone https://github.com/your-org/openclaw-lab.git
cd openclaw-lab

# Create a new agent (interactive)
node workshop/init.js

# Edit the workspace files to define your agent's persona
# Then start the test environment
node docker/setup.js --agent my-agent --init

# Run the test suite
node tests/runner.js --agent my-agent

# Run the full cycle with auto-fix
node tests/cycle.js --agent my-agent --fix

# When you're happy, promote to production
node docker/promote.js --agent my-agent
```

## Workshop Flow

The real power is collaborating with Claude Code:

```
You: "I want to create a customer support agent called Atlas"

Claude Code:
  1. Runs workshop/init.js → creates agents/atlas/
  2. Asks about persona, tone, tools, boundaries
  3. Generates SOUL.md, AGENTS.md from templates
  4. Creates seed scenarios (identity, security, error handling)
  5. Adds custom scenarios based on the agent's purpose
  6. Spins up Docker test env
  7. Runs initial test suite
  8. Iterates on failures
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `node workshop/init.js` | Create a new agent project |
| `node docker/setup.js --agent <name> --init` | Initialize Docker test environment |
| `node docker/setup.js --agent <name> --refresh` | Pull latest production files |
| `node docker/setup.js --agent <name> --stop` | Stop test container |
| `node docker/setup.js --agent <name> --status` | Check container health |
| `node tests/runner.js --agent <name>` | Run test scenarios |
| `node tests/runner.js --agent <name> --dry-run` | List scenarios without running |
| `node tests/runner.js --agent <name> --scenario DON-001` | Run single scenario |
| `node tests/runner.js --agent <name> --category security` | Run category |
| `node tests/scorer.js --agent <name>` | Score workspace files |
| `node tests/cycle.js --agent <name>` | Test + score + report |
| `node tests/cycle.js --agent <name> --fix` | Test + score + auto-fix + re-test |
| `node tests/cycle.js --agent <name> --fix --promote` | Full cycle with promotion |
| `node docker/promote.js --agent <name>` | Interactive diff + promote |
| `node docker/promote.js --agent <name> --dry-run` | Show diffs without copying |

## Architecture

```
openclaw-lab/
  lab.config.json          ← Points to your OpenClaw installation
  docker/
    docker-compose.yml     ← Generic test gateway container
    setup.js               ← Container lifecycle management
    promote.js             ← Diff + copy to production
  tests/
    runner.js              ← Scenario test runner
    scorer.js              ← Rubric scoring engine
    cycle.js               ← 5-phase orchestrator
  workshop/
    init.js                ← Agent bootstrapper
    templates/             ← Starter workspace files
  agents/
    _example-donna/        ← Working example (20 scenarios)
    your-agent/            ← Your agent project
      agent.json           ← Agent config
      workspace/           ← SOUL.md, AGENTS.md, etc.
      scenarios.json       ← Test scenarios
      rubrics.json         ← Scoring rubrics
      results/             ← Test results (gitignored)
      scores/              ← Score history (gitignored)
```

## How Scoring Works

**Scenario scoring:** Each test scenario has pass criteria and fail patterns. The runner first checks for fail patterns (fast, keyword-based), then uses LLM evaluation for semantic pass criteria.

**Rubric scoring:** Workspace files (SOUL.md, AGENTS.md, etc.) are scored against rubrics with weighted criteria. Each criterion gets 0 to its max weight. Grades: A=90%+, B=75%+, C=60%+, D=40%+, F=<40%.

**Auto-fix:** When tests fail, the fix phase reads the failure reasoning, examines the relevant workspace files, and generates the smallest possible edit to fix the issue. Changes are applied, the container is restarted, and tests re-run.

## How Promotion Works

1. Pulls the latest workspace files from the Docker container
2. Diffs each file against production
3. Shows the diff for review
4. Copies approved changes to the production directory
5. Logs the promotion

## Cost Estimates

- **Test run** (20 scenarios): ~$0.50-2.00 depending on model
- **Scoring** (4 files): ~$0.05-0.10 (uses Haiku)
- **Fix phase** (per failure): ~$0.10-0.50 depending on model
- **Full cycle** with fix: ~$1.00-5.00

## Example Agent

The `_example-donna` directory contains a complete working agent with 20 test scenarios and 4 rubrics. Use it as reference:

```bash
# See all Donna's scenarios
node tests/runner.js --agent _example-donna --dry-run

# Run just security tests
node tests/runner.js --agent _example-donna --category security
```

## No Dependencies

This project uses only Node.js built-in modules. No `npm install` needed.
