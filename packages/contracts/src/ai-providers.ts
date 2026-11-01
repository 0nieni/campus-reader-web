/** Saved connection metadata contains neither API keys nor encrypted payloads. */
export type AiProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
export interface AiProviderRef { id: string; version: number }
export interface AiSavedProvider {
  id: string; name: string; protocol: AiProviderProtocol; baseUrl: string;
  models: string[]; defaultModel: string; version: number; keySaved: boolean; updatedAt: string;
}
export interface AiProviderSelection { profile: AiProviderRef; model: string }
export interface AiProviderState {
  storageConfigured: boolean; version: number; profiles: AiSavedProvider[]; selection: AiProviderSelection | null;
}
export interface AiProviderSave {
  version: number; id?: string; profileVersion?: number; name: string; protocol: AiProviderProtocol;
  baseUrl: string; models: string[]; defaultModel: string; apiKey?: string;
}
export interface AiProviderActions {
  'ai.providers.list': { input: Record<string, never>; output: AiProviderState };
  'ai.providers.save': { input: { profile: AiProviderSave }; output: AiProviderState };
  'ai.providers.remove': { input: { id: string; version: number }; output: AiProviderState };
  'ai.providers.select': { input: { id: string | null; model?: string; version: number }; output: AiProviderState };
}
