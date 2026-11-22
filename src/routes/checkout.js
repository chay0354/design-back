import { Router } from 'express'
import { optionalUser, requireUser } from '../lib/auth.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, requireString, route } from '../lib/http.js'
import { commissionFor, quoteOrder } from '../lib/pricing.js'
import { getRoomPrice } from '../lib/settings.js'
import { charge } from '../lib/payments.js'
import { orderConfirmationEmail, sendEmail } from '../lib/email.js'
import {
  COUPON_ERRORS,
  VOUCHER_ERRORS,
  chooseAttribution,
  lookupCoupon,
  lookupVoucher,
  publicCoupon,
  resolveReferral,
} from '../lib/commerce.js'

const router = Router()
const MAX_ROOMS = 10
const UUID = /^[0-9a-f-]{36}$/i
const GENDERS = new Set(['boy', 'girl', 'unisex'])
const AGE_GROUPS = new Set(['0-2', '3-5', '6-10'])

function cleanChild(child) {
  const age = Number(child?.age)
  return {
    name: requireString(child?.name, 'child name', { max: 60 }),
    age: Number.isFinite(age) && age >= 0 && age <= 18 ? Math.round(age) : 0,
    gender: GENDERS.has(child?.gender) ? child.gender : '',
  }
}

function cleanRoom(room, index) {
  if (!room || typeof room !== 'object') throw new HttpError(400, `Invalid room ${index + 1}`)
  const children = Array.isArray(room.children) ? room.children.slice(0, 6).map(cleanChild) : []
  if (children.length === 0) throw new HttpError(400, `Room ${index + 1} has no children`)
  const roomId = typeof room.roomId === 'string' && UUID.test(room.roomId) ? room.roomId : null
  return {
    roomId,
    children,
    designGender: GENDERS.has(room.designGender) ? room.designGender : '',
    ageChoice: room.ageChoice && typeof room.ageChoice === 'object' ? room.ageChoice : null,
    ageGroup: AGE_GROUPS.has(room.ageGroup) ? room.ageGroup : '',
    ageTrack: room.ageTrack === 'cross-age' ? 'cross-age' : 'child',
    packageId: requireString(room.packageId, 'packageId', { max: 200 }),
    packageName: requireString(room.packageName, 'packageName', { max: 300, optional: true }),
    theme: requireString(room.theme, 'theme', { max: 120, optional: true }),
    colorPreference: requireString(room.colorPreference, 'colorPreference', { max: 120, optional: true }),
    wallDesignOption: requireString(room.wallDesignOption, 'wallDesignOption', { max: 40, optional: true }),
    displayName: requireString(room.displayName, 'displayName', { max: 200, optional: true }),
    // Used only when the package is not in app_packages (static default variant).
    packageSnapshot: room.packageSnapshot && typeof room.packageSnapshot === 'object' ? room.packageSnapshot : null,
    designAge: Number.isFinite(Number(room.designAge)) ? Number(room.designAge) : children[0].age,
  }
}

/** Indexes of the rooms that already belong to this customer — a new design for them is an upgrade. */
async function ownedRoomIndexes(userId, roomIds) {
  const ids = roomIds.filter((id) => typeof id === 'string' && UUID.test(id))
  if (!userId || ids.length === 0) return []
  const rows = unwrap(await getAdmin().from('petite_rooms').select('id').eq('user_id', userId).in('id', ids))
  const owned = new Set(rows.map((row) => row.id))
  return roomIds.flatMap((id, index) => (owned.has(id) ? [index] : []))
}

async function buildQuote({ roomCount, couponCode, voucherCode, upgradeIndexes = [] }) {
  const roomPrice = await getRoomPrice()
  let coupon = null
  let couponError = null
  if (couponCode) {
    const result = await lookupCoupon(couponCode)
    if (result.error) couponError = { code: result.error, message: COUPON_ERRORS[result.error] }
    else coupon = result.coupon
  }

  let voucher = null
  let voucherRemaining = 0
  let voucherError = null
  if (voucherCode) {
    const result = await lookupVoucher(voucherCode)
    if (result.error) voucherError = { code: result.error, message: VOUCHER_ERRORS[result.error] }
    else {
      voucher = result.voucher
      voucherRemaining = result.remaining
    }
  }

  const quote = quoteOrder({
    roomCount,
    roomPrice,
    couponPercent: coupon ? Number(coupon.discount_percent) : 0,
    voucherPackages: voucherRemaining,
    upgradeIndexes,
  })

  return { quote, coupon, couponError, voucher, voucherRemaining, voucherError, roomPrice }
}

function quoteResponse({ quote, coupon, couponError, voucher, voucherRemaining, voucherError, roomPrice }) {
  return {
    roomPrice,
    ...quote,
    coupon: coupon ? publicCoupon(coupon) : null,
    couponError,
    voucher: voucher
      ? { code: voucher.code, packagesRemaining: voucherRemaining, packagesCount: voucher.packages_count }
      : null,
    voucherError,
  }
}

