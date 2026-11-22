import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteOrder, defaultVoucherPrice, commissionFor } from '../src/lib/pricing.js'

test('single room pays full price', () => {
  const q = quoteOrder({ roomCount: 1, roomPrice: 660 })
  assert.equal(q.total, 660)
  assert.equal(q.discountTotal, 0)
})

test('extra rooms get 20% off', () => {
  const q = quoteOrder({ roomCount: 3, roomPrice: 660 })
  assert.deepEqual(q.lines.map((l) => l.price), [660, 528, 528])
  assert.deepEqual(q.lines.map((l) => l.discountType), ['', 'sibling', 'sibling'])
  assert.equal(q.total, 1716)
})

test('coupon never stacks with the extra-room discount — best one wins', () => {
  const small = quoteOrder({ roomCount: 2, roomPrice: 660, couponPercent: 15 })
  assert.deepEqual(small.lines.map((l) => l.price), [561, 528])
  assert.deepEqual(small.lines.map((l) => l.discountType), ['coupon', 'sibling'])

  const big = quoteOrder({ roomCount: 2, roomPrice: 660, couponPercent: 30 })
  assert.deepEqual(big.lines.map((l) => l.price), [462, 462])
  assert.ok(big.couponApplied)
})

test('voucher pays for the most expensive rooms first', () => {
  const q = quoteOrder({ roomCount: 3, roomPrice: 660, voucherPackages: 1 })
  assert.equal(q.lines[0].paidByVoucher, true)
  assert.equal(q.voucherPackagesUsed, 1)
  assert.equal(q.total, 1056)
})

test('voucher larger than the order only uses what is needed', () => {
  const q = quoteOrder({ roomCount: 2, roomPrice: 660, voucherPackages: 3 })
  assert.equal(q.voucherPackagesUsed, 2)
  assert.equal(q.total, 0)
})

test('voucher + coupon: coupon applies only to the paid rooms', () => {
  const q = quoteOrder({ roomCount: 2, roomPrice: 660, voucherPackages: 1, couponPercent: 10 })
  assert.deepEqual(q.lines.map((l) => l.discountType), ['voucher', 'sibling'])
  assert.equal(q.total, 528)
})

test('voucher default price matches buying that many rooms', () => {
  assert.equal(defaultVoucherPrice(1, 660), 660)
  assert.equal(defaultVoucherPrice(3, 660), 1716)
})

test('commission is a percent of the amount actually paid', () => {
  assert.equal(commissionFor(561, 10), 56.1)
  assert.equal(commissionFor(0, 10), 0)
})
