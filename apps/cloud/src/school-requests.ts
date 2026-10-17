import { createHash } from 'node:crypto';
import type { SchoolRequest } from '@campus/contracts';
import type { SqlPool } from './postgres-storage';
import { AppError } from './errors';
export const SCHOOL_FORM = 'school-add-request';
export function schoolName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION_FAILED','请输入学校名称。');
  const name = value.normalize('NFKC').trim().replace(/ +/g,' ');
  if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{N} ()·.\-]+$/u.test(name)) throw new AppError('VALIDATION_FAILED','学校名称须为 2～80 个字，可包含中英文、数字和括号。');
  return name;
}
export function schoolRequests(pool: SqlPool, submit: (fields: URLSearchParams) => Promise<void>, now = Date.now) {
  return async (value: unknown, owner: string, email: string): Promise<SchoolRequest> => {
    const name = schoolName(value), at = new Date(now()).toISOString();
    const day = new Date(now()+8*3600000).toISOString().slice(0,10);
    const id = createHash('sha256').update(`${owner}\n${day}\n${name.toLowerCase()}`).digest('hex');
    const client = await pool.connect(); let duplicate: SchoolRequest | undefined;
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,'{}') ON CONFLICT DO NOTHING",[owner]);
      const profile = (await client.query("SELECT body FROM campus_documents WHERE collection='user_profiles' AND id=$1 FOR UPDATE",[owner])).rows[0]!.body;
      const existing = (await client.query("SELECT body FROM campus_documents WHERE collection='school_requests' AND id=$1",[id])).rows[0]?.body;
      if (existing) duplicate = { id,state:existing.state,message:existing.message || '申请已记录，请勿重复提交。' };
      else {
        const count = profile.schoolRequestDay === day ? Number(profile.schoolRequestCount || 0) : 0;
        if (count >= 3) throw new AppError('REQUEST_LIMIT','今天已提交 3 个学校申请，请明天再试。');
        await client.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='user_profiles' AND id=$1",[owner,JSON.stringify({schoolRequestDay:day,schoolRequestCount:count+1})]);
        await client.query("INSERT INTO campus_documents(collection,id,body) VALUES('school_requests',$1,$2::jsonb)",[id,JSON.stringify({owner,email,schoolName:name,createdAt:at,state:'pending'})]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (duplicate) return duplicate;
    let result: SchoolRequest;
    try {
      await submit(new URLSearchParams({ 'form-name':SCHOOL_FORM,school:name,email,'request-id':id,'bot-field':'',message:`已登录用户申请添加学校：${name}。请核实学校官网与公开公告入口后接入。` }));
      result = {id,state:'submitted',message:'学校申请已提交。客服核实后添加；请勿重复提交。'};
    } catch {
      // Delivery may have completed before a connection failed. Never auto-repost.
      result = {id,state:'unknown',message:'申请已记录，通知提交状态待确认。请勿重复提交，客服可核对申请编号。'};
    }
    await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_requests' AND id=$1",[id,JSON.stringify(result)]);
    return result;
  };
}
