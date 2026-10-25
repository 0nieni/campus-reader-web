import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { getDatabase } from '@netlify/database';
import type { AiProviderSave, AiProviderState, AiSavedProvider } from '@campus/contracts';
import { providerProfiles } from '../src/ai-provider-profiles';
import { postgresStorage, type SqlPool } from '../src/postgres-storage';

// Synthetic wrapping and provider keys only. No environment or model connection is read.
const master = Buffer.alloc(32, 41).toString('base64');
const secret = 'fixture-provider-key-never-send';
const fixture = (patch: Partial<AiProviderSave> = {}): AiProviderSave => ({
  version: 0, name: 'Fixture provider', protocol: 'openai-chat',
  baseUrl: 'https://provider.example/v1', models: ['fixture-model', 'another-model'],
  defaultModel: 'fixture-model', apiKey: secret, ...patch,
});
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  assert.ok(!String(error).includes(secret));
  return true;
};
const current = (state: AiProviderState): AiSavedProvider => {
  assert.equal(state.profiles.length, 1); return state.profiles[0];
};
const ref = (profile: AiSavedProvider) => ({ id: profile.id, version: profile.version });

test('encrypted provider profiles use real local SQL with one driver connection', async t => {
  const server = new NetlifyDB({ logger() {} });
  const connectionString = await server.start(), native = getDatabase({ connectionString }).pool;
  // PGlite serializes its SQL engine. This exercises application concurrency,
  // transaction integration and migrations, not hosted PostgreSQL load behavior.
  (native as unknown as { options: { max: number } }).options.max = 1;
  const pool = native as unknown as SqlPool;
  let clock = Date.parse('2026-10-24T08:00:00Z');
  const store = providerProfiles(pool, { encryptionKey: () => master, now: () => clock });
  const save = (owner: string, profile = fixture()) => store.handle('ai.providers.save', { profile }, owner);
  const raw = async (owner: string, id: string) => (await pool.query('SELECT * FROM campus_ai_provider_profiles WHERE owner_id=$1 AND id=$2', [owner, id])).rows[0];
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations', import.meta.url)));

    await t.test('missing and malformed wrapping keys disable saving without storing plaintext', async () => {
      for (const value of [undefined, '', 'wrong', Buffer.alloc(31).toString('base64'), master.replace(/=$/, '')]) {
        const disabled = providerProfiles(pool, { encryptionKey: () => value });
        assert.deepEqual(await disabled.state('disabled'), { storageConfigured: false, version: 0, profiles: [], selection: null });
        await assert.rejects(disabled.handle('ai.providers.save', { profile: fixture() }, 'disabled'), code('PROVIDER_STORAGE_UNAVAILABLE'));
      }
      assert.equal((await store.state('disabled')).version, 0);
      assert.equal((await pool.query('SELECT * FROM campus_ai_provider_profiles WHERE owner_id=$1', ['disabled'])).rows.length, 0);
    });

    await t.test('save and list return safe metadata while credentials remain authenticated ciphertext', async () => {
      const state = await save('encrypted'), profile = current(state);
      assert.equal(state.version, 1); assert.equal(state.selection, null);
      assert.equal(profile.keySaved, true); assert.equal(profile.updatedAt, new Date(clock).toISOString());
      assert.deepEqual(Object.keys(profile).sort(), ['baseUrl', 'defaultModel', 'id', 'keySaved', 'models', 'name', 'protocol', 'updatedAt', 'version']);
      const persisted = await raw('encrypted', profile.id), serialized = JSON.stringify(persisted);
      assert.ok(!serialized.includes(secret)); assert.ok(!JSON.stringify(state).includes('key_ciphertext'));
      const envelope = JSON.parse(persisted.key_ciphertext);
      assert.equal(envelope.v, 1); assert.equal(Buffer.from(envelope.iv, 'base64').length, 12); assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
      assert.deepEqual(await store.resolve('encrypted', ref(profile), 'fixture-model'), {
        provider: 'custom', protocol: 'openai-chat', endpoint: 'https://provider.example/v1/chat/completions', model: 'fixture-model', apiKey: secret,
      });
      assert.deepEqual(await store.handle('ai.providers.list', {}, 'encrypted'), state);
    });

    await t.test('owners cannot list, resolve, edit, select or delete another account profile', async () => {
      const state = await save('isolated-owner'), profile = current(state);
      assert.deepEqual((await store.state('isolated-other')).profiles, []);
      await assert.rejects(store.resolve('isolated-other', ref(profile), 'fixture-model'), code('PROVIDER_PROFILE_CHANGED'));
      await assert.rejects(save('isolated-other', fixture({ id: profile.id, profileVersion: profile.version })), code('PROVIDER_CONFIG_CONFLICT'));
      await assert.rejects(store.handle('ai.providers.select', { id: profile.id, model: 'fixture-model', version: 0 }, 'isolated-other'), code('PROVIDER_CONFIG_CONFLICT'));
      await assert.rejects(store.handle('ai.providers.remove', { id: profile.id, version: 0 }, 'isolated-other'), code('PROVIDER_CONFIG_CONFLICT'));
      assert.deepEqual(await store.state('isolated-owner'), state);
    });

    await t.test('blank-key edits reencrypt for the new version and keep only a valid selected model', async () => {
      let state = await save('edited'), profile = current(state);
      state = await store.handle('ai.providers.select', { id: profile.id, model: 'another-model', version: state.version }, 'edited');
      const before = await raw('edited', profile.id); clock += 1000;
      state = await save('edited', fixture({ version: state.version, id: profile.id, profileVersion: profile.version, name: 'Renamed', apiKey: '' }));
      const changed = current(state), after = await raw('edited', profile.id);
      assert.equal(changed.version, profile.version + 1); assert.notEqual(before.key_ciphertext, after.key_ciphertext);
      assert.notEqual(JSON.parse(before.key_ciphertext).iv, JSON.parse(after.key_ciphertext).iv);
      assert.deepEqual(state.selection, { profile: ref(changed), model: 'another-model' });
      assert.equal((await store.resolve('edited', ref(changed), 'fixture-model')).apiKey, secret);
      await assert.rejects(store.resolve('edited', ref(profile), 'fixture-model'), code('PROVIDER_PROFILE_CHANGED'));
      state = await save('edited', fixture({ version: state.version, id: changed.id, profileVersion: changed.version, models: ['fixture-model'], apiKey: undefined }));
      assert.equal(state.selection, null);
      profile = current(state);
      for (const patch of [{ baseUrl: 'https://different.example/v1' }, { protocol: 'anthropic' as const }]) {
        await assert.rejects(save('edited', fixture({ version: state.version, id: profile.id, profileVersion: profile.version, apiKey: '', ...patch })), code('VALIDATION_FAILED'));
      }
      assert.equal((await store.state('edited')).version, state.version);
      const replaced = await save('edited', fixture({ version: state.version, id: profile.id, profileVersion: profile.version, baseUrl: 'https://different.example/v1', apiKey: 'fixture-replacement-key' }));
      assert.equal((await store.resolve('edited', ref(current(replaced)), 'fixture-model')).apiKey, 'fixture-replacement-key');
    });

    await t.test('strict validation rejects identity injection, invalid keys, model lists and stale versions', async () => {
      await assert.rejects(store.handle('ai.providers.list', { owner: 'someone' }, 'validated'), code('VALIDATION_FAILED'));
      await assert.rejects(store.handle('ai.providers.save', { profile: fixture(), owner: 'someone' }, 'validated'), code('VALIDATION_FAILED'));
      await assert.rejects(store.handle('ai.providers.save', { profile: { ...fixture(), owner: 'someone' } }, 'validated'), code('VALIDATION_FAILED'));
      for (const patch of [
        { apiKey: 5 }, { apiKey: '' }, { apiKey: 'space key' }, { apiKey: '非ASCII' }, { apiKey: 'x'.repeat(2049) },
        { models: [] }, { models: Array.from({ length: 21 }, (_, i) => `model-${i}`) }, { models: ['bad model'] },
        { defaultModel: 'not-listed' }, { name: '\u0000bad' }, { protocol: 'unsupported' }, { version: -1 },
      ]) await assert.rejects(save('validated', fixture(patch as Partial<AiProviderSave>)), code('VALIDATION_FAILED'));
      const state = await save('validated'), profile = current(state);
      await assert.rejects(save('validated', fixture()), code('PROVIDER_CONFIG_CONFLICT'));
      await assert.rejects(save('validated', fixture({ version: state.version, id: profile.id, profileVersion: profile.version + 1 })), code('PROVIDER_CONFIG_CONFLICT'));
      assert.deepEqual(await store.state('validated'), state);
    });

    await t.test('first creation and the tenth-profile boundary serialize through account compare-and-swap', async () => {
      const first = await Promise.allSettled([save('first-race'), save('first-race', fixture({ name: 'Concurrent' }))]);
      assert.equal(first.filter(result => result.status === 'fulfilled').length, 1);
      for (const result of first) if (result.status === 'rejected') code('PROVIDER_CONFIG_CONFLICT')(result.reason);
      assert.equal((await store.state('first-race')).profiles.length, 1);
      let state = await store.state('limit');
      for (let i = 0; i < 9; i++) state = await save('limit', fixture({ version: state.version, name: `Profile ${i}` }));
      const results = await Promise.allSettled([save('limit', fixture({ version: state.version, name: 'Tenth A' })), save('limit', fixture({ version: state.version, name: 'Tenth B' }))]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      for (const result of results) if (result.status === 'rejected') code('PROVIDER_CONFIG_CONFLICT')(result.reason);
      state = await store.state('limit'); assert.equal(state.profiles.length, 10);
      await assert.rejects(save('limit', fixture({ version: state.version })), code('VALIDATION_FAILED'));
      assert.equal((await store.state('limit')).version, state.version);
    });

    await t.test('ciphertext swaps, metadata tampering and a wrong wrapping key cannot resolve credentials', async () => {
      const state = await save('tampered'), profile = current(state), original = await raw('tampered', profile.id);
      const wrongKey = providerProfiles(pool, { encryptionKey: () => Buffer.alloc(32, 42).toString('base64') });
      await assert.rejects(wrongKey.resolve('tampered', ref(profile), 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
      await assert.rejects(wrongKey.handle('ai.providers.save', { profile: fixture({ version: state.version, id: profile.id, profileVersion: profile.version, apiKey: '' }) }, 'tampered'), code('PROVIDER_KEY_UNAVAILABLE'));
      assert.equal((await store.state('tampered')).version, state.version);
      const foreign = current(await save('ciphertext-owner'));
      // Same ID, version and public metadata isolate owner binding in the AAD.
      await pool.query('UPDATE campus_ai_provider_profiles SET id=$3,key_ciphertext=$4 WHERE owner_id=$1 AND id=$2', ['ciphertext-owner', foreign.id, original.id, original.key_ciphertext]);
      await assert.rejects(store.resolve('ciphertext-owner', ref(profile), 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
      // Rebinding only the ID or only the version must also fail authentication.
      await pool.query('UPDATE campus_ai_provider_profiles SET id=$3 WHERE owner_id=$1 AND id=$2', ['tampered', profile.id, 'rebound-fixture']);
      await assert.rejects(store.resolve('tampered', { id: 'rebound-fixture', version: profile.version }, 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
      await pool.query('UPDATE campus_ai_provider_profiles SET id=$3,version=$4 WHERE owner_id=$1 AND id=$2', ['tampered', 'rebound-fixture', profile.id, profile.version + 1]);
      await assert.rejects(store.resolve('tampered', { id: profile.id, version: profile.version + 1 }, 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
      await pool.query('UPDATE campus_ai_provider_profiles SET version=$3 WHERE owner_id=$1 AND id=$2', ['tampered', profile.id, profile.version]);
      await pool.query('UPDATE campus_ai_provider_profiles SET name=$3 WHERE owner_id=$1 AND id=$2', ['tampered', profile.id, 'Altered without encryption']);
      await assert.rejects(store.resolve('tampered', ref(profile), 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
      await pool.query('UPDATE campus_ai_provider_profiles SET name=$3,key_ciphertext=$4 WHERE owner_id=$1 AND id=$2', ['tampered', profile.id, original.name, '{"v":1}']);
      await assert.rejects(store.resolve('tampered', ref(profile), 'fixture-model'), code('PROVIDER_KEY_UNAVAILABLE'));
    });

    await t.test('selection changes preserve old references; deleting the selected profile clears selection atomically', async () => {
      let state = await save('selection'), first = current(state);
      state = await store.handle('ai.providers.select', { id: first.id, model: 'fixture-model', version: state.version }, 'selection');
      state = await save('selection', fixture({ version: state.version, name: 'Second', protocol: 'gemini', baseUrl: 'https://gemini.example/v1beta', models: ['models/fixture-gemini'], defaultModel: 'models/fixture-gemini' }));
      const second = state.profiles.find(profile => profile.id !== first.id)!;
      state = await store.handle('ai.providers.select', { id: second.id, model: 'models/fixture-gemini', version: state.version }, 'selection');
      assert.equal((await store.resolve('selection', ref(first), 'fixture-model')).apiKey, secret);
      assert.equal((await store.resolve('selection', ref(second), 'models/fixture-gemini')).endpoint, 'https://gemini.example/v1beta/models/fixture-gemini:generateContent');
      state = await store.handle('ai.providers.remove', { id: second.id, version: state.version }, 'selection');
      assert.equal(state.selection, null); assert.equal(state.profiles.length, 1);
      await assert.rejects(store.resolve('selection', ref(second), 'models/fixture-gemini'), code('PROVIDER_PROFILE_CHANGED'));
      await assert.rejects(store.resolve('selection', ref(first), 'not-configured'), code('PROVIDER_PROFILE_CHANGED'));
    });

    await t.test('list returns one coherent account snapshot if a save completes while the read is returning', async () => {
      const before = await save('snapshot'), profile = current(before);
      let injected = false;
      const interleaved: SqlPool = {
        connect: () => pool.connect(),
        async query(statement, values) {
          const result = await pool.query(statement, values);
          if (!injected && /^\s*SELECT/i.test(statement)) {
            injected = true;
            await save('snapshot', fixture({ version: before.version, id: profile.id, profileVersion: profile.version, name: 'After concurrent edit', apiKey: '' }));
          }
          return result;
        },
      };
      const result = await providerProfiles(interleaved, { encryptionKey: () => master }).state('snapshot');
      assert.equal(injected, true);
      assert.ok((result.version === before.version && current(result).version === profile.version) ||
        (result.version === before.version + 1 && current(result).version === profile.version + 1), 'Account and profile must describe the same committed snapshot');
    });

    await t.test('profile guards share the active task transaction with pool.max=1 and reject edits or deletion', async () => {
      const state = await save('guarded'), profile = current(state), db = postgresStorage(pool);
      const tx = await db.startTransaction();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          store.guard(tx, 'guarded', ref(profile), 'fixture-model'),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('guard tried to obtain a nested SQL connection')), 2000); }),
        ]);
        await tx.collection('web_ai_tasks').doc('provider-guard-fixture').set({ owner: 'guarded', providerProfile: ref(profile) });
        await tx.commit();
      } catch (error) { await tx.rollback(); throw error; }
      finally { clearTimeout(timer); }
      assert.equal((await db.collection('web_ai_tasks').doc('provider-guard-fixture').get()).data.owner, 'guarded');
      const changed = await save('guarded', fixture({ version: state.version, id: profile.id, profileVersion: profile.version, apiKey: '' }));
      const staleTx = await db.startTransaction();
      try { await assert.rejects(store.guard(staleTx, 'guarded', ref(profile), 'fixture-model'), code('PROVIDER_PROFILE_CHANGED')); }
      finally { await staleTx.rollback(); }
      await store.handle('ai.providers.remove', { id: profile.id, version: changed.version }, 'guarded');
      const removedTx = await db.startTransaction();
      try { await assert.rejects(store.guard(removedTx, 'guarded', ref(current(changed)), 'fixture-model'), code('PROVIDER_PROFILE_CHANGED')); }
      finally { await removedTx.rollback(); }
    });
  } finally { await native.end(); await server.stop(); }
});

test('database failures are sanitized rather than exposing driver details', async () => {
  const fail = async (): Promise<never> => { throw new Error(`driver contains ${secret}`); };
  const store = providerProfiles({ query: fail, connect: fail }, { encryptionKey: () => master });
  await assert.rejects(store.state('unavailable'), code('PROVIDER_STORAGE_UNAVAILABLE'));
  await assert.rejects(store.handle('ai.providers.save', { profile: fixture() }, 'unavailable'), code('PROVIDER_STORAGE_UNAVAILABLE'));
  await assert.rejects(store.resolve('unavailable', { id: 'unavailable', version: 1 }, 'fixture-model'), code('PROVIDER_STORAGE_UNAVAILABLE'));
});
