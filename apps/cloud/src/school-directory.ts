import type { SchoolSync } from '@campus/contracts';
import type { SqlPool } from './postgres-storage';
import type { ItemRow, Repository } from './repository';
import { readSchoolPage, extractNotices, extractArticle, type PageReader, type SchoolSource } from './school-pages';
import { AppError } from './errors';

const sourceId = (id: string) => `directory_${id}`;
export function schoolDirectory(pool: SqlPool, repo: Repository, reader: PageReader = readSchoolPage, now = Date.now) {
  async function source(id: string): Promise<SchoolSource> {
    const school = await repo.school(id);
    if (!school?.announcementUrl || !school.homepage) throw new AppError('SOURCE_UNAVAILABLE','此学校尚未配置公开公告入口。');
    return { id, name: school.name, announcementUrl: school.announcementUrl, homepage: school.homepage };
  }
  async function refresh(id: string): Promise<SchoolSync> {
    const school = await source(id), at = new Date(now()).toISOString();
    // The per-school lease also limits repeated failed fetches. No per-user or
    // scheduled fan-out across 115 schools; cached public notices are shared.
    const lease = await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)
      ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body
      WHERE coalesce(campus_documents.body->>'retryAt','')<$3 RETURNING body`, [id,JSON.stringify({ state:'checking',retryAt:new Date(now()+5*60000).toISOString(), checkedAt:at }),at]);
    if (!lease.rows.length) {
      const cached = await pool.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1",[id]);
      const body = cached.rows[0]?.body || {};
      return { state:body.state === 'ready' ? 'ready' : body.state === 'unavailable' ? 'unavailable' : 'checking', count:Number(body.count || 0), checkedAt:body.checkedAt || null, message:body.message || '正在读取学校公开页面，请稍后刷新。' };
    }
    let result: SchoolSync;
    try {
      const page = await reader(school.announcementUrl,school), rows = extractNotices(page,school);
      if (!rows.length) throw new AppError('SOURCE_UNAVAILABLE','未识别到可公开读取的公告列表，可能需要校园网、登录或人工更新入口。');
      const source = { _id:sourceId(id), key:sourceId(id), name:`${school.name}公开公告`, scope:'school',schoolIds:[id],aiProcessing:'allow',entryUrl:school.announcementUrl };
      await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('sources',$1,$2::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body",[source._id,JSON.stringify(source)]);
      // Keep existing article bodies/discovery dates when a list is refreshed.
      for (const row of rows) await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('items',$1,$2::jsonb)
        ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - 'discoveredAt' - 'createdAt')`, [row.id,JSON.stringify({ _id:row.id,title:row.title,originalUrl:row.url,canonicalUrl:row.url,publishedAt:row.publishedAt,status:'published',scope:'school',schoolIds:[id],sourceId:source._id,sourceName:source.name,aiProcessing:'allow',categories:[/竞赛|比赛|大赛/.test(row.title)?'competition':/活动|报名/.test(row.title)?'activity':'school'],discoveredAt:at,createdAt:at })]);
      await pool.query("UPDATE campus_documents SET body=body || '{\"status\":\"ready\"}'::jsonb WHERE collection='schools' AND id=$1",[id]);
      result = { state:'ready',count:rows.length,checkedAt:at,message:`已读取 ${rows.length} 条公开公告。缓存一小时；正文在打开或预览资料时读取，附件不自动读取。` };
    } catch (error) {
      result = { state:'unavailable',count:0,checkedAt:at,message:error instanceof AppError ? error.message : '学校公开页面暂时无法连接，保留已有公告。请稍后刷新或查看学校原站。' };
    }
    await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1",[id,JSON.stringify({ ...result,retryAt:new Date(now()+(result.state==='ready'?3600000:5*60000)).toISOString() })]);
    return result;
  }
  async function material(row: ItemRow): Promise<ItemRow> {
    if (row.contentText?.trim() || !row.sourceId?.startsWith('directory_')) return row;
    const id = row.schoolIds?.[0];
    if (!id || row.sourceId !== sourceId(id) || row.scope !== 'school' || row.ownerOpenid || !row.originalUrl) return row;
    const school = await source(id);
    const lease = await pool.query(`UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='items' AND id=$1
      AND coalesce(body->>'materialRetryAt','')<$3 RETURNING body`,[row._id,JSON.stringify({materialRetryAt:new Date(now()+5*60000).toISOString()}),new Date(now()).toISOString()]);
    if (!lease.rows.length) {
      const cached = await repo.item(row._id);
      if (cached?.contentText) return cached;
      throw new AppError('NO_MATERIAL','此公告正文正在读取或暂时无法读取，请稍后查看原文。');
    }
    const text = extractArticle(await reader(row.originalUrl,school));
    const patch = { contentText:text,updatedAt:new Date(now()).toISOString() };
    await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='items' AND id=$1",[row._id,JSON.stringify(patch)]);
    return { ...row,...patch };
  }
  return { refresh, material };
}
