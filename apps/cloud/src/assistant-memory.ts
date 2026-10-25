import type { AiMemoryItem, AiMemorySlot, AiMemoryState } from '@campus/contracts';
import { authorizeSchool, identifier } from './access';
import { reject } from './errors';
import type { IdentityContext } from './identity';
import type { Repository } from './repository';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';
import { createHash } from 'node:crypto';
import { goalMatches, goalTerms, memoryCommandReceiptLifetimeMs, parseMemoryCommand } from './memory-command';

export interface MemoryProposal { slot: AiMemorySlot; text: string; evidence: string; goalId?: string }
interface ApplyInput { requestId: string; question: string; proposals: MemoryProposal[]; generation: number; observedAt: number | string }
type Row = Record<string, any>;
export interface MemoryCommandResult { handled: boolean; message?: string; changed?: boolean }
interface CommandReceipt { requestId: string; at: string; fingerprint: string; result: MemoryCommandResult }
interface StoredMemory { enabled: boolean; version: number; generation: number; items: AiMemoryItem[]; processedRequests: string[]; updatedAtBySlot: Partial<Record<AiMemorySlot, string>>; updatedAtByItem: Record<string, string>; commandRequests: CommandReceipt[] }
const slots: AiMemorySlot[] = ['major', 'year', 'interests', 'response_style', 'goal', 'progress'];
const lifetimes: Partial<Record<AiMemorySlot, number>> = { year: 365, goal: 180, progress: 30 };
const day = 86400000;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const counter = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const isSlot = (value: unknown): value is AiMemorySlot => typeof value === 'string' && slots.includes(value as AiMemorySlot);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const date = (value: unknown): number => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const control = /[\u0000-\u001f\u007f]/;
const sensitive = /密[码钥]|口令|令牌|身份证|护照|证件|银行卡|手机号|电话号码|联系方式|微信号|api[\s_-]*key|password|secret|access[\s_-]*token|bearer\s|sk-[a-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[-\s]?)?1[3-9]\d{9}|\b\d[\d\s-]{7,}\d\b/i;
const optOut = /(?:不要|别|不许|不用|无需|不想|不希望|不允许|禁止|不能|不准).{0,10}(?:记住|记忆|保存|记录|存储)|(?:do\s*not|don't|never).{0,15}(?:remember|save|store)/i;
const nonPersonal = /假如|假设|如果|设想|想象|假装|比如说|举个例子|示例|同学说|朋友说|别人说|他人|我的(?:朋友|同学|同事|室友)|公告(?:写|说|中|里|内容)|原文(?:写|说|中|里)|(?:suppose|imagine|what if|\bif\s+I\b|my (?:friend|sister|brother|colleague)|for example)/i;
const self = /(?:我(?:的|是|现在|目前|已|想|要|希望|喜欢|长期|准备|计划|正在|主修|学|偏好|对|更|比较|倾向|习惯|主要|打算|目标|热爱|平时|持续|一直|通常)|本人|\bI\s+(?:am|study|prefer|like|want|plan|have)|\bmy\s+(?:major|year|goal|interest))/i;
const meaning: Record<AiMemorySlot, RegExp> = {
  major: /专业|主修|学的|学的是|转到|major|studying/i,
  year: /大[一二三四五六]|研[一二三四]|博[一二三四五六]|年级|本科|硕士|博士|freshman|sophomore|junior|senior|year\s*\d/i,
  interests: /喜欢|兴趣|感兴趣|关注|热爱|偏好|interested|interest|like|enjoy/i,
  response_style: /回答|回复|解释|结论|简短|详细|分点|语气|风格|步骤|例子|answer|respond|response|concise|detail/i,
  goal: /(?:准备|计划|目标|打算|希望|想|要).{0,65}(?:参加|报名|申请|报考|考研|保研|就业|实习|竞赛|比赛|项目|学习|提升|积累|完成|拿到|获得|发表|毕业|练习|练好|掌握|考取|求职|创业|研究)|(?:plan|want|goal|prepare|hope).{0,65}(?:apply|learn|study|compete|intern|project|career|graduate|build|improve)/i,
  progress: /(?:已经|已|正在|目前|刚刚|刚|完成|提交|通过|入围|进入).{0,65}(?:报名|申请|材料|简历|项目|比赛|竞赛|考试|面试|初赛|复赛|决赛|阶段|学习|练习)|(?:completed|submitted|passed|currently|finished).{0,65}(?:application|project|registration|interview|stage|study)/i,
};

/** Importance is selected by the answering model; this is the server's conservative trust boundary. */
function proposalsFrom(input: ApplyInput): MemoryProposal[] {
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 10000 || optOut.test(input.question)
    || !Array.isArray(input.proposals) || input.proposals.length > 2) return [];
  const seen = new Set<string>(), result: MemoryProposal[] = [];
  for (const candidate of input.proposals) {
    if (!candidate || !isSlot(candidate.slot) || candidate.goalId !== undefined && (!validId(candidate.goalId) || !['goal', 'progress'].includes(candidate.slot))) return [];
    const key = candidate.slot === 'goal' ? `${candidate.slot}:${candidate.goalId || candidate.text}` : `${candidate.slot}:${candidate.goalId || ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const { text, evidence, slot } = candidate;
    if (typeof text !== 'string' || typeof evidence !== 'string' || !text.trim() || text !== text.trim() || text.length > 180
      || text !== evidence || control.test(text) || sensitive.test(text) || !input.question.includes(evidence)) continue;
    const offset = input.question.indexOf(evidence), prefix = input.question.slice(0, offset);
    const sentenceStart = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？')) + 1;
    const context = input.question.slice(sentenceStart, offset + evidence.length);
    if (nonPersonal.test(context) || /[“”「」『』"]/.test(context) || !self.test(context)
      || /[?？]|吗|是否|是不是|我(?:并)?不(?:是|喜欢|想|打算|准备)|我(?:还)?(?:没|没有|尚未|不再)|I\s+am\s+not/i.test(text) || !meaning[slot].test(text)) continue;
    result.push({ slot, text, evidence, ...(candidate.goalId ? { goalId: candidate.goalId } : {}) });
  }
  return result;
}

function storedMemory(row: Row, schoolId: string, current: number): StoredMemory {
  const schools = object(row.aiMemory), stored = object(Object.prototype.hasOwnProperty.call(schools, schoolId) ? schools[schoolId] : undefined);
  const items: AiMemoryItem[] = [];
  const updatedAtBySlot: Partial<Record<AiMemorySlot, string>> = {};
  const updatedAtByItem: Record<string, string> = {};
  const stamps = object(stored.updatedAtBySlot);
  for (const slot of slots) if (Number.isFinite(date(stamps[slot]))) updatedAtBySlot[slot] = new Date(date(stamps[slot])).toISOString();
  for (const [id, stamp] of Object.entries(object(stored.updatedAtByItem))) if (validId(id) && Number.isFinite(date(stamp))) updatedAtByItem[id] = new Date(date(stamp)).toISOString();
  for (const value of Array.isArray(stored.items) ? stored.items : []) {
    const slot: unknown = value?.slot;
    if (isSlot(slot) && value.id === slot && Number.isFinite(date(value.updatedAt)) && (!updatedAtBySlot[slot] || date(value.updatedAt) > date(updatedAtBySlot[slot]))) updatedAtBySlot[slot] = new Date(date(value.updatedAt)).toISOString();
    if (validId(value?.id) && Number.isFinite(date(value.updatedAt)) && (!updatedAtByItem[value.id] || date(value.updatedAt) > date(updatedAtByItem[value.id]))) updatedAtByItem[value.id] = new Date(date(value.updatedAt)).toISOString();
    if (!value || !isSlot(value.slot) || !validId(value.id) || !['goal', 'progress'].includes(value.slot) && value.id !== value.slot
      || value.goalId !== undefined && (!validId(value.goalId) || value.slot !== 'progress') || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 180 || control.test(value.text) || sensitive.test(value.text)
      || !Number.isFinite(date(value.createdAt)) || !Number.isFinite(date(value.updatedAt)) || value.expiresAt !== null && !Number.isFinite(date(value.expiresAt))) continue;
    const item: AiMemoryItem = { id: value.id, slot: value.slot, text: value.text, createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt, ...(value.goalId ? { goalId: value.goalId } : {}) };
    const prior = items.findIndex(other => other.id === item.id || other.slot === item.slot && (item.slot === 'progress' ? other.goalId === item.goalId : item.slot !== 'goal'));
    if (prior < 0) items.push(item); else if (date(item.updatedAt) > date(items[prior].updatedAt)) items[prior] = item;
  }
  const goals = items.filter(item => item.slot === 'goal');
  for (const item of items) if (item.slot === 'progress') {
    const goal = item.goalId ? goals.find(goal => goal.id === item.goalId) : goals.length === 1 ? goals[0] : undefined;
    if (goal) {
      item.goalId = goal.id;
      if (goal.expiresAt && (!item.expiresAt || date(item.expiresAt) > date(goal.expiresAt))) item.expiresAt = goal.expiresAt;
    }
  }
  return { enabled: stored.enabled !== false, version: counter(stored.version), generation: counter(stored.generation), items, updatedAtBySlot, updatedAtByItem,
    // Keep every result within the replay window, rather than evicting by request count.
    commandRequests: Array.isArray(stored.commandRequests) ? stored.commandRequests.filter((receipt: any) => validId(receipt?.requestId) && typeof receipt.fingerprint === 'string' && typeof receipt.result?.handled === 'boolean'
      && date(receipt.at) > current - memoryCommandReceiptLifetimeMs && date(receipt.at) <= current) : [],
    processedRequests: Array.isArray(stored.processedRequests) ? stored.processedRequests.filter((id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)).slice(-40) : [] };
}

function activeItems(items: AiMemoryItem[], at: number): AiMemoryItem[] {
  const active = items.filter(item => item.expiresAt === null || date(item.expiresAt) > at);
  const goals = new Set(active.filter(item => item.slot === 'goal').map(item => item.id));
  return active.filter(item => item.slot !== 'progress' || !item.goalId || goals.has(item.goalId));
}

/** Caller passes a permission-checked, unexpired snapshot. Keep four background slots and relevant goals. */
export function selectMemoryItems(items: AiMemoryItem[], question: string): AiMemoryItem[] {
  const goals = items.filter(item => item.slot === 'goal').slice(0, 3);
  const matched = goals.filter(item => goalTerms(item.text).some(term => question.toLowerCase().includes(term)));
  const selected = matched.length ? matched : goals;
  const background = items.filter(item => item.slot !== 'goal' && item.slot !== 'progress').filter((item, i, values) => values.findIndex(other => other.slot === item.slot) === i).slice(0, 4);
  return [...background, ...selected.flatMap(goal => [goal, ...items.filter(item => item.slot === 'progress' && (item.goalId === goal.id || !item.goalId && goals.length === 1)).slice(0, 1)]),
    ...(!goals.length ? items.filter(item => item.slot === 'progress' && !item.goalId).slice(0, 1) : [])].slice(0, 10).map(item => ({ ...item }));
}

export function memoryService(db: Database, repo: Repository, now = Date.now) {
  const visible = (schoolId: string, memory: StoredMemory): AiMemoryState => ({ schoolId, enabled: memory.enabled, version: memory.version, generation: memory.generation,
    items: activeItems(memory.items, now()).map(item => ({ ...item })) });
  async function get(owner: string, schoolId: string): Promise<AiMemoryState> {
    schoolId = identifier(schoolId);
    await authorizeSchool(repo, owner, schoolId);
    return visible(schoolId, storedMemory(await readDoc(db, 'user_profiles', owner) || {}, schoolId, now()));
  }
  async function change<T>(owner: string, schoolId: string, run: (memory: StoredMemory) => T | Promise<T>): Promise<T> {
    // Repository queries use their own SQL client; never call them inside a transaction.
    await authorizeSchool(repo, owner, schoolId);
    await seed(db, 'user_profiles', owner, {});
    return atomic(db, async tx => {
      const ref = tx.collection('user_profiles').doc(owner), row = transactionRow((await ref.get()).data);
      // Both SQL and CloudBase repositories persist selection under this field.
      // Recheck the locked row so a concurrent school switch cannot escape the preflight.
      if (row.selectedSchoolId !== schoolId) reject('STALE_SCOPE', '当前学校已变化，请重新选择资料。');
      const memory = storedMemory(row, schoolId, now()), result = await run(memory);
      await ref.update({ aiMemory: { ...object(row.aiMemory), [schoolId]: memory } });
      return result;
    });
  }
  function remove(memory: StoredMemory, ids: string[]) {
    const targets = new Set(ids);
    const deletedGoals = memory.items.filter(item => item.slot === 'goal' && targets.has(item.id));
    memory.items = memory.items.filter(item => !targets.has(item.id) && !(item.slot === 'progress' && (item.goalId && targets.has(item.goalId)
      || !item.goalId && deletedGoals.length && !memory.items.some(goal => goal.slot === 'goal' && !targets.has(goal.id)))));
    for (const id of ids) { delete memory.updatedAtByItem[id]; if (isSlot(id)) delete memory.updatedAtBySlot[id]; }
  }
  return {
    get,
    /** Trusted internal caller only; matching and mutation share the selected-school profile lock. */
    async command(owner: string, schoolId: string, input: { requestId: string; question: string }): Promise<MemoryCommandResult> {
      schoolId = identifier(schoolId);
      if (!owner) reject('UNAUTHENTICATED', '请使用本人账号登录。');
      if (!input || !validId(input.requestId) || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 10000) reject('VALIDATION_FAILED', '请提供有效的请求编号和记忆指令。');
      await authorizeSchool(repo, owner, schoolId);
      // Ordinary questions do not create a profile or command receipt. A receipt lookup
      // still catches request reuse where a previously handled command was changed.
      const fingerprint = hash(input.question), snapshot = storedMemory(await readDoc(db, 'user_profiles', owner) || {}, schoolId, now());
      const prior = snapshot.commandRequests.find(receipt => receipt.requestId === input.requestId);
      if (prior && prior.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '请求编号已用于其他内容，请重新发送。');
      if (!prior && !parseMemoryCommand(input.question)) return { handled: false };
      return change(owner, schoolId, memory => {
        const receipt = memory.commandRequests.find(value => value.requestId === input.requestId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '请求编号已用于其他内容，请重新发送。');
          return { ...receipt.result };
        }
        const command = parseMemoryCommand(input.question);
        let result: MemoryCommandResult = { handled: false };
        if (!command) return result;
        const clarify = (message = '请写明要修改或忘掉的具体目标，例如：忘掉目标考研。'): MemoryCommandResult => ({ handled: true, changed: false, message });
        const items = activeItems(memory.items, now()), goals = items.filter(item => item.slot === 'goal');
        if (command.kind === 'clarify') result = clarify();
        else if (command.kind === 'clear') {
          // Clear even invisible expired content, and fence all pre-command callbacks.
          memory.items = []; memory.updatedAtBySlot = {}; memory.updatedAtByItem = {};
          result = { handled: true, changed: true, message: '已清空自动记忆，手动填写的偏好保留。' };
        } else if (command.kind === 'forget') {
          if (['goal', 'progress'].includes(command.slot) && items.filter(item => item.slot === command.slot).length > 1) result = clarify();
          else {
            const targets = memory.items.filter(item => item.slot === command.slot);
            if (!targets.length) result = { handled: true, changed: true, message: '当前没有这项自动记忆；已阻止此前任务再次写入。' };
            else { remove(memory, targets.map(item => item.id)); result = { handled: true, changed: true, message: '已忘掉这项自动记忆。' }; }
          }
        } else if (command.kind === 'correct') {
          if (command.text.length > 180 || sensitive.test(command.text) || control.test(command.text)) result = clarify('这段内容不能保存为自动记忆，请只提供不含敏感信息的专业名称。');
          else {
            const existing = memory.items.find(item => item.slot === 'major');
            if (!memory.enabled) {
              remove(memory, ['major']);
              result = { handled: true, changed: true, message: '自动记忆已关闭，旧专业记忆已失效；本次未保存新专业。' };
            } else if (existing?.text === command.text) result = { handled: true, changed: false, message: '当前自动记忆已是这个专业。' };
            else {
              const stamp = new Date(now()).toISOString();
              remove(memory, ['major']);
              memory.items.push({ id: 'major', slot: 'major', text: command.text, createdAt: existing?.createdAt || stamp, updatedAt: stamp, expiresAt: null });
              memory.updatedAtBySlot.major = stamp; memory.updatedAtByItem.major = stamp;
              result = { handled: true, changed: true, message: '已纠正自动记忆中的专业。' };
            }
          }
        } else {
          const targets = goals.filter(goal => goalMatches(goal.text, command.target));
          if (/^(?:那个|这个|该|它|全部|所有)$/.test(command.target) || targets.length > 1) result = clarify();
          else if (!targets.length && command.kind === 'forgetGoal' && goalTerms(command.target).length > 0) result = { handled: true, changed: true, message: '没有找到匹配的自动目标；已阻止此前任务再次写入，手动填写的偏好未修改。' };
          else if (!targets.length) result = { handled: true, changed: false, message: '没有找到匹配的自动目标，请写明目标名称；手动填写的偏好未修改。' };
          else if (command.kind === 'replaceGoal' && (!command.text || command.text.length > 180 || sensitive.test(command.text) || control.test(command.text))) result = clarify('新目标不能包含敏感信息，且需在180字符以内，请重新说明。');
          else {
            const target = targets[0]; remove(memory, [target.id]);
            if (command.kind === 'replaceGoal' && memory.enabled) {
              const stamp = new Date(now()).toISOString();
              memory.items.push({ id: target.id, slot: 'goal', text: command.text, createdAt: target.createdAt, updatedAt: stamp, expiresAt: new Date(now() + 180 * day).toISOString() });
              memory.updatedAtByItem[target.id] = stamp;
            }
            result = { handled: true, changed: true, message: command.kind === 'forgetGoal' ? '已忘掉这个自动目标及其进展。' : memory.enabled ? '已修改这个自动目标，并清除旧进展。' : '自动记忆已关闭，旧目标及进展已失效；本次未保存新目标。' };
          }
        }
        if (result.changed) { memory.generation++; memory.version++; }
        memory.commandRequests.push({ requestId: input.requestId, at: new Date(now()).toISOString(), fingerprint, result: { ...result } });
        return result;
      });
    },
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<AiMemoryState> {
      if (!['ai.memory.get', 'ai.memory.configure', 'ai.memory.forget', 'ai.memory.clear'].includes(action)) reject('ACTION_NOT_ALLOWED', '不支持的记忆操作。');
      const owner = identity.dataOwnerId, schoolId = identifier(input.schoolId);
      if (!owner) reject('UNAUTHENTICATED', '请使用本人账号登录。');
      await authorizeSchool(repo, owner, schoolId);
      if (action === 'ai.memory.get') return get(owner, schoolId);
      if (!Number.isSafeInteger(input.version) || Number(input.version) < 0 || action === 'ai.memory.configure' && typeof input.enabled !== 'boolean'
        || action === 'ai.memory.forget' && !validId(input.id)) reject('VALIDATION_FAILED', '请提供有效的记忆版本、条目和开关。');
      return change(owner, schoolId, memory => {
        if (memory.version !== input.version) reject('MEMORY_CONFLICT', '记忆已在其他页面修改，请重新读取后操作。');
        if (action === 'ai.memory.configure') memory.enabled = input.enabled as boolean;
        if (action === 'ai.memory.forget') {
          let id = input.id as string;
          // Old clients knew only goal/progress; resolve their single-item alias safely.
          if (['goal', 'progress'].includes(id) && !memory.items.some(item => item.id === id)) {
            const matching = activeItems(memory.items, now()).filter(item => item.slot === id);
            if (matching.length > 1) reject('VALIDATION_FAILED', '请提供要删除的具体目标或进展编号。');
            if (matching.length === 1) id = matching[0].id;
          }
          remove(memory, [id]);
        }
        if (action === 'ai.memory.clear') { memory.items = []; memory.updatedAtBySlot = {}; memory.updatedAtByItem = {}; }
        memory.generation++; memory.version++;
        return visible(schoolId, memory);
      });
    },
    /** Internal completion hook only. No browser action can call this mutation. */
    async apply(owner: string, schoolId: string, input: ApplyInput): Promise<number> {
      schoolId = identifier(schoolId);
      await authorizeSchool(repo, owner, schoolId);
      if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.requestId)
        || !Number.isSafeInteger(input.generation) || input.generation < 0) return 0;
      const observedAt = date(input.observedAt), current = now();
      if (!Number.isFinite(observedAt) || observedAt < 0 || observedAt > current) return 0;
      const candidates = proposalsFrom(input).filter(proposal => !lifetimes[proposal.slot] || observedAt + lifetimes[proposal.slot]! * day > current);
      if (!candidates.length) return 0;
      // Read before seeding so an ignored callback never creates an empty profile.
      const snapshot = storedMemory(await readDoc(db, 'user_profiles', owner) || {}, schoolId, now());
      if (!snapshot.enabled || snapshot.generation !== input.generation || snapshot.processedRequests.includes(input.requestId)) return 0;
      return change(owner, schoolId, memory => {
        if (!memory.enabled || memory.generation !== input.generation || memory.processedRequests.includes(input.requestId)) return 0;
        let changed = 0;
        // Expired items do not consume the three active goal positions.
        memory.items = activeItems(memory.items, current);
        for (const [index, proposal] of candidates.entries()) {
          const goals = memory.items.filter(item => item.slot === 'goal');
          let goal: AiMemoryItem | undefined;
          let prior: AiMemoryItem | undefined;
          if (proposal.slot === 'goal') {
            prior = proposal.goalId ? goals.find(item => item.id === proposal.goalId) : goals.find(item => item.text === proposal.text);
            if (proposal.goalId && !prior || !prior && goals.length >= 3) continue;
          } else if (proposal.slot === 'progress') {
            goal = proposal.goalId ? goals.find(item => item.id === proposal.goalId) : goals.length === 1 ? goals[0] : undefined;
            if (!goal) continue;
            if (observedAt < date(memory.updatedAtByItem[goal.id] || goal.updatedAt)) continue;
            prior = memory.items.find(item => item.slot === 'progress' && (item.goalId === goal!.id || !item.goalId && goals.length === 1));
          } else prior = memory.items.find(item => item.slot === proposal.slot);
          const id = prior?.id || (proposal.slot === 'goal' ? `goal_${hash(`${input.requestId}:${index}`).slice(0, 24)}` : proposal.slot === 'progress' ? `progress_${hash(goal!.id).slice(0, 24)}` : proposal.slot);
          const watermark = date(memory.updatedAtByItem[id] || (id === proposal.slot ? memory.updatedAtBySlot[proposal.slot] : undefined));
          if (Number.isFinite(watermark) && watermark >= observedAt) continue;
          // A repeated fact is still a newer observation. Preserve content dates/expiry,
          // but prevent an older in-flight correction from reversing this affirmation.
          if (prior?.text === proposal.text) {
            memory.updatedAtByItem[id] = new Date(observedAt).toISOString();
            if (id === proposal.slot) memory.updatedAtBySlot[proposal.slot] = new Date(observedAt).toISOString();
            continue;
          }
          const stamp = new Date(observedAt).toISOString();
          const expiry = lifetimes[proposal.slot] ? observedAt + lifetimes[proposal.slot]! * day : null;
          const item: AiMemoryItem = { id, slot: proposal.slot, text: proposal.text, createdAt: prior?.createdAt || stamp, updatedAt: stamp,
            expiresAt: expiry === null ? null : new Date(goal?.expiresAt ? Math.min(expiry, date(goal.expiresAt)) : expiry).toISOString(), ...(goal ? { goalId: goal.id } : {}) };
          // A changed goal invalidates progress recorded for its earlier meaning.
          if (proposal.slot === 'goal' && prior) remove(memory, [id]);
          memory.items = [...memory.items.filter(value => value.id !== id), item];
          memory.updatedAtByItem[id] = stamp;
          if (id === proposal.slot) memory.updatedAtBySlot[proposal.slot] = stamp;
          changed++;
        }
        memory.processedRequests = [...memory.processedRequests, input.requestId].slice(-40);
        if (changed) memory.version++;
        return changed;
      });
    },
  };
}
