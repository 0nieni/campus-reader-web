import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { AiProviderRef, AiProviderState, AiSavedProvider } from '@campus/contracts';
import type { SqlExecutor, SqlPool, Row } from './postgres-storage';
import { sqlTransactionExecutor } from './postgres-storage';
import type { Transaction } from './storage';
import type { Connection } from './model-provider';
import { checkedModel, checkedProtocol, checkedProviderRef, normalizeProviderBaseUrl, providerEndpoint } from './provider-endpoints';
import { AppError, reject } from './errors';

export interface ProviderProfiles {
  state(owner: string): Promise<AiProviderState>;
  handle(action: string, input: Record<string, unknown>, owner: string): Promise<AiProviderState>;
  resolve(owner: string, ref: AiProviderRef, model: string): Promise<Connection>;
  guard(tx: Transaction, owner: string, ref: AiProviderRef, model: string): Promise<void>;
}
export function providerProfiles(pool: SqlPool, options: { encryptionKey?: () => string | undefined; now?: () => number } = {}): ProviderProfiles {
  const now = options.now || Date.now;
  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      if (['40001', '40P01', 'TRANSACTION_CONFLICT'].includes(String((error as { code?: unknown })?.code)))
        reject('PROVIDER_CONFIG_CONFLICT', '配置正在更新，请刷新列表后重试。');
      reject('PROVIDER_STORAGE_UNAVAILABLE', '个人配置暂时无法读取或保存，请稍后重试；未调用模型。');
    }
  }
  // The shared connection validator retains legacy MODEL_INVALID errors. Saved
  // profile inputs expose one validation code for all invalid form fields.
  function checkedSavedModel(value: unknown): string {
    try { return checkedModel(value); }
    catch { reject('VALIDATION_FAILED', '请填写有效的服务商模型 ID。'); }
  }
  function key(required = true): Buffer | undefined {
    const encoded = (options.encryptionKey || (() => process.env.AI_PROVIDER_ENCRYPTION_KEY))();
    const value = typeof encoded === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(encoded) ? Buffer.from(encoded, 'base64') : undefined;
    if (!value || value.length !== 32 || value.toString('base64') !== encoded) {
      if (required) reject('PROVIDER_STORAGE_UNAVAILABLE', '个人配置保存尚未启用，请联系站点管理员配置加密密钥；临时 API 仍可使用。');
      return;
    }
    return value;
  }
  const aad = (row: Row) => Buffer.from(JSON.stringify([row.owner_id, row.id, Number(row.version), row.name, row.protocol, row.base_url, row.models, row.default_model]));
  function encrypt(secret: string, row: Row): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key()!, iv);
    cipher.setAAD(aad(row));
    const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') });
  }
  function decrypt(row: Row): string {
    const master = key()!;
    try {
      if (typeof row.key_ciphertext !== 'string' || row.key_ciphertext.length > 4096) throw Error('Invalid envelope');
      const envelope = JSON.parse(row.key_ciphertext);
      if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).some(k => !['v', 'iv', 'tag', 'data'].includes(k)) ||
          ![envelope.iv, envelope.tag, envelope.data].every(value => typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value))) throw Error('Invalid envelope');
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64'), bytes = Buffer.from(envelope.data, 'base64');
      if (envelope.v !== 1 || iv.length !== 12 || tag.length !== 16 || bytes.length > 2048) throw Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', master, iv); decipher.setAAD(aad(row)); decipher.setAuthTag(tag);
      const secret = Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
      if (!secret || secret.length > 2048 || /[^\x21-\x7e]/.test(secret)) throw Error('Invalid key');
      return secret;
    } catch { reject('PROVIDER_KEY_UNAVAILABLE', '此配置的密钥无法解密，请重新填写并保存 API Key；未调用模型。'); }
  }
  function metadata(row: Row): AiSavedProvider {
    return { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url, models: row.models, defaultModel: row.default_model, version: Number(row.version), keySaved: true, updatedAt: new Date(row.updated_at).toISOString() };
  }
  async function state(owner: string, executor: SqlExecutor = pool): Promise<AiProviderState> {
    // One SQL statement gives account CAS version, current selection and safe
    // metadata the same READ COMMITTED snapshot, without ever selecting secrets.
    const result = await executor.query(`SELECT a.version AS account_version,a.selected_id,a.selected_model,
      p.id,p.name,p.protocol,p.base_url,p.models,p.default_model,p.version,p.updated_at
      FROM (SELECT $1::text AS owner_id) requested
      LEFT JOIN campus_ai_provider_accounts a ON a.owner_id=requested.owner_id
      LEFT JOIN campus_ai_provider_profiles p ON p.owner_id=requested.owner_id
      ORDER BY p.updated_at,p.id`, [owner]);
    const account = result.rows[0], rows = result.rows.filter(row => row.id !== null && row.id !== undefined);
    const selected = rows.find(row => row.id === account?.selected_id && row.models.includes(account?.selected_model));
    return { storageConfigured: Boolean(key(false)), version: Number(account?.account_version || 0), profiles: rows.map(metadata), selection: selected ? { profile: { id: selected.id, version: Number(selected.version) }, model: account.selected_model } : null };
  }
  async function lock(executor: SqlExecutor, owner: string) {
    await executor.query('INSERT INTO campus_ai_provider_accounts(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING', [owner]);
    return (await executor.query('SELECT * FROM campus_ai_provider_accounts WHERE owner_id=$1 FOR UPDATE', [owner])).rows[0];
  }
  async function selectedRow(executor: SqlExecutor, owner: string, reference: AiProviderRef, model: string) {
    const ref = checkedProviderRef(reference); checkedSavedModel(model);
    const row = (await executor.query('SELECT * FROM campus_ai_provider_profiles WHERE owner_id=$1 AND id=$2', [owner, ref.id])).rows[0];
    if (!row || Number(row.version) !== ref.version || !row.models.includes(model)) reject('PROVIDER_PROFILE_CHANGED', '本轮使用的服务商配置已修改或删除，请用新配置重新提问；不会自动更换服务商。');
    return row;
  }
  function version(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) reject('VALIDATION_FAILED', '配置版本无效，请刷新服务商列表。');
    return Number(value);
  }
  function fields(value: Record<string, unknown>, allowed: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('VALIDATION_FAILED', '服务商配置格式无效。');
    if (Object.keys(value).some(k => !allowed.includes(k))) reject('VALIDATION_FAILED', '配置包含不支持的字段。');
  }
  return {
    state: owner => safe(() => state(owner)),
    async handle(action, input, owner) {
      return safe(async () => {
      if (action === 'ai.providers.list') { fields(input, []); return state(owner); }
      if (!['ai.providers.save','ai.providers.remove','ai.providers.select'].includes(action)) reject('VALIDATION_FAILED', '不支持的服务商配置操作。');
      fields(input, action === 'ai.providers.save' ? ['profile'] : action === 'ai.providers.remove' ? ['id','version'] : ['id','model','version']);
      const raw = action === 'ai.providers.save' ? input.profile : input;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('VALIDATION_FAILED', '服务商配置格式无效。');
      const data = raw as Record<string, unknown>, expected = version(data.version);
      if (action === 'ai.providers.save') fields(data, ['version','id','profileVersion','name','protocol','baseUrl','models','defaultModel','apiKey']);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = await lock(client, owner);
        if (Number(account.version) !== expected) reject('PROVIDER_CONFIG_CONFLICT', '配置已在其他页面更新，请刷新列表后再操作。');
        if (action === 'ai.providers.save') {
          key();
          if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60 || /[\x00-\x1f\x7f]/.test(data.name)) reject('VALIDATION_FAILED', '配置名称需要1至60个字符。');
          const protocol = checkedProtocol(data.protocol), baseUrl = normalizeProviderBaseUrl(data.baseUrl, protocol);
          if (!Array.isArray(data.models) || !data.models.length || data.models.length > 20) reject('VALIDATION_FAILED', '每个服务商需要1至20个模型 ID。');
          const models = [...new Set(data.models.map(checkedSavedModel))], defaultModel = checkedSavedModel(data.defaultModel);
          if (!models.includes(defaultModel)) reject('VALIDATION_FAILED', '默认模型必须在模型列表中。');
          let old: Row | undefined;
          if (data.id !== undefined) {
            const ref = checkedProviderRef({ id: data.id, version: data.profileVersion });
            old = (await client.query('SELECT * FROM campus_ai_provider_profiles WHERE owner_id=$1 AND id=$2', [owner, ref.id])).rows[0];
            if (!old || Number(old.version) !== ref.version) reject('PROVIDER_CONFIG_CONFLICT', '此配置已修改或删除，请刷新后再编辑。');
          } else {
            const count = await client.query('SELECT count(*)::integer AS count FROM campus_ai_provider_profiles WHERE owner_id=$1', [owner]);
            if (Number(count.rows[0].count) >= 10) reject('VALIDATION_FAILED', '每个账号最多保存10项服务商配置。');
          }
          if (data.apiKey !== undefined && typeof data.apiKey !== 'string') reject('VALIDATION_FAILED', 'API Key 格式无效。');
          const supplied = typeof data.apiKey === 'string' ? data.apiKey : '';
          if (supplied && (supplied.length > 2048 || /[^\x21-\x7e]/.test(supplied))) reject('VALIDATION_FAILED', 'API Key 需要可打印的 ASCII 字符，不含空白，长度最多2048字符。');
          if (!supplied && (!old || old.base_url !== baseUrl || old.protocol !== protocol)) reject('VALIDATION_FAILED', '新增配置或改变地址、协议时，请重新输入该服务商的 API Key。');
          const row: Row = { owner_id: owner, id: old?.id || randomUUID(), version: Number(old?.version || 0) + 1, name: data.name.trim(), protocol, base_url: baseUrl, models, default_model: defaultModel, updated_at: new Date(now()).toISOString() };
          const encrypted = encrypt(supplied || decrypt(old!), row);
          await client.query(`INSERT INTO campus_ai_provider_profiles(owner_id,id,version,name,protocol,base_url,models,default_model,key_ciphertext,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) ON CONFLICT(owner_id,id) DO UPDATE SET version=EXCLUDED.version,name=EXCLUDED.name,protocol=EXCLUDED.protocol,base_url=EXCLUDED.base_url,models=EXCLUDED.models,default_model=EXCLUDED.default_model,key_ciphertext=EXCLUDED.key_ciphertext,updated_at=EXCLUDED.updated_at`,
          [owner,row.id,row.version,row.name,row.protocol,row.base_url,JSON.stringify(models),defaultModel,encrypted,row.updated_at]);
          if (account.selected_id === row.id && !models.includes(account.selected_model)) await client.query('UPDATE campus_ai_provider_accounts SET selected_id=NULL,selected_model=NULL WHERE owner_id=$1', [owner]);
        } else if (action === 'ai.providers.remove') {
          if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id)) reject('VALIDATION_FAILED', '配置编号无效。');
          const removed = await client.query('DELETE FROM campus_ai_provider_profiles WHERE owner_id=$1 AND id=$2 RETURNING id', [owner, data.id]);
          if (!removed.rows.length) reject('PROVIDER_CONFIG_CONFLICT', '配置不存在或已删除，请刷新列表。');
          if (account.selected_id === data.id) await client.query('UPDATE campus_ai_provider_accounts SET selected_id=NULL,selected_model=NULL WHERE owner_id=$1', [owner]);
        } else if (data.id === null) {
          await client.query('UPDATE campus_ai_provider_accounts SET selected_id=NULL,selected_model=NULL WHERE owner_id=$1', [owner]);
        } else {
          key();
          if (typeof data.id !== 'string') reject('VALIDATION_FAILED', '请选择服务商。');
          const row = (await client.query('SELECT * FROM campus_ai_provider_profiles WHERE owner_id=$1 AND id=$2', [owner, data.id])).rows[0];
          const selectedModel = checkedSavedModel(data.model);
          if (!row || !row.models.includes(selectedModel)) reject('PROVIDER_CONFIG_CONFLICT', '配置或模型不存在，请刷新列表。');
          decrypt(row);
          await client.query('UPDATE campus_ai_provider_accounts SET selected_id=$2,selected_model=$3 WHERE owner_id=$1', [owner, row.id, selectedModel]);
        }
        await client.query('UPDATE campus_ai_provider_accounts SET version=version+1 WHERE owner_id=$1', [owner]);
        const result = await state(owner, client);
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      });
    },
    async resolve(owner, ref, model) {
      return safe(async () => {
      const row = await selectedRow(pool, owner, ref, model);
      return { provider: 'custom', protocol: checkedProtocol(row.protocol), endpoint: providerEndpoint(row.protocol, row.base_url, model), model, apiKey: decrypt(row) };
      });
    },
    async guard(tx, owner, ref, model) {
      return safe(async () => {
      const executor = sqlTransactionExecutor(tx);
      if (!executor) reject('PROVIDER_STORAGE_UNAVAILABLE', '个人配置需要网站的数据库执行环境。');
      key(); await lock(executor, owner); await selectedRow(executor, owner, ref, model);
      });
    },
  };
}
