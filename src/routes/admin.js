import { Router } from 'express'
import { requireAdmin } from '../lib/auth.js'
import { fetchAll, getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, isEmail, optionalNumber, parseDateRange, requireString, route } from '../lib/http.js'
import { normalizeCode, slugify, randomCode } from '../lib/codes.js'
import { toCsv, sendCsv } from '../lib/csv.js'
import { DEFAULT_SETTINGS, MAX_VOUCHER_PACKAGES, getSetting, setSetting } from '../lib/settings.js'
import { emailConfigured, siteUrl } from '../lib/email.js'
import { computeStats } from '../lib/stats.js'
import { revertVoucher } from './checkout.js'
import { buyerView, deliverVoucher } from './vouchers.js'
import {
  lastFinishedRun,
  linkCounts,
  processRun,
  replaceLinkInPackage,
  sendLinkReport,
  startRun,
  checkLink,
} from '../lib/linkCheck.js'

const router = Router()
router.use(requireAdmin)

const round2 = (v) => Math.round(v * 100) / 100
const referralUrl = (slug) => `${siteUrl()}/?ref=${encodeURIComponent(slug)}`
const isoOrNull = (value, field) => {
  if (value === undefined || value === null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Invalid ${field}`)
  return date.toISOString()
}

function couponFields(body, { partial = false } = {}) {
  const fields = {}
  if (!partial || body.code !== undefined) {
    const code = normalizeCode(body.code)
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new HttpError(400, 'קוד קופון: 3–30 אותיות באנגלית, ספרות, מקף או קו תחתון')
    fields.code = code
  }
  if (!partial || body.discountPercent !== undefined) {
    fields.discount_percent = optionalNumber(body.discountPercent, 'discountPercent', { min: 0.01, max: 100 })
    if (fields.discount_percent === null) throw new HttpError(400, 'Missing discountPercent')
  }
  if (body.validFrom !== undefined) fields.valid_from = isoOrNull(body.validFrom, 'validFrom')
  if (body.validUntil !== undefined) fields.valid_until = isoOrNull(body.validUntil, 'validUntil')
  if (body.maxUses !== undefined) {
    const max = optionalNumber(body.maxUses, 'maxUses', { min: 1, max: 1000000 })
    fields.max_uses = max === null ? null : Math.round(max)
  }
  if (body.active !== undefined) fields.active = Boolean(body.active)
  if (body.description !== undefined) fields.description = requireString(body.description, 'description', { max: 300, optional: true })
  return fields
}

function couponError(err) {
  if (err?.code === '23505') return new HttpError(409, 'קוד הקופון כבר קיים')
  return err
}

// ---------------------------------------------------------------------------
// Influencers
// ---------------------------------------------------------------------------

function summarizeInfluencerOrders(orders) {
  const paid = orders.filter((o) => o.status === 'paid')
  const commission = round2(paid.reduce((s, o) => s + Number(o.commission_amount), 0))
  const commissionPaid = round2(
    paid.filter((o) => o.commission_paid_at).reduce((s, o) => s + Number(o.commission_amount), 0),
  )
  return {
    orders: orders.length,
    paidOrders: paid.length,
    cancelledOrders: orders.length - paid.length,
    sales: round2(paid.reduce((s, o) => s + Number(o.total), 0)),
    viaCoupon: paid.filter((o) => o.attribution === 'coupon').length,
    viaLink: paid.filter((o) => o.attribution === 'link').length,
    commission,
    commissionPaid,
    commissionDue: round2(commission - commissionPaid),
  }
}

router.get(
  '/influencers',
  route(async (_req, res) => {
    const influencers = await fetchAll('influencers', (q) => q.select('*').order('created_at', { ascending: false }))
    const coupons = await fetchAll('coupons', (q) => q.select('*').not('influencer_id', 'is', null))
    const orders = await fetchAll('orders', (q) =>
      q
        .select('id, influencer_id, status, total, attribution, commission_amount, commission_paid_at')
        .not('influencer_id', 'is', null),
    )
    const visits = await fetchAll('referral_visits', (q) => q.select('influencer_id'))

    res.json({
      influencers: influencers.map((inf) => ({
        ...inf,
        referralUrl: referralUrl(inf.referral_slug),
        coupons: coupons.filter((c) => c.influencer_id === inf.id),
        linkVisits: visits.filter((v) => v.influencer_id === inf.id).length,
        stats: summarizeInfluencerOrders(orders.filter((o) => o.influencer_id === inf.id)),
      })),
    })
  }),
)

router.post(
  '/influencers',
  route(async (req, res) => {
    const body = req.body || {}
    const name = requireString(body.name, 'name', { max: 120 })
    const email = requireString(body.email, 'email', { max: 200, optional: true })
    if (email && !isEmail(email)) throw new HttpError(400, 'כתובת מייל לא תקינה')
    const commission = optionalNumber(body.commissionPercent, 'commissionPercent', { min: 0, max: 100 }) ?? 0
    const slug = slugify(body.referralSlug) || slugify(body.couponCode) || `inf-${randomCode(6).toLowerCase()}`

    const db = getAdmin()
    const { data: influencer, error } = await db
      .from('influencers')
      .insert({
        name,
        email: email.toLowerCase(),
        phone: requireString(body.phone, 'phone', { max: 30, optional: true }),
        instagram: requireString(body.instagram, 'instagram', { max: 120, optional: true }),
        notes: requireString(body.notes, 'notes', { max: 1000, optional: true }),
        referral_slug: slug,
        commission_percent: commission,
        active: body.active !== false,
      })
      .select('*')
      .single()
    if (error?.code === '23505') throw new HttpError(409, 'כתובת קישור ההפניה כבר בשימוש')
    if (error) throw error

    if (body.couponCode) {
      const { error: couponErr } = await db
        .from('coupons')
        .insert({ ...couponFields(body), influencer_id: influencer.id })
      if (couponErr) {
        await db.from('influencers').delete().eq('id', influencer.id)
        throw couponError(couponErr)
      }
    }
    res.status(201).json({ influencer: { ...influencer, referralUrl: referralUrl(slug) } })
  }),
)

router.patch(
  '/influencers/:id',
  route(async (req, res) => {
    const body = req.body || {}
    const fields = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) fields.name = requireString(body.name, 'name', { max: 120 })
    if (body.email !== undefined) {
      const email = requireString(body.email, 'email', { max: 200, optional: true })
      if (email && !isEmail(email)) throw new HttpError(400, 'כתובת מייל לא תקינה')
      fields.email = email.toLowerCase()
    }
    for (const key of ['phone', 'instagram', 'notes']) {
      if (body[key] !== undefined) fields[key] = requireString(body[key], key, { max: key === 'notes' ? 1000 : 120, optional: true })
    }
    if (body.commissionPercent !== undefined) {
      fields.commission_percent = optionalNumber(body.commissionPercent, 'commissionPercent', { min: 0, max: 100 }) ?? 0
    }
    if (body.referralSlug !== undefined) {
      const slug = slugify(body.referralSlug)
      if (!slug) throw new HttpError(400, 'Invalid referralSlug')
      fields.referral_slug = slug
    }
    if (body.active !== undefined) fields.active = Boolean(body.active)

    const { data, error } = await getAdmin().from('influencers').update(fields).eq('id', req.params.id).select('*').single()
    if (error?.code === '23505') throw new HttpError(409, 'כתובת קישור ההפניה כבר בשימוש')
    if (error) throw error
    res.json({ influencer: data })
  }),
)

router.post(
  '/influencers/:id/mark-paid',
  route(async (req, res) => {
    const upTo = isoOrNull(req.body?.upTo, 'upTo') || new Date().toISOString()
    const updated = unwrap(
      await getAdmin()
        .from('orders')
        .update({ commission_paid_at: new Date().toISOString() })
        .eq('influencer_id', req.params.id)
        .eq('status', 'paid')
        .is('commission_paid_at', null)
        .lte('created_at', upTo)
        .select('id, commission_amount'),
    )
    res.json({
      ordersMarked: updated.length,
      amount: round2(updated.reduce((s, o) => s + Number(o.commission_amount), 0)),
    })
  }),
)

/** Monthly influencer report (Excel-compatible CSV). ?month=YYYY-MM, optional ?influencerId= */
router.get(
  '/influencers/report.csv',
  route(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7)
    const from = new Date(`${month}-01T00:00:00.000Z`)
    const to = new Date(from)
    to.setUTCMonth(to.getUTCMonth() + 1)

    const orders = await fetchAll('orders', (q) => {
      let query = q
        .select('*, influencer:influencers(name, referral_slug)')
        .not('influencer_id', 'is', null)
        .gte('created_at', from.toISOString())
        .lt('created_at', to.toISOString())
        .order('created_at')
      if (req.query.influencerId) query = query.eq('influencer_id', req.query.influencerId)
      return query
    })

    const statusLabel = { paid: 'שולם', cancelled: 'בוטל', refunded: 'הוחזר', pending: 'ממתין' }
    const csv = toCsv(
      [
        { label: 'משפיענית', value: (o) => o.influencer?.name || '' },
        { label: 'מספר הזמנה', key: 'order_number' },
        { label: 'תאריך', value: (o) => o.created_at.slice(0, 10) },
        { label: 'לקוח', key: 'email' },
        { label: 'מקור', value: (o) => (o.attribution === 'coupon' ? `קופון ${o.coupon_code}` : 'קישור הפניה') },
        { label: 'סטטוס', value: (o) => statusLabel[o.status] || o.status },
        { label: 'סכום ששולם', key: 'total' },
        { label: 'אחוז עמלה', key: 'commission_percent' },
        { label: 'עמלה', value: (o) => (o.status === 'paid' ? o.commission_amount : 0) },
        { label: 'עמלה שולמה', value: (o) => (o.commission_paid_at ? o.commission_paid_at.slice(0, 10) : '') },
      ],
      orders,
    )
    sendCsv(res, `influencers-${month}.csv`, csv)
  }),
)

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

router.get(
  '/coupons',
  route(async (_req, res) => {
    const coupons = await fetchAll('coupons', (q) =>
      q.select('*, influencer:influencers(id, name)').order('created_at', { ascending: false }),
    )
    const orders = await fetchAll('orders', (q) =>
      q.select('coupon_id, status, total, discount_total').not('coupon_id', 'is', null),
    )
    res.json({
      coupons: coupons.map((coupon) => {
        const mine = orders.filter((o) => o.coupon_id === coupon.id)
        const paid = mine.filter((o) => o.status === 'paid')
        return {
          ...coupon,
          uses: paid.length,
          sales: round2(paid.reduce((s, o) => s + Number(o.total), 0)),
          discountGiven: round2(paid.reduce((s, o) => s + Number(o.discount_total), 0)),
        }
      }),
    })
  }),
)

router.post(
  '/coupons',
  route(async (req, res) => {
    const fields = couponFields(req.body || {})
    if (req.body?.influencerId) fields.influencer_id = req.body.influencerId
    const { data, error } = await getAdmin().from('coupons').insert(fields).select('*').single()
    if (error) throw couponError(error)
    res.status(201).json({ coupon: data })
  }),
)

router.patch(
  '/coupons/:id',
  route(async (req, res) => {
    const fields = { ...couponFields(req.body || {}, { partial: true }), updated_at: new Date().toISOString() }
    const { data, error } = await getAdmin().from('coupons').update(fields).eq('id', req.params.id).select('*').single()
    if (error) throw couponError(error)
    res.json({ coupon: data })
  }),
)

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

async function loadOrders(query) {
  const { from, to } = parseDateRange(query, 365)
  const orders = await fetchAll('orders', (q) => {
    let builder = q
      .select('*, influencer:influencers(name)')
      .gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString())
      .order('created_at', { ascending: false })
    if (query.influencerId) builder = builder.eq('influencer_id', query.influencerId)
    if (query.couponId) builder = builder.eq('coupon_id', query.couponId)
    if (query.kind) builder = builder.eq('kind', query.kind)
    if (query.status) builder = builder.eq('status', query.status)
    return builder
  })
  const ids = orders.map((o) => o.id)
  const items = []
  for (let i = 0; i < ids.length; i += 200) {
    items.push(...(await fetchAll('order_items', (q) => q.select('*').in('order_id', ids.slice(i, i + 200)))))
  }
  return orders.map((order) => ({ ...order, items: items.filter((it) => it.order_id === order.id) }))
}

router.get(
  '/orders',
  route(async (req, res) => {
    res.json({ orders: await loadOrders(req.query) })
  }),
)

router.get(
  '/orders.csv',
  route(async (req, res) => {
    const orders = await loadOrders(req.query)
    const csv = toCsv(
      [
        { label: 'מספר הזמנה', key: 'order_number' },
        { label: 'תאריך', value: (o) => o.created_at.slice(0, 10) },
        { label: 'סוג', value: (o) => (o.kind === 'gift_voucher' ? 'שובר מתנה' : 'חבילות') },
        { label: 'לקוח', key: 'email' },
        { label: 'סטטוס', key: 'status' },
        { label: 'חבילות', value: (o) => o.items.length },
        { label: 'חבילות', value: (o) => o.items.map((i) => i.package_name).join(' | ') },
        { label: 'מחיר מחירון', key: 'subtotal' },
        { label: 'הנחה', key: 'discount_total' },
        { label: 'שולם', key: 'total' },
        { label: 'קופון', key: 'coupon_code' },
        { label: 'משפיענית', value: (o) => o.influencer?.name || '' },
        { label: 'חבילות משובר', key: 'voucher_packages_used' },
      ],
      orders,
    )
    sendCsv(res, 'orders.csv', csv)
  }),
)

/** Cancel or refund. Gives back voucher packages and removes the order from commissions and stats. */
router.patch(
  '/orders/:id',
  route(async (req, res) => {
    const status = req.body?.status
    if (!['cancelled', 'refunded', 'paid'].includes(status)) throw new HttpError(400, 'Invalid status')
    const db = getAdmin()
    const order = unwrap(await db.from('orders').select('*').eq('id', req.params.id).single())
    const wasActive = order.status === 'paid'
    const nowActive = status === 'paid'

    unwrap(
      await db
        .from('orders')
        .update({
          status,
          cancelled_at: nowActive ? null : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id),
    )

    if (wasActive && !nowActive && order.voucher_id && order.voucher_packages_used > 0) {
      await revertVoucher(order.voucher_id, order.voucher_packages_used)
      unwrap(
        await db
          .from('voucher_redemptions')
          .update({ reverted_at: new Date().toISOString() })
          .eq('order_id', order.id),
      )
    }
    if (wasActive && !nowActive && order.purchased_voucher_id) {
      unwrap(
        await db
          .from('gift_vouchers')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', order.purchased_voucher_id),
      )
    }
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------------------
// Gift vouchers
// ---------------------------------------------------------------------------

router.get(
  '/vouchers',
  route(async (_req, res) => {
    const vouchers = await fetchAll('gift_vouchers', (q) => q.select('*').order('created_at', { ascending: false }))
    const redemptions = await fetchAll('voucher_redemptions', (q) => q.select('*').is('reverted_at', null))
    res.json({
      vouchers: vouchers.map((v) => ({
        ...buyerView(v),
        buyerName: v.buyer_name,
        buyerEmail: v.buyer_email,
        pricePaid: Number(v.price_paid),
        packagesRemaining: v.packages_count - v.packages_redeemed,
        sentAt: v.sent_at,
        cancelledAt: v.cancelled_at,
        redemptions: redemptions
          .filter((r) => r.voucher_id === v.id)
          .map((r) => ({ orderId: r.order_id, packagesUsed: r.packages_used, createdAt: r.created_at })),
      })),
    })
  }),
)

router.post(
  '/vouchers/:id/resend',
  route(async (req, res) => {
    const voucher = unwrap(await getAdmin().from('gift_vouchers').select('*').eq('id', req.params.id).single())
    if (voucher.status === 'cancelled') throw new HttpError(409, 'השובר בוטל')
    if (!emailConfigured()) throw new HttpError(503, 'שליחת מיילים לא הוגדרה בשרת (RESEND_API_KEY)')
    const result = await deliverVoucher(voucher, { resend: true })
    res.json({ result, status: voucher.status })
  }),
)

router.post(
  '/vouchers/:id/cancel',
  route(async (req, res) => {
    const db = getAdmin()
    const voucher = unwrap(await db.from('gift_vouchers').select('*').eq('id', req.params.id).single())
    unwrap(
      await db
        .from('gift_vouchers')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', voucher.id),
    )
    if (req.body?.refundOrder) {
      unwrap(
        await db
          .from('orders')
          .update({ status: 'refunded', cancelled_at: new Date().toISOString() })
          .eq('purchased_voucher_id', voucher.id),
      )
    }
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------------------
// Settings (voucher prices, voucher email text, room price)
// ---------------------------------------------------------------------------

router.get(
  '/settings',
  route(async (_req, res) => {
    res.json({
      roomPrice: await getSetting('room_price'),
      giftVoucherPrices: await getSetting('gift_voucher_prices'),
      giftVoucherEmail: await getSetting('gift_voucher_email'),
      guideVideos: await getSetting('guide_videos'),
      defaults: DEFAULT_SETTINGS,
      emailConfigured: emailConfigured(),
      paymentProvider: (process.env.PAYMENT_PROVIDER || 'demo').toLowerCase(),
    })
  }),
)

router.put(
  '/settings',
  route(async (req, res) => {
    const body = req.body || {}
    if (body.roomPrice !== undefined) {
      const price = optionalNumber(body.roomPrice, 'roomPrice', { min: 1, max: 100000 })
      await setSetting('room_price', price)
    }
    if (body.giftVoucherPrices !== undefined) {
      const prices = {}
      for (let count = 1; count <= MAX_VOUCHER_PACKAGES; count += 1) {
        const value = optionalNumber(body.giftVoucherPrices?.[count], `price for ${count}`, { min: 1, max: 100000 })
        if (value !== null) prices[String(count)] = value
      }
      await setSetting('gift_voucher_prices', prices)
    }
    if (body.giftVoucherEmail !== undefined) {
      const template = {}
      for (const key of Object.keys(DEFAULT_SETTINGS.gift_voucher_email)) {
        template[key] = requireString(body.giftVoucherEmail?.[key], key, { max: 2000, optional: true }) ||
          DEFAULT_SETTINGS.gift_voucher_email[key]
      }
      await setSetting('gift_voucher_email', template)
    }
    if (body.guideVideos !== undefined) {
      if (!Array.isArray(body.guideVideos) || body.guideVideos.length > 12) throw new HttpError(400, 'Invalid guideVideos')
      const videos = body.guideVideos.map((video, index) => {
        const videoUrl = requireString(video?.videoUrl, 'videoUrl', { max: 500, optional: true })
        if (videoUrl && !/^https:\/\//i.test(videoUrl)) throw new HttpError(400, 'קישור וידאו חייב להתחיל ב-https://')
        return {
          id: requireString(video?.id, 'id', { max: 40, optional: true }) || `lesson-${index + 1}`,
          title: requireString(video?.title, 'title', { max: 120 }),
          description: requireString(video?.description, 'description', { max: 400, optional: true }),
          image: requireString(video?.image, 'image', { max: 500, optional: true }),
          videoUrl,
        }
      })
      await setSetting('guide_videos', videos)
    }
    res.json({ ok: true })
  }),
)

// ---------------------------------------------------------------------------
// Broken product links
// ---------------------------------------------------------------------------

router.get(
  '/links',
  route(async (req, res) => {
    const links = await fetchAll('product_link_checks', (q) => {
      let builder = q.select('*').order('package_name').order('category')
      if (req.query.status) builder = builder.eq('status', req.query.status)
      return builder
    })
    const activeRun = unwrap(
      await getAdmin().from('link_check_runs').select('*').is('finished_at', null).limit(1).maybeSingle(),
    )
    res.json({ links, counts: await linkCounts(), lastRun: await lastFinishedRun(), activeRun })
  }),
)

/** Starts (or continues) a manual check. The admin page calls it again while `remaining > 0`. */
router.post(
  '/links/run',
  route(async (_req, res) => {
    const run = await startRun('manual')
    const result = await processRun(run, { budgetMs: 40000 })
    res.json(result)
  }),
)

router.post(
  '/links/:id/replace',
  route(async (req, res) => {
    const url = requireString(req.body?.url, 'url', { max: 2000 })
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'קישור לא תקין')
    res.json({ result: await replaceLinkInPackage(req.params.id, url) })
  }),
)

router.post(
  '/links/:id/handled',
  route(async (req, res) => {
    const handled = req.body?.handled !== false
    unwrap(
      await getAdmin()
        .from('product_link_checks')
        .update({ handled_at: handled ? new Date().toISOString() : null })
        .eq('id', req.params.id),
    )
    res.json({ ok: true })
  }),
)

router.post(
  '/links/:id/recheck',
  route(async (req, res) => {
    const db = getAdmin()
    const row = unwrap(await db.from('product_link_checks').select('*').eq('id', req.params.id).single())
    const result = await checkLink(row.url, { delay: 1500 })
    const now = new Date().toISOString()
    unwrap(
      await db
        .from('product_link_checks')
        .update({
          status: result.status,
          http_status: result.httpStatus,
          problem: result.problem,
          last_checked_at: now,
          consecutive_failures: result.status === 'broken' ? row.consecutive_failures + 1 : 0,
          first_failed_at: result.status === 'broken' ? row.first_failed_at || now : null,
        })
        .eq('id', row.id),
    )
    res.json({ result })
  }),
)

router.post(
  '/links/report',
  route(async (_req, res) => {
    const run = await lastFinishedRun()
    if (!run) throw new HttpError(409, 'עדיין לא בוצעה בדיקה')
    res.json(await sendLinkReport(run))
  }),
)

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const GRANULARITIES = new Set(['day', 'week', 'month', 'year'])

router.get(
  '/stats',
  route(async (req, res) => {
    const { from, to } = parseDateRange(req.query, 30)
    const granularity = GRANULARITIES.has(req.query.granularity) ? req.query.granularity : 'day'
    res.json(await computeStats({ from, to, granularity, compare: req.query.compare !== 'false' }))
  }),
)

router.get(
  '/stats.csv',
  route(async (req, res) => {
    const { from, to } = parseDateRange(req.query, 30)
    const granularity = GRANULARITIES.has(req.query.granularity) ? req.query.granularity : 'day'
    const stats = await computeStats({ from, to, granularity, compare: true })
    const rows = []
    const add = (section, label, value, previous) => rows.push({ section, label, value, previous: previous ?? '' })
    const s = stats.sales
    const p = stats.previous?.sales || {}
    add('מכירות', 'רכישות', s.totalPurchases, p.totalPurchases)
    add('מכירות', 'לקוחות ייחודיים', s.uniqueBuyers, p.uniqueBuyers)
    add('מכירות', 'הכנסות', s.revenue, p.revenue)
    add('מכירות', 'סכום רכישה ממוצע', s.averageOrder, p.averageOrder)
    add('מכירות', 'חבילות שנרכשו', s.packagesSold, p.packagesSold)
    add('מכירות', 'רכישות חבילה ראשונה', s.firstPackagePurchases, p.firstPackagePurchases)
    add('מכירות', 'שדרוגים', s.upgradePurchases, p.upgradePurchases)
    add('מכירות', 'הזמנות עם כמה חדרים', s.multiRoomOrders, p.multiRoomOrders)
    add('מכירות', 'הזמנות עם הנחת אחים', s.siblingDiscountOrders, p.siblingDiscountOrders)
    add('מכירות', 'הכנסות מחבילות חדשות', s.newPackageRevenue, p.newPackageRevenue)
    add('מכירות', 'הכנסות משדרוגים', s.upgradeRevenue, p.upgradeRevenue)
    for (const entry of s.topPackages) add('חבילות נמכרות', entry.name, entry.count)
    for (const entry of s.byTheme) add('לפי נושא', entry.name, entry.count)
    for (const entry of s.byColor) add('לפי סקלת צבעים', entry.name, entry.count)
    add('ילדים', 'ילדים שהוזנו בשאלון', stats.children.childrenEntered, stats.previous?.children.childrenEntered)
    add('ילדים', 'ילדים ברכישות', stats.children.childrenPurchased, stats.previous?.children.childrenPurchased)
    for (const entry of stats.children.byAgeBucket) add('ילדים לפי קבוצת גיל (שאלון)', entry.name, entry.count)
    for (const entry of stats.children.purchasedByAgeBucket) add('ילדים לפי קבוצת גיל (רוכשים)', entry.name, entry.count)
    for (const [gender, count] of Object.entries(stats.children.byGender)) add('ילדים לפי מגדר', gender, count)
    const r = stats.rooms
    const pr = stats.previous?.rooms || {}
    add('חדרים', 'חדרים שנרכשו', r.roomsPurchased, pr.roomsPurchased)
    add('חדרים', 'חדרים משותפים', r.sharedRooms, pr.sharedRooms)
    add('חדרים', 'משפחות עם כמה חדרים', r.familiesMultipleRooms, pr.familiesMultipleRooms)
    add('חדרים', 'לקוחות חוזרים', r.returningCustomers, pr.returningCustomers)
    add('חדרים', 'חבילות שהועברו לארכיון', r.archivedPackages, pr.archivedPackages)
    const q = stats.questionnaire
    const pq = stats.previous?.questionnaire || {}
    add('שאלון', 'התחלות', q.started, pq.started)
    add('שאלון', 'השלמות', q.completed, pq.completed)
    add('שאלון', 'הגיעו לסל', q.reachedCart, pq.reachedCart)
    add('שאלון', 'רכישות', q.purchased, pq.purchased)
    add('שאלון', 'אחוז המרה', q.conversionRate, pq.conversionRate)
    for (const point of stats.series) add('לפי תקופה', point.key, `${point.orders} רכישות / ₪${point.revenue}`)

    const csv = toCsv(
      [
        { label: 'נושא', key: 'section' },
        { label: 'מדד', key: 'label' },
        { label: 'ערך', key: 'value' },
        { label: 'תקופה קודמת', key: 'previous' },
      ],
      rows,
    )
    sendCsv(res, `dashboard-${req.query.from || 'from'}-${req.query.to || 'to'}.csv`, csv)
  }),
)

export default router