/** Price preview for the cart: room count + optional coupon / voucher codes and the rooms being redesigned. */
router.post(
  '/quote',
  optionalUser,
  route(async (req, res) => {
    const roomCount = Math.min(MAX_ROOMS, Math.max(1, Number.parseInt(req.body?.roomCount, 10) || 1))
    const roomIds = Array.isArray(req.body?.roomIds) ? req.body.roomIds.slice(0, roomCount) : []
    const result = await buildQuote({
      roomCount,
      couponCode: req.body?.couponCode,
      voucherCode: req.body?.voucherCode,
      upgradeIndexes: await ownedRoomIndexes(req.user?.id, roomIds),
    })
    res.json(quoteResponse(result))
  }),
)

/** The package as customers saw it when buying — the published version wins over the browser copy. */
async function packageSnapshots(rooms) {
  const ids = [...new Set(rooms.map((room) => room.packageId))]
  const rows = unwrap(await getAdmin().from('app_packages').select('id, data').in('id', ids))
  const published = new Map(rows.map((row) => [row.id, row.data]))
  return rooms.map((room) => published.get(room.packageId) || room.packageSnapshot || null)
}

async function upsertRoom(userId, room) {
  const db = getAdmin()
  const fields = {
    label: room.displayName,
    children: room.children,
    design_gender: room.designGender,
    age_choice: room.ageChoice,
    age_group: room.ageGroup,
    age_track: room.ageTrack,
    updated_at: new Date().toISOString(),
  }
  if (room.roomId) {
    const existing = unwrap(
      await db.from('petite_rooms').select('id').eq('id', room.roomId).eq('user_id', userId).maybeSingle(),
    )
    if (existing) {
      unwrap(await db.from('petite_rooms').update(fields).eq('id', room.roomId))
      return { id: room.roomId, existed: true }
    }
  }
  const created = unwrap(await db.from('petite_rooms').insert({ user_id: userId, ...fields }).select('id').single())
  return { id: created.id, existed: false }
}

