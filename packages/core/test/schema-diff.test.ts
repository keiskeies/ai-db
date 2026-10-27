import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSchemas } from '../src/schema/diff';
import type { TableInfo } from '../src/types';

const source: TableInfo[] = [
  {
    name: 'tasks',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
      { name: 'status', type: 'TEXT', nullable: true, primaryKey: false },
    ],
    indexes: [{ name: 'ix_tasks_status', columns: ['status'], unique: false }],
  },
  {
    name: 'projects',
    type: 'table',
    columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
    indexes: [],
  },
];

test('detects added tables and generates target DDL', () => {
  const diff = diffSchemas(source, [], { targetEngine: 'sqlite' });
  assert.equal(diff.summary.added, 2);
  assert.equal(diff.summary.statements, 3);
  assert.ok(diff.sql.some((sql) => /CREATE TABLE "tasks"/.test(sql)));
  assert.ok(diff.sql.some((sql) => /CREATE INDEX "ix_tasks_status"/.test(sql)));
});

test('detects added/dropped columns, altered columns and indexes', () => {
  const target: TableInfo[] = [
    {
      name: 'tasks',
      type: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: true, primaryKey: false },
        { name: 'legacy', type: 'TEXT', nullable: true, primaryKey: false },
      ],
      indexes: [],
    },
    {
      name: 'obsolete',
      type: 'table',
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
      indexes: [],
    },
  ];
  const diff = diffSchemas(source, target, { targetEngine: 'postgresql', targetSchema: 'public' });
  const tasks = diff.tables.find((table) => table.name === 'tasks')!;
  assert.equal(tasks.status, 'changed');
  assert.ok(tasks.changes.some((change) => change.kind === 'add_column' && change.column === 'status'));
  assert.ok(tasks.changes.some((change) => change.kind === 'add_index'));
  assert.ok(tasks.changes.some((change) => change.kind === 'drop_column' && change.destructive));
  assert.ok(tasks.changes.some((change) => change.kind === 'alter_column' && change.column === 'title'));
  assert.equal(diff.summary.removed, 1);
  assert.ok(diff.sql.some((sql) => /DROP TABLE "public"."obsolete"/.test(sql)));
});
