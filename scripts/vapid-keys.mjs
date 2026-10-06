// Generates the VAPID key pair for Web Push. Run once and store both values as secrets:
//   node scripts/vapid-keys.mjs
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY
// Changing the keys later disconnects every device until it activates notices again.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const b64url = bytes => Buffer.from(bytes).toString('base64url');
// Paste only the value on the line below each name.
console.log('VAPID_PUBLIC_KEY:\n' + b64url(await crypto.subtle.exportKey('raw', pair.publicKey)) + '\n');
console.log('VAPID_PRIVATE_KEY:\n' + (await crypto.subtle.exportKey('jwk', pair.privateKey)).d);
