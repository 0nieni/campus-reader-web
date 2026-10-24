import type { AiConnection, AiQuota, Notice, ReadingTask } from './index';

export interface AiPreferences { schoolId: string; interests: string[]; goals: string; learningEnabled: boolean; version: number }
export interface RecommendedNotice extends Notice { originalUrl: string | null; reason: string; readState: 'body' | 'title_only' | 'snippet_only' | 'unavailable'; checkedAt: string | null; allowAi: boolean }
export interface AiRecommendations { items: RecommendedNotice[]; search: { state: 'idle' | 'unconfigured' | 'complete' | 'failed'; message: string }; coverage: string }
export interface ChatReference { reference: string; itemId: string; title: string; originalUrl: string | null }
export interface AiWebSource { reference: string | null; title: string; url: string; readState: 'body' | 'snippet_only' | 'unavailable'; checkedAt: string; publishedAt: string | null }
export interface AiWebSearchState { state: 'not_needed' | 'complete' | 'failed' | 'unconfigured'; message: string; query: string | null; sources: AiWebSource[] }
export interface AiChatTurn { id: string; question: string; taskId: string | null; state: ReadingTask['state']; result: string | null; message: string; references: ChatReference[]; step: number; totalSteps: number; quotaHeld: boolean; service: 'official' | 'byok'; provider: string; model: string; search?: AiRecommendations['search']; webSearch?: AiWebSearchState }
export interface AiConversation { id: string; schoolId: string; createdAt: string; expireAt: string; turns: AiChatTurn[] }
export interface AssistantActions {
  'ai.profile.get': { input: { schoolId: string }; output: AiPreferences };
  'ai.profile.save': { input: AiPreferences; output: AiPreferences };
  'ai.profile.clearBehavior': { input: { schoolId: string }; output: AiPreferences };
  'ai.behavior': { input: { schoolId: string; itemId: string }; output: { recorded: boolean } };
  'ai.dismiss': { input: { schoolId: string; itemId: string; dismissed: boolean }; output: { dismissed: boolean } };
  'ai.recommend': { input: { schoolId: string; query?: string; search?: boolean }; output: AiRecommendations };
  'ai.chat.create': { input: { schoolId: string; requestId: string }; output: AiConversation };
  'ai.chat.get': { input: { conversationId: string }; output: AiConversation };
  'ai.chat.send': { input: { conversationId: string; requestId: string; question: string; itemIds?: string[]; service?: 'official' | 'byok'; provider?: AiConnection['provider']; model?: string; webSearch?: boolean }; output: AiChatTurn };
  'ai.chat.step': { input: { conversationId: string; turnId: string; step: number; connection?: AiConnection }; output: AiChatTurn };
  'ai.chat.cancel': { input: { conversationId: string; turnId: string }; output: AiChatTurn };
  'ai.chat.resolve': { input: { conversationId: string; turnId: string; charged: boolean }; output: AiChatTurn };
  'ai.chat.clear': { input: { conversationId: string }; output: { cleared: boolean } };
  'ai.chat.latest': { input: { schoolId: string }; output: { conversation: AiConversation | null } };
}
