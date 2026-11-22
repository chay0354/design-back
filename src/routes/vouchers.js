import { Router } from 'express'
import QRCode from 'qrcode'
import { requireUser } from '../lib/auth.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, isEmail, requireString, route } from '../lib/http.js'
import { newVoucherCode, normalizeCode } from '../lib/codes.js'
import { charge } from '../lib/payments.js'
import { MAX_VOUCHER_PACKAGES, getSetting, getVoucherPrice } from '../lib/settings.js'
import {
  emailConfigured,
  escapeHtml,
  receivedPackagesLine,
  sendEmail,
  siteUrl,
  voucherBuyerEmail,
  voucherRecipientEmail,
  voucherRedeemUrl,
} from '../lib/email.js'

const router = Router()
const CODE_RE = /^PD-[A-Z0-9]{4,12}$/

export function whatsappText(voucher) {
  const lines = [
    '🎁 מתנה קטנה, חלומות גדולים!',
    '',
    `${voucher.recipient_names} היקרים,`,
    '',
    voucher.giver_name ? `מחכה לכם מתנה מיוחדת מ${voucher.giver_name}! ♡` : 'מחכה לכם מתנה מיוחדת! ♡',
    '',
    `${receivedPackagesLine(voucher.recipient_names, voucher.packages_count)} מבית Petite Dreams.`,
    'מקום קטן לחלומות גדולים, לדמיון ולזיכרונות יפים. ✨',
    '',
  ]
  if (voucher.personal_message) lines.push(voucher.personal_message, '')
  lines.push('🎁 למימוש המתנה:', shareUrl(voucher.code), '', `קוד השובר: ${voucher.code}`)
  if (voucher.giver_name) lines.push('', 'באהבה,', `${voucher.giver_name} ♡`)
  return lines.join('\n')
}

/** Share link that renders a designed WhatsApp preview, then forwards to the redeem page. */
export function shareUrl(code) {
  return `${siteUrl()}/api/g/${encodeURIComponent(code)}`
}

export function buyerView(voucher) {
  return {
    id: voucher.id,
    code: voucher.code,
    packagesCount: voucher.packages_count,
    packagesRedeemed: voucher.packages_redeemed,
    recipientNames: voucher.recipient_names,
    recipientEmail: voucher.recipient_email,
    recipientPhone: voucher.recipient_phone,
    giverName: voucher.giver_name,
    personalMessage: voucher.personal_message,
    deliveryMethod: voucher.delivery_method,
    status: voucher.status,
    redeemUrl: voucherRedeemUrl(voucher.code),
    shareUrl: shareUrl(voucher.code),
    whatsappText: whatsappText(voucher),
    createdAt: voucher.created_at,
  }
}

