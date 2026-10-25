#!/usr/bin/env node
/* token-meter: reads your coding agents' local logs and writes token-meter.json. Offline, read-only, no dependencies.
   Claude Code   every .jsonl under ~/.claude/projects (or CLAUDE_CONFIG_DIR)
   Codex CLI     every .jsonl under ~/.codex/sessions and ~/.codex/archived_sessions (or CODEX_HOME)
   Gemini CLI    every session file under ~/.gemini/tmp/<project>/chats (or GEMINI_CLI_HOME)
   OpenCode      ~/.local/share/opencode/opencode.db, or the older storage/message folders (or XDG_DATA_HOME)
   Hermes Agent  ~/.hermes/state.db (or HERMES_HOME). It keeps totals per session and model only, so it has no taxes or by_source
   OpenCode and Hermes keep SQLite files, read with node:sqlite (Node 22.13 or later); on older Node they're skipped with a note.
   Open models (OpenRouter, Ollama) are priced from prices.json's "open" entry; one run on your own machine is priced as the same model hosted.
   Usage: npx 100x-token-meter [--days 30] [--tool all|claude|codex|gemini|opencode|hermes] [--out token-meter.json]
   The output holds totals and tax scores only: no prompts, code, file names or paths.
   Totals come from each response's own usage numbers, deduplicated by request or response id. Each reader turns its log into
   the same shape (requests with usage, and the blocks added to the context between them) so one engine prices them all:
     usage   input (new, uncached), read (cache hits), write (stored at the short lifetime), write_long (the long one), output (with thinking)
   Tax scores, as in the Token Meter spec:
     noisy_output  tool results over 5,000 tokens (characters ÷ 3.5), priced as written once and re-read on every later request
     screenshots   image blocks, tokens from the image's own size and the provider's rule in prices.json
     startup       the new tokens on each session's first request (system prompt, CLAUDE.md / AGENTS.md / GEMINI.md, tools, MCP servers)
     cache_breaks  over 20K new tokens after a model change or a pause past the cache lifetime: the extra over reading them from the cache
     one_model     short jobs on the provider's top model (a session with at most 10 requests, none writing 300 tokens or more):
                   what they cost over its small model. Counting every short request would flag each step of an agent loop,
                   where a switch would break the cache
   by_source splits the same total by where the tokens came from: the startup, your prompts, the replies, each built-in tool,
   each MCP server, each skill, subagents, and the tool's own notes.
   Each request's real cost is shared out over what was in the context, in proportion to estimated tokens (characters ÷ 3.5):
   cache reads over everything already stored, cache writes and input over what is new, output over the blocks the model wrote.
   Names only (tool, server, skill); never the text. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const USAGE = 'Usage: npx 100x-token-meter [--days 30] [--tool all|claude|codex|gemini|opencode|hermes] [--out token-meter.json]';
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const DAYS = +opt('--days', 30), OUT = opt('--out', 'token-meter.json'), ONLY = opt('--tool', 'all');
if (!['all', 'claude', 'codex', 'gemini', 'opencode', 'hermes'].includes(ONLY)) { console.error(USAGE); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const PR = JSON.parse(fs.readFileSync(path.join(here, 'prices.json'), 'utf8'));
const NOISY = 5000, BREAK = 20000, SHORT = 300;
const since = Date.now() - DAYS * 864e5;

/* ---------- prices: every provider in prices.json ---------- */
/* a missing cache_write means storing costs the normal input price; fill it in once so the maths needn't ask */
function fill(p) { if (p.cache_write == null) p.cache_write = p.input; if (p.cache_write_1h == null) p.cache_write_1h = p.cache_write; return p; }
const MODELS = [];
for (const [prov, P] of Object.entries(PR.providers)) for (const [key, m] of Object.entries(P.models)) {
  fill(m); if (m.long_prompt) fill(m.long_prompt); if (m.next) fill(m.next);
  MODELS.push({ prov, key, id: m.id || key, m });
}
const found = new Map();
/* exact id, then the longest id the name starts with (gpt-6.1-sol-codex), then the provider's aliases (any Claude name with "opus",
   an Ollama tag), then a router's vendor/model id without the vendor (google/gemini-3.8-flash) */
