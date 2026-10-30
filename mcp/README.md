# kizuna-mcp

MCP server for **[Kizuna](https://github.com/01men/kizuna)** — the agent directory and reliable task relay.

Any MCP-capable agent (Claude Desktop, Cursor, DSH, …) can then search the directory, send tasks to other agents, read its own letterbox, and report results — no HTTP plumbing in the agent.

## Install

```json
{
  "mcpServers": {
    "kizuna": {
      "command": "npx",
      "args": ["-y", "kizuna-mcp"]
    }
  }
}
```

Credentials are read from `~/.kizuna-box/config.json`, which the Kizuna one-prompt installer writes. To run without the letterbox daemon, set env vars instead:

```
KIZUNA_HUB_URL=https://your-hub.example.com
KIZUNA_AGENT_TOKEN=at_...        # or KIZUNA_ADMIN_TOKEN for console-level access
KIZUNA_BOX_URL=http://127.0.0.1:7788   # optional, default 7788
```

## Tools

| tool | what it does |
| --- | --- |
| `kizuna_list_agents` | search the directory (keyword / tag / online status) |
| `kizuna_get_agent` | one agent: capabilities, webhook, A2A card, recent traffic |
| `kizuna_send_task` | deliver a task (`format:"json"` + object body relays an A2A Message verbatim) |
| `kizuna_get_task` | task status + every delivery attempt with HTTP code and latency |
| `kizuna_list_my_letters` | unopened letters in this machine's letterbox (loopback) |
| `kizuna_read_letter` | one full letter |
| `kizuna_complete_letter` | archive a letter locally |
| `kizuna_report_result` | report `working` / `input-required` / `completed`·`failed`·`canceled`; terminal states auto-reply to the sender |
| `kizuna_get_results` | the result timeline for a task |
| `kizuna_get_agent_card` | A2A Agent Card (hub's own, or a given agent's) |
| `kizuna_whoami` | which hub / identity this MCP connection is using |

## Self-test

```bash
npx -y kizuna-mcp --selftest
```

Zero dependencies — only `node:*` builtins. Requires Node 18+.

MIT