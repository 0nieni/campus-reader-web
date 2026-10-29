import type {SqlPool} from './postgres-storage';
export async function cleanupNoticeBriefs(pool:SqlPool,now=Date.now()){
 const client=await pool.connect();try{await client.query('BEGIN');
  const rows=(await client.query("SELECT * FROM campus_notice_briefs WHERE state='running' AND lease_until<=$1 AND quota_settled=false ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED",[new Date(now).toISOString()])).rows;
  for(const row of rows){await client.query('UPDATE campus_notice_brief_budget SET held_tokens=GREATEST(0,held_tokens-$3),used_tokens=used_tokens+$3 WHERE store_scope=$1 AND day=$2',[row.store_scope,row.quota_day,row.reserved_tokens]);await client.query("UPDATE campus_notice_briefs SET state='uncertain',quota_settled=true,input='{}',error_code='MODEL_UNCERTAIN',message='上次请求结果不明，已停止自动重试，请先核查服务商用量。' WHERE id=$1",[row.id]);}
  await client.query('DELETE FROM campus_notice_briefs WHERE id IN (SELECT id FROM campus_notice_briefs WHERE expires_at<$1 AND quota_settled=true ORDER BY expires_at LIMIT 1000)',[new Date(now).toISOString()]);
  await client.query('DELETE FROM campus_notice_brief_budget WHERE (store_scope,day) IN (SELECT store_scope,day FROM campus_notice_brief_budget WHERE day<$1 ORDER BY day LIMIT 1000)',[new Date(now-400*86400000).toISOString().slice(0,10)]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
