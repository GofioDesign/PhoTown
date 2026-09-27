// Transactional email through the Cloudflare Email Service binding (`EMAIL`).
// Without a binding (tests, local runs without Wrangler) messages go to
// `env.MAIL_OUTBOX` when present, so no address ever receives a surprise email.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const mailReady = env => Boolean(env.EMAIL);

export async function sendMail(env, { to, subject, text, html }) {
  const message = { to, from: env.MAIL_FROM || 'photown@gofiodesign.eu', subject, text, html };
  if (env.EMAIL) { await env.EMAIL.send(message); return true; }
  if (Array.isArray(env.MAIL_OUTBOX)) { env.MAIL_OUTBOX.push(message); return true; }
  console.log(`[photown mail] ${to} · ${subject}\n${text}`);
  return false;
}

// One restrained layout for every message: black and white, a single action.
export function layout({ title, paragraphs, action, link, footer }) {
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#111;color:#eee;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px">
<table role="presentation" width="100%" style="max-width:520px"><tr><td>
<p style="letter-spacing:.2em;font-size:13px;color:#aaa;margin:0 0 32px">PHOTOWN</p>
<h1 style="font-weight:400;font-size:24px;line-height:1.3;margin:0 0 20px">${escape(title)}</h1>
${paragraphs.map(p => `<p style="font-size:16px;line-height:1.6;color:#ccc;margin:0 0 16px">${escape(p)}</p>`).join('')}
${link ? `<p style="margin:32px 0"><a href="${escape(link)}" style="display:inline-block;background:#eee;color:#111;text-decoration:none;padding:14px 28px;font-size:16px">${escape(action)}</a></p>
<p style="font-size:13px;color:#999;line-height:1.5;word-break:break-all">Si el botón no funciona, copia esta dirección en el navegador:<br>${escape(link)}</p>` : ''}
${footer ? `<p style="font-size:13px;color:#888;line-height:1.5;margin-top:32px">${escape(footer)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  const plain = [title, '', ...paragraphs, ...(link ? ['', `${action}: ${link}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  return { html, text: plain };
}
