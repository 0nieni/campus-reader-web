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
  const schoolOf = (row: Record<string, any>): School => ({ id: row._id, name: String(row.name || row._id), status: ['ready', 'candidate'].includes(row.status) ? row.status : 'not_connected', ...(typeof row.announcementUrl === 'string' ? {announcementUrl:row.announcementUrl} : {}), ...(typeof row.homepage === 'string' ? {homepage:row.homepage} : {}), ...(Array.isArray(row.tags) ? {tags:row.tags} : {}) });
  return {
    async selectedSchool(owner) { const row = await one('user_profiles', owner); return typeof row?.selectedSchoolId === 'string' ? row.selectedSchoolId : null; },
    async school(id) { const row = await one('schools', id); return row ? schoolOf(row) : id === bjtu.id ? bjtu : null; },
    async schools(offset, limit) {
      const { rows } = await pool.query("SELECT id,body FROM campus_documents WHERE collection='schools' AND id<>'bjtu' ORDER BY id LIMIT $1 OFFSET $2", [offset === 0 ? limit - 1 : limit, Math.max(0, offset - 1)]);
      return [...(offset === 0 ? [await this.school('bjtu') || bjtu] : []), ...rows.map(row => schoolOf({ ...row.body, _id: row.id }))];
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
    async personalize(row, owner) {
      const {rows} = await pool.query('SELECT categories FROM campus_notice_labels WHERE owner_id=$1 AND item_id=$2',[owner,row._id]);
      return rows[0] ? {...row,personalCategories:rows[0].categories} : row;
    },
    async setLabels(owner, itemId, categories) {
      if (categories === null) { await pool.query('DELETE FROM campus_notice_labels WHERE owner_id=$1 AND item_id=$2',[owner,itemId]); return; }
      await pool.query('INSERT INTO campus_notice_labels(owner_id,item_id,categories) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id,item_id) DO UPDATE SET categories=EXCLUDED.categories,updated_at=now()',[owner,itemId,JSON.stringify(categories)]);
    },
    async items(scope, offset, limit, since, filters = {}) {
      if (filters.categories?.length === 0) return [];
      const values: any[] = [scope.ownerId, scope.schoolId, scope.publicSourceIds, scope.privateSourceIds, since];
      const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
      // SQL predicates precede pagination. The gateway also rechecks every returned row.
      const visible = `((body->>'ownerOpenid'=$1 AND (body->>'importKind' IS DISTINCT FROM 'website' OR body->'schoolIds' ? $2)) OR (
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
      const effectiveCategories = `coalesce(labels.categories,CASE WHEN jsonb_typeof(body->'categories')='array' THEN CASE WHEN jsonb_array_length(body->'categories')>0 THEN body->'categories' ELSE jsonb_build_array(body->>'category') END ELSE jsonb_build_array(body->>'category') END)`;
      if (filters.categories?.length) where.push(`jsonb_exists_any(${effectiveCategories},${bind(filters.categories)}::text[])`);
      const { rows } = await pool.query(`SELECT d.id,d.body,labels.categories AS personal_categories FROM campus_documents AS d LEFT JOIN campus_notice_labels AS labels ON labels.owner_id=$1 AND labels.item_id=d.id WHERE ${where.join(' AND ')} ORDER BY body->>'publishedAt' DESC NULLS LAST,d.id DESC LIMIT ${bind(limit)} OFFSET ${bind(offset)}`, values);
      return rows.map(row => ({ ...row.body, _id: row.id, ...(Array.isArray(row.personal_categories) ? {personalCategories:row.personal_categories} : {}) })) as ItemRow[];
    },
  };
}
