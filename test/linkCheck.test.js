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

const i18n = '"i18nMap":{"PAGE_NOT_FOUND_NOTICE":"\u05de\u05e6\u05d8\u05e2\u05e8\u05d9\u05dd, \u05d4\u05e4\u05e8\u05d9\u05d8 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df \u05db\u05e2\u05ea","X":"Sorry, this item is gone"}'

test('AliExpress i18n table does not make a live product look removed', () => {
  const html = bigPage(`<meta property="og:title" content="Kids shelf" />${i18n}`)
  assert.equal(classifyResponse({ status: 200, finalUrl: item, originalUrl: item, html }).status, 'ok')
})

test('AliExpress page with an empty og:title is a removed product', () => {
  const html = bigPage(`<meta property="og:title" content="" />${i18n}`)
  assert.equal(classifyResponse({ status: 200, finalUrl: item, originalUrl: item, html }).status, 'broken')
})
