import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider, InMemoryStore } from '@dream/core';
import { DreamKernel } from '@dream/kernel';
import { ScriptedReasoningPlugin, behaviors } from '@dream/plugin-scripted';
import { McpToolsPlugin } from '../src';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url));

async function buildWithMcp() {
  const store = new InMemoryStore();
  const scripted = new ScriptedReasoningPlugin();
  const kernel = new DreamKernel(
    { memory: store, journal: store, traces: store, provider: new HashingEmbeddingProvider(), clock: Date.now },
    { preset: 'companion' },
  );
  await kernel.use(scripted);
  const mcp = new McpToolsPlugin({
    servers: [{ name: 'fake', command: process.execPath, args: [FAKE_SERVER] }],
  });
  await kernel.use(mcp);
  return { kernel, scripted, mcp };
}

describe('McpToolsPlugin', () => {
  it('exposes MCP tools through the single tool pipeline', { timeout: 20_000 }, async () => {
    const { kernel, mcp } = await buildWithMcp();
    try {
      const specs = kernel.toolSpecs().map((t) => t.name).sort();
      expect(specs).toContain('mcp__fake__echo');
      expect(specs).toContain('mcp__fake__add');

      const echo = await kernel.executeTool({ name: 'mcp__fake__echo', args: { text: 'hello' } });
      expect(echo.ok).toBe(true);
      expect(String(echo.result)).toBe('echo:hello');

      const add = await kernel.executeTool({ name: 'mcp__fake__add', args: { a: 2, b: 3 } });
      expect(String(add.result)).toBe('5');
    } finally {
      mcp.close();
    }
  });

  it('routes MCP failures through the pipeline as tool errors (not crashes)', { timeout: 20_000 }, async () => {
    const { kernel, mcp } = await buildWithMcp();
    try {
      const bad = await kernel.executeTool({ name: 'mcp__fake__explode', args: {} });
      expect(bad.ok).toBe(false);
      expect(String(bad.error)).toContain('boom');
      const missing = await kernel.executeTool({ name: 'mcp__fake__nope', args: {} });
      expect(missing.ok).toBe(false);
      expect(String(missing.error)).toContain('unknown tool');
    } finally {
      mcp.close();
    }
  });

  it('pre-execute policy hooks apply to MCP tools exactly like built-ins', { timeout: 20_000 }, async () => {
    const { kernel, mcp } = await buildWithMcp();
    try {
      let seen: string[] = [];
      await kernel.use({
        name: 'auditor',
        apply(ctx) {
          ctx.tools.addPreExecuteHook((call) => {
            seen.push(call.name);
            return call.name.startsWith('mcp__') ? 'deny' : 'allow';
          });
        },
      });
      const res = await kernel.executeTool({ name: 'mcp__fake__echo', args: { text: 'x' } });
      expect(res.ok).toBe(false);
      expect(res.deniedBy).toBe('auditor');
      expect(seen).toContain('mcp__fake__echo');
    } finally {
      mcp.close();
    }
  });

  it('an MCP tool call can drive a full turn (reasoning → MCP tool → answer)', { timeout: 20_000 }, async () => {
    const { kernel, scripted, mcp } = await buildWithMcp();
    try {
      scripted.set(behaviors.toolThenAnswer('mcp__fake__echo', { text: 'turn' }, 'done with mcp'));
      const session = kernel.session();
      const turn = await session.submit('please echo turn');
      expect(turn.final).toBe('done with mcp');
      expect(String(turn.toolResults[0])).toBe('echo:turn');
    } finally {
      mcp.close();
    }
  });
});
