// Transactional email through Resend's HTTP API (free tier). Sending stays in this
// file so the provider can change without touching the rest of the Worker.
// Without RESEND_API_KEY (tests, local runs) messages go to `env.MAIL_OUTBOX`
// when it is an array, so no address ever receives a surprise email.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_FROM = 'PhoTown <acceso@photown.gofiodesign.eu>';

export const mailReady = env => Boolean(env.RESEND_API_KEY);

export async function sendMail(env, { to, subject, text, html }) {
  const message = { from: env.MAIL_FROM || DEFAULT_FROM, to: [to], subject, text, html };
  if (env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Resend rejected the message (${response.status})`);
    return true;
  }
  if (Array.isArray(env.MAIL_OUTBOX)) { env.MAIL_OUTBOX.push({ ...message, to }); return true; }
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
