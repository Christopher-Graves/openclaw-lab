# OpenClaw Lab — Claude Code Instructions

## What This Is

A workshop for designing, testing, and iterating on OpenClaw agents. Each agent lives in `agents/<name>/` with its own workspace files, test scenarios, rubrics, and results.

## Key Commands

```bash
# Create a new agent
node workshop/init.js

# Start test environment
node docker/setup.js --agent <name> --init

# Run test scenarios
node tests/runner.js --agent <name>

# Run full cycle (test + score + fix)
node tests/cycle.js --agent <name> --fix

# Score workspace files
node tests/scorer.js --agent <name>

# Promote to production
node docker/promote.js --agent <name>
```

## Project Structure

- `agents/<name>/agent.json` — Agent metadata and config
- `agents/<name>/workspace/` — Workspace files (SOUL.md, AGENTS.md, etc.)
- `agents/<name>/scenarios.json` — Test scenarios
- `agents/<name>/rubrics.json` — Scoring rubric definitions
- `agents/<name>/results/` — Test results (gitignored)
- `agents/<name>/scores/` — Score history (gitignored)
- `lab.config.json` — Points to user's OpenClaw installation
- `workshop/templates/` — Starter templates for new agents

## Workshop Flow

When a user says "I want to create an agent that...":

1. Run `node workshop/init.js` to bootstrap the agent directory
2. Help them design the persona in `workspace/SOUL.md`
3. Define capabilities in `workspace/AGENTS.md` and `workspace/TOOLS.md`
4. Add custom test scenarios to `scenarios.json`
5. Start the Docker test env: `node docker/setup.js --agent <name> --init`
6. Run tests: `node tests/runner.js --agent <name>`
7. Iterate on failures — edit workspace files, re-test

## Conventions

- All scripts require `--agent <name>` to specify which agent to operate on
- Scoring uses `claude -p` with stdin pipe (avoids Windows command line limits)
- Results and scores are saved per-agent in their directory
- The `_example-donna` agent shows a complete working example
- Templates use `{{variable}}` syntax (simple string replacement, not Handlebars)

## Testing Notes

- Docker mode sends prompts to the OpenClaw gateway HTTP endpoint
- CLI mode uses `claude -p` directly (for agents without Docker)
- Scenarios marked `skip_docker: true` are skipped in Docker mode
- LLM scoring uses the model specified in `lab.config.json` (default: haiku)
