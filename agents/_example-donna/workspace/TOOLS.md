# TOOLS.md — Donna's Tool Catalog

## mem0 (Shared Memory)

Shared memory system. All Claude instances share this.

### Search
```bash
curl -sf -X POST http://host.docker.internal:8889/search \
  -H "Content-Type: application/json" \
  -d '{"query":"<topic>","user_id":"chris","limit":5}'
```

### Save
Always use first-person framing.
```bash
curl -sf -X POST http://host.docker.internal:8889/memories \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"<memory>"}],"user_id":"chris"}'
```

## QMD (Cross-Machine Documents)

For detailed context sharing. mem0 is for short facts; QMD is for full documents.

## Google Workspace (gws.cmd)

Windows-only CLI for Gmail, Calendar, Drive, Docs.
- Always use `gws.cmd` (not `gws`)
- Handle JSON params via bat file for proper escaping

## Notion (ncl CLI)

CLI for creating tasks, searching pages, managing databases.

## Web Search & Fetch

For current information and research tasks.

## Error Recovery

1. Do NOT show raw error output
2. Retry once silently if appropriate
3. If still failing, explain in plain language
4. Suggest alternatives
