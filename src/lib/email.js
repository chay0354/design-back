/**
 * Transactional email through Resend (https://resend.com) using plain fetch.
 * Without RESEND_API_KEY emails are skipped and logged, so local development
 * and the demo site keep working.
 */

export function siteUrl() {
  return (process.env.FRONTEND_URL || 'https://www.petite-dreams.com').replace(/\/$/, '')
}

/** Public URL of this API as seen from the browser (the site proxies /api). */
export function publicApiUrl() {
  return (process.env.PUBLIC_API_URL || `${siteUrl()}/api`).replace(/\/$/, '')
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY)
}

export async function sendEmail({ to, subject, html, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (recipients.length === 0) return { sent: false, reason: 'no recipient' }

  if (!emailConfigured()) {
    console.warn(`[email] RESEND_API_KEY missing — skipped "${subject}"`)
    return { sent: false, reason: 'email not configured' }
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Petite Dreams <hello@petite-dreams.com>',
      to: recipients,
      subject,
      html,
      text,
      reply_to: replyTo || process.env.EMAIL_REPLY_TO || undefined,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Email send failed (${response.status}): ${detail}`)
  }
  return { sent: true }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const nl2br = (value) => escapeHtml(value).replace(/\n/g, '<br>')

/** Minimal, mobile-first RTL wrapper in the site palette. */
export function layout(inner, { preheader = '' } = {}) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F7F4EF;font-family:Arial,Helvetica,sans-serif;color:#3C3834;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
<tr><td style="padding:28px 24px 8px;text-align:center;">
<img src="${siteUrl()}/assets/logo-full.png" alt="Petite Dreams" width="160" style="max-width:160px;height:auto;">
</td></tr>
<tr><td style="padding:8px 24px 28px;text-align:right;font-size:15px;line-height:1.7;">${inner}</td></tr>
</table>
<p style="font-size:12px;color:#8A847C;margin:16px 0 0;">petite-dreams.com</p>
</td></tr></table>
</body></html>`
}

export function button(href, label) {
  return `<p style="text-align:center;margin:24px 0;">
<a href="${escapeHtml(href)}" style="display:inline-block;background:#C4B49A;color:#FFFFFF;text-decoration:none;padding:12px 28px;border-radius:999px;font-size:15px;">${escapeHtml(label)}</a>
</p>`
}

export function voucherRedeemUrl(code) {
  return `${siteUrl()}/gift/redeem/${encodeURIComponent(code)}`
}

export function voucherQrUrl(code) {
  return `${publicApiUrl()}/vouchers/${encodeURIComponent(code)}/qr.png`
}

export function packagesPhrase(count) {
  return count === 1 ? 'חבילת עיצוב אחת' : `${count} חבילות עיצוב`
}

/** The designed voucher card used in emails (and mirrored on the site). No price, ever. */
export function voucherCardHtml(voucher) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7D9C8;border-radius:14px;background:#FBF8F3;">
<tr><td style="padding:22px 18px;text-align:center;">
<img src="${siteUrl()}/assets/logo-full.png" alt="Petite Dreams" width="120" style="max-width:120px;height:auto;">
<p style="margin:12px 0 0;font-size:26px;color:#3C3834;">שובר מתנה</p>
<p style="margin:4px 0 14px;font-size:14px;color:#8A847C;">מתנה קטנה, חלומות גדולים</p>
<p style="margin:0;font-size:17px;">${escapeHtml(voucher.recipient_names)}</p>
${voucher.personal_message ? `<p style="margin:10px 0 0;font-size:14px;color:#5E5852;">${nl2br(voucher.personal_message)}</p>` : ''}
<p style="margin:14px 0 0;font-size:15px;">${packagesPhrase(voucher.packages_count)} לחדרי הילדים</p>
${voucher.giver_name ? `<p style="margin:6px 0 0;font-size:14px;color:#5E5852;">מאת: ${escapeHtml(voucher.giver_name)}</p>` : ''}
<p style="margin:16px 0 4px;font-size:13px;color:#8A847C;">קוד השובר</p>
<p dir="ltr" style="margin:0;font-size:22px;letter-spacing:2px;color:#3C3834;">${escapeHtml(voucher.code)}</p>
<img src="${voucherQrUrl(voucher.code)}" alt="QR למימוש השובר" width="132" height="132" style="margin-top:14px;">
<p style="margin:8px 0 0;font-size:12px;color:#8A847C;">petite-dreams.com</p>
</td></tr></table>`
}

export function voucherRecipientEmail(voucher, template) {
  const blessing = voucher.personal_message || template.defaultBlessing
  const fromLine = voucher.giver_name ? `מחכה לכם מתנה מיוחדת מ${escapeHtml(voucher.giver_name)}!` : 'מחכה לכם מתנה מיוחדת!'
  const inner = `
<p style="font-size:20px;margin:0 0 12px;">${escapeHtml(template.intro)}</p>
<p style="margin:0 0 12px;">${escapeHtml(voucher.recipient_names)} היקרים,</p>
<p style="margin:0 0 12px;">${fromLine}</p>
<p style="margin:0 0 12px;"><strong>${packagesPhrase(voucher.packages_count)} לחדרי הילדים מבית Petite Dreams.</strong></p>
<p style="margin:0 0 18px;">${nl2br(template.body)}</p>
${voucherCardHtml(voucher)}
${button(voucherRedeemUrl(voucher.code), 'למימוש המתנה שלכם')}
<p style="margin:0;">קוד השובר: <span dir="ltr">${escapeHtml(voucher.code)}</span></p>
<p style="margin:18px 0 0;">${nl2br(blessing)}${voucher.giver_name ? `,<br>${escapeHtml(voucher.giver_name)} ♡` : ''}</p>
<p style="margin:18px 0 0;color:#8A847C;">${escapeHtml(template.signature)}</p>`
  return {
    subject: template.subject,
    html: layout(inner, { preheader: template.intro }),
    text: `${template.intro}\n\n${voucher.recipient_names} היקרים,\n${packagesPhrase(voucher.packages_count)} לחדרי הילדים מבית Petite Dreams.\n\nלמימוש: ${voucherRedeemUrl(voucher.code)}\nקוד השובר: ${voucher.code}\n\n${blessing}\n${voucher.giver_name || ''}`,
  }
}

export function voucherBuyerEmail(voucher, { orderNumber, total }) {
  const deliveryLine =
    voucher.delivery_method === 'email'
      ? `השובר נשלח במייל אל ${escapeHtml(voucher.recipient_email)}.`
      : voucher.delivery_method === 'whatsapp'
        ? 'אפשר לשתף את השובר בוואטסאפ מעמוד האישור או מהקישור למטה.'
        : 'השובר מצורף כאן — אפשר להעביר אותו בעצמכם.'
  const inner = `
<p style="font-size:20px;margin:0 0 12px;">תודה על הרכישה!</p>
<p style="margin:0 0 12px;">רכשת שובר מתנה עבור ${escapeHtml(voucher.recipient_names)} — ${packagesPhrase(voucher.packages_count)}.</p>
<p style="margin:0 0 12px;">${deliveryLine}</p>
<p style="margin:0 0 18px;">מספר הזמנה: ${escapeHtml(orderNumber)} · סכום ששולם: ₪${escapeHtml(total)}</p>
${voucherCardHtml(voucher)}
${button(voucherRedeemUrl(voucher.code), 'קישור למימוש השובר')}
<p style="margin:0;color:#8A847C;">החשבונית תונפק על שמך ותישלח אלייך בנפרד.</p>`
  return {
    subject: `אישור רכישת שובר מתנה — הזמנה ${orderNumber}`,
    html: layout(inner, { preheader: 'אישור רכישת שובר מתנה' }),
    text: `תודה על הרכישה! שובר מתנה עבור ${voucher.recipient_names}. קוד: ${voucher.code}. קישור: ${voucherRedeemUrl(voucher.code)}`,
  }
}

export function orderConfirmationEmail({ order, items }) {
  const rows = items
    .map(
      (item) =>
        `<li style="margin-bottom:6px;">${escapeHtml(item.package_name || item.theme)} — ${escapeHtml(
          (item.children || []).map((c) => c.name).filter(Boolean).join(', '),
        )}</li>`,
    )
    .join('')
  const inner = `
<p style="font-size:20px;margin:0 0 12px;">החבילות שלכם מחכות!</p>
<p style="margin:0 0 12px;">תודה על הרכישה. הזמנה מספר ${escapeHtml(order.order_number)}.</p>
<ul style="padding-right:18px;margin:0 0 12px;">${rows}</ul>
${button(`${siteUrl()}/account`, 'לחדרים שלי')}`
  return {
    subject: `אישור הזמנה ${order.order_number} — Petite Dreams`,
    html: layout(inner, { preheader: 'אישור הזמנה' }),
    text: `תודה על הרכישה. הזמנה ${order.order_number}. ${siteUrl()}/account`,
  }
}
