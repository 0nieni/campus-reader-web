import type {
  AuthSession,
  AiProviderState,
  GatewayAction,
  GatewayActions,
  AnonymousTransport,
  McpTransport,
} from "@campus/contracts";

export interface Transport {
  anonymous?: AnonymousTransport;
  mcp?: McpTransport;
  restore(): Promise<AuthSession | null>;
  signIn(username: string, password: string): Promise<AuthSession>;
  signUp?(email: string, password: string): Promise<{ verificationRequired: true }>;
  confirmEmail?(token: string): Promise<AuthSession>;
  requestPasswordRecovery?(): Promise<void>;
  recoverPassword?(token: string, newPassword: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  onSessionChange(listener: (session: AuthSession | null) => void): () => void;
  call<A extends GatewayAction>(
    action: A,
    input: GatewayActions[A]["input"],
  ): Promise<GatewayActions[A]["output"]>;
}
export interface ProviderChange {
  state: AiProviderState;
  activate: 'saved' | 'official' | null;
}
