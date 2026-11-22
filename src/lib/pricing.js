/**
 * Order pricing. The server is the only place prices are decided — the browser
 * shows a quote from here and can never send its own amounts.
 *
 * Rules:
 * - First room: full room price. Every additional room in the same order: 20% off.
 * - A new design for a room the customer already owns ("upgrade"): 20% off too.
 * - A gift voucher pays for whole packages, starting with the most expensive rooms.
 * - A coupon is never added on top of another discount: on each paid room the
 *   customer gets whichever is larger, the extra-room discount or the coupon.
 */

export const DEFAULT_ROOM_PRICE = 540
export const EXTRA_ROOM_DISCOUNT_PERCENT = 20

const round2 = (value) => Math.round(value * 100) / 100

export function listPriceForRoom(roomPrice, roomIndex) {
  return roomIndex === 0 ? roomPrice : Math.round(roomPrice * (1 - EXTRA_ROOM_DISCOUNT_PERCENT / 100))
}

/**
 * @param {object} input
 * @param {number} input.roomCount
 * @param {number} [input.roomPrice]
 * @param {number} [input.couponPercent]  0 when no coupon
 * @param {number} [input.voucherPackages] packages still available on the voucher
 * @param {number[]} [input.upgradeIndexes] rooms that replace a package the customer already owns
 */
export function quoteOrder({
  roomCount,
  roomPrice = DEFAULT_ROOM_PRICE,
  couponPercent = 0,
  voucherPackages = 0,
  upgradeIndexes = [],
}) {
  if (!Number.isInteger(roomCount) || roomCount < 1) throw new Error('roomCount must be a positive integer')
  const upgrades = new Set(upgradeIndexes)

  const items = Array.from({ length: roomCount }, (_, index) => {
    const fullPrice = roomPrice
    const upgrade = upgrades.has(index)
    const extraRoomPrice = listPriceForRoom(roomPrice, upgrade ? Math.max(1, index) : index)
    return { index, fullPrice, extraRoomPrice, upgrade }
  })

  // Vouchers cover whole packages; give the customer the most valuable rooms first.
  const voucherOrder = [...items].sort((a, b) => b.extraRoomPrice - a.extraRoomPrice)
  const coveredByVoucher = new Set(
    voucherOrder.slice(0, Math.max(0, Math.min(voucherPackages, roomCount))).map((item) => item.index),
  )

  const lines = items.map((item) => {
    if (coveredByVoucher.has(item.index)) {
      return {
        index: item.index,
        listPrice: item.fullPrice,
        discountType: 'voucher',
        discountAmount: item.fullPrice,
        price: 0,
        paidByVoucher: true,
      }
    }

    const couponPrice = couponPercent > 0 ? round2(item.fullPrice * (1 - couponPercent / 100)) : item.fullPrice
    const best = Math.min(couponPrice, item.extraRoomPrice)
    let discountType = ''
    if (best < item.fullPrice) {
      if (couponPercent > 0 && couponPrice <= item.extraRoomPrice) discountType = 'coupon'
      else discountType = item.upgrade ? 'upgrade' : 'sibling'
    }
    return {
      index: item.index,
      listPrice: item.fullPrice,
      discountType,
      discountAmount: round2(item.fullPrice - best),
      price: round2(best),
      paidByVoucher: false,
    }
  })

  const subtotal = round2(lines.reduce((sum, line) => sum + line.listPrice, 0))
  const total = round2(lines.reduce((sum, line) => sum + line.price, 0))
  const couponSavings = round2(
    lines.filter((line) => line.discountType === 'coupon').reduce((sum, line) => sum + line.discountAmount, 0),
  )

  return {
    lines,
    subtotal,
    discountTotal: round2(subtotal - total),
    total,
    couponApplied: couponPercent > 0 && lines.some((line) => line.discountType === 'coupon'),
    couponSavings,
    voucherPackagesUsed: coveredByVoucher.size,
  }
}

/** Default gift voucher price: same as buying that many rooms in one order. */
export function defaultVoucherPrice(packagesCount, roomPrice = DEFAULT_ROOM_PRICE) {
  let total = 0
  for (let i = 0; i < packagesCount; i += 1) total += listPriceForRoom(roomPrice, i)
  return total
}

export function commissionFor(total, commissionPercent) {
  return round2((Number(total) || 0) * ((Number(commissionPercent) || 0) / 100))
}
