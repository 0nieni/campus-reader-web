import {atomic, seed, transactionRow, type Database} from './storage';
import {reject} from './errors';

/** All external search paths share this per-account ledger. Attempts are not retried. */
export async function reserveSearch(db:Database,owner:string,now=Date.now()) {
  const day=new Date(now+8*3600000).toISOString().slice(0,10);
  await seed(db,'user_profiles',owner,{});
  await atomic(db,async tx=>{
    const ref=tx.collection('user_profiles').doc(owner),row=transactionRow((await ref.get()).data);
    const prior=row.aiSearchBudget?.day===day?row.aiSearchBudget:{day,count:0,lastAt:0};
    if(prior.count>=20||now-prior.lastAt<15000)reject('SEARCH_LIMIT','联网搜索请至少间隔 15 秒，每人每天最多 20 次；已有公告仍可使用。');
    await ref.update({aiSearchBudget:{day,count:prior.count+1,lastAt:now}});
  });
}
