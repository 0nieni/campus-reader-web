declare const Netlify: { env: { get(name: string): string | undefined } };
import type { UserValidateEvent, UserLoginEvent, UserModifiedEvent } from '@netlify/functions';
type Event = UserValidateEvent | UserLoginEvent | UserModifiedEvent;
function check(event: Event) {
  const owner = Netlify.env.get('NETLIFY_OWNER_EMAIL')?.trim().toLowerCase();
  if (!owner || event.user.email?.toLowerCase() !== owner) event.deny();
}
export default { userValidate: check, userLogin: check, userModified: check };
