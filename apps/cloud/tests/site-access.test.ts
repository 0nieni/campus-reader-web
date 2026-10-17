import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizedEmail, requireSiteUser, siteWorkspace } from '../src/site-access';
import { createSiteAuth } from '../src/netlify-http';
import identityEvents from '../../../netlify/functions/identity.mjs';

test('invited members use stable UID namespaces while the original owner retains the existing workspace', () => {
  const owner = { id: 'owner-uid', email: 'Owner@Example.test' }, member = { id: 'member-uid', email: 'member@example.test' };
  assert.equal(siteWorkspace(owner, ' owner@example.test ').dataOwnerId, 'netlify_owner');
  const one = siteWorkspace(member, owner.email);
  assert.match(one.dataOwnerId, /^netlify_user_[a-f0-9]{64}$/);
  assert.equal(siteWorkspace({ ...member, email: 'changed@example.test' }, owner.email).dataOwnerId, one.dataOwnerId);
  assert.notEqual(siteWorkspace({ ...member, id: 'other-uid' }, owner.email).dataOwnerId, one.dataOwnerId);
  for (const user of [null, { id: '', email: member.email }, { id: 'anonymous', email: '' }]) assert.throws(() => requireSiteUser(user, owner.email), { code: 'UNAUTHENTICATED' });
  assert.throws(() => siteWorkspace(member), { code: 'OWNER_NOT_CONFIGURED' });
  for (const value of ['', 'not-an-email', 'a@b.test\nb@c.test', '*']) assert.equal(normalizedEmail(value), null);
});

test('member passwords still go through Identity; mismatched or failed sessions are not adopted', async () => {
  let current: any = null, loginCalls = 0, loggedOut = 0;
  const owner = 'owner@example.test', member = { id: 'member-uid', email: 'member@example.test' };
  const handler = createSiteAuth({ async user() { return current; }, async login(email, password) {
    loginCalls++;
    if (password !== 'fixture-password') throw new Error('must-not-leak');
    return current = email === member.email ? member : { ...member, email: 'different@example.test' };
  }, async logout() { loggedOut++; current = null; } }, () => owner);
  const req = (email: string, password = 'fixture-password') => new Request('https://campus.example/auth?op=login', { method: 'POST', headers: { origin: 'https://campus.example', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal((await handler(req(member.email))).status, 200); assert.equal(loginCalls, 1);
  const restored = await (await handler(new Request('https://campus.example/auth'))).json() as { data: unknown };
  assert.deepEqual(restored.data, { uid: member.id, username: member.email });
  assert.equal((await handler(req('not-invited@example.test', 'wrong'))).status, 401);
  assert.equal((await handler(req('mismatch@example.test'))).status, 401); assert.equal(loggedOut, 1);
});

test('Identity event hooks allow other invited emails instead of rejecting everyone except the original owner', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'Netlify');
  Object.defineProperty(globalThis, 'Netlify', { configurable: true, value: { env: { get() { return 'owner@example.test'; } } } });
  try {
    let denied = 0;
    for (const check of Object.values(identityEvents)) check({ user: { email: 'member@example.test' }, deny() { denied++; } } as any);
    assert.equal(denied, 0);
    identityEvents.userValidate({ user: { email: '' }, deny() { denied++; } } as any);
    assert.equal(denied, 1);
  } finally {
    if (before) Object.defineProperty(globalThis, 'Netlify', before);
    else delete (globalThis as any).Netlify;
  }
});
