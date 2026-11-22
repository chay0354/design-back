import { getAdmin, unwrap } from './supabaseAdmin.js'
import { normalizeCode } from './codes.js'

export const REFERRAL_WINDOW_DAYS = 30

export const COUPON_ERRORS = {
  not_found: 'קוד הקופון לא קיים',
  inactive: 'קוד הקופון אינו פעיל',
  not_started: 'קוד הקופון עדיין לא בתוקף',
  expired: 'תוקף קוד הקופון פג',
  max_uses: 'קוד הקופון נוצל עד תום',
}

export const VOUCHER_ERRORS = {
  not_found: 'קוד השובר לא קיים',
  cancelled: 'השובר בוטל',
  used: 'השובר כבר מומש במלואו',
}

/** Paid uses only — cancelled and refunded orders give the use back. */
export async function couponUses(couponId) {
  const { count, error } = await getAdmin()
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('coupon_id', couponId)
    .eq('status', 'paid')
  if (error) throw error
  return count || 0
}

export async function lookupCoupon(rawCode, now = new Date()) {
  const code = normalizeCode(rawCode)
  if (!code) return { error: 'not_found' }

  const coupon = unwrap(
    await getAdmin().from('coupons').select('*, influencer:influencers(*)').eq('code', code).maybeSingle(),
  )
  if (!coupon) return { error: 'not_found' }
  if (!coupon.active || (coupon.influencer && !coupon.influencer.active)) return { error: 'inactive', coupon }
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { error: 'not_started', coupon }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) return { error: 'expired', coupon }
  if (coupon.max_uses && (await couponUses(coupon.id)) >= coupon.max_uses) return { error: 'max_uses', coupon }
  return { coupon }
}

export async function lookupVoucher(rawCode) {
  const code = normalizeCode(rawCode)
  if (!code) return { error: 'not_found' }
  const voucher = unwrap(await getAdmin().from('gift_vouchers').select('*').eq('code', code).maybeSingle())
  if (!voucher) return { error: 'not_found' }
  if (voucher.status === 'cancelled') return { error: 'cancelled', voucher }
  const remaining = voucher.packages_count - voucher.packages_redeemed
  if (remaining <= 0) return { error: 'used', voucher }
  return { voucher, remaining }
}

/** The influencer whose referral link this visitor used in the last 30 days, if any. */
export async function resolveReferral(visitorId, now = new Date()) {
  if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 100) return null
  const since = new Date(now.getTime() - REFERRAL_WINDOW_DAYS * 86400000).toISOString()
  const visit = unwrap(
    await getAdmin()
      .from('referral_visits')
      .select('influencer_id, created_at, influencer:influencers(*)')
      .eq('visitor_id', visitorId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
  if (!visit?.influencer?.active) return null
  return visit.influencer
}

/**
 * One attribution per order. A coupon that belongs to an influencer wins;
 * otherwise a referral link from the last 30 days; otherwise none.
 */
export function chooseAttribution({ coupon, referralInfluencer }) {
  if (coupon?.influencer_id && coupon.influencer) {
    return { influencer: coupon.influencer, attribution: 'coupon' }
  }
  if (referralInfluencer) {
    return { influencer: referralInfluencer, attribution: 'link' }
  }
  return { influencer: null, attribution: '' }
}

export function publicCoupon(coupon) {
  return { code: coupon.code, discountPercent: Number(coupon.discount_percent) }
}
