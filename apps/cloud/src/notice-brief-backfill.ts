import type {SqlPool,Row} from './postgres-storage';
import type {ItemRow} from './repository';

export type BriefArticleReader=(row:ItemRow,school:string,deadline:number)=>Promise<string>;
interface Options {
 scope:string;now():number;enabled():boolean;readLimit:number;
 article:BriefArticleReader;
 capacity():Promise<boolean>;
 eligible(id:string,school:string):Promise<ItemRow|null>;
 known(row:ItemRow,school:string):Promise<boolean>;
 enqueue(row:ItemRow,school:string,text:string):Promise<boolean>;
}
const iso=(at:number)=>new Date(at).toISOString();
const day=(at:number)=>iso(at+8*3600000).slice(0,10);
const tomorrow=(at:number)=>iso(Date.parse(day(at)+'T00:00:00+08:00')+86400000);
const scanLimit=5000;

/** Invoked under the same global lease as model work. Wakes may inspect the
 * checkpoint, but only that worker advances it. No request-page side effects. */
export function noticeBriefBackfill(pool:SqlPool,options:Options){
 const {scope,now}=options;
 async function state():Promise<Row>{
  await pool.query(`INSERT INTO campus_notice_brief_backfill(store_scope,budget_day) VALUES($1,$2)
   ON CONFLICT(store_scope) DO UPDATE SET budget_day=$2,
   scanned=CASE WHEN campus_notice_brief_backfill.budget_day=$2 THEN campus_notice_brief_backfill.scanned ELSE 0 END,
   article_reads=CASE WHEN campus_notice_brief_backfill.budget_day=$2 THEN campus_notice_brief_backfill.article_reads ELSE 0 END`,[scope,day(now())]);
  return(await pool.query('SELECT * FROM campus_notice_brief_backfill WHERE store_scope=$1',[scope])).rows[0];
 }
 async function defer(){await pool.query('UPDATE campus_notice_brief_backfill SET available_at=$2,updated_at=$3 WHERE store_scope=$1',[scope,tomorrow(now()),iso(now())]);}
 async function due(){
  if(!options.enabled()||!await options.capacity())return false;
  const row=await state();if(Date.parse(row.available_at)>now())return false;
  if(row.scanned>=scanLimit||row.article_reads>=options.readLimit){await defer();return false;}
  return true;
 }
 async function run(deadline:number){
  let scanned=0,queued=0,failed=0;
  while(scanned<500&&now()<deadline-25000&&await due()){
   const checkpoint=await state();
   const rows=(await pool.query(`SELECT i.id,i.body,s.body AS source FROM campus_documents i
    LEFT JOIN campus_documents s ON s.collection='sources' AND s.id=i.body->>'sourceId'
    WHERE i.collection='items' AND i.id>$1 AND i.body->>'status'='published'
    AND coalesce(i.body->>'ownerOpenid','')='' AND i.body->>'scope' IS DISTINCT FROM 'private'
    ORDER BY i.id LIMIT 50`,[checkpoint.cursor_id])).rows;
   if(!rows.length){await pool.query("UPDATE campus_notice_brief_backfill SET cursor_id='',available_at=$2,updated_at=$3 WHERE store_scope=$1",[scope,tomorrow(now()),iso(now())]);break;}
   for(const row of rows){
    if(scanned>=500||now()>=deadline-25000||!await due())break;
    const item=row.body as ItemRow,source=row.source||{};
    const global=item.scope==='global'||(!item.scope&&(source.scope==='global'||['ciscn-announcement','lanqiao-competition'].includes(source.key)));
    const school=global?'global':item.schoolIds?.[0]||source.schoolIds?.[0]||'bjtu';
    const candidate=await options.eligible(row.id,school);
    if(candidate&&!await options.known(candidate,school)){
     const reserved=await pool.query(`UPDATE campus_notice_brief_backfill SET article_reads=article_reads+1
      WHERE store_scope=$1 AND budget_day=$2 AND article_reads<$3 RETURNING store_scope`,[scope,day(now()),options.readLimit]);
     if(!reserved.rows.length){await defer();break;}
     try{const text=await options.article(candidate,school,Math.min(deadline,now()+20000));if(options.enabled()&&await options.enqueue(candidate,school,text))queued++;}
     catch{failed++;} // Individual unavailable pages cannot stop the catalogue.
    }
    await pool.query('UPDATE campus_notice_brief_backfill SET cursor_id=$2,scanned=scanned+1,updated_at=$3 WHERE store_scope=$1',[scope,row.id,iso(now())]);
    scanned++;
   }
  }
  return{scanned,queued,failed};
 }
 return{due,run};
}
