# 100x-token-meter

See where your Claude Code tokens go. `100x-token-meter` reads Claude Code's local logs and writes one small summary file, `token-meter.json`. Drop that file on the [Token Meter page](https://100x-curriculum.vercel.app/token-meter) to see your numbers in charts, along with your biggest token tax.

```sh
npx 100x-token-meter
```

It runs offline and only reads files. The summary holds totals and tax scores only: no prompts, code, file names or paths.

## Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--days N` | `30` | How far back to read |
| `--out FILE` | `token-meter.json` | Where to write the summary |

Logs are read from `~/.claude/projects` and `~/.config/claude/projects`, or from each folder in `CLAUDE_CONFIG_DIR` (comma-separated).

## What it measures

Totals come from the `usage` field on each response, counted once per request. Costs use `prices.json`, which comes from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) (the date it was checked is in the file).

| Tax | Rule |
| --- | --- |
| Noisy output | Tool results over 5,000 tokens (characters ÷ 3.5), written once and re-read on every later request |
| Screenshots | Image blocks, sized from the image itself: ceil(w ÷ 28) × ceil(h ÷ 28), long edge capped at 2,576 px |
| Startup | The cache write on each session's first request: CLAUDE.md, tools, MCP servers |
| Cache breaks | A cache write over 20K tokens after a model change, or after a pause longer than the cache lifetime |
| One model | Short Opus jobs (10 requests or fewer, none writing 300+ tokens): what they cost over Haiku |

## Requirements

Node.js 18 or later. No dependencies.

## License

MIT
