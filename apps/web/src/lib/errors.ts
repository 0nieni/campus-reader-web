export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown): string {
  // SDK messages can contain request URLs and tokens. Only our fixed messages reach UI.
  return error instanceof ClientError
    ? error.message
    : "连接失败，请检查网络后重试。";
}
