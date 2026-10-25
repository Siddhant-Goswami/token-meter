# 100x-token-meter

[![npm version](https://img.shields.io/npm/v/100x-token-meter?color=FE6242&label=npm)](https://www.npmjs.com/package/100x-token-meter)
[![node](https://img.shields.io/node/v/100x-token-meter)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/100x-token-meter)](LICENSE)

See where your coding agent's tokens go. `100x-token-meter` reads the local logs of **Claude Code**, **Codex CLI**, **Gemini CLI** and **Hermes Agent**, including open models on OpenRouter or Ollama, and writes one small summary file, `token-meter.json`. Drop that file on the [Token Meter page](https://100x-curriculum.vercel.app/token-meter) to see your numbers in charts, along with your biggest token tax.

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

**2. Run it on the computer where you use your coding agent**

```sh
npx 100x-token-meter
```

npx downloads it the first time. It reads every tool it finds. You'll see something like:

```
Read 12,467 requests from 292 sessions (last 30 days).
  Claude Code: 283 sessions, 10,961 requests, $1091.89
  Codex CLI: 9 sessions, 1,506 requests, $68.67
About $1160.56 at API prices. Biggest tax: noisy output, $100.08.
Wrote /Users/you/token-meter.json. Drop it on the Token Meter page.
```

**3. Load the summary**

Open the [Token Meter page](https://100x-curriculum.vercel.app/token-meter), go to **Your sessions**, and drop `token-meter.json` there. The file is read in your browser and is never uploaded.

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--tool NAME` | `all` | `claude`, `codex`, `gemini` or `hermes` to read one tool only |
| `--days N` | `30` | How many days back to read |
| `--out FILE` | `token-meter.json` | Where to write the summary |
| `--help` | | Show usage |

```sh
npx 100x-token-meter --tool codex              # Codex CLI only
npx 100x-token-meter --days 7                  # just the last week
npx 100x-token-meter --out ~/Desktop/tm.json   # write it somewhere else
```

Where the logs are read from, and how to point somewhere else:

| Tool | Folder | Override |
| --- | --- | --- |
| Claude Code | `~/.claude/projects`, `~/.config/claude/projects` | `CLAUDE_CONFIG_DIR` (comma-separated for more than one) |
| Codex CLI | `~/.codex/sessions`, `~/.codex/archived_sessions` | `CODEX_HOME` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats` | `GEMINI_CLI_HOME` |
| Hermes Agent | `~/.hermes/state.db` | `HERMES_HOME` |

Hermes keeps a SQLite database, which needs Node 22.13 or later to read. On older Node the other tools still run and Hermes is skipped with a note. Hermes stores totals per session and model, not each request, so its sessions add to the totals and the model table but have no tax scores or split by source; `by_tool` lists what each tool could measure.

## What it measures

Totals come from each response's own usage numbers, counted once per request. Costs use the bundled `prices.json`, taken from [Anthropic's](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI's](https://developers.openai.com/api/docs/pricing) and [Google's](https://ai.google.dev/gemini-api/docs/pricing) pricing pages; the date they were checked is in the file. Costs are what the same tokens would cost on the API, even if you're on a subscription.

Open models are priced at [OpenRouter's](https://openrouter.ai/models) rates. A model you run on your own machine (Ollama, LM Studio) bills nothing, so it is priced as the same model hosted on OpenRouter, marked `local` in `by_model`, and summed in `local`. Ollama tags are matched only where the family and size match (`llama3.2:3b` is Llama 3.2 3B); others, such as `qwen3:8b`, which OpenRouter doesn't host, show as not priced.

| Tax | Rule |
| --- | --- |
| Noisy output | Tool results over 5,000 tokens (characters ÷ 3.5), written once and re-read on every later request |
| Screenshots | Image blocks, by each provider's rule: Claude counts 28 px squares, OpenAI 32 px squares × 1.2, Gemini a flat 1,120 per image |
| Startup | The new tokens on each session's first request: system prompt, CLAUDE.md / AGENTS.md / GEMINI.md, tools, MCP servers |
| Cache breaks | Over 20K new tokens after a model change, or after a pause longer than the cache lifetime |
| One model | Short jobs on the top model (10 requests or fewer, none writing 300+ tokens): what they cost over the same provider's small model |

### Where it went, by source

`by_source` splits the same total by what was in the model's context: the startup (system prompt, memory file, tool list), your prompts, the replies, each built-in tool, each MCP server, each skill, subagents, and the tool's own notes.

Each request's real cost is shared out over its context in proportion to estimated size (characters ÷ 3.5): cache reads over everything already stored, cache writes and input over what is new, output over the blocks the model wrote. A Claude Code subagent's whole log counts as Subagents. The split is an estimate; its total matches the real one.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `No … requests in the last 30 days` | Read further back with `--days 90`, run it on the machine where you use the tool, or set the folder override above |
| `requests on … aren't in prices.json` | Those models have no price yet, so they count as requests but add no cost |
| `Skipped Hermes Agent` | Its log is SQLite; update to Node 22.13 or later |
| `npx: command not found` | Install Node.js 18 or later from [nodejs.org](https://nodejs.org) |

## License

MIT
