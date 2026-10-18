import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EncodingGate,
  HashingEmbeddingProvider,
  type Journal,
} from '@dream/core';
import { SqliteStore } from '@dream/store-sqlite';
import { makeTable, type ExperimentResult } from './harness';

/**
 * E20 — P10-lite durability.
 *
 * Three properties a local memory store must have before any product layer:
 * replaying a write does not duplicate it, a failed write leaves no partial
 * node/edge, and the database reports a healthy WAL-backed state.
 */
export async function e20Durability(): Promise<ExperimentResult> {
  const dir = mkdtempSync(join(tmpdir(), 'dream-e20-'));
  const dbPath = join(dir, 'memory.db');
  const provider = new HashingEmbeddingProvider(256);
  const store = await new SqliteStore(dbPath).init();
  const gate = new EncodingGate(store, store, provider);

  const first = (await gate.encode({
    content: 'The deploy window is Friday at 2am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    idempotencyKey: 'turn-42',
  }))!;
  const replay = (await gate.encode({
    content: 'The deploy window is Friday at 2am',
    kind: 'percept',
    source: 'user',
    explicitFact: true,
    idempotencyKey: 'turn-42',
  }))!;
  const afterReplay = await store.listNodes();

  let rolledBack = false;
  try {
    await store.runInTransaction(async () => {
      await store.putNode({
        id: 'tx-node',
        kind: 'semantic',
        scope: 'user',
        content: 'should roll back',
        embedding: await provider.embed(['should roll back']).then((vectors) => vectors[0]!),
        edges: [],
        provenance: { source: 'user', trust: 1 },
        importance: 0.5,
        strength: 1,
        createdAt: 1,
        lastAccessedAt: 1,
        version: 1,
      });
      await store.addEdge('tx-node', { to: 'missing', type: 'similar', weight: 1 });
      throw new Error('simulated crash');
    });
  } catch {
    rolledBack = (await store.getNode('tx-node')) === null;
  }

  // A journal failure inside the encode transaction must not leave a node.
  const failingJournal: Journal = {
    async append() {
      throw new Error('journal unavailable');
    },
    async list() {
      return [];
    },
  };
  const failingGate = new EncodingGate(store, failingJournal, provider);
  let journalFailureRolledBack = false;
  try {
    await failingGate.encode({
      content: 'A write whose journal fails must not persist',
      kind: 'percept',
      source: 'user',
      explicitFact: true,
      idempotencyKey: 'turn-failing',
    });
  } catch {
    const nodes = await store.listNodes();
    journalFailureRolledBack = !nodes.some((node) => node.idempotencyKey === 'turn-failing');
  }

  const health = await store.health();
  const journalMode = health.checks.find((check) => check.name === 'journal_mode')?.detail ?? '';
  const orphanEdges = health.checks.find((check) => check.name === 'orphan_edges')?.detail ?? '';

  const duplicates = afterReplay.length;
  const passed =
    replay.id === first.id &&
    duplicates === 1 &&
    rolledBack &&
    journalFailureRolledBack &&
    health.ok &&
    journalMode === 'wal' &&
    orphanEdges === '0';

  const rows: Array<Array<string | number>> = [
    ['same idempotency key -> one node', `${duplicates} node(s)`, duplicates === 1 ? 'yes' : 'no'],
    ['replayed node id equals original', replay.id === first.id ? 'yes' : 'no', replay.id === first.id ? 'yes' : 'no'],
    ['transaction rollback left no node', rolledBack ? 'yes' : 'no', rolledBack ? 'yes' : 'no'],
    ['journal failure rolled back node', journalFailureRolledBack ? 'yes' : 'no', journalFailureRolledBack ? 'yes' : 'no'],
    ['journal mode', journalMode, journalMode === 'wal' ? 'yes' : 'no'],
    ['orphan edges', orphanEdges, orphanEdges === '0' ? 'yes' : 'no'],
    ['health.ok', health.ok ? 'yes' : 'no', health.ok ? 'yes' : 'no'],
  ];

  await store.close();
  // libsql may release Windows file locks asynchronously.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  const findings = [
    `Idempotency: replaying "turn-42" returned the original node; the store held ${duplicates} node(s), not two.`,
    `Atomicity: a thrown transaction removed both the node and its edge (${rolledBack ? 'clean' : 'LEAKED'}); a journal failure inside encode also rolled the node back (${journalFailureRolledBack ? 'clean' : 'LEAKED'}).`,
    `Health: journal_mode=${journalMode}, orphan_edges=${orphanEdges}, integrity and schema checks ${health.ok ? 'passed' : 'FAILED'}.`,
    `This is P10-lite: single-process durability and replay safety. Leases, multi-worker FIFO and crash-resume queues remain future work (P10-full).`,
  ];

  return {
    id: 'E20',
    title: 'P10-lite durability: idempotency & atomic writes',
    question: 'Can a local SQLite store survive retries and failed writes without duplicates or partial state?',
    hypothesis:
      'A WAL-backed store with write transactions and idempotency keys makes replay safe and keeps node/edge/journal writes all-or-nothing.',
    method: [
      'Encode the same idempotency key twice and count nodes.',
      'Throw inside a write transaction and verify node/edge rollback.',
      'Make the journal fail inside encode and verify no node persists.',
      'Run integrity, journal-mode, orphan-edge and schema health checks.',
    ],
    tables: [
      makeTable('Durability checks', ['check', 'result', 'pass'], rows),
    ],
    findings,
    recommendations: [
      'Use an idempotency key per turn at the caller boundary; retries should never create a second memory.',
      'Keep node, edge and journal writes in one transaction; a half-written memory is worse than a failed write.',
      'Run `dream doctor` before backups and add WAL checkpointing to the backup script.',
      'Do not add leases or multi-worker queues until a second writer actually exists.',
    ],
    verdict: passed ? 'works' : 'partial',
  };
}
