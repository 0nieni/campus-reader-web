declare const Netlify: { env: { get(name: string): string | undefined } };
import type { UserValidateEvent, UserLoginEvent, UserModifiedEvent } from '@netlify/functions';
import { normalizedEmail } from '../../apps/cloud/src/site-access';
type Event = UserValidateEvent | UserLoginEvent | UserModifiedEvent;
function check(event: Event) {
  // Identity controls enrollment and email verification. Each new account
  // keeps its trusted UID namespace; no original-owner data is shared.
  if (!normalizedEmail(Netlify.env.get('NETLIFY_OWNER_EMAIL')) || !normalizedEmail(event.user.email)) return event.deny();
}
export default { userValidate: check, userLogin: check, userModified: check };
