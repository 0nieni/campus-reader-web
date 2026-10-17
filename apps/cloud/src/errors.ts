export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function reject(code: string, message: string): never {
  throw new AppError(code, message);
}
