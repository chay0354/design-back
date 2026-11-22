import { getAdmin } from './supabaseAdmin.js'
import { DEFAULT_ROOM_PRICE, defaultVoucherPrice } from './pricing.js'

export const MAX_VOUCHER_PACKAGES = 5

export const DEFAULT_VOUCHER_EMAIL = {
  subject: '🎁 מחכה לכם מתנה מיוחדת מ־Petite Dreams!',
  intro: 'מתנה קטנה, חלומות גדולים ✨',
  body:
    'כי לכל ילד מגיע מקום משלו לחלום, לדמיין ולגדול בו.\nאנחנו שמחים לעזור להפוך את החלומות הקטנים למציאות.',
  defaultBlessing: 'באהבה',
  signature: 'צוות Petite Dreams',
}

export const DEFAULT_SETTINGS = {
  room_price: DEFAULT_ROOM_PRICE,
  gift_voucher_prices: Object.fromEntries(
    Array.from({ length: MAX_VOUCHER_PACKAGES }, (_, i) => [String(i + 1), defaultVoucherPrice(i + 1)]),
  ),
  gift_voucher_email: DEFAULT_VOUCHER_EMAIL,
  // Masterclass lessons in the personal area: [{ id, title, description, image, videoUrl }]
  guide_videos: [],
  // Application guides in the personal area toolbox: [{ id, title, subtitle, summary, body }]
  application_guides: [],
}

export async function getSetting(key) {
  const { data, error } = await getAdmin().from('app_settings').select('value').eq('key', key).maybeSingle()
  if (error) throw error
  if (data?.value === undefined || data?.value === null) return DEFAULT_SETTINGS[key]
  if (DEFAULT_SETTINGS[key] && typeof DEFAULT_SETTINGS[key] === 'object' && !Array.isArray(DEFAULT_SETTINGS[key])) {
    return { ...DEFAULT_SETTINGS[key], ...data.value }
  }
  return data.value
}

export async function setSetting(key, value) {
  const { error } = await getAdmin()
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() })
  if (error) throw error
}

export async function getRoomPrice() {
  const value = Number(await getSetting('room_price'))
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROOM_PRICE
}

export async function getVoucherPrice(packagesCount) {
  const prices = await getSetting('gift_voucher_prices')
  const value = Number(prices?.[String(packagesCount)])
  if (Number.isFinite(value) && value > 0) return value
  return defaultVoucherPrice(packagesCount, await getRoomPrice())
}