async function revertVoucher(voucherId, packages) {
  if (!voucherId || packages <= 0) return
  const db = getAdmin()
  const voucher = unwrap(await db.from('gift_vouchers').select('*').eq('id', voucherId).single())
  const redeemed = Math.max(0, voucher.packages_redeemed - packages)
  unwrap(
    await db
      .from('gift_vouchers')
      .update({
        packages_redeemed: redeemed,
        status:
          voucher.status === 'cancelled'
            ? 'cancelled'
            : redeemed === 0
              ? voucher.sent_at
                ? 'sent'
                : 'pending_send'
              : 'partially_redeemed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', voucherId),
  )
}

/** Adds the purchase to the profile the personal area reads, archiving replaced room packages. */
async function recordOnProfile(userId, entries) {
  const db = getAdmin()
  const profile = unwrap(
    await db.from('petite_profiles').select('purchased_packages, children').eq('id', userId).single(),
  )
  const purchased = new Set(profile.purchased_packages || [])
  const children = Array.isArray(profile.children) ? [...profile.children] : []
  const now = new Date().toISOString()

  for (const entry of entries) {
    purchased.add(entry.packageId)
    if (entry.replacesRoom) {
      for (const child of children) {
        if (child.roomId === entry.roomId && !child.archivedAt) child.archivedAt = now
      }
    }
    children.push({
      name: entry.name,
      age: entry.age,
      packageId: entry.packageId,
      purchaseDate: now,
      gender: entry.gender,
      theme: entry.theme,
      colorPreference: entry.colorPreference,
      roomId: entry.roomId,
      orderItemId: entry.orderItemId,
      roomChildren: entry.roomChildren,
    })
  }

  unwrap(
    await db
      .from('petite_profiles')
      .update({ purchased_packages: [...purchased], children, updated_at: now })
      .eq('id', userId),
  )
}

router.post(
  '/orders',
  requireUser,
  route(async (req, res) => {
    const db = getAdmin()
    const user = req.user
    const rawRooms = Array.isArray(req.body?.rooms) ? req.body.rooms : []
    if (rawRooms.length === 0 || rawRooms.length > MAX_ROOMS) throw new HttpError(400, 'Invalid rooms')
    const rooms = rawRooms.map(cleanRoom)

    const quoteResult = await buildQuote({
      roomCount: rooms.length,
      couponCode: req.body?.couponCode,
      voucherCode: req.body?.voucherCode,
      upgradeIndexes: await ownedRoomIndexes(
        user.id,
        rooms.map((room) => room.roomId),
      ),
    })
    if (quoteResult.couponError) throw new HttpError(409, quoteResult.couponError.message, quoteResult.couponError)
    if (quoteResult.voucherError) throw new HttpError(409, quoteResult.voucherError.message, quoteResult.voucherError)
    const { quote, coupon, voucher } = quoteResult

    const referralInfluencer = await resolveReferral(req.body?.referral?.visitorId)
    const { influencer, attribution } = chooseAttribution({ coupon, referralInfluencer })

    // Reserve voucher packages atomically before charging.
    let voucherUsed = 0
    if (voucher && quote.voucherPackagesUsed > 0) {
      voucherUsed = unwrap(
        await db.rpc('redeem_gift_voucher', { p_voucher_id: voucher.id, p_packages: quote.voucherPackagesUsed }),
      )
      if (voucherUsed !== quote.voucherPackagesUsed) {
        await revertVoucher(voucher.id, voucherUsed)
        throw new HttpError(409, 'השובר עודכן בינתיים — רעננו את העמוד ונסו שוב')
      }
    }

    let payment
    try {
      payment = await charge({
        amount: quote.total,
        description: `Petite Dreams — ${rooms.length} room package(s)`,
        customerEmail: user.email,
      })
    } catch (err) {
      await revertVoucher(voucher?.id, voucherUsed)
      throw err
    }

    const commissionPercent = influencer ? Number(influencer.commission_percent) : 0
    const order = unwrap(
      await db
        .from('orders')
        .insert({
          user_id: user.id,
          email: user.email,
          kind: 'packages',
          status: 'paid',
          subtotal: quote.subtotal,
          discount_total: quote.discountTotal,
          total: quote.total,
          payment_option: req.body?.paymentOption === 'installments' ? 'installments' : 'full',
          payment_provider: payment.provider,
          payment_reference: payment.reference,
          coupon_id: quote.couponApplied ? coupon.id : null,
          coupon_code: quote.couponApplied ? coupon.code : '',
          coupon_percent: quote.couponApplied ? Number(coupon.discount_percent) : 0,
          influencer_id: influencer?.id ?? null,
          attribution,
          commission_percent: commissionPercent,
          commission_amount: commissionFor(quote.total, commissionPercent),
          voucher_id: voucherUsed > 0 ? voucher.id : null,
          voucher_packages_used: voucherUsed,
        })
        .select('*')
        .single(),
    )

    if (voucherUsed > 0) {
      unwrap(
        await db.from('voucher_redemptions').insert({
          voucher_id: voucher.id,
          order_id: order.id,
          user_id: user.id,
          packages_used: voucherUsed,
        }),
      )
    }

    const snapshots = await packageSnapshots(rooms)
    const items = []
    const profileEntries = []
    for (let index = 0; index < rooms.length; index += 1) {
      const room = rooms[index]
      const line = quote.lines[index]
      const savedRoom = await upsertRoom(user.id, room)

      // A new package for a room that already has one replaces it; the old one moves to the archive.
      const previous = savedRoom.existed
        ? unwrap(
            await db
              .from('order_items')
              .select('id')
              .eq('room_id', savedRoom.id)
              .is('archived_at', null),
          )
        : []

      const item = unwrap(
        await db
          .from('order_items')
          .insert({
            order_id: order.id,
            user_id: user.id,
            room_id: savedRoom.id,
            package_id: room.packageId,
            package_name: room.packageName,
            theme: room.theme,
            age_group: room.ageGroup,
            design_gender: room.designGender,
            color_preference: room.colorPreference,
            wall_design_option: room.wallDesignOption,
            children: room.children,
            package_snapshot: snapshots[index],
            list_price: line.listPrice,
            discount_type: line.discountType,
            discount_amount: line.discountAmount,
            price: line.price,
            paid_by_voucher: line.paidByVoucher,
            is_upgrade: previous.length > 0,
          })
          .select('*')
          .single(),
      )
      items.push(item)

      if (previous.length > 0) {
        unwrap(
          await db
            .from('order_items')
            .update({ archived_at: new Date().toISOString(), replaced_by_item_id: item.id })
            .in(
              'id',
              previous.map((p) => p.id),
            ),
        )
      }

      profileEntries.push({
        name: room.displayName || room.children.map((c) => c.name).join(' ו'),
        age: room.designAge,
        gender: room.designGender,
        theme: room.theme,
        colorPreference: room.colorPreference,
        packageId: room.packageId,
        roomId: savedRoom.id,
        orderItemId: item.id,
        roomChildren: room.children,
        replacesRoom: savedRoom.existed,
      })
    }

    await recordOnProfile(user.id, profileEntries)

    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.slice(0, 100) : ''
    if (sessionId) {
      await db.from('questionnaire_events').insert({ session_id: sessionId, user_id: user.id, event: 'purchase' })
    }

    try {
      const email = orderConfirmationEmail({ order, items })
      await sendEmail({ to: user.email, ...email })
    } catch (err) {
      console.error('[orders] confirmation email failed', err)
    }

    res.status(201).json({
      order: {
        id: order.id,
        orderNumber: order.order_number,
        total: Number(order.total),
        discountTotal: Number(order.discount_total),
        voucherPackagesUsed: voucherUsed,
      },
      items: items.map((item) => ({ id: item.id, roomId: item.room_id, packageId: item.package_id })),
    })
  }),
)

export { revertVoucher }
export default router
