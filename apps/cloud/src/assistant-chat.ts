import type { AiChatTurn, AiConversation, AiRecommendations, ReadingTask, ReadingPackage } from '@campus/contracts';
import type { Repository } from './repository';
import type { IdentityContext } from './identity';
import { authorizeSchool, identifier } from './access';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';
import { digest, readingPackage } from './reading-package';
import { AppError, reject } from './errors';
import type { aiService } from './ai-service';
import { buildChatContext, type ContextExchange } from './chat-context';
import { chatSearchQuery } from './chat-intent';

const COLLECTION = 'web_ai_conversations';
const unreadableMaterial = new Set(['NO_MATERIAL', 'SOURCE_UNAVAILABLE', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_RESTRICTED', 'SOURCE_NOT_FOUND', 'SOURCE_ROBOTS_BLOCKED', 'SOURCE_BUSY', 'SOURCE_DAILY_LIMIT']);
type SavedTurn = { id: string; question: string; fingerprint: string; taskId: string | null; materialIds: string[]; references: AiChatTurn['references']; reply?: string; error?: string; history: string; evidence?: import('./chat-context').HistoryEvidence[]; search?: AiRecommendations['search']; webSearch?: boolean; preparing?: boolean; preparationStartedAt?: number; cancelled?: boolean; service: 'official' | 'byok'; provider?: string; model?: string };
type Conversation = { _id: string; owner: string; schoolId: string; createdAt: string; expireAt: string; turns: SavedTurn[]; pendingTurn: string | null; purged?: boolean };
type Ai = ReturnType<typeof aiService>;
export function assistantChat(db: Database, repo: Repository, ai: Ai, recommend: (owner: string, schoolId: string, query?: string) => Promise<AiRecommendations>, now = Date.now, discover?: (schoolId: string, query: string, identity: IdentityContext) => Promise<AiRecommendations>) {
  const requestId = (value: unknown) => { const id = identifier(value); if (id.length < 12 || id.length > 100) reject('VALIDATION_FAILED', '请求编号无效。'); return id; };
  async function purge(row: Conversation) {
    for (const turn of row.turns || []) if (turn.taskId) {
      const task = await readDoc(db, 'web_ai_tasks', turn.taskId);
      if (task?.owner === row.owner) await db.collection('web_ai_tasks').doc(turn.taskId).update({ expireAt: new Date(now()).toISOString(), docs: db.command.remove(), notes: db.command.remove(), batches: db.command.remove(), question: db.command.remove(), result: db.command.remove(), chat: db.command.remove(), webEvidence: db.command.remove(), webSearch: db.command.remove(), purged: true });
    }
    await db.collection(COLLECTION).doc(row._id).update({ turns: db.command.remove(), pendingTurn: null, purged: true });
  }
  async function load(value: unknown, owner: string): Promise<Conversation> {
    const row = await readDoc(db, COLLECTION, identifier(value)) as Conversation | null;
    if (!row || row.owner !== owner) reject('NOT_FOUND', '对话不存在或不属于本人。');
    if (row.purged || Date.parse(row.expireAt) <= now() || !Number.isFinite(Date.parse(row.expireAt))) { if (!row.purged) await purge(row); reject('RESULT_EXPIRED', '对话已到期或已清除，请新建对话。'); }
    await authorizeSchool(repo, owner, row.schoolId); return row;
  }
  function baseTurn(turn: SavedTurn): AiChatTurn {
    return { id: turn.id, question: turn.question, taskId: turn.taskId, state: turn.cancelled ? 'cancelled' : turn.preparing ? 'running' : turn.error ? 'failed' : 'complete', result: turn.reply || null, message: turn.preparing ? '正在检索或准备资料，请稍后刷新对话状态。' : turn.error || (turn.reply ? '未调用模型，不扣官方次数。' : '正在准备本轮，请先刷新状态。'), references: turn.references, step: 0, totalSteps: 0, quotaHeld: false, service: turn.service, provider: turn.provider || '', model: turn.model || '', ...(turn.search ? { search: turn.search } : {}) };
  }
  async function publicTurn(row: Conversation, turn: SavedTurn): Promise<AiChatTurn> {
    if (turn.preparing && now() - (turn.preparationStartedAt || 0) > 90000) {
      await atomic(db, async tx => {
        const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
        const saved = current.turns?.find(value => value.id === turn.id);
        if (saved?.preparing) {
          turn = { ...saved, preparing: false, error: '资料准备超时，未调用模型。请用新问题重试，不会自动重复搜索。' };
          await ref.update({ turns: current.turns.map(value => value.id === turn.id ? turn : value), pendingTurn: current.pendingTurn === turn.id ? null : current.pendingTurn });
        } else if (saved) turn = saved;
      });
    }
    if (!turn.taskId || turn.error || turn.preparing || turn.cancelled) return baseTurn(turn);
    try {
      const task = await ai.handle('ai.task', { taskId: turn.taskId }, { dataOwnerId: row.owner } as IdentityContext) as ReadingTask;
      // Legacy execution or a lost response can finish before the chat lock is
      // released. Reads reconcile only settled tasks and never replay a call.
      await releasePending(row, turn, task);
      return { ...baseTurn(turn), state: task.state, result: task.result, message: task.message, step: task.step, totalSteps: task.totalSteps, quotaHeld: task.quotaHeld, service: task.service, provider: task.provider, model: task.model, ...(task.webSearch ? {webSearch:task.webSearch} : {}) };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!['NOT_FOUND', 'MATERIAL_CHANGED', 'AI_POLICY_BLOCKED', 'RESULT_EXPIRED', 'NO_MATERIAL'].includes(error.code)) throw error;
      const task = await readDoc(db, 'web_ai_tasks', turn.taskId);
      // Revoked evidence must stay hidden, but cancellation and uncertain-call
      // settlement remain available without reading that evidence again.
      const state = task?.state === 'cancelled' || task?.state === 'uncertain' ? task.state : 'failed';
      return { ...baseTurn(turn), state, result: null, references: [], quotaHeld: Boolean(task?.quotaHeld), message: `${error.message} 如有额度预占，请取消本轮后核查。` };
    }
  }
  async function view(row: Conversation): Promise<AiConversation> {
    return { id: row._id, schoolId: row.schoolId, createdAt: row.createdAt, expireAt: row.expireAt, turns: await Promise.all(row.turns.map(turn => publicTurn(row, turn))) };
  }
  async function releasePending(row: Conversation, turn: SavedTurn, task: ReadingTask) {
    if (['ready', 'running', 'uncertain'].includes(task.state) || task.quotaHeld) return;
    await atomic(db, async tx => { const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data); if (current.pendingTurn === turn.id) await ref.update({ pendingTurn: null }); });
  }
  return {
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<unknown> {
      const owner = identity.dataOwnerId;
      if (action === 'ai.chat.latest' || action === 'ai.chat.create') {
        const schoolId = identifier(input.schoolId); await authorizeSchool(repo, owner, schoolId);
        const expired = await db.collection(COLLECTION).where({ owner, schoolId, expireAt: db.command.lte(new Date(now()).toISOString()), purged: db.command.neq(true) }).limit(20).get();
        for (const row of expired.data) await purge(row as unknown as Conversation);
        if (action === 'ai.chat.latest') {
          const { data } = await db.collection(COLLECTION).where({ owner, schoolId, expireAt: db.command.gt(new Date(now()).toISOString()), purged: db.command.neq(true) }).orderBy('createdAt', 'desc').limit(1).get();
          return { conversation: data[0] ? await view(await load(data[0]._id, owner)) : null };
        }
        const id = digest(['conversation-v2', owner, schoolId, requestId(input.requestId)]), createdAt = new Date(now()).toISOString();
        await seed(db, COLLECTION, id, { owner, schoolId, createdAt, expireAt: new Date(now() + 86400000).toISOString(), turns: [], pendingTurn: null });
        return view(await load(id, owner));
      }
      const row = await load(input.conversationId, owner);
      if (action === 'ai.chat.get') return view(row);
      if (action === 'ai.chat.clear') {
        // Lock the latest conversation before checking its tasks. The snapshot
        // read by load can predate another client's completed turn.
        const locked = await atomic(db, async tx => {
          const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
          if (current.purged) reject('RESULT_EXPIRED', '对话已到期或清除。');
          if (current.pendingTurn) reject('TASK_BUSY', '本对话仍有一轮正在处理，请先取消。');
          for (const turn of current.turns) if (turn.taskId) {
            const task = transactionRow((await tx.collection('web_ai_tasks').doc(turn.taskId).get()).data);
            if (task.quotaHeld) reject('TASK_BUSY', '本对话还有额度预占，请先取消或核查本轮状态再清除。');
          }
          await ref.update({ purged: true });
          return current;
        });
        await purge(locked); return { cleared: true };
      }
      if (action === 'ai.chat.send') {
        const id = requestId(input.requestId);
        if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1500) reject('VALIDATION_FAILED', '请输入 1～1500 字的问题。');
        const question = input.question.trim();
        if (input.service !== undefined && !['official', 'byok'].includes(String(input.service))) reject('VALIDATION_FAILED', '使用方式无效。');
        if(input.webSearch!==undefined&&typeof input.webSearch!=='boolean')reject('VALIDATION_FAILED','联网搜索开关无效。');
        if (input.itemIds !== undefined && (!Array.isArray(input.itemIds) || input.itemIds.length > 8)) reject('VALIDATION_FAILED', '一次最多使用八篇公告。');
        const explicitIds = Array.isArray(input.itemIds) ? [...new Set(input.itemIds.map(identifier))] : [];
        const fingerprint = digest([question, explicitIds, input.service || 'official', input.provider || null, input.model || null, ...(input.webSearch ? [true] : [])]);
        let turn = row.turns.find(t => t.id === id);
        if (turn && turn.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '同一请求编号不能更换问题、资料或模型。');
        if (turn?.error || turn?.reply || turn?.preparing || turn?.cancelled) return publicTurn(row, turn);
        if (turn?.taskId && await readDoc(db, 'web_ai_tasks', turn.taskId)) return publicTurn(row, turn);
        if (!turn) {
          const pending: SavedTurn = { id, question, fingerprint, taskId: null, materialIds: [], references: [], history: '', preparing: true, preparationStartedAt: now(), ...(input.webSearch?{webSearch:true}:{}), service: input.service === 'byok' ? 'byok' : 'official', ...(input.provider ? { provider: String(input.provider) } : {}), ...(input.model ? { model: String(input.model) } : {}) };
          let acquired = false;
          await atomic(db, async tx => {
            const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
            if (current.purged || Date.parse(current.expireAt) <= now()) reject('RESULT_EXPIRED', '对话已到期或清除。');
            const existing = current.turns.find(value => value.id === id);
            if (existing) { if (existing.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '请求编号冲突。'); turn = existing; return; }
            if (current.pendingTurn) reject('TASK_BUSY', '请先完成、取消或核查当前轮次，再发送新问题。');
            if (current.turns.length >= 20) reject('CONTEXT_TOO_LONG', '本对话已达到 20 轮，请新建对话。');
            row.turns = current.turns;
            await ref.update({ turns: [...current.turns, pending], pendingTurn: id });
            acquired = true;
          });
          if (!acquired) return publicTurn(row, turn!);
          try {
            const searchQuery = discover && !input.webSearch ? chatSearchQuery(question) : null;
            const discovery = searchQuery ? await discover!(row.schoolId, searchQuery, identity) : null;
            let ids = discovery ? discovery.items.filter(item => item.allowAi).map(item => item.id).slice(0, 5) : explicitIds;
            if (!ids.length && !discovery && !input.webSearch) {
              const last = [...row.turns].reverse().find(t => t.materialIds.length && !t.error);
              const isFollowup = /^(那|它|这个|这条|这项|什么时候|截止|需要|怎么|能否|可以|还有|报名|材料|费用|地点|你刚才|刚才|之前|第二|第一个|接下来)/.test(question);
              ids = last && isFollowup ? last.materialIds : (await recommend(owner, row.schoolId, question)).items.filter(n => n.allowAi).map(n => n.id).slice(0, 5);
            }
            let pack: ReadingPackage | null = null;
            const readable: string[] = [];
            let missingExplicit = false;
            // Title-only recommendations may fail body retrieval independently.
            // Authorization and policy failures must still stop the entire request.
            for (const itemId of ids) {
              try { await readingPackage(db, repo, owner, row.schoolId, [itemId]); readable.push(itemId); }
              catch (error) {
                if (!(error instanceof AppError) || !unreadableMaterial.has(error.code)) throw error;
                if (explicitIds.length && !discovery) missingExplicit = true;
              }
            }
            if (discovery && !readable.length) {
              const local = await recommend(owner, row.schoolId, searchQuery || undefined);
              for (const item of local.items.filter(value => value.allowAi)) {
                try { await readingPackage(db, repo, owner, row.schoolId, [item.id]); readable.push(item.id); }
                catch (error) { if (!(error instanceof AppError) || !unreadableMaterial.has(error.code)) throw error; }
              }
              discovery.search = { ...discovery.search, message: `${discovery.search.message} 本次检索未取得可用于回答的新正文，继续使用已有公告；搜索摘要不作为正文依据。` };
            }
            if (readable.length && !missingExplicit) pack = await readingPackage(db, repo, owner, row.schoolId, readable);
            const modelTurn=Boolean(pack||input.webSearch&&!missingExplicit);
            const profile = await readDoc(db, 'user_profiles', owner);
            const prefs = profile?.aiAssistant?.[row.schoolId]?.preferences;
            const exchanges: ContextExchange[] = [];
            for (const prior of row.turns.slice(-3)) {
              const visible = await publicTurn(row, prior);
              if (visible.state !== 'complete' || !visible.result) continue;
              const task = prior.taskId ? await readDoc(db, 'web_ai_tasks', prior.taskId) : null;
              const evidence = task ? [...(task.docs || []).map((doc: { itemId: string; version: string }) => ({ itemId: doc.itemId, version: doc.version })), ...(task.chat?.evidence || [])] : [];
              exchanges.push({ question: prior.question, answer: visible.result, evidence });
            }
            const { history, evidence } = buildChatContext(row.schoolId, prefs, exchanges, pack?.docs.map(doc => doc.title) || [], discovery?.search);
            const taskId = modelTurn ? digest([owner, digest(['chat-turn', row._id, id])]) : null;
            turn = { id, question, fingerprint, taskId, materialIds: pack?.docs.map(d => d.itemId) || [], references: pack?.docs.map(d => ({ reference: d.reference, itemId: d.itemId, title: d.title, originalUrl: d.originalUrl })) || [], history, evidence, ...(input.webSearch?{webSearch:true}:{}), ...(discovery ? { search: discovery.search } : {}), service: input.service === 'byok' ? 'byok' : 'official', ...(input.provider ? { provider: String(input.provider) } : {}), ...(input.model ? { model: String(input.model) } : {}), ...(!modelTurn ? { reply: missingExplicit ? '所选公告有正文暂时不可读取，请查看原文或调整选择后再提问。此提示未调用模型，不扣官方次数。' : '当前没有可供 AI 阅读的公告正文。请先选择本校公告，或开启联网搜索后继续提问。此提示未调用模型，不扣官方次数。' } : {}) };
            const saved = turn;
            await authorizeSchool(repo, owner, row.schoolId);
            await atomic(db, async tx => {
              const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
              if (current.purged || Date.parse(current.expireAt) <= now()) reject('RESULT_EXPIRED', '对话已到期或清除。');
              const existing = current.turns.find(t => t.id === id);
              if (!existing?.preparing || current.pendingTurn !== id) { turn = existing || { ...pending, preparing: false, cancelled: true }; return; }
              await ref.update({ turns: current.turns.map(value => value.id === id ? saved : value), pendingTurn: modelTurn ? id : null });
            });
          } catch (error) {
            await atomic(db, async tx => {
              const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
              if (!current.purged) await ref.update({ turns: current.turns.map(value => value.id === id && value.preparing ? { ...value, preparing: false, error: error instanceof AppError ? error.message : '资料准备失败，未调用模型。请重新提问。' } : value), pendingTurn: current.pendingTurn === id ? null : current.pendingTurn });
            });
            throw error;
          }
        }
        if (!turn!.taskId) return publicTurn(row, turn!);
        let task: ReadingTask;
        try {
          task = await ai.handle('ai.start', { schoolId: row.schoolId, itemIds: turn!.materialIds, requestId: digest(['chat-turn', row._id, id]), service: turn!.service, provider: turn!.provider, model: turn!.model, task: 'answer', question: turn!.question, chat: { history: turn!.history, evidence: turn!.evidence, expireAt: row.expireAt, ...(turn!.webSearch?{webSearch:true}:{}) } }, identity) as ReadingTask;
        } catch (error) {
          // Preserve idempotency and a safe explanation; do not leave the conversation locked.
          const message = error instanceof AppError ? error.message : '本轮准备未完成，请查询对话状态。';
          const storedTask = await readDoc(db, 'web_ai_tasks', turn!.taskId);
          if (storedTask && storedTask.state !== 'new') throw error;
          await atomic(db, async tx => { const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation; await ref.update({ turns: current.turns.map(t => t.id === id ? { ...t, taskId: null, error: message } : t), pendingTurn: current.pendingTurn === id ? null : current.pendingTurn }); });
          throw error;
        }
        await releasePending(row, turn!, task); return publicTurn(row, turn!);
      }
      const turn = row.turns.find(t => t.id === identifier(input.turnId));
      if (turn && !turn.taskId && action === 'ai.chat.cancel') {
        let cancelled = turn;
        await atomic(db, async tx => {
          const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
          const latest = current.turns?.find(value => value.id === turn.id);
          if (latest?.taskId) reject('TASK_BUSY', '资料准备已完成，请刷新后取消回答。');
          if (latest?.preparing) {
            cancelled = { ...latest, preparing: false, cancelled: true, error: '已取消资料准备，未调用模型。' };
            await ref.update({ turns: current.turns.map(value => value.id === turn.id ? cancelled : value), pendingTurn: current.pendingTurn === turn.id ? null : current.pendingTurn });
          } else if (latest) cancelled = latest;
        });
        return baseTurn(cancelled);
      }
      if (!turn?.taskId) reject('NOT_FOUND', '本轮没有可执行的模型任务。');
      if (!['ai.chat.step', 'ai.chat.cancel', 'ai.chat.resolve'].includes(action)) reject('ACTION_NOT_ALLOWED', '不支持的对话操作。');
      const taskAction = action.replace('ai.chat.', 'ai.');
      const task = await ai.handle(taskAction, { taskId: turn.taskId, ...(action === 'ai.chat.step' ? { step: input.step, ...(input.connection ? { connection: input.connection } : {}) } : action === 'ai.chat.resolve' ? { charged: input.charged } : {}) }, identity) as ReadingTask;
      await releasePending(row, turn, task); return publicTurn(await load(row._id, owner), turn);
    },
  };
}
