import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlterTable, buildCreateTable, buildDeleteMany, buildExplain, buildInsert, buildRenameTable, buildTableMaintenance } from '../src/sql/ddl';

const cols = [
  { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: true },
  { name: 'title', type: 'TEXT', nullable: false },
  { name: 'done', type: 'INTEGER', nullable: true },
  { name: 'created_at', type: 'TEXT', defaultValue: 'CURRENT_TIMESTAMP' },
];

test('sqlite create table emits exactly one primary key and autoincrement', () => {
  const ddl = buildCreateTable('sqlite', { table: 'tasks', columns: cols });
  assert.match(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.equal((ddl.match(/PRIMARY KEY/g) ?? []).length, 1);
  assert.match(ddl, /"title" TEXT NOT NULL/);
  assert.match(ddl, /DEFAULT CURRENT_TIMESTAMP/);
});

test('mysql create table includes auto increment and table options', () => {
  const ddl = buildCreateTable('mysql', { table: 'tasks', columns: cols });
  assert.match(ddl, /`id` INTEGER AUTO_INCREMENT/);
  assert.match(ddl, /PRIMARY KEY \(`id`\)/);
  assert.match(ddl, /ENGINE=InnoDB/);
});

test('postgres create table uses serial for auto increment integer columns', () => {
  const ddl = buildCreateTable('postgresql', { table: 'tasks', columns: cols });
  assert.match(ddl, /"id" SERIAL/);
  assert.match(ddl, /PRIMARY KEY \("id"\)/);
});

test('postgres multi-row insert numbers placeholders across rows', () => {
  const sql = buildInsert('postgresql', 't', ['a', 'b'], 2);
  assert.match(sql, /\$1, \$2\), \(\$3, \$4/);
});

test('alter table builds multiple statements and rejects sqlite type changes', () => {
  const statements = buildAlterTable('postgresql', 't', [
    { op: 'add_column', column: { name: 'note', type: 'text', nullable: true } },
    { op: 'rename_column', from: 'note', to: 'memo' },
    { op: 'add_index', index: { name: 'ix_t_memo', columns: ['memo'], unique: false } },
  ]);
  assert.equal(statements.length, 3);
  assert.throws(() => buildAlterTable('sqlite', 't', [{ op: 'alter_column', name: 'a', type: 'TEXT' }]), /SQLite/);
});

test('explain dialect per engine', () => {
  assert.match(buildExplain('sqlite', 'SELECT 1'), /EXPLAIN QUERY PLAN/);
  assert.match(buildExplain('mysql', 'SELECT 1'), /EXPLAIN FORMAT=JSON/);
  assert.match(buildExplain('postgresql', 'SELECT 1'), /EXPLAIN \(FORMAT JSON/);
});

test('foreign keys are emitted inside create table and skipped for clickhouse', () => {
  const fk = { name: 'fk_tasks_owner', columns: ['owner_id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' };
  const sqlite = buildCreateTable('sqlite', { table: 'tasks', columns: cols, foreignKeys: [fk] });
  assert.match(sqlite, /CONSTRAINT "fk_tasks_owner" FOREIGN KEY \("owner_id"\) REFERENCES "users" \("id"\) ON DELETE CASCADE/);
  const clickhouse = buildCreateTable('clickhouse', { table: 'tasks', columns: cols, foreignKeys: [fk] });
  assert.doesNotMatch(clickhouse, /FOREIGN KEY/);
});

test('alter table adds and drops foreign keys per engine', () => {
  const fk = { name: 'fk_audio_album', columns: ['album_id'], refTable: 'm_audio_album', refColumns: ['id'], refSchema: 'media', onDelete: 'RESTRICT', onUpdate: 'CASCADE' };
  const mysql = buildAlterTable('mysql', 'm_audio', [{ op: 'add_foreign_key', fk }], 'media');
  assert.deepEqual(mysql, [
    'ALTER TABLE `media`.`m_audio` ADD CONSTRAINT `fk_audio_album` FOREIGN KEY (`album_id`) REFERENCES `media`.`m_audio_album` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  ]);
  assert.match(buildAlterTable('postgresql', 'audio', [{ op: 'add_foreign_key', fk: { ...fk, refSchema: undefined } }], 'public')[0], /ADD CONSTRAINT "fk_audio_album" FOREIGN KEY/);
  assert.match(buildAlterTable('mysql', 'audio', [{ op: 'drop_foreign_key', name: 'fk_audio_album' }])[0], /DROP FOREIGN KEY `fk_audio_album`/);
  assert.match(buildAlterTable('postgresql', 'audio', [{ op: 'drop_foreign_key', name: 'fk_audio_album' }])[0], /DROP CONSTRAINT "fk_audio_album"/);
  assert.throws(() => buildAlterTable('sqlite', 'audio', [{ op: 'add_foreign_key', fk }]), /重建表/);
});

test('table and column comments emit dialect statements', () => {
  assert.deepEqual(buildAlterTable('mysql', 'orders', [{ op: 'set_comment', comment: '电商' }], 'shop'), ['ALTER TABLE `shop`.`orders` COMMENT=\'电商\'']);
  assert.match(buildAlterTable('mysql', 'orders', [{ op: 'set_comment', comment: "a'b" }])[0], /COMMENT='a''b'/);
  assert.deepEqual(buildAlterTable('postgresql', 'orders', [{ op: 'set_comment', comment: 'x' }], 'public'), [`COMMENT ON TABLE "public"."orders" IS 'x'`]);
  assert.deepEqual(buildAlterTable('oracle', 'orders', [{ op: 'set_comment', comment: 'x' }]), ['COMMENT ON TABLE "orders" IS \'x\'']);
  assert.throws(() => buildAlterTable('clickhouse', 'orders', [{ op: 'set_comment', comment: 'x' }]), /不支持表注释/);
  assert.match(
    buildAlterTable('mysql', 'orders', [{ op: 'alter_column', name: 'status', type: 'varchar(32)', nullable: true, comment: '状态' }])[0],
    /MODIFY COLUMN `status` varchar\(32\) NULL COMMENT '状态'/,
  );
  assert.match(
    buildAlterTable('postgresql', 'orders', [{ op: 'alter_column', name: 'status', type: 'varchar(32)', comment: '状态' }], 'public')[1],
    /COMMENT ON COLUMN "public"\."orders"\."status" IS '状态'/,
  );
});

test('index method maps to dialect syntax', () => {
  assert.deepEqual(buildAlterTable('mysql', 'orders', [{ op: 'add_index', index: { name: 'ft_note', columns: ['note'], method: 'FULLTEXT' } }]), [
    'CREATE FULLTEXT INDEX `ft_note` ON `orders` (`note`)',
  ]);
  assert.equal(
    buildAlterTable('mysql', 'orders', [{ op: 'add_index', index: { name: 'ix_status', columns: ['status'], method: 'BTREE', unique: true } }])[0],
    'CREATE UNIQUE INDEX `ix_status` ON `orders` (`status`) USING BTREE',
  );
  assert.equal(
    buildAlterTable('postgresql', 'orders', [{ op: 'add_index', index: { name: 'ix_status', columns: ['status'], method: 'hash' } }], 'public')[0],
    'CREATE INDEX "ix_status" USING HASH ON "public"."orders" ("status")',
  );
});

test('rename table uses engine-specific syntax', () => {
  assert.match(buildRenameTable('mysql', 'old', 'new', 'shop'), /RENAME TABLE `shop`\.`old` TO `shop`\.`new`/);
  assert.match(buildRenameTable('postgresql', 'old', 'new', 'public'), /ALTER TABLE "public"\."old" RENAME TO "new"/);
  assert.match(buildRenameTable('sqlserver', 'old', 'new', 'dbo'), /sp_rename 'dbo\.old', 'new'/);
});

test('maintenance plans respect engine capabilities', () => {
  assert.deepEqual(buildTableMaintenance('mysql', 'orders', 'optimize', 'shop'), ['OPTIMIZE TABLE `shop`.`orders`']);
  assert.deepEqual(buildTableMaintenance('postgresql', 'orders', 'vacuum', 'public'), ['VACUUM "public"."orders"']);
  assert.equal(buildTableMaintenance('sqlite', 'orders', 'repair'), null);
  assert.equal(buildTableMaintenance('oracle', 'orders', 'optimize'), null);
});

test('batch delete builds one OR group per key', () => {
  const sql = buildDeleteMany('postgresql', 't', ['id'], 2);
  assert.match(sql, /DELETE FROM "t" WHERE \("id" = \$1\) OR \("id" = \$2\)/);
});
