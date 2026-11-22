import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseAttribution } from '../src/lib/commerce.js'

const maya = { id: 'maya', active: true }
const noa = { id: 'noa', active: true }

test('influencer coupon wins over a referral link — counted once', () => {
  const r = chooseAttribution({ coupon: { influencer_id: 'maya', influencer: maya }, referralInfluencer: noa })
  assert.equal(r.influencer.id, 'maya')
  assert.equal(r.attribution, 'coupon')
})

test('general coupon keeps the referral link attribution', () => {
  const r = chooseAttribution({ coupon: { influencer_id: null }, referralInfluencer: noa })
  assert.equal(r.influencer.id, 'noa')
  assert.equal(r.attribution, 'link')
})

test('no coupon and no link — no attribution', () => {
  assert.deepEqual(chooseAttribution({ coupon: null, referralInfluencer: null }), { influencer: null, attribution: '' })
})
