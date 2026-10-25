# 100x-token-meter

[![npm version](https://img.shields.io/npm/v/100x-token-meter?color=FE6242&label=npm)](https://www.npmjs.com/package/100x-token-meter)
[![node](https://img.shields.io/node/v/100x-token-meter)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/100x-token-meter)](LICENSE)

See where your Claude Code tokens go. `100x-token-meter` reads Claude Code's local logs and writes one small summary file, `token-meter.json`. Drop that file on the [Token Meter page](https://100x-curriculum.vercel.app/token-meter) to see your numbers in charts, along with your biggest token tax.

```sh
npx 100x-token-meter
```

It runs offline and only reads files. The summary holds totals, tax scores and a cost split by source only: tool, MCP server and skill names, never prompts, code, file names or paths.

## Setup guide

**1. Check you have Node.js 18 or later**

```sh
node -v
```

If that prints nothing or a version below 18, install the LTS version from [nodejs.org](https://nodejs.org).

**2. Run it on the computer where you use Claude Code**

```sh
npx 100x-token-meter
```

npx downloads it the first time. You'll see something like:

```
Read 3,304 requests from 49 sessions (last 30 days).
About $311.03 at API prices. Biggest tax: cache breaks, $25.86.
Wrote /Users/you/token-meter.json. Drop it on the Token Meter page.
```

**3. Load the summary**

Open the [Token Meter page](https://100x-curriculum.vercel.app/token-meter), go to **Your sessions**, and drop `token-meter.json` on **Claude Code**. The file is read in your browser and is never uploaded.

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--days N` | `30` | How many days back to read |
| `--out FILE` | `token-meter.json` | Where to write the summary |
| `--help` | | Show usage |

```sh
npx 100x-token-meter --days 7                  # just the last week
npx 100x-token-meter --out ~/Desktop/tm.json   # write it somewhere else
```

Logs are read from `~/.claude/projects` and `~/.config/claude/projects`. If yours live elsewhere, set `CLAUDE_CONFIG_DIR` (comma-separated for more than one folder):

```sh
CLAUDE_CONFIG_DIR=/path/to/claude npx 100x-token-meter
```

## What it measures

Totals come from the `usage` field on each response, counted once per request. Costs use the bundled `prices.json`, taken from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing); the date it was checked is in the file. Costs are what the same tokens would cost on the API, even if you're on a subscription.

| Tax | Rule |
| --- | --- |
| Noisy output | Tool results over 5,000 tokens (characters ÷ 3.5), written once and re-read on every later request |
| Screenshots | Image blocks, sized from the image itself: ceil(w ÷ 28) × ceil(h ÷ 28), long edge capped at 2,576 px |
| Startup | The cache write on each session's first request: CLAUDE.md, tools, MCP servers |
| Cache breaks | A cache write over 20K tokens after a model change, or after a pause longer than the cache lifetime |
| One model | Short Opus jobs (10 requests or fewer, none writing 300+ tokens): what they cost over Haiku |

### Where it went, by source

`by_source` splits the same total by what was in Claude's context: the startup (system prompt, CLAUDE.md, tool list), your prompts, Claude's replies, each built-in tool, each MCP server, each skill, subagents, and Claude Code's own notes. The skill list and MCP server instructions, which load every session, get their own lines.

Each request's real cost is shared out over its context in proportion to estimated size (characters ÷ 3.5): cache reads over everything already stored, cache writes and input over what is new, output over the blocks Claude wrote. A subagent's whole log counts as Subagents. The split is an estimate; its total matches the real one.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `No Claude Code logs found` | Run it on the machine where you use Claude Code, or point `CLAUDE_CONFIG_DIR` at your Claude folder |
| `No Claude Code requests in the last 30 days` | Read further back, for example `--days 90` |
| `requests on … aren't in prices.json` | Those models have no price yet, so they count as requests but add no cost |
| `npx: command not found` | Install Node.js 18 or later from [nodejs.org](https://nodejs.org) |

## License

MIT