function lookup(model) {
  const s = String(model || '').toLowerCase().replace(/^openrouter\//, '');
  if (found.has(s)) return found.get(s);
  let hit = MODELS.find(x => x.id === s || x.key === s) || MODELS.filter(x => s.startsWith(x.id)).sort((a, b) => b.id.length - a.id.length)[0];
  if (!hit) for (const [prov, P] of Object.entries(PR.providers)) {
    const a = Object.entries(P.aliases || {}).find(([re]) => new RegExp(re).test(s));
    if (a) { hit = MODELS.find(x => x.prov === prov && x.key === a[1]); break; }
  }
  if (!hit && s.includes('/')) hit = lookup(s.slice(s.lastIndexOf('/') + 1));
  /* and the reverse: a vendor's own API names glm-5.3 what OpenRouter calls z-ai/glm-5.3 */
  if (!hit) hit = MODELS.filter(x => x.id.includes('/') && s.startsWith(x.id.split('/')[1])).sort((a, b) => b.id.length - a.id.length)[0];
  found.set(s, hit || null);
  return hit || null;
}
/* the price in force at time t: an announced change applies from its date, the long-prompt tier past its size */
function rates(model, prompt, t) {
  const hit = lookup(model); if (!hit) return null;
  let p = hit.m;
  if (p.next && t >= Date.parse(p.next.from)) p = Object.assign({}, p, p.next);
  if (p.long_prompt && prompt > p.long_prompt.over_tokens) p = Object.assign({}, p, p.long_prompt);
  return Object.assign({ prov: hit.prov, key: hit.key }, p);
}
const prompt = u => u.input + u.read + u.write + u.write_long;
function cost(u, model, t) {
  const p = rates(model, prompt(u), t);
  if (!p) return null;
  return { input: u.input * p.input / 1e6, output: u.output * p.output / 1e6,
    cache_write: (u.write * p.cache_write + u.write_long * p.cache_write_1h) / 1e6, cache_read: u.read * p.cache_read / 1e6, p };
}
const sumC = c => c.input + c.output + c.cache_write + c.cache_read;

const est = s => Math.ceil(String(s || '').length / 3.5);
/* image size from the first bytes of a PNG, GIF or JPEG */
function imageSize(b64) {
  let w = 0, h = 0;
  try {
    const buf = Buffer.from(b64.slice(0, 90000), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
    else if (buf[0] === 0x47 && buf[1] === 0x49) { w = buf.readUInt16LE(6); h = buf.readUInt16LE(8); }
    else if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < buf.length - 9;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) {}
  return w && h ? { w, h } : { w: 1100, h: 1100 }; /* unknown format: about 1,100 × 1,100 px */
}
/* the same rule the page uses in module 3, from the provider's image entry */
function imageTokens(b64, prov) {
  const I = PR.providers[prov].image;
  if (I.scheme === 'flat') return I.levels[I.default];
  let { w, h } = imageSize(b64);
  const long = Math.max(w, h); if (I.cap && long > I.cap) { w = Math.round(w * I.cap / long); h = Math.round(h * I.cap / long); }
  return Math.ceil(Math.ceil(w / I.px) * Math.ceil(h / I.px) * (I.mult || 1));
}
const dataB64 = url => { const m = /^data:[^;]+;base64,(.*)$/.exec(url || ''); return m ? m[1] : ''; };

/* ---------- where the logs are ---------- */
const home = os.homedir();
function walk(d, test, out) {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, test, out); else if (test(p)) out.push(p); }
  return out;
}
const recent = f => { try { return fs.statSync(f).mtimeMs >= since; } catch (e) { return false; } };
const TOOLS = {
  'claude-code': {
    flag: 'claude', label: 'Claude Code', provider: 'anthropic', setup: 'System prompt, CLAUDE.md and tool definitions',
    files: () => (process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR.split(',') : [path.join(home, '.claude'), path.join(home, '.config', 'claude')])
      .flatMap(d => walk(path.join(d.trim(), 'projects'), p => p.endsWith('.jsonl'), [])),
    read: readClaude
  },
  codex: {
    flag: 'codex', label: 'Codex CLI', provider: 'openai', setup: 'System prompt and tool definitions',
    files: () => { const d = process.env.CODEX_HOME || path.join(home, '.codex'); return ['sessions', 'archived_sessions'].flatMap(s => walk(path.join(d, s), p => p.endsWith('.jsonl'), [])); },
    read: readCodex
  },
  'gemini-cli': {
    flag: 'gemini', label: 'Gemini CLI', provider: 'google', setup: 'System prompt, GEMINI.md and tool definitions',
    files: () => walk(path.join(process.env.GEMINI_CLI_HOME || home, '.gemini', 'tmp'), p => /[\\/]chats[\\/][^\\/]+\.jsonl?$/.test(p), []),
    read: readGemini
  },
  opencode: {
    flag: 'opencode', label: 'OpenCode', provider: null, setup: 'System prompt, AGENTS.md and tool definitions', sqlite: true,
    files: () => {
      const d = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode'), db = path.join(d, 'opencode.db'), msg = path.join(d, 'storage', 'message');
      return [...(fs.existsSync(db) ? [db] : []), ...(fs.existsSync(msg) ? fs.readdirSync(msg).map(x => path.join(msg, x)) : [])];
    },
    read: readOpencode
  },
  hermes: {
    flag: 'hermes', label: 'Hermes Agent', provider: null, setup: 'System prompt, SOUL.md and tool definitions', sqlite: true,
    files: () => { const db = path.join(process.env.HERMES_HOME || path.join(home, '.hermes'), 'state.db'); return fs.existsSync(db) ? [db] : []; },
    read: readHermes
  }
};
/* node:sqlite is built in from Node 22.13 (22.5 behind a flag). Loaded only when a SQLite log exists, without its "experimental" warning */
let SQL;
async function loadSqlite() {
  if (SQL !== undefined) return SQL;
  const warn = process.emitWarning;
  process.emitWarning = (w, ...a) => { if (!/SQLite/.test(String(w && w.message || w))) warn.call(process, w, ...a); };
  try { SQL = (await import('node:sqlite')).DatabaseSync; } catch (e) { SQL = null; }
  return SQL;
}
const openDb = f => new SQL(f, { readOnly: true });
/* a local server (Ollama, LM Studio, llama.cpp) bills nothing; its tokens are priced as the same model hosted, and marked local */
const isLocal = (prov, url) => /^(ollama|lmstudio|llama\.?cpp|local)/i.test(prov || '') || /localhost|127\.0\.0\.1|0\.0\.0\.0|:11434\b/.test(url || '');

