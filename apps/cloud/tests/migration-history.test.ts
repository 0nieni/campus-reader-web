import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';

const root = fileURLToPath(new URL('../../../netlify/database/', import.meta.url));
const common = [
  '20261016000100_campus_documents.sql', '20261016000200_import_bjtu.sql',
  '20261017000100_school_directory.sql', '20261017000200_personal_notice_labels.sql',
];
const reminders = [
  '20261020000100_web_reminders.sql', '20261021000100_minute_reminders.sql',
  '20261021000200_aliyun_reminders.sql',
];

test('production and the existing PR14 preview retain their applied migration history and converge without data loss', async t => {
  for (const file of [...common, ...reminders]) {
    assert.deepEqual(await readFile(join(root, 'migrations', file)), await readFile(join(root, 'pr14-migrations', file)), `Applied migration copies must have the same checksum: ${file}`);
  }
  assert.deepEqual(await readFile(join(root, 'migrations/20261022000100_ai_conversations.sql')), await readFile(join(root, 'pr14-migrations/20261019000100_ai_conversations.sql')));
  assert.deepEqual(await readFile(join(root, 'migrations/20261024000300_ai_provider_profiles.sql')), await readFile(join(root, 'pr14-migrations/20261024000300_ai_provider_profiles.sql')));
  const schemas: unknown[] = [];
  for (const history of [
    { name: 'production', directory: 'migrations', initial: [...common, ...reminders] },
    { name: 'existing PR14 preview', directory: 'pr14-migrations', initial: [...common, '20261019000100_ai_conversations.sql'] },
  ]) await t.test(history.name, async () => {
    const directory = join(root, history.directory), initial = await mkdtemp(join(tmpdir(), 'campus-migration-history-'));
    const server = new NetlifyDB({ logger() {} });
    const connectionString = await server.start(), pool = getDatabase({ connectionString }).pool;
    try {
      for (const file of history.initial) await copyFile(join(directory, file), join(initial, file));
      await server.applyMigrations(initial);
      await pool.query("INSERT INTO campus_documents(id,collection,body) VALUES('migration-fixture-profile','user_profiles',$1::jsonb)", [JSON.stringify({ schoolId: 'bjtu', marker: 'preserve existing account data' })]);
      const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
      for (const file of history.initial) assert.ok(files.includes(file), `Already applied migration must remain: ${file}`);
      const highest = Math.max(...history.initial.map(file => Number(file.split('_')[0])));
      for (const file of files.filter(file => !history.initial.includes(file))) {
        assert.ok(Number(file.split('_')[0]) > highest, `Out-of-order pending migration: ${file}`);
      }
      await server.applyMigrations(directory);
      const saved = await pool.query("SELECT body FROM campus_documents WHERE id='migration-fixture-profile'");
      assert.equal(saved.rows[0].body.marker, 'preserve existing account data');
      await pool.query("INSERT INTO campus_documents(id,collection,body) VALUES('migration-fixture-chat','web_ai_conversations','{}')");
      const tables = await pool.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'campus_%' ORDER BY table_name,ordinal_position");
      const indexes = await pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'campus_%' ORDER BY indexname");
      const constraints = await pool.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relname LIKE 'campus_%') ORDER BY conname");
      assert.ok(tables.rows.some((row: { table_name: string }) => row.table_name === 'campus_reminder_accounts'));
      assert.ok(tables.rows.some((row: { table_name: string }) => row.table_name === 'campus_reminder_channel_receipts'));
      assert.ok(tables.rows.some((row: { table_name: string }) => row.table_name === 'campus_ai_provider_profiles'));
      schemas.push({ tables: tables.rows, indexes: indexes.rows, constraints: constraints.rows });
    } finally {
      await pool.end(); await server.stop();
      assert.equal(dirname(resolve(initial)), resolve(tmpdir()));
      assert.ok(basename(initial).startsWith('campus-migration-history-'));
      await rm(initial, { recursive: true, force: true });
    }
  });
  assert.equal(schemas.length, 2);
  assert.deepEqual(schemas[0], schemas[1], 'Both existing histories must reach the same AI and reminder schema');
});
