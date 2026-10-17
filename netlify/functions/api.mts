import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import { postgresStorage, type SqlPool } from '../../apps/cloud/src/postgres-storage';
import { postgresRepository } from '../../apps/cloud/src/postgres-repository';
import { createSiteApi } from '../../apps/cloud/src/netlify-http';
import { createGateway } from '../../apps/cloud/src/gateway';
import { bookmarksService } from '../../apps/cloud/src/bookmarks';
import { aiService } from '../../apps/cloud/src/ai-service';
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
    const gateway = createGateway(repo, { ownerUid: user.id, dataOwnerId: 'netlify_owner' }, Date.now, { bookmarks: bookmarksService(db, repo), ai: aiService(db, repo) });
    return gateway(event, { uid: user.id, isAnonymous: false });
  },
});
