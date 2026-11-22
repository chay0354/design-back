import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyResponse } from '../src/lib/linkCheck.js'

const item = 'https://he.aliexpress.com/item/1005006383594034.html'
const bigPage = (extra = '') => `<html>${'x'.repeat(9000)}${extra}</html>`

test('404 and 410 are broken', () => {
  assert.equal(classifyResponse({ status: 404, finalUrl: item, originalUrl: item }).status, 'broken')
  assert.equal(classifyResponse({ status: 410, finalUrl: item, originalUrl: item }).status, 'broken')
})

test('blocks and server errors are unverified, never broken', () => {
  assert.equal(classifyResponse({ status: 403, finalUrl: item, originalUrl: item }).status, 'unverified')
  assert.equal(classifyResponse({ status: 429, finalUrl: item, originalUrl: item }).status, 'unverified')
  assert.equal(classifyResponse({ status: 503, finalUrl: item, originalUrl: item }).status, 'unverified')
  assert.equal(
    classifyResponse({ status: 200, finalUrl: item, originalUrl: item, html: '<html>captchaRecaptcha</html>' }).status,
    'unverified',
  )
})

test('removed product page is broken', () => {
  const r = classifyResponse({
    status: 200,
    finalUrl: item,
    originalUrl: item,
    html: bigPage('Sorry, this item is no longer available'),
  })
  assert.equal(r.status, 'broken')
})

test('redirect from a product to the home page is broken', () => {
  const r = classifyResponse({ status: 200, finalUrl: 'https://he.aliexpress.com/', originalUrl: item, html: bigPage() })
  assert.equal(r.status, 'broken')
})

test('normal product page is ok', () => {
  assert.equal(classifyResponse({ status: 200, finalUrl: item, originalUrl: item, html: bigPage() }).status, 'ok')
})
