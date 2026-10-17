import { createHash } from 'node:crypto';
import { AppError } from './errors';
import type { NetlifyUser } from './netlify-http';

export function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : null;
}

/** Input must be the official server SDK's user, never browser-submitted claims.
 * Netlify Identity remains invite-only; Identity controls account enrollment. */
export function requireSiteUser(user: NetlifyUser | null, ownerEmail?: string): NetlifyUser {
  if (!user?.id?.trim() || !normalizedEmail(user.email)) throw new AppError('UNAUTHENTICATED', '请先使用受邀账号登录。');
  if (!normalizedEmail(ownerEmail)) throw new AppError('OWNER_NOT_CONFIGURED', '本站尚未配置初始工作区账号。');
  return user;
}

export function siteWorkspace(user: NetlifyUser, ownerEmail?: string) {
  requireSiteUser(user, ownerEmail);
  // Preserve the original owner's data. Every other Identity UID gets its own
  // stable namespace; changing a member's email never changes that namespace.
  const dataOwnerId = normalizedEmail(user.email) === normalizedEmail(ownerEmail) ? 'netlify_owner'
    : `netlify_user_${createHash('sha256').update(user.id).digest('hex')}`;
  return { ownerUid: user.id, dataOwnerId };
}