/* ---------- readers: one log file in, sessions out ---------- */
/* a session: { id, side (a subagent's own log), ttl (cache lifetime in minutes), reqs: [{t, model, u, out}],
   events: the context in log order, either {req} or {key, tokens}, blocks: big tool results and images, {kind, tokens, at} } */
/* split: the log has the context between requests, so by_source works. coarse: one entry stands for many requests (n of them),
   so only totals and by_model work */
const seen = new Set();
const session = () => ({ id: null, side: false, ttl: 5, reqs: [], events: [], blocks: [], split: true, coarse: false });
function addReq(s, r) { s.reqs.push(r); s.events.push({ req: r }); }
function addImage(s, b64, prov, key) { const tk = imageTokens(b64, prov); s.blocks.push({ kind: 'img', tokens: tk, at: s.reqs.length }); s.events.push({ key, tokens: tk }); }
function addResult(s, key, tokens) { if (tokens > NOISY) s.blocks.push({ kind: 'noisy', tokens, at: s.reqs.length }); s.events.push({ key, tokens }); }

/* Claude Code: one response is logged as several lines, so keep the fullest usage per request id */
const ATTACH = { skill_listing: 'skill:Skill list, loaded every session', mcp_instructions_delta: 'mcp:Server instructions, loaded every session',
  deferred_tools_delta: 'setup:Tool list', deferred_tools_record: 'setup:Tool list', agent_listing_delta: 'setup:Subagent list' };
const BUILTIN = new Set(['model', 'clear', 'compact', 'config', 'help', 'cost', 'context', 'memory', 'login', 'logout', 'status', 'resume', 'permissions', 'mcp', 'agents', 'hooks', 'exit', 'fast', 'usage', 'doctor', 'ide', 'theme', 'plugin', 'export', 'rewind']);
function claudeKey(name, input) {
  if (/^mcp__/.test(name)) return 'mcp:' + name.split('__')[1];
  if (name === 'Skill') return 'skill:' + String((input && (input.skill || input.command)) || 'unknown').replace(/^\//, '');
  if (name === 'Task' || name === 'Agent') return 'agent';
  return 'tool:' + name;
}
function readClaude(f) {
  const s = session(), byId = new Map(), toolKey = new Map();
  s.side = f.includes(path.sep + 'subagents' + path.sep);
  let lastCmd = null, long = false;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch (e) { continue; }
    if (d.isSidechain) s.side = true;
    const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!(t >= since)) continue;
    const m = d.message;
    if (d.type === 'assistant' && m && m.usage) {
      const id = d.requestId || m.id;
      if (!id || m.model === '<synthetic>') continue;
      let r = byId.get(id);
      if (!r) {
        if (seen.has(id)) continue; seen.add(id); /* the same request logged in another file */
        r = { t, model: m.model || 'unknown', raw: m.usage, out: [] }; byId.set(id, r); addReq(s, r);
        if (d.sessionId) s.id = d.sessionId;
      } else if ((m.usage.output_tokens || 0) >= (r.raw.output_tokens || 0)) r.raw = m.usage;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_use') { const k = claudeKey(b.name, b.input); toolKey.set(b.id, k); r.out.push({ key: k, tokens: est(JSON.stringify(b.input || {})), call: 1 }); }
        else if (b.type === 'text' || b.type === 'thinking') r.out.push({ key: 'replies', tokens: est(b.text || b.thinking || '') });
      }
    } else if (d.type === 'user' && m) {
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];
      for (const b of content) {
        if (b.type === 'image' && b.source && b.source.data) addImage(s, b.source.data, 'anthropic', d.isMeta ? 'notes' : 'prompts');
        else if (b.type === 'tool_result') {
          const key = toolKey.get(b.tool_use_id) || 'notes';
          const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: typeof b.content === 'string' ? b.content : '' }];
          let text = 0;
          for (const x of inner) {
            if (x.type === 'image' && x.source && x.source.data) addImage(s, x.source.data, 'anthropic', key);
            else if (x.type === 'text' && x.text) text += est(x.text);
          }
          addResult(s, key, text);
        } else if (b.type === 'text' && b.text) {
          /* a skill's instructions arrive as a meta message after the Skill call, or after you type its slash command */
          const cmd = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(b.text);
          let key = 'prompts';
          if (d.isMeta) key = d.sourceToolUseID && toolKey.get(d.sourceToolUseID) ? toolKey.get(d.sourceToolUseID) : lastCmd && !BUILTIN.has(lastCmd) ? 'skill:' + lastCmd : 'notes';
          else if (/^<(local-command|system-reminder|bash-|task-notification)/.test(b.text.trim())) key = 'notes';
          s.events.push({ key, tokens: est(b.text) });
          lastCmd = cmd ? cmd[1] : d.isMeta ? null : lastCmd;
        }
      }
    } else if (d.type === 'attachment' && d.attachment && d.attachment.type !== 'prompt_snapshot') {
      s.events.push({ key: ATTACH[d.attachment.type] || 'notes', tokens: est(JSON.stringify(d.attachment)) });
    }
  }
  for (const r of s.reqs) {
    const u = r.raw, cc = u.cache_creation;
    const w5 = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0, w1 = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
    if (w1) long = true;
    r.u = { input: u.input_tokens || 0, read: u.cache_read_input_tokens || 0, write: w5, write_long: w1, output: u.output_tokens || 0 };
    delete r.raw;
  }
  s.ttl = PR.providers.anthropic.cache.ttl_minutes[long ? 'app' : 'api'];
  return [s];
}

