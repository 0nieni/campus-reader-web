import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import { getContext } from '@netlify/functions';
import { AppError } from '../../apps/cloud/src/errors';
import { postgresStorage, type SqlPool } from '../../apps/cloud/src/postgres-storage';
import { postgresRepository } from '../../apps/cloud/src/postgres-repository';
import { createSiteApi } from '../../apps/cloud/src/netlify-http';
import { createGateway } from '../../apps/cloud/src/gateway';
import { bookmarksService } from '../../apps/cloud/src/bookmarks';
import { aiService } from '../../apps/cloud/src/ai-service';
import { siteWorkspace } from '../../apps/cloud/src/site-access';
import { schoolDirectory } from '../../apps/cloud/src/school-directory';
import { schoolRequests } from '../../apps/cloud/src/school-requests';
import {websiteSources} from '../../apps/cloud/src/website-sources';
import {reminderService} from '../../apps/cloud/src/reminders';
import {reminderRuntime} from '../../apps/cloud/src/netlify-reminder-runtime';
declare const Netlify: { env: { get(name: string): string | undefined } };
let pool: SqlPool | undefined;
export default createSiteApi({
  auth: { async user() { const user = await getUser(); return user?.email ? { id: user.id, email: user.email } : null; } },
  ownerEmail: () => Netlify.env.get('NETLIFY_OWNER_EMAIL'),
  async gateway(event, user) {
    // Runtime values only, never VITE_ or static build configuration. No relay to CloudBase.
    for (const key of ['AI_CHAT_API_KEY', 'AI_DAILY_LIMIT', 'AI_PLATFORM_DAILY_CALLS', 'AI_PLATFORM_DAILY_TOKENS']) {
      const value = Netlify.env.get(key); if (value !== undefined) process.env[key] = value;
    }
    process.env.AI_CHAT_BASE_URL = Netlify.env.get('AI_CHAT_BASE_URL') || 'https://api.deepseek.com';
    process.env.AI_CHAT_MODEL = Netlify.env.get('AI_CHAT_MODEL') || 'deepseek-flash';
    process.env.AI_EXECUTION_MODE = 'direct';
    process.env.AI_PROVIDER = 'openai_compatible';
    pool ||= getDatabase().pool as unknown as SqlPool;
    const db = postgresStorage(pool), repo = postgresRepository(pool);
    const directory = schoolDirectory(pool,repo);
    const websites=websiteSources(pool,repo);
    repo.material = row=>row.importKind==='website'?websites.material(row):directory.material(row);
    const request = schoolRequests(pool,async fields => {
      // Fixed site target: never accept URLs, recipients, email addresses or UID
      // from the browser. Notification recipients are configured in Netlify Forms.
      const response = await fetch('https://campus-reader-ninie6159.netlify.app/__forms.html', {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:fields.toString(),redirect:'error',signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('Form submission not confirmed');
    });
    const runtime=reminderRuntime(pool,getContext().deploy.context==='production'),workspace=siteWorkspace(user,Netlify.env.get('NETLIFY_OWNER_EMAIL'));
    const reminderAction=(event as {action?:unknown})?.action;
    if(typeof reminderAction==='string'&&reminderAction.startsWith('reminders.'))await runtime.aliyun.email.bind(workspace.dataOwnerId,user.id,user.email);
    const gateway = createGateway(repo, workspace, Date.now, { reminders:reminderService(pool,runtime), websites, bookmarks: bookmarksService(db, repo), ai: aiService(db, repo), directory:{refresh:directory.refresh,request:(name,identity)=>{
      if (getContext().deploy.context !== 'production') throw new AppError('PRODUCTION_REQUIRED','请在正式网站提交学校添加申请；预览环境不发送通知。');
      return request(name,identity.dataOwnerId,user.email);
    }} });
    return gateway(event, { uid: user.id, isAnonymous: false });
  },
});
