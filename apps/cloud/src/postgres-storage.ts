import type { Database } from './storage';

export type Row = Record<string, any>;
export interface SqlExecutor { query(sql: string, values?: any[]): Promise<{ rows: Row[]; rowCount?: number | null }> }
export interface SqlClient extends SqlExecutor { release(): void }
export interface SqlPool extends SqlExecutor { connect(): Promise<SqlClient> }
const collections = new Set(['schools', 'sources', 'items', 'user_profiles', 'web_ai_tasks', 'web_ai_accounts', 'school_sync', 'school_requests']);
const operator = Symbol('campus-query');
type Condition = { [operator]: string; value?: unknown };
const condition = (op: string, value?: unknown): Condition => ({ [operator]: op, value });
function checked(name: string) { if (!collections.has(name)) throw new Error('Unsupported collection'); return name; }
function field(key: string) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Unsupported field'); return key; }
function normalized(error: unknown): never {
  if (['40001', '40P01'].includes(String((error as { code?: unknown })?.code)))
    throw Object.assign(new Error('Transaction conflict'), { code: 'TRANSACTION_CONFLICT' });
  throw error;
}
/** Small, explicit compatibility surface for the existing quota/bookmark services.
 * No CloudBase SDK or credentials are used. Every value is a SQL parameter. */
export function postgresStorage(pool: SqlPool): Database {
  function reference(executor: SqlExecutor, collection: string, id: string, lock = false) {
    return {
      async get() {
        const { rows } = await executor.query(`SELECT body FROM campus_documents WHERE collection=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [checked(collection), id]);
        return { data: rows[0] ? { ...rows[0].body, _id: id } : {} };
      },
      async update(patch: Row) {
        const remove: string[] = [], additions: Row = {};
        for (const [key, value] of Object.entries(patch)) {
          field(key); if (value?.[operator] === 'remove') remove.push(key); else additions[key] = value;
        }
        const result = await executor.query('UPDATE campus_documents SET body=(body - $3::text[]) || $4::jsonb WHERE collection=$1 AND id=$2', [checked(collection), id, remove, JSON.stringify(additions)]);
        if (!result.rowCount) throw new Error('Missing document');
        return { updated: 1 };
      },
      async set(body: Row) {
        await executor.query('INSERT INTO campus_documents(collection,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body', [checked(collection), id, JSON.stringify({ ...body, _id: id })]);
        return { updated: 1 };
      },
    };
  }
  function collection(name: string) {
    checked(name); let filter: Row = {}, limit = 100, offset = 0;
    const order: Array<[string, string]> = [];
    const builder = {
      where(value: Row) { filter = value; return builder; },
      limit(value: number) { limit = Math.max(0, Math.min(2001, Math.floor(value))); return builder; },
      skip(value: number) { offset = Math.max(0, Math.floor(value)); return builder; },
      orderBy(key: string, direction: string) { order.push([field(key), direction === 'desc' ? 'DESC' : 'ASC']); return builder; },
      doc(id: string) { return reference(pool, name, id); },
      async add(body: Row) {
        if (typeof body._id !== 'string' || !body._id) throw new Error('Missing id');
        await pool.query('INSERT INTO campus_documents(collection,id,body) VALUES($1,$2,$3::jsonb)', [name, body._id, JSON.stringify(body)]);
        return { id: body._id };
      },
      async get() {
        const values: unknown[] = [name]; const predicates = ['collection=$1'];
        const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
        for (const [key, value] of Object.entries(filter)) {
          const column = key === '_id' ? 'id' : `(body ->> ${bind(field(key))})`;
          const op = value?.[operator];
          if (op === 'lte' || op === 'gt') predicates.push(`${column} ${op === 'lte' ? '<=' : '>'} ${bind(String(value.value))}`);
          else if (op === 'neq') predicates.push(`${column} IS DISTINCT FROM ${bind(String(value.value))}`);
          else if (op) throw new Error('Unsupported query operator');
          else predicates.push(`${column} = ${bind(String(value))}`);
        }
        const sorts = order.map(([key, direction]) => `${key === '_id' ? 'id' : `(body ->> ${bind(key)})`} ${direction} NULLS LAST`);
        const sql = `SELECT id,body FROM campus_documents WHERE ${predicates.join(' AND ')}${sorts.length ? ` ORDER BY ${sorts.join(',')}` : ''} LIMIT ${bind(limit)} OFFSET ${bind(offset)}`;
        const { rows } = await pool.query(sql, values);
        return { data: rows.map(row => ({ ...row.body, _id: row.id })) };
      },
    }; return builder;
  }
  return {
    collection,
    command: { lte: (value: unknown) => condition('lte', value), gt: (value: unknown) => condition('gt', value), neq: (value: unknown) => condition('neq', value), remove: () => condition('remove') },
    async startTransaction() {
      const client = await pool.connect(); let closed = false;
      // Each mutation reads its existing task/account/profile FOR UPDATE on the
      // same connection. READ COMMITTED rereads the latest locked row after waits.
      try { await client.query('BEGIN'); }
      catch (error) { client.release(); normalized(error); }
      const close = () => { if (!closed) { closed = true; client.release(); } };
      const executor: SqlExecutor = { async query(sql, values) { try { return await client.query(sql, values); } catch (error) { normalized(error); } } };
      return {
        collection(name: string) { checked(name); return { doc(id: string) { return reference(executor, name, id, true); } }; },
        async commit() { try { await client.query('COMMIT'); } catch (error) { normalized(error); } finally { close(); } },
        async rollback() { if (closed) return; try { await client.query('ROLLBACK'); } finally { close(); } },
      };
    },
  } as unknown as Database;
}
