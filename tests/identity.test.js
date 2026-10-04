import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEmail } from '../server/identity.js';

test('canonical email folds dots only for gmail.com and keeps aliases', () => {
  assert.equal(canonicalEmail('  Ana.Perez@Gmail.COM '), 'anaperez@gmail.com');
  assert.equal(canonicalEmail('a.n.a+clase@gmail.com'), 'ana+clase@gmail.com');
  assert.equal(canonicalEmail('ana.perez@googlemail.com'), 'ana.perez@googlemail.com');
  assert.equal(canonicalEmail('Ana.Perez@Example.com'), 'ana.perez@example.com');
  assert.equal(canonicalEmail('ana.perez@gmail.com.example.org'), 'ana.perez@gmail.com.example.org');
  assert.equal(canonicalEmail(undefined), '');
});
