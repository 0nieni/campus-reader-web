import type { School } from '@campus/contracts';
import type { Repository, ItemRow } from './repository';
import type { SqlPool } from './postgres-storage';
import { isPrivate, sourceVisible, type Resource } from './scope';
import { reject } from './errors';
const bjtu: School = { id: 'bjtu', name: '北京交通大学', status: 'ready' };
export function postgresRepository(pool: SqlPool): Repository {
  const one = async (collection: string, id: string) => {
    const { rows } = await pool.query('SELECT body FROM campus_documents WHERE collection=$1 AND id=$2', [collection, id]);
    return rows[0] ? { ...rows[0].body, _id: id } : null;
  };
  const schoolOf = (row: Record<string, any>): School => ({ id: row._id, name: String(row.name || row._id), status: ['ready', 'candidate'].includes(row.status) ? row.status : 'not_connected' });
  return {
    async selectedSchool(owner) { const row = await one('user_profiles', owner); return typeof row?.selectedSchoolId === 'string' ? row.selectedSchoolId : null; },
    async school(id) { const row = await one('schools', id); return row ? schoolOf(row) : id === bjtu.id ? bjtu : null; },
    async schools(offset, limit) {
      const { rows } = await pool.query("SELECT id,body FROM campus_documents WHERE collection='schools' AND id<>'bjtu' ORDER BY id LIMIT $1 OFFSET $2", [offset === 0 ? limit - 1 : limit, Math.max(0, offset - 1)]);
      return [...(offset === 0 ? [bjtu] : []), ...rows.map(row => schoolOf({ ...row.body, _id: row.id }))];
    },
    async selectSchool(owner, schoolId) {
      await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,$2::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body", [owner, JSON.stringify({ _id: owner, selectedSchoolId: schoolId, updatedAt: new Date().toISOString() })]);
    },
    async scope(schoolId, ownerId) {
      const { rows } = await pool.query("SELECT id,body FROM campus_documents WHERE collection='sources' ORDER BY id LIMIT 2001");
      if (rows.length > 2000) reject('SOURCE_LIMIT_EXCEEDED', '来源目录超过当前读取范围。');
      const scope = { schoolId, ownerId, publicSourceIds: [] as string[], privateSourceIds: [] as string[] };
      for (const row of rows) { const resource = row.body as Resource; if (isPrivate(resource)) scope.privateSourceIds.push(row.id); else if (sourceVisible(resource, schoolId, ownerId)) scope.publicSourceIds.push(row.id); }
      return scope;
    },
    async item(id) { return await one('items', id) as ItemRow | null; },
    async items(scope, offset, limit, since, filters = {}) {
      const values: any[] = [scope.ownerId, scope.schoolId, scope.publicSourceIds, scope.privateSourceIds, since];
      const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
      // SQL predicates precede pagination. The gateway also rechecks every returned row.
      const visible = `(body->>'ownerOpenid'=$1 OR (
        coalesce(body->>'ownerOpenid','')='' AND coalesce(body->>'scope','')<>'private'
        AND coalesce(body->>'type','')<>'manual' AND coalesce(body->>'category','')<>'mail'
        AND NOT coalesce(body->'categories' ? 'mail',false)
        AND coalesce(body->>'key','') NOT IN ('mail-inbox','manual-inbox')
        AND coalesce(body->>'canonicalUrl','') !~* '^(mail|manual):'
        AND NOT (coalesce(body->>'sourceId','')=ANY($4::text[]))
        AND (body->>'scope'='global' OR (body->>'scope'='school' AND body->'schoolIds' ? $2)
          OR (NOT(body ? 'scope') AND body->>'sourceId'=ANY($3::text[])))))`;
      const where = ["collection='items'", "body->>'status'='published'", visible, "coalesce(nullif(body->>'publishedAt',''),nullif(body->>'discoveredAt',''),body->>'createdAt') >= $5"];
      if (filters.keyword) where.push(`strpos(lower(coalesce(body->>'title','') || E'\\n' || coalesce(body->>'contentText','') || E'\\n' || coalesce(body->'summary'->>'oneLine','')), lower(${bind(filters.keyword)}))>0`);
      if (filters.categories?.length) { const param = bind(filters.categories); where.push(`(body->>'category'=ANY(${param}::text[]) OR jsonb_exists_any(coalesce(body->'categories','[]'::jsonb),${param}::text[]))`); }
      const { rows } = await pool.query(`SELECT id,body FROM campus_documents WHERE ${where.join(' AND ')} ORDER BY body->>'publishedAt' DESC NULLS LAST,id DESC LIMIT ${bind(limit)} OFFSET ${bind(offset)}`, values);
      return rows.map(row => ({ ...row.body, _id: row.id })) as ItemRow[];
    },
  };
}
