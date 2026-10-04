// Gmail ignores dots in the local part; other providers may not, so only gmail.com is folded.
// The canonical value is for comparison and unique keys; keep the verified original for display.
export function canonicalEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || email.slice(at + 1) !== 'gmail.com') return email;
  return email.slice(0, at).replace(/\./g, '') + '@gmail.com';
}

export const roleRank = { user: 0, moderator: 1, admin: 2, owner: 3 };
