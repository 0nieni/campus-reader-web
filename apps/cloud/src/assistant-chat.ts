import type { AiChatTurn, AiConversation, AiRecommendations, ReadingTask, ReadingPackage } from '@campus/contracts';
import type { Repository } from './repository';
import type { IdentityContext } from './identity';
import { authorizeSchool, identifier } from './access';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';
import { digest, readingPackage } from './reading-package';
import { AppError, reject } from './errors';
import type { aiService } from './ai-service';
import { buildChatContext, type ContextExchange, type MemorySnapshot, type MemoryDependency } from './chat-context';
import { chatSearchQuery, isSearchCapabilityQuestion } from './chat-intent';
import {deepseekSearchConfigured} from './deepseek-search';
import { memoryService, selectMemoryItems } from './assistant-memory';
import { buildConversationSummary } from './conversation-summary';
import type { AiProviderRef } from '@campus/contracts';
import type { ProviderProfiles } from './ai-provider-profiles';
import { checkedProviderRef } from './provider-endpoints';
import { filterProgramReferences } from './program-references';

const COLLECTION = 'web_ai_conversations';
const unreadableMaterial = new Set(['NO_MATERIAL', 'SOURCE_UNAVAILABLE', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_RESTRICTED', 'SOURCE_NOT_FOUND', 'SOURCE_ROBOTS_BLOCKED', 'SOURCE_BUSY', 'SOURCE_DAILY_LIMIT']);
type SavedTurn = { id: string; question: string; fingerprint: string; taskId: string | null; materialIds: string[]; references: AiChatTurn['references']; reply?: string; programReply?: AiChatTurn['programReply']; error?: string; history: string; summary?: string; evidence?: import('./chat-context').HistoryEvidence[]; memory?: MemorySnapshot; memoryDependencies?: MemoryDependency[]; search?: AiRecommendations['search']; preparing?: boolean; preparationStartedAt?: number; cancelled?: boolean; service: 'official' | 'byok'; provider?: string; model?: string; providerProfile?: AiProviderRef };
type Conversation = { _id: string; owner: string; schoolId: string; createdAt: string; expireAt: string; turns: SavedTurn[]; pendingTurn: string | null; purged?: boolean };
type Ai = ReturnType<typeof aiService>;
export function assistantChat(db: Database, repo: Repository, ai: Ai, recommend: (owner: string, schoolId: string, query?: string) => Promise<AiRecommendations>, now = Date.now, discover?: (schoolId: string, query: string, identity: IdentityContext) => Promise<AiRecommendations>, providers?: ProviderProfiles) {
  const memory = memoryService(db, repo, now);
  const requestId = (value: unknown) => { const id = identifier(value); if (id.length < 12 || id.length > 100) reject('VALIDATION_FAILED', '请求编号无效。'); return id; };
  async function purge(row: Conversation) {
    for (const turn of row.turns || []) if (turn.taskId) {
      const task = await readDoc(db, 'web_ai_tasks', turn.taskId);
      if (task?.owner === row.owner) await db.collection('web_ai_tasks').doc(turn.taskId).update({ expireAt: new Date(now()).toISOString(), docs: db.command.remove(), notes: db.command.remove(), batches: db.command.remove(), question: db.command.remove(), result: db.command.remove(), chat: db.command.remove(), memoryProposals: db.command.remove(), purged: true });
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
    return { id: turn.id, question: turn.question, taskId: turn.taskId, state: turn.cancelled ? 'cancelled' : turn.preparing ? 'running' : turn.error ? 'failed' : 'complete', result: turn.reply || null, message: turn.preparing ? '正在检索或准备资料，请稍后刷新对话状态。' : turn.error || (turn.reply ? '未调用模型，不扣官方次数。' : '正在准备本轮，请先刷新状态。'), references: turn.references, step: 0, totalSteps: 0, quotaHeld: false, service: turn.service, provider: turn.provider || '', model: turn.model || '', ...(turn.providerProfile ? { providerProfile: turn.providerProfile } : {}), ...(turn.search ? { search: turn.search } : {}), ...(turn.programReply ? { programReply: turn.programReply } : {}) };
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
    if (!turn.taskId || turn.error || turn.preparing || turn.cancelled) {
      const visible = baseTurn(turn);
      if (turn.programReply === 'search_status' && visible.references.length) {
        const references = await filterProgramReferences(db, repo, row.owner, row.schoolId, visible.references);
        if (references.length < visible.references.length) visible.result = `${visible.result || ''}\n\n部分原文入口已变化或不可访问，已隐藏；请重新搜索确认。`;
        visible.references = references;
      }
      return visible;
    }
    try {
      const task = await ai.handle('ai.task', { taskId: turn.taskId }, { dataOwnerId: row.owner } as IdentityContext) as ReadingTask;
      // Legacy execution or a lost response can finish before the chat lock is
      // released. Reads reconcile only settled tasks and never replay a call.
      await releasePending(row, turn, task);
      let memoryMessage: string | undefined;
      if (task.state === 'complete') {
        try {
          const saved = await readDoc(db, 'web_ai_tasks', turn.taskId);
          if (saved?.chat?.memory?.enabled && saved.memoryProposals?.length) {
            await memory.apply(row.owner, row.schoolId, { requestId: saved.id, question: saved.question, proposals: saved.memoryProposals, generation: saved.chat.memory.generation, observedAt: saved.createdAt });
          }
        } catch (error) {
          if (error instanceof AppError && ['STALE_SCOPE', 'UNAUTHENTICATED', 'SCHOOL_NOT_FOUND', 'AI_POLICY_BLOCKED'].includes(error.code)) throw error;
          memoryMessage = '本次记忆暂未更新，回答已正常保留。稍后刷新对话状态可重试保存，不会再次调用模型。';
        }
      }
      return { ...baseTurn(turn), state: task.state, result: task.result, message: task.message, step: task.step, totalSteps: task.totalSteps, quotaHeld: task.quotaHeld, service: task.service, provider: task.provider, model: task.model, ...(memoryMessage ? { memoryMessage } : {}) };
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
  async function completeProgramTurn(row: Conversation, pending: SavedTurn, patch: Pick<SavedTurn, 'reply' | 'programReply'> & Partial<Pick<SavedTurn, 'references' | 'search'>>): Promise<AiChatTurn> {
    let turn: SavedTurn = { ...pending, preparing: false, ...patch };
    await load(row._id, row.owner);
    await atomic(db, async tx => {
      const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
      if (current.purged || Date.parse(current.expireAt) <= now()) reject('RESULT_EXPIRED', '对话已到期或清除。');
      const existing = current.turns.find(value => value.id === pending.id);
      if (!existing?.preparing || current.pendingTurn !== pending.id) { turn = existing || { ...pending, preparing: false, cancelled: true }; return; }
      await ref.update({ turns: current.turns.map(value => value.id === pending.id ? turn : value), pendingTurn: null });
    });
    return publicTurn(await load(row._id, row.owner), turn);
  }
  function searchStatusTurn(row: Conversation, pending: SavedTurn, discovery: AiRecommendations, explanation?: string) {
    const reply = explanation || (discovery.search.state !== 'complete'
      ? `这次没有完成联网搜索。${discovery.search.message} 下方保留已收录公告的入口；本轮没有调用模型。`
      : discovery.search.candidateCount === 0
        ? '联网搜索已完成，但这次没找到可用的公开网页线索。下方保留已收录公告入口，不会把它们当成本次新搜到的结果。'
        : `联网搜索找到了${discovery.search.candidateCount ?? '一些'}条候选，但本次没有取得可用于AI回答的正文。${discovery.search.message} 你可以查看仍可访问的原文入口；搜索摘要不会被当作公告正文。`);
    return completeProgramTurn(row, pending, { reply, programReply: 'search_status', search: discovery.search,
      references: discovery.items.slice(0, 5).map((item, index) => ({ reference: `R${index + 1}`, itemId: item.id, title: item.title, originalUrl: item.originalUrl })) });
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
        if (input.itemIds !== undefined && (!Array.isArray(input.itemIds) || input.itemIds.length > 8)) reject('VALIDATION_FAILED', '一次最多使用八篇公告。');
        const explicitIds = Array.isArray(input.itemIds) ? [...new Set(input.itemIds.map(identifier))] : [];
        const providerProfile = input.providerProfile === undefined ? undefined : checkedProviderRef(input.providerProfile);
        if (providerProfile && (input.service !== 'byok' || input.provider !== undefined || !providers)) reject('VALIDATION_FAILED', '请重新选择已保存的个人服务商配置。');
        const fingerprint = digest([question, explicitIds, input.service || 'official', input.provider || null, input.model || null, ...(providerProfile ? [providerProfile] : [])]);
        let turn = row.turns.find(t => t.id === id);
        if (turn && turn.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '同一请求编号不能更换问题、资料或模型。');
        if (turn?.error || turn?.reply || turn?.preparing || turn?.cancelled) return publicTurn(row, turn);
        if (turn?.taskId && await readDoc(db, 'web_ai_tasks', turn.taskId)) return publicTurn(row, turn);
        if (!turn) {
          if (providerProfile) await providers!.resolve(owner, providerProfile, String(input.model || ''));
          const pending: SavedTurn = { id, question, fingerprint, taskId: null, materialIds: [], references: [], history: '', preparing: true, preparationStartedAt: now(), service: input.service === 'byok' ? 'byok' : 'official', ...(input.provider ? { provider: String(input.provider) } : {}), ...(input.model ? { model: String(input.model) } : {}), ...(providerProfile ? { providerProfile } : {}) };
          let acquired = false;
          await atomic(db, async tx => {
            const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
            if (current.purged || Date.parse(current.expireAt) <= now()) reject('RESULT_EXPIRED', '对话已到期或清除。');
            const existing = current.turns.find(value => value.id === id);
            if (existing) { if (existing.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '请求编号冲突。'); turn = existing; return; }
            if (current.pendingTurn) reject('TASK_BUSY', '请先完成、取消或核查当前轮次，再发送新问题。');
            if (current.turns.length >= 20) reject('CONTEXT_TOO_LONG', '本对话已达到 20 轮，请新建对话。');
            if (providerProfile) await providers!.guard(tx, owner, providerProfile, String(input.model || ''));
            row.turns = current.turns;
            await ref.update({ turns: [...current.turns, pending], pendingTurn: id });
            acquired = true;
          });
          if (!acquired) return publicTurn(row, turn!);
          try {
            // Program-owned capability facts and memory management need no model or sources.
            const command = isSearchCapabilityQuestion(question)
              ? { handled: true, message: discover && deepseekSearchConfigured()
                ? 'DeepSeek 搜索服务已配置，可以帮你搜索公开网页，也可以查当前学校的公告。你可以直接问“最近学校有什么比赛可以报名”。是否搜到、正文能否读到，会按本次实际结果说明；外部网页会标明真实来源，不会冒充学校官方通知。搜索和网页读取由网站后台的 DeepSeek 账户单独计量。'
                : '当前还不能实际联网，因为网站后台尚未配置可用于搜索的官方 DeepSeek Key。请联系网站管理员；已收录的公告仍然可以查看。个人聊天模型配置不影响后台统一搜索配置。' }
              : await memory.command(owner, row.schoolId, { requestId: digest(['chat-memory-command', row._id, id]), question });
            if (command.handled) return completeProgramTurn(row, pending, { reply: command.message || '请说明要修改或删除哪条自动记忆。', programReply: isSearchCapabilityQuestion(question) ? 'search_capability' : 'memory' });
            const searchQuery = discover ? chatSearchQuery(question) : null;
            const discovery = searchQuery ? await discover!(row.schoolId, searchQuery, identity) : null;
            if (discovery && (discovery.search.state !== 'complete' || discovery.search.readableCount === 0)) return searchStatusTurn(row, pending, discovery);
            if (discovery && explicitIds.length === 8 && discovery.items.some(item => item.allowAi && !explicitIds.includes(item.id) && (!discovery.search.candidateIds || discovery.search.candidateIds.includes(item.id)))) {
              return searchStatusTurn(row, pending, discovery, `联网搜索已完成，找到${discovery.search.candidateCount ?? '一些'}条候选、取得${discovery.search.readableCount ?? '一些'}篇可读正文。你已选择8篇资料，已达到单次上限；请减少所选资料，为搜索正文留出位置后再提问。本轮未调用模型，不扣官方次数。`);
            }
            // Validate all bounded search candidates before allocating remaining
            // document slots; an unreadable first hit must not hide a later body.
            let ids = discovery ? [...new Set([...explicitIds, ...discovery.items.filter(item => item.allowAi && (!discovery.search.candidateIds || discovery.search.candidateIds.includes(item.id))).map(item => item.id).slice(0, 5)])] : explicitIds;
            if (!ids.length && !discovery) {
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
                if (explicitIds.includes(itemId)) missingExplicit = true;
              }
            }
            if (discovery) {
              discovery.search = { ...discovery.search, readableCount: readable.filter(id => !discovery.search.candidateIds || discovery.search.candidateIds.includes(id)).length };
              if (!discovery.search.readableCount) return searchStatusTurn(row, pending, discovery);
            }
            if (readable.length && !missingExplicit) {
              const packIds = discovery ? [...readable.filter(id => explicitIds.includes(id)), ...readable.filter(id => !explicitIds.includes(id)).slice(0, 8 - explicitIds.length)] : readable;
              try { pack = await readingPackage(db, repo, owner, row.schoolId, packIds); }
              catch (error) {
                if (!discovery || !(error instanceof AppError) || !unreadableMaterial.has(error.code)) throw error;
                // Reacquisition can fail after successful individual reads. Recheck
                // candidate bodies for truthful counts, but do not retry model work.
                let count = 0;
                for (const itemId of readable) {
                  try {
                    await readingPackage(db, repo, owner, row.schoolId, [itemId]);
                    if (!discovery.search.candidateIds || discovery.search.candidateIds.includes(itemId)) count++;
                  } catch (recheckError) {
                    if (!(recheckError instanceof AppError) || !unreadableMaterial.has(recheckError.code)) throw recheckError;
                  }
                }
                discovery.search = { ...discovery.search, readableCount: count };
                return searchStatusTurn(row, pending, discovery, count ? `联网搜索已完成，找到${discovery.search.candidateCount ?? '一些'}条候选；合并资料时正文暂不可读取，重新核验后仍有${count}篇搜索正文可读。请查看原文或调整选择后重新提问。本轮未调用模型，不扣官方次数。` : undefined);
              }
            }
            const profile = await readDoc(db, 'user_profiles', owner);
            const prefs = profile?.aiAssistant?.[row.schoolId]?.preferences;
            const memoryState = await memory.get(owner, row.schoolId);
            const memorySnapshot: MemorySnapshot = { enabled: memoryState.enabled, generation: memoryState.generation, items: memoryState.enabled ? selectMemoryItems(memoryState.items, question).map(({ id, slot, text, goalId }) => ({ id, slot, text, ...(goalId ? { goalId } : {}) })) : [] };
            const exchanges: ContextExchange[] = [];
            const older: ContextExchange[] = [];
            for (const [index, prior] of row.turns.entries()) {
              if (!prior.taskId) continue;
              if ((prior.memory?.generation ?? 0) !== memoryState.generation) continue;
              if (prior.memory?.items.some(saved => !memoryState.items.some(item => item.id === saved.id && item.text === saved.text))) continue;
              let visible: AiChatTurn;
              try { visible = await publicTurn(row, prior); }
              catch (error) { if (error instanceof AppError && unreadableMaterial.has(error.code)) continue; throw error; }
              if (visible.state !== 'complete' || !visible.result) continue;
              const task = prior.taskId ? await readDoc(db, 'web_ai_tasks', prior.taskId) : null;
              const memoryDependencies: MemoryDependency[] = [...(task?.chat?.memory?.items || prior.memory?.items || []).map(({ id, text }: MemoryDependency) => ({ id, text })), ...(task?.chat?.memoryDependencies || prior.memoryDependencies || [])];
              if (memoryDependencies.some(saved => !memoryState.items.some(item => item.id === saved.id && item.text === saved.text))) continue;
              const evidence = task ? [...(task.docs || []).map((doc: { itemId: string; version: string }) => ({ itemId: doc.itemId, version: doc.version })), ...(task.chat?.evidence || [])] : [];
              const exchange = { question: prior.question, answer: visible.result, evidence, memoryDependencies };
              if (index < row.turns.length - 3) older.push(exchange); else exchanges.push(exchange);
            }
            const summaryInput = buildConversationSummary(older);
            const { history, evidence, summary, memoryDependencies } = buildChatContext(row.schoolId, prefs, exchanges, pack?.docs.map(doc => doc.title) || [], discovery?.search, summaryInput);
            const taskId = pack ? digest([owner, digest(['chat-turn', row._id, id])]) : null;
            turn = { id, question, fingerprint, taskId, materialIds: pack?.docs.map(d => d.itemId) || [], references: pack?.docs.map(d => ({ reference: d.reference, itemId: d.itemId, title: d.title, originalUrl: d.originalUrl })) || [], history, summary, evidence, memory: memorySnapshot, memoryDependencies, ...(discovery ? { search: discovery.search } : {}), service: input.service === 'byok' ? 'byok' : 'official', ...(input.provider ? { provider: String(input.provider) } : {}), ...(input.model ? { model: String(input.model) } : {}), ...(providerProfile ? { providerProfile } : {}), ...(!pack ? { reply: missingExplicit ? '所选公告有正文暂时不可读取，请查看原文或调整选择后再提问。此提示未调用模型，不扣官方次数。' : '当前没有可供 AI 阅读的公告正文。请先选择本校公告，或使用联网搜索查找公开公告，再继续提问。此提示未调用模型，不扣官方次数。' } : {}) };
            const saved = turn;
            await authorizeSchool(repo, owner, row.schoolId);
            await atomic(db, async tx => {
              const ref = tx.collection(COLLECTION).doc(row._id), current = transactionRow((await ref.get()).data) as Conversation;
              if (current.purged || Date.parse(current.expireAt) <= now()) reject('RESULT_EXPIRED', '对话已到期或清除。');
              const existing = current.turns.find(t => t.id === id);
              if (!existing?.preparing || current.pendingTurn !== id) { turn = existing || { ...pending, preparing: false, cancelled: true }; return; }
              if (providerProfile) await providers!.guard(tx, owner, providerProfile, String(input.model || ''));
              await ref.update({ turns: current.turns.map(value => value.id === id ? saved : value), pendingTurn: pack ? id : null });
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
          task = await ai.handle('ai.start', { schoolId: row.schoolId, itemIds: turn!.materialIds, requestId: digest(['chat-turn', row._id, id]), service: turn!.service, ...(turn!.providerProfile ? { providerProfile: turn!.providerProfile } : { provider: turn!.provider }), model: turn!.model, task: 'answer', question: turn!.question, chat: { history: turn!.history, summary: turn!.summary, memory: turn!.memory, memoryDependencies: turn!.memoryDependencies, evidence: turn!.evidence, expireAt: row.expireAt } }, identity) as ReadingTask;
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
