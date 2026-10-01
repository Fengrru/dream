#!/usr/bin/env node
/**
 * Dream CLI.
 *
 *   dream chat --demo                     offline scripted companion (no API key)
 *   dream chat --db memory.db             persistent chat (scripted reasoning)
 *   dream chat --model gpt-4o-mini        real reasoning via OpenAI-compatible API
 *   dream dream  --db memory.db           run a consolidation cycle now
 *   dream stats  --db memory.db           memory space statistics
 *   dream eval                            run the offline eval suites
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import {
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import type { ReasoningRequest } from '@dream/kernel';
import { OpenAIReasoningPlugin } from '@dream/plugin-reasoning-openai';
import type { ReasoningBehavior } from '@dream/plugin-scripted';
import { MockToolsPlugin, ScriptedReasoningPlugin } from '@dream/plugin-scripted';
import { SqliteStore } from '@dream/store-sqlite';
import { InMemoryStore } from '@dream/core';
import { renderMarkdown, runAllSuites } from '@dream/eval';
import { renderExperimentReport, runAllExperiments } from '@dream/eval';
import { writeFileSync } from 'node:fs';
import { serve } from '../gateway';

/** Minimal .env loader (repo root): KEY=VALUE lines, never overrides real env. */
function loadEnvFile(): void {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const [command = 'chat', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command: command ?? 'chat', flags };
}

function parsePreset(value: string | boolean | undefined): 'companion' | 'amnesiac' | 'headless' {
  if (value === 'amnesiac' || value === 'headless') return value;
  return 'companion';
}

async function openStore(dbPath?: string) {
  if (!dbPath) return new InMemoryStore();
  return new SqliteStore(dbPath).init();
}

/**
 * Embeddings are a SEPARATE provider choice from reasoning. DeepSeek (like
 * most chat-only APIs) has no embeddings endpoint, so the default is the
 * local deterministic embedder. Set DREAM_EMBED_MODEL (with
 * DREAM_EMBED_BASE_URL / DREAM_EMBED_API_KEY) to opt into a real one.
 */
function makeProvider(flags: Record<string, string | boolean>) {
  const embedModel = String(flags['embed-model'] ?? process.env.DREAM_EMBED_MODEL ?? '');
  if (embedModel) {
    const apiKey = String(
      flags['embed-api-key'] ??
        process.env.DREAM_EMBED_API_KEY ??
        process.env.DREAM_API_KEY ??
        process.env.OPENAI_API_KEY ??
        '',
    );
    if (apiKey) {
      return new OpenAIEmbeddingProvider({
        apiKey,
        baseUrl:
          String(flags['embed-base-url'] ?? process.env.DREAM_EMBED_BASE_URL ?? 'https://api.openai.com/v1'),
        model: embedModel,
      });
    }
  }
  return new HashingEmbeddingProvider();
}

function offlineBehavior(): ReasoningBehavior {
  // A tiny offline persona: questions trigger recall, recalled memories are
  // cited in the answer. Enough to demonstrate the memory loop without an
  // API key.
  return async (req: ReasoningRequest) => {
    if (req.wm.items.some((i) => i.kind === 'tool_result')) {
      return { kind: 'final', content: 'Done — see the tool results above.' };
    }
    const isQuestion =
      /\?\s*$/.test(req.userText) ||
      /^(what|where|when|who|why|how|which|do i|am i|is my)\b/i.test(req.userText);
    if (isQuestion && req.recalledNodes.length === 0) {
      return { kind: 'recall', query: req.userText };
    }
    if (req.recalledNodes.length > 0) {
      return {
        kind: 'final',
        content: `I remember: ${req.recalledNodes.map((n) => n.content).join(' | ')}`,
      };
    }
    if (/weather in/i.test(req.userText)) {
      return { kind: 'tool_calls', calls: [{ name: 'weather', args: { city: 'your city' } }] };
    }
    return {
      kind: 'final',
      content:
        "Got it. Tell me things like 'my ... is ...' to build memory, then run `dream dream` to consolidate.",
    };
  };
}

async function cmdChat(flags: Record<string, string | boolean>): Promise<void> {
  const store = await openStore(typeof flags.db === 'string' ? flags.db : undefined);
  const preset = parsePreset(flags.preset);
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      provider: makeProvider(flags),
      clock: Date.now,
    },
    { preset, dreamOnSessionClose: flags.demo ? true : Boolean(flags['dream-on-close']) },
  );

  const model = typeof flags.model === 'string' ? flags.model : process.env.DREAM_MODEL;
  if (flags.demo) {
    scripted.set(offlineBehavior());
    await kernel.use(scripted);
    await kernel.use(new MockToolsPlugin());
    console.log('Dream offline demo — scripted reasoning, mock tools. Type /exit to quit.\n');
  } else if (model) {
    await kernel.use(
      new OpenAIReasoningPlugin({
        apiKey: String(process.env.DREAM_API_KEY ?? process.env.OPENAI_API_KEY ?? ''),
        model,
        baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : process.env.DREAM_BASE_URL,
      }),
    );
    console.log(`Dream online — reasoning model: ${model}. Type /exit to quit.\n`);
  } else {
    scripted.set(offlineBehavior());
    await kernel.use(scripted);
    await kernel.use(new MockToolsPlugin());
    console.log(
      'No --model given: running with scripted reasoning. Use --model <name> with ' +
        'DREAM_API_KEY/OPENAI_API_KEY for real reasoning.\n',
    );
  }

  const session = kernel.session();
  await session.start({ contextSeeds: ['the user, their preferences and ongoing topics'] });
  const rl = createInterface({ input: stdin, output: stdout });

  // Event-driven line loop: queued lines survive fast piped input (unlike
  // question(), which loses lines and dangles on EOF).
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit' || line === 'exit' || line === 'quit') break;
    if (line === '/dream') {
      const report = await kernel.dreamNow();
      console.log(renderReport(report));
      continue;
    }
    if (line === '/stats') {
      console.log(JSON.stringify(await kernel.stats(), null, 2));
      continue;
    }
    const turn = await session.submit(line, { explicitFact: /^(my|i prefer|i live|i drive)\b/i.test(line) });
    if (turn.skillUsed) console.log(`  [implicit skill: ${turn.skillUsed}]`);
    if (turn.recalled.length > 0) console.log(`  [recalled ${turn.recalled.length} memory(ies)]`);
    console.log(`dream › ${turn.final}\n`);
  }

  rl.close();
  const end = await session.end();
  console.log(`\nSession ended. Encoded ${end.encoded} new memory(ies).`);
  if (end.dreamReport) console.log(renderReport(end.dreamReport));
  if (store instanceof SqliteStore) await store.close();
}

