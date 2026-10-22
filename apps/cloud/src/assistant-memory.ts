import type { AiMemoryItem, AiMemorySlot, AiMemoryState } from '@campus/contracts';
import { authorizeSchool, identifier } from './access';
import { reject } from './errors';
import type { IdentityContext } from './identity';
import type { Repository } from './repository';
import { atomic, readDoc, seed, transactionRow, type Database } from './storage';

export interface MemoryProposal { slot: AiMemorySlot; text: string; evidence: string }
interface ApplyInput { requestId: string; question: string; proposals: MemoryProposal[]; generation: number; observedAt: number | string }
type Row = Record<string, any>;
interface StoredMemory { enabled: boolean; version: number; generation: number; items: AiMemoryItem[]; processedRequests: string[]; updatedAtBySlot: Partial<Record<AiMemorySlot, string>> }
const slots: AiMemorySlot[] = ['major', 'year', 'interests', 'response_style', 'goal', 'progress'];
const lifetimes: Partial<Record<AiMemorySlot, number>> = { year: 365, goal: 180, progress: 30 };
const day = 86400000;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const counter = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const isSlot = (value: unknown): value is AiMemorySlot => typeof value === 'string' && slots.includes(value as AiMemorySlot);
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
  const seen = new Set<AiMemorySlot>(), result: MemoryProposal[] = [];
  for (const candidate of input.proposals) {
    if (!candidate || !isSlot(candidate.slot) || seen.has(candidate.slot)) return [];
    seen.add(candidate.slot);
    const { text, evidence, slot } = candidate;
    if (typeof text !== 'string' || typeof evidence !== 'string' || !text.trim() || text !== text.trim() || text.length > 180
      || text !== evidence || control.test(text) || sensitive.test(text) || !input.question.includes(evidence)) continue;
    const offset = input.question.indexOf(evidence), prefix = input.question.slice(0, offset);
    const sentenceStart = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？')) + 1;
    const context = input.question.slice(sentenceStart, offset + evidence.length);
    if (nonPersonal.test(context) || /[“”「」『』"]/.test(context) || !self.test(context)
      || /[?？]|吗|是否|是不是|我(?:并)?不(?:是|喜欢|想|打算|准备)|我(?:还)?(?:没|没有|尚未|不再)|I\s+am\s+not/i.test(text) || !meaning[slot].test(text)) continue;
    result.push({ slot, text, evidence });
  }
  return result;
}

function storedMemory(row: Row, schoolId: string): StoredMemory {
  const schools = object(row.aiMemory), stored = object(Object.prototype.hasOwnProperty.call(schools, schoolId) ? schools[schoolId] : undefined);
  const items: AiMemoryItem[] = [];
  const updatedAtBySlot: Partial<Record<AiMemorySlot, string>> = {};
  const stamps = object(stored.updatedAtBySlot);
  for (const slot of slots) if (Number.isFinite(date(stamps[slot]))) updatedAtBySlot[slot] = new Date(date(stamps[slot])).toISOString();
  for (const value of Array.isArray(stored.items) ? stored.items : []) {
    const slot: unknown = value?.slot;
    if (isSlot(slot) && Number.isFinite(date(value.updatedAt)) && (!updatedAtBySlot[slot] || date(value.updatedAt) > date(updatedAtBySlot[slot]))) updatedAtBySlot[slot] = new Date(date(value.updatedAt)).toISOString();
    if (!value || !isSlot(value.slot) || value.id !== value.slot || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 180 || control.test(value.text) || sensitive.test(value.text)
      || !Number.isFinite(date(value.createdAt)) || !Number.isFinite(date(value.updatedAt)) || value.expiresAt !== null && !Number.isFinite(date(value.expiresAt))) continue;
    const item: AiMemoryItem = { id: value.slot, slot: value.slot, text: value.text, createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt };
    const prior = items.findIndex(other => other.slot === item.slot);
    if (prior < 0) items.push(item); else if (date(item.updatedAt) > date(items[prior].updatedAt)) items[prior] = item;
  }
  return { enabled: stored.enabled !== false, version: counter(stored.version), generation: counter(stored.generation), items, updatedAtBySlot,
    processedRequests: Array.isArray(stored.processedRequests) ? stored.processedRequests.filter((id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)).slice(-40) : [] };
}

