declare const Netlify: { env: { get(name: string): string | undefined } };
import type { UserValidateEvent, UserLoginEvent, UserModifiedEvent } from '@netlify/functions';
import { normalizedEmail } from '../../apps/cloud/src/site-access';
type Event = UserValidateEvent | UserLoginEvent | UserModifiedEvent;
function check(event: Event) {
  // Enrollment stays invite-only in Identity. Do not share the original
  // owner's workspace with new accounts; API scoping uses their trusted UID.
  if (!normalizedEmail(Netlify.env.get('NETLIFY_OWNER_EMAIL')) || !normalizedEmail(event.user.email)) return event.deny();
}
export default { userValidate: check, userLogin: check, userModified: check };