function renderReport(report: {
  replayedEpisodes: number;
  abstractions: string[];
  skillsFormed: string[];
  skillsUpdated: string[];
  mergedCount: number;
  fadedCount: number;
  selfUpdates: string[];
}): string {
  const lines = [
    '',
    '── Dream report ──────────────────────────────',
    `  episodes replayed: ${report.replayedEpisodes}`,
    `  patterns abstracted: ${report.abstractions.length}${report.abstractions.length ? ` (${report.abstractions.join(', ')})` : ''}`,
    `  skills formed: ${report.skillsFormed.length ? report.skillsFormed.join(', ') : 'none'}`,
    `  skills updated: ${report.skillsUpdated.length ? report.skillsUpdated.join(', ') : 'none'}`,
    `  episodes merged: ${report.mergedCount}`,
    `  memories faded: ${report.fadedCount}`,
    `  self updates: ${report.selfUpdates.length ? report.selfUpdates.join('; ') : 'none'}`,
    '──────────────────────────────────────────────',
  ];
  return lines.join('\n');
}

async function cmdDream(flags: Record<string, string | boolean>): Promise<void> {
  const dbPath = typeof flags.db === 'string' ? flags.db : join(process.cwd(), 'memory.db');
  const store = await new SqliteStore(dbPath).init();
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    {
      memory: store,
      journal: store,
      traces: store,
      provider: makeProvider(flags),
      clock: Date.now,
    },
    { preset: parsePreset(flags.preset) },
  );
  await kernel.use(scripted);
  const report = await kernel.dreamNow();
  console.log(renderReport(report));
  await store.close();
}

async function cmdStats(flags: Record<string, string | boolean>): Promise<void> {
  const dbPath = typeof flags.db === 'string' ? flags.db : join(process.cwd(), 'memory.db');
  const store = await new SqliteStore(dbPath).init();
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    { memory: store, journal: store, traces: store, provider: new HashingEmbeddingProvider(), clock: Date.now },
    {},
  );
  await kernel.use(scripted);
  console.log(JSON.stringify(await kernel.stats(), null, 2));
  const events = await store.list();
  console.log(`journal entries: ${events.length}`);
  await store.close();
}

async function cmdEval(): Promise<void> {
  const results = await runAllSuites();
  console.log(renderMarkdown(results));
  if (!results.every((r) => r.passed)) process.exitCode = 1;
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  // MCP servers come from a JSON file: [{name, command, args}].
  let mcpServers: Array<{ name: string; command: string; args?: string[] }> | undefined;
  const mcpConfigPath = typeof flags['mcp-config'] === 'string' ? flags['mcp-config'] : process.env.DREAM_MCP_CONFIG;
  if (mcpConfigPath && existsSync(mcpConfigPath)) {
    mcpServers = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as typeof mcpServers;
  }

  await serve({
    dbPath: typeof flags.db === 'string' ? flags.db : undefined,
    port: Number(flags.port ?? 7333),
    preset: parsePreset(flags.preset),
    apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : process.env.DREAM_API_KEY,
    baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : process.env.DREAM_BASE_URL,
    model: typeof flags.model === 'string' ? flags.model : process.env.DREAM_MODEL,
    idleDreamSeconds: flags['idle-dream'] !== undefined ? Number(flags['idle-dream']) : undefined,
    mcpServers,
    embedModel: process.env.DREAM_EMBED_MODEL,
    embedBaseUrl: process.env.DREAM_EMBED_BASE_URL,
    embedApiKey: process.env.DREAM_EMBED_API_KEY,
  });
  // Keep the process alive: the WebSocket server holds the event loop open.
  await new Promise(() => {});
}

async function cmdExperiments(flags: Record<string, string | boolean>): Promise<void> {
  console.log('Running Dream experiment suite (E1-E6)...\n');
  const results = await runAllExperiments();
  const markdown = renderExperimentReport(results);
  const outPath = typeof flags.out === 'string' ? flags.out : join(process.cwd(), 'EXPERIMENTS.md');
  writeFileSync(outPath, markdown, 'utf8');
  for (const r of results) {
    console.log(`${r.verdict.toUpperCase().padEnd(7)} ${r.id} — ${r.title}`);
    for (const f of r.findings) console.log(`        · ${f}`);
  }
  console.log(`\nFull report written to ${outPath}`);
}

async function main(): Promise<void> {
  loadEnvFile();
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'chat':
      await cmdChat(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'dream':
      await cmdDream(flags);
      break;
    case 'stats':
      await cmdStats(flags);
      break;
    case 'eval':
      await cmdEval();
      break;
    case 'experiments':
      await cmdExperiments(flags);
      break;
    default:
      console.error(`Unknown command "${command}". Try: chat | serve | dream | stats | eval | experiments`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
