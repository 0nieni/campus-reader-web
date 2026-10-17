import type {
  AuthSession,
  GatewayAction,
  GatewayActions,
} from "@campus/contracts";

export interface Transport {
  restore(): Promise<AuthSession | null>;
  signIn(username: string, password: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  onSessionChange(listener: (session: AuthSession | null) => void): () => void;
  call<A extends GatewayAction>(
    action: A,
    input: GatewayActions[A]["input"],
  ): Promise<GatewayActions[A]["output"]>;
}
