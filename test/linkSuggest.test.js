import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isGenericName,
  nameSimilarity,
  parseAliExpressSearch,
  normalizeName,
  sameItemElsewhere,
  themeOfPackage,
  urlVariants,
} from '../src/lib/linkSuggest.js'

const broken = { package_id: 'animals-boy-fresh-greens', category: 'אלמנטים', item_name: 'פוסטרים', url: 'https://a/old' }
const working = (overrides) => ({
  package_id: 'animals-girl-soft-pinks',
  category: 'אלמנטים',
  item_name: 'פוסטרים',
  url: 'https://a/new',
  package_name: 'חיות בנות',
  ...overrides,
})

test('a working copy of the same item in the same theme is suggested', () => {
  const matches = sameItemElsewhere([working()], broken)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].url, 'https://a/new')
})

test('other themes, other categories and generic names are never suggested', () => {
  assert.equal(sameItemElsewhere([working({ package_id: 'safari-boy-0-2-warm-natural' })], broken).length, 0)
  assert.equal(sameItemElsewhere([working({ category: 'ריהוט' })], broken).length, 0)
  assert.equal(sameItemElsewhere([working({ item_name: 'פריט לרכישה' })], { ...broken, item_name: 'פריט לרכישה' }).length, 0)
  assert.equal(sameItemElsewhere([working({ url: broken.url })], broken).length, 0)
})

test('generic item names never justify a match', () => {
  assert.equal(isGenericName('פריט לרכישה'), true)
  assert.equal(isGenericName('כרית'), true)
  assert.equal(isGenericName('שטיח עגול ספארי'), false)
})

test('the theme of a package is the part before the gender', () => {
  assert.equal(themeOfPackage('safari-boy-0-2-warm-natural'), 'safari')
  assert.equal(themeOfPackage('animals-girl-happy-colorful'), 'animals')
  assert.equal(themeOfPackage('junior-superheroes-boy-3-5-calming-blues'), 'junior-superheroes')
})

test('names are compared ignoring case and punctuation', () => {
  assert.equal(normalizeName('  Wooden Toy-Box! '), 'wooden toy box')
  assert.equal(nameSimilarity('שטיח ספארי', 'שטיח  ספארי!'), 1)
})

test('similar names score high and unrelated names score zero', () => {
  assert.ok(nameSimilarity('שטיח עגול ספארי לילדים', 'שטיח עגול ספארי') >= 0.6)
  assert.equal(nameSimilarity('שטיח עגול', 'מנורת לילה'), 0)
  assert.equal(nameSimilarity('', 'מנורת לילה'), 0)
})

test('an AliExpress link is also offered in its canonical form', () => {
  const variants = urlVariants('http://he.aliexpress.com/item/1005006383594034.html?spm=a2g0o.cart&gatewayAdapt=glo2isr')
  assert.ok(variants.includes('https://www.aliexpress.com/item/1005006383594034.html'))
  assert.ok(!variants.some((url) => url.includes('spm=')))
})

test('a link that is already clean has no variants besides www', () => {
  const variants = urlVariants('https://example.com/product/lamp')
  assert.deepEqual(variants, ['https://www.example.com/product/lamp'])
  assert.deepEqual(urlVariants('not a url'), [])
})

test('a subdomain never gets an extra www', () => {
  assert.ok(!urlVariants('https://he.aliexpress.com/item/1005006383594034.html').some((url) => url.includes('www.he.')))
})

test('numbered pieces of the same set are not treated as the same item', () => {
  const check = { package_id: 'animals-boy-fresh-greens', category: 'x', item_name: '\u05d3\u05e7\u05d5\u05e8\u05e6\u05d9\u05d4 5 \u05dc\u05de\u05d3\u05e3 \u05e0\u05d5\u05e9\u05d0\u05d9\u05ea', url: 'https://a/old' }
  const row = { package_id: 'animals-girl-soft-pinks', category: 'x', item_name: '\u05d3\u05e7\u05d5\u05e8\u05e6\u05d9\u05d4 7 \u05dc\u05de\u05d3\u05e3 \u05e0\u05d5\u05e9\u05d0\u05d9\u05ea', url: 'https://a/new', package_name: 'p' }
  assert.equal(sameItemElsewhere([row], check).length, 0)
  assert.equal(sameItemElsewhere([{ ...row, item_name: check.item_name }], check).length, 1)
})

test('AliExpress search page is parsed into item urls and titles', () => {
  const html = '..."productId":"3256813317013366","x":1,"displayTitle":"Basket A \\u0026 B"...,"productId":"3256813432875057","displayTitle":"Basket C"'
  const hits = parseAliExpressSearch(html)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].url, 'https://www.aliexpress.com/item/3256813317013366.html')
  assert.equal(hits[0].title, 'Basket A & B')
})