export async function deliverVoucher(voucher, { orderNumber, total, resend = false }) {
  const template = await getSetting('gift_voucher_email')
  const results = {}
  const configured = emailConfigured()

  // Gift email whenever a recipient address was provided (required for email delivery; optional for WhatsApp/self).
  if (voucher.recipient_email && isEmail(voucher.recipient_email)) {
    results.recipient = await sendEmail({ to: voucher.recipient_email, ...voucherRecipientEmail(voucher, template) })
  }

  if (!resend && voucher.buyer_email) {
    results.buyer = await sendEmail({ to: voucher.buyer_email, ...voucherBuyerEmail(voucher, { orderNumber, total }) })
  } else if (resend && voucher.buyer_email) {
    // On resend, buyer gets the shareable gift email (useful when WhatsApp/self was chosen).
    results.buyer = await sendEmail({ to: voucher.buyer_email, ...voucherRecipientEmail(voucher, template) })
  }

  const emailed = Object.values(results).some((r) => r?.sent)
  // WhatsApp/self can complete without email; pure email delivery stays pending until a send succeeds.
  if (emailed || voucher.delivery_method === 'whatsapp' || voucher.delivery_method === 'self') {
    const status = voucher.status === 'pending_send' ? 'sent' : voucher.status
    unwrap(
      await getAdmin()
        .from('gift_vouchers')
        .update({ status, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', voucher.id),
    )
    voucher.status = status
  }
  return {
    ...results,
    emailConfigured: configured,
    emailed,
    recipientEmailed: Boolean(results.recipient?.sent),
    buyerEmailed: Boolean(results.buyer?.sent),
  }
}

router.get(
  '/prices',
  route(async (_req, res) => {
    const prices = {}
    for (let count = 1; count <= MAX_VOUCHER_PACKAGES; count += 1) prices[count] = await getVoucherPrice(count)
    res.json({ maxPackages: MAX_VOUCHER_PACKAGES, prices })
  }),
)

router.post(
  '/',
  requireUser,
  route(async (req, res) => {
    const body = req.body || {}
    const packagesCount = Number.parseInt(body.packagesCount, 10)
    if (!Number.isInteger(packagesCount) || packagesCount < 1 || packagesCount > MAX_VOUCHER_PACKAGES) {
      throw new HttpError(400, 'Invalid packagesCount')
    }
    const deliveryMethod = ['email', 'whatsapp', 'self'].includes(body.deliveryMethod) ? body.deliveryMethod : 'email'
    const recipientEmail = requireString(body.recipientEmail, 'recipientEmail', { max: 200, optional: true })
    if (deliveryMethod === 'email' && !isEmail(recipientEmail)) {
      throw new HttpError(400, 'כתובת המייל של מקבל המתנה אינה תקינה')
    }
    const recipientPhone = requireString(body.recipientPhone, 'recipientPhone', { max: 30, optional: true })
    const fields = {
      recipient_names: requireString(body.recipientNames, 'recipientNames', { max: 200 }),
      recipient_email: recipientEmail.toLowerCase(),
      recipient_phone: recipientPhone.replace(/[^\d+]/g, ''),
      giver_name: requireString(body.giverName, 'giverName', { max: 120 }),
      personal_message: requireString(body.personalMessage, 'personalMessage', { max: 600, optional: true }),
      buyer_name: requireString(body.buyerName, 'buyerName', { max: 120, optional: true }) || req.user.name,
      buyer_email: req.user.email,
      buyer_user_id: req.user.id,
      delivery_method: deliveryMethod,
      packages_count: packagesCount,
    }

    const price = await getVoucherPrice(packagesCount)
    const payment = await charge({
      amount: price,
      description: `Petite Dreams gift voucher — ${packagesCount} package(s)`,
      customerEmail: req.user.email,
    })

    const db = getAdmin()
    let voucher = null
    for (let attempt = 0; attempt < 5 && !voucher; attempt += 1) {
      const { data, error } = await db
        .from('gift_vouchers')
        .insert({
          ...fields,
          code: newVoucherCode(),
          price_paid: price,
          payment_provider: payment.provider,
          payment_reference: payment.reference,
        })
        .select('*')
        .single()
      if (!error) voucher = data
      else if (error.code !== '23505') throw error
    }
    if (!voucher) throw new HttpError(500, 'Could not create a unique voucher code')

    const order = unwrap(
      await db
        .from('orders')
        .insert({
          user_id: req.user.id,
          email: req.user.email,
          kind: 'gift_voucher',
          status: 'paid',
          subtotal: price,
          total: price,
          payment_provider: payment.provider,
          payment_reference: payment.reference,
          purchased_voucher_id: voucher.id,
        })
        .select('order_number')
        .single(),
    )

    let delivery = {}
    try {
      delivery = await deliverVoucher(voucher, { orderNumber: order.order_number, total: price })
    } catch (err) {
      console.error('[vouchers] delivery failed', err)
      delivery = { error: 'email_failed', emailed: false, emailConfigured: emailConfigured() }
    }

    res.status(201).json({ voucher: buyerView(voucher), orderNumber: order.order_number, delivery })
  }),
)

/** The buyer can reopen the confirmation page for vouchers they bought. */
router.get(
  '/purchased/:id',
  requireUser,
  route(async (req, res) => {
    const voucher = unwrap(
      await getAdmin()
        .from('gift_vouchers')
        .select('*')
        .eq('id', req.params.id)
        .eq('buyer_user_id', req.user.id)
        .maybeSingle(),
    )
    if (!voucher) throw new HttpError(404, 'Voucher not found')
    res.json({ voucher: buyerView(voucher) })
  }),
)

/** Buyer can retry sending the gift email (e.g. after RESEND was configured). */
router.post(
  '/purchased/:id/resend-email',
  requireUser,
  route(async (req, res) => {
    if (!emailConfigured()) {
      throw new HttpError(503, 'שליחת מיילים עדיין לא הוגדרה בשרת. פנו לתמיכה.')
    }
    const voucher = unwrap(
      await getAdmin()
        .from('gift_vouchers')
        .select('*')
        .eq('id', req.params.id)
        .eq('buyer_user_id', req.user.id)
        .maybeSingle(),
    )
    if (!voucher) throw new HttpError(404, 'Voucher not found')
    if (voucher.status === 'cancelled') throw new HttpError(409, 'השובר בוטל')
    const delivery = await deliverVoucher(voucher, {
      resend: true,
      orderNumber: voucher.code,
      total: voucher.price_paid,
    })
    if (!delivery.emailed) {
      throw new HttpError(502, 'שליחת המייל נכשלה. נסי שוב בעוד רגע.')
    }
    res.json({ delivery, voucher: buyerView(voucher) })
  }),
)

router.get(
  '/:code/qr.png',
  route(async (req, res) => {
    const code = normalizeCode(req.params.code)
    if (!CODE_RE.test(code)) throw new HttpError(400, 'Invalid code')
    const png = await QRCode.toBuffer(voucherRedeemUrl(code), {
      width: 360,
      margin: 1,
      color: { dark: '#3C3834', light: '#FFFFFF' },
    })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(png)
  }),
)

/** What the recipient sees on the redeem page. Never exposes the buyer or the price. */
router.get(
  '/:code',
  route(async (req, res) => {
    const code = normalizeCode(req.params.code)
    if (!CODE_RE.test(code)) {
      res.json({ valid: false, reason: 'not_found' })
      return
    }
    const voucher = unwrap(await getAdmin().from('gift_vouchers').select('*').eq('code', code).maybeSingle())
    if (!voucher) {
      res.json({ valid: false, reason: 'not_found' })
      return
    }
    const remaining = voucher.packages_count - voucher.packages_redeemed
    const reason = voucher.status === 'cancelled' ? 'cancelled' : remaining <= 0 ? 'used' : null
    res.json({
      valid: !reason,
      reason,
      code: voucher.code,
      packagesCount: voucher.packages_count,
      packagesRemaining: Math.max(0, remaining),
      recipientNames: voucher.recipient_names,
      giverName: voucher.giver_name,
      personalMessage: voucher.personal_message,
    })
  }),
)

export const shareRouter = Router()

shareRouter.get(
  '/:code',
  route(async (req, res) => {
    const code = normalizeCode(req.params.code)
    const target = voucherRedeemUrl(code)
    const image = `${siteUrl()}/assets/gift-voucher-og.png`
    const title = '🎁 מחכה לכם מתנה מ־Petite Dreams'
    const description = 'מתנה קטנה, חלומות גדולים — חבילות עיצוב לחדרי הילדים'
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(target)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">
</head><body><a href="${escapeHtml(target)}">למימוש המתנה</a>
<script>location.replace(${JSON.stringify(target)})</script></body></html>`)
  }),
)

export default router
