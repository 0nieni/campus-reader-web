import type { AiConnection, AiQuota, Notice, ReadingTask } from './index';
import type { AiProviderRef } from './ai-providers';

export interface AiPreferences { schoolId: string; interests: string[]; goals: string; learningEnabled: boolean; version: number }
export type AiMemorySlot = 'major' | 'year' | 'interests' | 'response_style' | 'goal' | 'progress';
export interface AiMemoryItem { id: string; slot: AiMemorySlot; goalId?: string; text: string; createdAt: string; updatedAt: string; expiresAt: string | null }
export interface AiMemoryState { schoolId: string; enabled: boolean; version: number; generation: number; items: AiMemoryItem[] }
export interface RecommendedNotice extends Notice { originalUrl: string | null; reason: string; readState: 'body' | 'title_only' | 'snippet_only' | 'unavailable'; checkedAt: string | null; allowAi: boolean }
export type AiSearchErrorCode = 'unconfigured' | 'authorization' | 'quota' | 'rate_limited' | 'timeout' | 'network' | 'provider' | 'invalid_response' | 'invalid_scope';
export interface AiRecommendations { items: RecommendedNotice[]; search: { state: 'idle' | 'unconfigured' | 'complete' | 'failed'; message: string; code?: AiSearchErrorCode; candidateCount?: number; readableCount?: number; candidateIds?: string[] }; coverage: string }
export interface ChatReference { reference: string; itemId: string; title: string; originalUrl: string | null }
export interface AiChatTurn { id: string; question: string; taskId: string | null; state: ReadingTask['state']; result: string | null; message: string; references: ChatReference[]; step: number; totalSteps: number; quotaHeld: boolean; service: 'official' | 'byok'; provider: string; model: string; providerProfile?: AiProviderRef; memoryMessage?: string; programReply?: 'memory' | 'search_capability' | 'search_status'; search?: AiRecommendations['search'] }
export interface AiConversation { id: string; schoolId: string; createdAt: string; expireAt: string; turns: AiChatTurn[] }
export interface AssistantActions {
  'ai.memory.get': { input: { schoolId: string }; output: AiMemoryState };
  'ai.memory.configure': { input: { schoolId: string; enabled: boolean; version: number }; output: AiMemoryState };
  'ai.memory.forget': { input: { schoolId: string; id: string; version: number }; output: AiMemoryState };
  'ai.memory.clear': { input: { schoolId: string; version: number }; output: AiMemoryState };
  'ai.profile.get': { input: { schoolId: string }; output: AiPreferences };
  'ai.profile.save': { input: AiPreferences; output: AiPreferences };
  'ai.profile.clearBehavior': { input: { schoolId: string }; output: AiPreferences };
  'ai.behavior': { input: { schoolId: string; itemId: string }; output: { recorded: boolean } };
  'ai.dismiss': { input: { schoolId: string; itemId: string; dismissed: boolean }; output: { dismissed: boolean } };
  'ai.recommend': { input: { schoolId: string; query?: string; search?: boolean }; output: AiRecommendations };
  'ai.chat.create': { input: { schoolId: string; requestId: string }; output: AiConversation };
  'ai.chat.get': { input: { conversationId: string }; output: AiConversation };
  'ai.chat.send': { input: { conversationId: string; requestId: string; question: string; itemIds?: string[]; service?: 'official' | 'byok'; provider?: AiConnection['provider']; model?: string; providerProfile?: AiProviderRef }; output: AiChatTurn };
  'ai.chat.step': { input: { conversationId: string; turnId: string; step: number; connection?: AiConnection }; output: AiChatTurn };
  'ai.chat.cancel': { input: { conversationId: string; turnId: string }; output: AiChatTurn };
  'ai.chat.resolve': { input: { conversationId: string; turnId: string; charged: boolean }; output: AiChatTurn };
  'ai.chat.clear': { input: { conversationId: string }; output: { cleared: boolean } };
  'ai.chat.latest': { input: { schoolId: string }; output: { conversation: AiConversation | null } };
}