export function memoryService(db: Database, repo: Repository, now = Date.now) {
  const visible = (schoolId: string, memory: StoredMemory): AiMemoryState => ({ schoolId, enabled: memory.enabled, version: memory.version, generation: memory.generation,
    items: memory.items.filter(item => item.expiresAt === null || date(item.expiresAt) > now()).map(item => ({ ...item })) });
  async function get(owner: string, schoolId: string): Promise<AiMemoryState> {
    schoolId = identifier(schoolId);
    await authorizeSchool(repo, owner, schoolId);
    return visible(schoolId, storedMemory(await readDoc(db, 'user_profiles', owner) || {}, schoolId));
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
      const memory = storedMemory(row, schoolId), result = await run(memory);
      await ref.update({ aiMemory: { ...object(row.aiMemory), [schoolId]: memory } });
      return result;
    });
  }
  return {
    get,
    async handle(action: string, input: Record<string, unknown>, identity: IdentityContext): Promise<AiMemoryState> {
      if (!['ai.memory.get', 'ai.memory.configure', 'ai.memory.forget', 'ai.memory.clear'].includes(action)) reject('ACTION_NOT_ALLOWED', '不支持的记忆操作。');
      const owner = identity.dataOwnerId, schoolId = identifier(input.schoolId);
      if (!owner) reject('UNAUTHENTICATED', '请使用本人账号登录。');
      await authorizeSchool(repo, owner, schoolId);
      if (action === 'ai.memory.get') return get(owner, schoolId);
      if (!Number.isSafeInteger(input.version) || Number(input.version) < 0 || action === 'ai.memory.configure' && typeof input.enabled !== 'boolean'
        || action === 'ai.memory.forget' && !isSlot(input.id)) reject('VALIDATION_FAILED', '请提供有效的记忆版本、条目和开关。');
      return change(owner, schoolId, memory => {
        if (memory.version !== input.version) reject('MEMORY_CONFLICT', '记忆已在其他页面修改，请重新读取后操作。');
        if (action === 'ai.memory.configure') memory.enabled = input.enabled as boolean;
        if (action === 'ai.memory.forget') {
          memory.items = memory.items.filter(item => item.id !== input.id);
          delete memory.updatedAtBySlot[input.id as AiMemorySlot];
        }
        if (action === 'ai.memory.clear') { memory.items = []; memory.updatedAtBySlot = {}; }
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
      const snapshot = storedMemory(await readDoc(db, 'user_profiles', owner) || {}, schoolId);
      if (!snapshot.enabled || snapshot.generation !== input.generation || snapshot.processedRequests.includes(input.requestId)) return 0;
      return change(owner, schoolId, memory => {
        if (!memory.enabled || memory.generation !== input.generation || memory.processedRequests.includes(input.requestId)) return 0;
        let changed = 0;
        for (const proposal of candidates) {
          const prior = memory.items.find(item => item.slot === proposal.slot);
          const watermark = date(memory.updatedAtBySlot[proposal.slot]);
          if (Number.isFinite(watermark) && watermark >= observedAt) continue;
          // A repeated fact is still a newer observation. Preserve content dates/expiry,
          // but prevent an older in-flight correction from reversing this affirmation.
          if (prior?.text === proposal.text) {
            memory.updatedAtBySlot[proposal.slot] = new Date(observedAt).toISOString();
            continue;
          }
          const stamp = new Date(observedAt).toISOString();
          const item: AiMemoryItem = { id: proposal.slot, slot: proposal.slot, text: proposal.text, createdAt: prior?.createdAt || stamp, updatedAt: stamp,
            expiresAt: lifetimes[proposal.slot] ? new Date(observedAt + lifetimes[proposal.slot]! * day).toISOString() : null };
          memory.items = [...memory.items.filter(value => value.slot !== proposal.slot), item];
          memory.updatedAtBySlot[proposal.slot] = stamp;
          changed++;
        }
        memory.processedRequests = [...memory.processedRequests, input.requestId].slice(-40);
        if (changed) memory.version++;
        return changed;
      });
    },
  };
}