/* Codex CLI: a rollout file per session. The model's output items come before the usage record of the response that wrote them.
   input_tokens counts everything sent, so the uncached part is input minus cached minus written. Reasoning is inside output_tokens */
const textParts = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : x && x.text || '').join('') : c && typeof c === 'object' ? JSON.stringify(c) : '';
const imageParts = c => Array.isArray(c) ? c.filter(x => x && x.type === 'input_image').map(x => dataB64(x.image_url)).filter(Boolean) : [];
function codexKey(p) {
  const ns = String(p.namespace || ''), name = String(p.name || p.type || 'tool');
  if (/^mcp__/.test(ns)) return 'mcp:' + ns.split('__')[1];
  if (/^mcp__/.test(name)) return 'mcp:' + name.split('__')[1];
  if (/^(spawn_agent|agent|delegate)/.test(name)) return 'agent';
  return 'tool:' + name.replace(/_call$/, '');
}
function readCodex(f) {
  const s = session(), callKey = new Map(), text = fs.readFileSync(f, 'utf8');
  const records = text.includes('"token_usage_record"'); /* older files only have token_count events */
  let model = 'unknown', out = [];
  s.ttl = PR.providers.openai.cache.ttl_minutes.api;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch (e) { continue; }
    const p = d.payload || {}, t = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (d.type === 'session_meta') { s.id = p.id || p.session_id || f; if (p.source && /subagent/i.test(JSON.stringify(p.source))) s.side = true; continue; }
    if (d.type === 'turn_context' && p.model) { model = p.model; continue; }
    if (!(t >= since)) continue;
    let usage = null, id = null;
    if (d.type === 'token_usage_record') { usage = p.usage; id = p.response_id; }
    else if (!records && d.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) { usage = p.info.last_token_usage; id = f + d.timestamp; }
    if (usage) {
      if (!id || seen.has(id)) { out = []; continue; } seen.add(id);
      const cached = usage.cached_input_tokens || 0, write = usage.cache_write_input_tokens || 0;
      const u = { input: Math.max(0, (usage.input_tokens || 0) - cached - write), read: cached, write, write_long: 0, output: usage.output_tokens || 0 };
      if (usage.reasoning_output_tokens) out.push({ key: 'replies', tokens: usage.reasoning_output_tokens });
      addReq(s, { t, model: p.model || model, u, out }); out = [];
      continue;
    }
    if (d.type !== 'response_item') continue;
    if (p.type === 'additional_tools') s.events.push({ key: 'setup:Tool list', tokens: est(JSON.stringify(p.tools || [])) });
    else if (p.type === 'message') {
      const body = textParts(p.content), trimmed = body.trim();
      if (p.role === 'assistant') { out.push({ key: 'replies', tokens: est(body) }); continue; }
      const key = p.role === 'developer' || p.role === 'system' ? 'setup:Instructions Codex adds'
        : /^(# AGENTS\.md|<environment_context|<user_instructions|<INSTRUCTIONS)/.test(trimmed) ? 'setup:AGENTS.md and environment'
        : /^<[a-z_-]+[ >]/.test(trimmed) ? 'notes' : 'prompts';
      s.events.push({ key, tokens: est(body) });
      imageParts(p.content).forEach(b => addImage(s, b, 'openai', key));
    } else if (/_call$/.test(p.type)) {
      const k = codexKey(p); if (p.call_id) callKey.set(p.call_id, k);
      out.push({ key: k, tokens: est(p.arguments || p.input || JSON.stringify(p.action || {})), call: 1 });
    } else if (/_call_output$/.test(p.type)) {
      const key = callKey.get(p.call_id) || 'notes', o = p.output && p.output.content !== undefined ? p.output.content : p.output;
      imageParts(o).forEach(b => addImage(s, b, 'openai', key));
      addResult(s, key, est(textParts(o)));
    } else if (p.type === 'reasoning') { /* its size is in the usage record's reasoning_output_tokens */ }
  }
  if (!s.id) s.id = f;
  return [s];
}

