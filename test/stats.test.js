import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, ageBucket } from '../src/lib/stats.js'

const from = new Date('2026-11-01T00:00:00Z')
const to = new Date('2026-11-08T00:00:00Z')

const orders = [
  { id: 'o1', user_id: 'u1', kind: 'packages', status: 'paid', total: 1188, coupon_id: null, voucher_packages_used: 0, created_at: '2026-11-02T10:00:00Z' },
  { id: 'o2', user_id: 'u1', kind: 'packages', status: 'paid', total: 660, coupon_id: 'c1', voucher_packages_used: 0, created_at: '2026-11-03T10:00:00Z' },
  { id: 'o3', user_id: 'u2', kind: 'packages', status: 'cancelled', total: 660, coupon_id: null, voucher_packages_used: 0, created_at: '2026-11-03T11:00:00Z' },
  { id: 'o4', user_id: 'u3', kind: 'gift_voucher', status: 'paid', total: 660, coupon_id: null, voucher_packages_used: 0, created_at: '2026-11-04T11:00:00Z' },
]
const items = [
  // one shared room: two children, one room
  { id: 'i1', order_id: 'o1', user_id: 'u1', room_id: 'r1', package_name: 'ספארי', theme: 'ספארי', color_preference: 'חמים', price: 660, discount_type: '', is_upgrade: false, children: [{ age: 2 }, { age: 4 }] },
  { id: 'i2', order_id: 'o1', user_id: 'u1', room_id: 'r2', package_name: 'חלל', theme: 'חלל', color_preference: 'כחול', price: 528, discount_type: 'sibling', is_upgrade: false, children: [{ age: 7 }] },
  { id: 'i3', order_id: 'o2', user_id: 'u1', room_id: 'r1', package_name: 'דינוזאורים', theme: 'דינוזאורים', color_preference: 'חמים', price: 660, discount_type: 'coupon', is_upgrade: true, children: [{ age: 2 }, { age: 4 }] },
  { id: 'i4', order_id: 'o3', user_id: 'u2', room_id: 'r3', package_name: 'ספארי', theme: 'ספארי', color_preference: 'חמים', price: 660, discount_type: '', is_upgrade: false, children: [{ age: 1 }] },
]

const result = aggregate({
  orders,
  items,
  priorOrders: [],
  submissions: [{ rooms: [{ theme: 'ספארי', ageGroup: '0-2', designGender: 'unisex', children: [{ age: 2, gender: 'boy' }, { age: 4, gender: 'girl' }] }] }],
  events: [
    { session_id: 's1', event: 'start' },
    { session_id: 's1', event: 'complete' },
    { session_id: 's1', event: 'cart' },
    { session_id: 's1', event: 'purchase' },
    { session_id: 's2', event: 'start' },
    { session_id: 's2', event: 'step', step_kind: 'theme', step_index: 4 },
  ],
  archivedItems: [{ id: 'i1' }],
  from,
  to,
  granularity: 'day',
})

test('cancelled orders are excluded', () => {
  assert.equal(result.sales.totalPurchases, 3)
  assert.equal(result.sales.revenue, 2508)
  assert.equal(result.sales.packagesSold, 3)
})

test('one customer with several purchases is one customer', () => {
  assert.equal(result.sales.uniqueBuyers, 2)
  assert.equal(result.rooms.returningCustomers, 1)
  assert.equal(result.sales.firstPackagePurchases, 1)
})

test('children and rooms are counted separately', () => {
  assert.equal(result.rooms.roomsPurchased, 2)
  assert.equal(result.rooms.sharedRooms, 2)
  assert.equal(result.children.childrenEntered, 2)
  assert.equal(result.children.childrenPurchased, 5)
})

test('discount and upgrade counters', () => {
  assert.equal(result.sales.multiRoomOrders, 1)
  assert.equal(result.sales.siblingDiscountOrders, 1)
  assert.equal(result.sales.upgradePurchases, 1)
  assert.equal(result.sales.upgradeRevenue, 660)
  assert.equal(result.rooms.familiesMultipleRooms, 1)
})

test('questionnaire funnel and drop-off', () => {
  assert.equal(result.questionnaire.started, 2)
  assert.equal(result.questionnaire.purchased, 1)
  assert.equal(result.questionnaire.conversionRate, 50)
  assert.deepEqual(result.questionnaire.dropOffSteps, [{ name: 'theme', count: 1 }])
})

test('series has one bucket per day', () => {
  assert.equal(result.series.length, 7)
  assert.equal(result.series[1].orders, 1)
})

test('age buckets', () => {
  assert.equal(ageBucket(2), '0-2')
  assert.equal(ageBucket(8), '6-8')
  assert.equal(ageBucket(12), '9-12')
  assert.equal(ageBucket(14), '13+')
})