/* Gemini CLI: one JSON file per session, a list of messages. Each "gemini" message is one request and carries its own token counts:
   input includes the cached part; thoughts are billed as output. Tool results ride in the same message and reach the next request */
function geminiKey(name) {
  if (/__/.test(name)) return 'mcp:' + name.split('__')[0];
  if (/^(delegate|agent|subagent)/i.test(name)) return 'agent';
  if (name === 'activate_skill') return 'skill:unknown';
  return 'tool:' + name;
}
const partsText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : x && x.text || '').join('') : '';
function readGemini(f) {
  const s = session(), raw = fs.readFileSync(f, 'utf8');
  let msgs = [];
  if (f.endsWith('.jsonl')) msgs = raw.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(m => m && m.type);
  else { try { const d = JSON.parse(raw); msgs = d.messages || []; s.id = d.sessionId; } catch (e) { return []; } }
  s.id = s.id || f; s.ttl = PR.providers.google.cache.ttl_minutes.api;
  for (const m of msgs) {
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!(t >= since)) continue;
    if (m.type === 'user') {
      const body = partsText(m.content);
      s.events.push({ key: /^\s*<[a-z_-]+[ >]/.test(body) ? 'notes' : 'prompts', tokens: est(body) });
      (Array.isArray(m.content) ? m.content : []).forEach(x => { if (x && x.inlineData && /^image\//.test(x.inlineData.mimeType || '')) addImage(s, x.inlineData.data || '', 'google', 'prompts'); });
    } else if (m.type === 'gemini' && m.tokens) {
      const id = m.id ? 'g' + m.id : null;
      if (id && seen.has(id)) continue; if (id) seen.add(id);
      const k = m.tokens, calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const u = { input: Math.max(0, (k.input || 0) - (k.cached || 0)) + (k.tool || 0), read: k.cached || 0, write: 0, write_long: 0, output: (k.output || 0) + (k.thoughts || 0) };
      const out = [{ key: 'replies', tokens: est(partsText(m.content)) + (k.thoughts || 0) }];
      calls.forEach(c => out.push({ key: geminiKey(c.name || 'tool'), tokens: est(JSON.stringify(c.args || {})), call: 1 }));
      addReq(s, { t, model: m.model || 'unknown', u, out });
      calls.forEach(c => {
        const key = geminiKey(c.name || 'tool'), res = Array.isArray(c.result) ? c.result : [];
        res.forEach(x => { if (x && x.inlineData && /^image\//.test(x.inlineData.mimeType || '')) addImage(s, x.inlineData.data || '', 'google', key); });
        addResult(s, key, est(JSON.stringify(res.map(x => x && x.functionResponse ? x.functionResponse.response : x))));
      });
    }
  }
  return [s];
}

/* OpenCode: each assistant message carries its own tokens (input is the uncached part; reasoning is billed as output but counted
   apart). Newer versions keep them in opencode.db (session_message.data), older ones one JSON file per message under
   storage/message/<session>. A session with no per-message counts falls back to session_v2's totals. The text isn't read for by_source */
function ocUsage(d) {
  const k = d && (d.tokens || d.usage);
  if (!k || typeof k !== 'object') return null;
  const c = k.cache || {}, n = v => +v || 0;
  const u = { input: n(k.input ?? k.input_tokens ?? k.inputTokens), read: n(c.read ?? k.cache_read ?? k.cacheRead), write: n(c.write ?? k.cache_write ?? k.cacheWrite), write_long: 0,
    output: n(k.output ?? k.output_tokens ?? k.outputTokens) + n(k.reasoning ?? k.reasoning_tokens ?? k.reasoningTokens) };
  return u.input + u.read + u.write + u.output ? u : null;
}
function ocRequest(s, id, d, t) {
  const u = ocUsage(d);
  if (!u || !(t >= since) || seen.has('oc' + id)) return;
  seen.add('oc' + id);
  const m = d.model && typeof d.model === 'object' ? d.model : { id: d.modelID || d.model, providerID: d.providerID };
  addReq(s, { t, model: m.id || 'unknown', u, out: [], local: isLocal(m.providerID) });
}
function readOpencode(f) {
  if (fs.statSync(f).isDirectory()) {
    const s = session(); s.id = path.basename(f); s.split = false;
    for (const x of fs.readdirSync(f).filter(x => x.endsWith('.json')).sort()) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(f, x), 'utf8')); } catch (e) { continue; }
      if (d.role === 'assistant') ocRequest(s, d.id || x, d, d.time && d.time.created);
    }
    s.reqs.sort((a, b) => a.t - b.t); s.events = s.reqs.map(req => ({ req }));
    return [s];
  }
  const db = openDb(f), byS = new Map();
  try {
    for (const r of db.prepare("SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant' ORDER BY session_id, seq").all()) {
      let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
      if (!byS.has(r.session_id)) { const s = session(); s.id = r.session_id; s.split = false; byS.set(r.session_id, s); }
      ocRequest(byS.get(r.session_id), r.id, d, (d.time && d.time.created) || r.time_created);
    }
    for (const r of db.prepare('SELECT id, parent_id, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated FROM session_v2').all()) {
      const s = byS.get(r.id) || session();
      s.id = r.id; s.side = !!r.parent_id;
      if (s.reqs.length || !(r.time_updated >= since) || seen.has('ocs' + r.id)) { byS.set(r.id, s); continue; }
      const u = { input: r.tokens_input, read: r.tokens_cache_read, write: r.tokens_cache_write, write_long: 0, output: r.tokens_output + r.tokens_reasoning };
      if (!(u.input + u.read + u.write + u.output)) continue;
      seen.add('ocs' + r.id);
      let m = {}; try { m = JSON.parse(r.model) || {}; } catch (e) { m = { id: r.model }; }
      const n = db.prepare("SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'").get(r.id).n || 1;
      Object.assign(s, { split: false, coarse: true }); addReq(s, { t: r.time_updated, model: m.id || 'unknown', u, out: [], n, local: isLocal(m.providerID) });
      byS.set(r.id, s);
    }
  } finally { db.close(); }
  return [...byS.values()];
}

/* Hermes Agent: state.db keeps one row per session, model and billing route, with the call count and token sums (input without
   cache reads; reasoning inside output). No per-request detail, so these sessions count toward totals and by_model only */
function readHermes(f) {
  const db = openDb(f), byS = new Map();
  try {
    const rows = db.prepare(`SELECT u.session_id, u.model, u.billing_provider AS prov, u.billing_base_url AS url, u.task, u.api_call_count AS n,
      u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, coalesce(u.last_seen, u.first_seen, s.started_at) AS t, s.parent_session_id AS parent
      FROM session_model_usage u JOIN sessions s ON s.id = u.session_id`).all();
    for (const r of rows) {
      const t = r.t * 1000, id = ['h', r.session_id, r.model, r.prov, r.url, r.task].join('|');
      if (!(t >= since) || seen.has(id)) continue;
      seen.add(id);
      const u = { input: r.input_tokens, read: r.cache_read_tokens, write: r.cache_write_tokens, write_long: 0, output: r.output_tokens };
      if (!(u.input + u.read + u.write + u.output)) continue;
      if (!byS.has(r.session_id)) { const s = session(); Object.assign(s, { id: r.session_id, side: !!r.parent, split: false, coarse: true }); byS.set(r.session_id, s); }
      addReq(byS.get(r.session_id), { t, model: r.model, u, out: [], n: r.n || 1, local: isLocal(r.prov, r.url) });
    }
  } finally { db.close(); }
  return [...byS.values()];
}

/* ---------- the engine: price every request, share it over its context, score the taxes ---------- */
const T = { tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost: { input: 0, output: 0, cache_write: 0, cache_read: 0 } };
const X = { noisy_output: { count: 0, tokens: 0, cost: 0 }, screenshots: { count: 0, tokens: 0, cost: 0 }, startup: { sessions: 0, tokens: 0, cost: 0 }, cache_breaks: { count: 0, tokens: 0, cost: 0 }, one_model: { count: 0, cost: 0 } };
const byModel = {}, byTool = {}, unpriced = new Set(), provs = new Set(), local = { requests: 0, cost: 0 };
let requests = 0, unpricedReq = 0, from = null, to = null, taxed = false;
const SRC = {};
const LABEL = { prompts: 'Your prompts', replies: 'Replies', notes: "The tool's own notes", agent: 'Subagents' };
function charge(key, cost, tokens = 0, calls = 0) {
  const s = SRC[key] = SRC[key] || { cost: 0, tokens: 0, calls: 0 };
  s.cost += cost; s.tokens += tokens; s.calls += calls;
}

function account(s, tool) {
  const { reqs, events, blocks, side } = s;
  if (!reqs.length) return;
  const bt = byTool[tool] = byTool[tool] || { sessions: 0, requests: 0, cost: 0, ids: new Set(), measured: new Set(['totals', 'by_model']) };
  bt.ids.add(s.id || s.reqs[0].t); /* a subagent's log shares its parent's session id */
  if (!s.coarse) { bt.measured.add('taxes'); taxed = true; }
  if (s.split && !s.coarse) bt.measured.add('by_source');

  /* share each request's real cost over the context it carried. A subagent's whole log counts as Subagents */
  let stored = [], fresh = [], setupDone = false;
  const spread = (list, cost) => { const n = list.reduce((a, x) => a + x.tokens, 0); if (!n) return false; list.forEach(x => charge(side ? 'agent' : x.key, cost * x.tokens / n)); return true; };
  if (s.split) for (const e of events) {
    if (!e.req) { if (e.tokens > 0) fresh.push(e); continue; }
    const r = e.req, c = cost(r.u, r.model, r.t);
    if (!c) continue;
    const u = r.u, newT = u.input + u.write + u.write_long, freshT = fresh.reduce((a, x) => a + x.tokens, 0);
    if (!setupDone) { stored.push({ key: 'setup:' + TOOLS[tool].setup, tokens: Math.max(1000, newT + u.read - freshT) }); setupDone = true; }
    else if (!u.read && newT < 0.6 * (stored.reduce((a, x) => a + x.tokens, 0) + freshT)) stored = stored.filter(x => x.key.startsWith('setup')); /* compacted or cleared */
    const newCost = c.input + c.cache_write;
    /* new tokens beyond what's fresh are history sent again (a cache break): that part goes to what was stored */
    if (newT > freshT && stored.length) { const old = newCost * (newT - freshT) / newT; spread(stored, old); if (!spread(fresh, newCost - old)) spread(stored, newCost - old); }
    else if (!spread(fresh, newCost)) spread(stored, newCost);
    if (!spread(stored, c.cache_read)) spread(fresh, c.cache_read);
    const outList = r.out.length ? r.out : [{ key: 'replies', tokens: 1 }];
    spread(outList.map(x => ({ key: x.key, tokens: Math.max(1, x.tokens) })), c.output);
    outList.forEach(x => { if (x.call && !side) charge(x.key, 0, 0, 1); });
    stored.push(...fresh); fresh = [];
    const outT = outList.reduce((a, x) => a + Math.max(1, x.tokens), 0);
    outList.forEach(x => fresh.push({ key: x.key, tokens: u.output * Math.max(1, x.tokens) / outT }));
  }
  events.forEach(e => { if (!e.req && e.tokens > 0) charge(side ? 'agent' : e.key, 0, e.tokens); });

  reqs.forEach((r, i) => {
    const n = r.n || 1;
    requests += n; bt.requests += n;
    from = from == null || r.t < from ? r.t : from; to = to == null || r.t > to ? r.t : to;
    const u = r.u, c = cost(u, r.model, r.t), newT = u.input + u.write + u.write_long;
    T.tokens.input += u.input; T.tokens.output += u.output; T.tokens.cache_write += u.write + u.write_long; T.tokens.cache_read += u.read;
    const bm = byModel[r.model] = byModel[r.model] || { requests: 0, cost: 0 };
    bm.requests += n;
    if (r.local) { bm.local = true; local.requests += n; }
    if (!c) { unpricedReq += n; unpriced.add(r.model); bm.cost = null; return; }
    provs.add(c.p.prov);
    const sum = sumC(c);
    ['input', 'output', 'cache_write', 'cache_read'].forEach(k => { T.cost[k] += c[k]; });
    bt.cost += sum;
    if (bm.cost != null) bm.cost += sum;
    if (r.local) local.cost += sum;
    if (s.coarse) return;
    if (i === 0) { X.startup.sessions++; X.startup.tokens += newT; X.startup.cost += c.input + c.cache_write; }
    else {
      const prev = reqs[i - 1];
      if (newT > BREAK && (prev.model !== r.model || (r.t - prev.t) / 60000 > s.ttl)) {
        X.cache_breaks.count++; X.cache_breaks.tokens += newT; X.cache_breaks.cost += c.input + c.cache_write - newT * c.p.cache_read / 1e6;
      }
    }
  });
  if (s.coarse) return;
  /* short jobs on the top model, priced again on the same provider's small model */
  const first = lookup(reqs[0].model), P = first && PR.providers[first.prov];
  if (P && reqs.length <= 10 && reqs.every(r => { const h = lookup(r.model); return h && h.prov === first.prov && h.key === P.tiers[2] && r.u.output < SHORT; })) {
    X.one_model.count++;
    const small = P.models[P.tiers[0]].id || P.tiers[0];
    reqs.forEach(r => { X.one_model.cost += sumC(cost(r.u, r.model, r.t)) - sumC(cost(r.u, small, r.t)); });
  }
  for (const b of blocks) {
    const next = reqs[Math.min(b.at, reqs.length - 1)], p = rates(next.model, 0, next.t);
    if (!p) continue;
    const later = Math.max(0, reqs.length - b.at - 1), c = b.tokens * (p.cache_write + p.cache_read * later) / 1e6;
    const x = b.kind === 'img' ? X.screenshots : X.noisy_output; x.count++; x.tokens += b.tokens; x.cost += c;
  }
}

const present = [], skipped = [];
/* a SQLite file can change only in its -wal file */
const fresh = f => recent(f) || recent(f + '-wal') || (fs.existsSync(f) && fs.statSync(f).isDirectory() && recent(f));
for (const [tool, def] of Object.entries(TOOLS)) {
  if (ONLY !== 'all' && ONLY !== def.flag) continue;
  const files = def.files().filter(fresh);
  if (!files.length) continue;
  if (def.sqlite && files.some(f => f.endsWith('.db')) && !(await loadSqlite())) { skipped.push(def.label); continue; }
  present.push(tool);
  for (const f of files) { let ss = []; try { ss = def.read(f); } catch (e) { continue; } ss.forEach(s => account(s, tool)); }
}
if (skipped.length) console.error(`Skipped ${skipped.join(' and ')}: reading ${skipped.length > 1 ? 'their' : 'its'} SQLite log needs Node 22.13 or later (you have ${process.version}).`);
const names = (ONLY === 'all' ? Object.values(TOOLS) : Object.values(TOOLS).filter(d => d.flag === ONLY)).map(d => d.label).join(', ');
if (!requests) {
  console.error(`No ${names} requests in the last ${DAYS} day${DAYS === 1 ? '' : 's'}.`);
  console.error('Logs are read from ~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp, ~/.local/share/opencode and ~/.hermes.');
  console.error('Set CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, XDG_DATA_HOME or HERMES_HOME if yours live elsewhere.');
  process.exit(1);
}

const r2 = v => Math.round(v * 1e4) / 1e4;
T.cost.total = T.cost.input + T.cost.output + T.cost.cache_write + T.cost.cache_read;
Object.keys(T.cost).forEach(k => { T.cost[k] = r2(T.cost[k]); });
Object.values(X).forEach(x => { x.cost = r2(x.cost); });
X.startup.avg_first_write = X.startup.sessions ? Math.round(X.startup.tokens / X.startup.sessions) : 0;
Object.values(byModel).forEach(v => { if (v.cost != null) v.cost = r2(v.cost); });
const tools = Object.keys(byTool);
Object.values(byTool).forEach(v => { v.cost = r2(v.cost); v.sessions = v.ids.size; v.measured = [...v.measured]; delete v.ids; });
local.cost = r2(local.cost);
/* taxes need per-request logs: with only session totals (Hermes, older OpenCode) each one is null */
const taxes = taxed ? X : Object.fromEntries(Object.keys(X).map(k => [k, null]));
const bySource = Object.entries(SRC).filter(([, v]) => v.cost > 0).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => {
  const [kind, name] = k.includes(':') ? k.split(/:(.*)/) : [k, LABEL[k]];
  return { kind, name, cost: r2(v.cost), tokens: Math.round(v.tokens), calls: v.calls };
});
const sessions = Object.values(byTool).reduce((a, v) => a + v.sessions, 0);
const out = {
  tool: 'token-meter', version: 3, source: tools.length === 1 ? tools[0] : 'mixed', provider: provs.size === 1 ? [...provs][0] : 'mixed',
  generated: new Date().toISOString(), prices_checked: PR.checked,
  period: { days: DAYS, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  sessions, requests, totals: T, by_tool: byTool, by_model: byModel, by_source: bySource, taxes,
  local, unpriced: { requests: unpricedReq, models: [...unpriced] }
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const top = taxed && Object.entries(X).sort((a, b) => b[1].cost - a[1].cost)[0];
console.log(`Read ${requests.toLocaleString()} requests from ${sessions} sessions (last ${DAYS} day${DAYS === 1 ? '' : 's'}).`);
if (tools.length > 1) tools.forEach(k => console.log(`  ${TOOLS[k].label}: ${byTool[k].sessions} sessions, ${byTool[k].requests.toLocaleString()} requests, $${byTool[k].cost.toFixed(2)}`));
console.log(`About $${T.cost.total.toFixed(2)} at API prices.` + (top ? ` Biggest tax: ${top[0].replace('_', ' ')}, $${top[1].cost.toFixed(2)}.` : ' These logs keep totals only, so there are no tax scores.'));
if (local.requests) console.log(`${local.requests.toLocaleString()} requests ran on your own machine: $${local.cost.toFixed(2)} is what the same models would cost hosted.`);
if (unpricedReq) console.log(`${unpricedReq} requests on ${[...unpriced].join(', ')} aren't in prices.json, so they have no cost.`);
if (tools.length > 1) console.log(`To see one tool on its own, add ${tools.map(k => '--tool ' + TOOLS[k].flag).join(', ')}.`);
console.log(`Wrote ${path.resolve(OUT)}. Drop it on the Token Meter page. It holds totals only, no prompts or code.`);
