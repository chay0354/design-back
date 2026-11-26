import { fetchAll, getAdmin, unwrap } from './supabaseAdmin.js'
import { checkLink, replaceLinkInPackage } from './linkCheck.js'
import { fetchHtmlViaScrapingBee } from '../scraperFetch.js'

/**
 * Finds a working replacement for a broken product link.
 *
 * Sources, best first:
 *  1. a cleaned-up form of the same link (tracking removed, https, canonical AliExpress item URL) —
 *     the very same product, so it can be applied automatically,
 *  2. the same item that still works in another package of the same theme,
 *  3. a web search for the item on the supplier's site (needs SCRAPINGBEE_API_KEY).
 *
 * Every suggestion is checked before it is offered. Only (1) is ever applied without the admin's choice,
 * because (2) and (3) can be a different color or model of the item.
 */

const PRODUCT_ID_RE = /\/item\/(\d+)\.html/i
const SCRAPINGBEE_GOOGLE = 'https://app.scrapingbee.com/api/v1/store/google'
const MAX_WEB_RESULTS = 5
const MIN_NAME_SIMILARITY = 0.6
const GENERIC_NAMES = new Set(['פריט לרכישה', 'פריט', 'מוצר', 'פריט חדש', 'דקורציה', 'item', 'product'])

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(name) {
  return new Set(normalizeName(name).split(' ').filter((token) => token.length > 1))
}

/** Names like "פריט לרכישה" say nothing about the product, so they never justify a match. */
export function isGenericName(name) {
  const normalized = normalizeName(name)
  return !normalized || GENERIC_NAMES.has(normalized) || tokens(name).size < 2
}

/** 1 for identical names, otherwise the share of words the two names have in common. */
export function nameSimilarity(a, b) {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const first = tokens(a)
  const second = tokens(b)
  if (first.size === 0 || second.size === 0) return 0
  let shared = 0
  for (const token of first) if (second.has(token)) shared += 1
  return shared / (first.size + second.size - shared)
}

/** "safari-boy-0-2-warm-natural" and "animals-boy-warm-natural" both belong to the theme before the gender. */
export function themeOfPackage(packageId) {
  return String(packageId || '').match(/^(.+?)-(?:boy|girl|unisex)-/)?.[1] || String(packageId || '')
}

/** Cleaned-up forms of a link that often still work when the original stopped. */
export function urlVariants(url) {
  const variants = new Set()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return []
  }

  const itemId = url.match(PRODUCT_ID_RE)?.[1]
  if (itemId && /aliexpress\./i.test(parsed.hostname)) {
    variants.add(`https://www.aliexpress.com/item/${itemId}.html`)
    variants.add(`https://he.aliexpress.com/item/${itemId}.html`)
  }

  const clean = new URL(parsed)
  clean.search = ''
  clean.hash = ''
  clean.protocol = 'https:'
  variants.add(clean.toString())

  // "example.com" → "www.example.com", but never "www.he.aliexpress.com".
  if (parsed.hostname.split('.').length === 2) {
    const withWww = new URL(clean)
    withWww.hostname = `www.${parsed.hostname}`
    variants.add(withWww.toString())
  }

  variants.delete(url)
  return [...variants]
}

function baseHost(hostname) {
  const parts = hostname.replace(/^www\./, '').split('.')
  return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.')
}

/** Product ids and titles from an AliExpress search results page. */
export function parseAliExpressSearch(html) {
  const found = []
  const seen = new Set()
  for (const chunk of String(html || '').split('"productId":').slice(1)) {
    const id = chunk.match(/^"?(\d{10,})/)?.[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    // The 3256… form of an id is the same product as 1005… — both open the item page.
    const title = chunk.slice(0, 4000).match(/"displayTitle":"((?:[^"\\]|\\.)*)"/)?.[1] || ''
    found.push({ url: `https://www.aliexpress.com/item/${id}.html`, title: title.replace(/\\u0026/g, '&') })
    if (found.length >= MAX_WEB_RESULTS) break
  }
  return found
}

/** AliExpress search page through the scraping proxy (Google rarely lists product pages for Hebrew terms). */
async function searchAliExpress(query) {
  const html = await fetchHtmlViaScrapingBee(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(query)}.html`)
  return html ? parseAliExpressSearch(html) : []
}

async function searchSupplier({ query, url }) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY
  if (!apiKey || !query) return []

  let host
  try {
    host = baseHost(new URL(url).hostname)
  } catch {
    return []
  }

  if (host === 'aliexpress.com') {
    const direct = await searchAliExpress(query)
    if (direct.length) return direct
  }

  const endpoint = new URL(SCRAPINGBEE_GOOGLE)
  endpoint.searchParams.set('api_key', apiKey)
  endpoint.searchParams.set('search', `${query} site:${host}`)
  endpoint.searchParams.set('nb_results', '10')

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) return []
    const body = await response.json()
    const results = Array.isArray(body?.organic_results) ? body.organic_results : []
    const found = []
    for (const entry of results) {
      const link = String(entry?.url || entry?.link || '')
      let parsed
      try {
        parsed = new URL(link)
      } catch {
        continue
      }
      if (baseHost(parsed.hostname) !== host) continue
      // On AliExpress only a real product page is useful.
      if (host === 'aliexpress.com') {
        const id = link.match(PRODUCT_ID_RE)?.[1]
        if (!id) continue
        found.push({ url: `https://www.aliexpress.com/item/${id}.html`, title: String(entry?.title || '') })
      } else {
        parsed.search = ''
        parsed.hash = ''
        found.push({ url: parsed.toString(), title: String(entry?.title || '') })
      }
      if (found.length >= MAX_WEB_RESULTS) break
    }
    return found
  } catch {
    return []
  }
}

function numbersOf(name) {
  return (String(name || '').match(/\d+/g) || []).join(',')
}

async function workingRows() {
  return fetchAll('product_link_checks', (q) =>
    q.select('package_id, category, item_name, url, package_name').eq('status', 'ok'),
  )
}

/**
 * The same item, still working in another package of the same theme. Generic names never match,
 * and a one-word name ("פוסטרים") must also sit in the same shopping category.
 */
export function sameItemElsewhere(rows, check) {
  const normalized = normalizeName(check.item_name)
  if (!normalized || GENERIC_NAMES.has(normalized)) return []
  const oneWord = tokens(check.item_name).size < 2
  const theme = themeOfPackage(check.package_id)
  const byUrl = new Map()
  for (const row of rows) {
    if (row.url === check.url) continue
    if (themeOfPackage(row.package_id) !== theme) continue
    if (oneWord && row.category !== check.category) continue
    // "דקורציה 5" and "דקורציה 7" are different pieces, not the same item.
    if (numbersOf(check.item_name) !== numbersOf(row.item_name)) continue
    const score = nameSimilarity(check.item_name, row.item_name)
    if (score < MIN_NAME_SIMILARITY) continue
    const known = byUrl.get(row.url)
    if (!known || score > known.score) {
      byUrl.set(row.url, { url: row.url, score, itemName: row.item_name, packageName: row.package_name })
    }
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score)
}

/** Item note from the package itself — extra words for the supplier search. */
async function itemNotes(check) {
  const row = await getAdmin().from('app_packages').select('data').eq('id', check.package_id).maybeSingle()
  const categories = row.data?.data?.shoppingCategories || []
  for (const category of categories) {
    for (const item of category.items || []) {
      if (String(item.link || '').trim() === check.url) return String(item.notes || '')
    }
  }
  return ''
}

/** Working replacement links for one broken link row. */
export async function suggestReplacements(checkId) {
  const db = getAdmin()
  const check = unwrap(await db.from('product_link_checks').select('*').eq('id', checkId).single())
  const suggestions = []
  const seen = new Set([check.url])
  const push = (entry) => {
    if (seen.has(entry.url)) return
    seen.add(entry.url)
    suggestions.push(entry)
  }

  const notes = await itemNotes(check)
  const query = [isGenericName(check.item_name) ? '' : check.item_name, notes, isGenericName(check.item_name) ? check.category : '']
    .join(' ')
    .trim()

  const candidates = [
    ...urlVariants(check.url).map((url) => ({
      url,
      source: 'variant',
      sourceLabel: 'אותו מוצר — ניסוח נקי של הקישור',
      title: '',
    })),
    ...(await searchSupplier({ query, url: check.url })).map((hit) => ({
      url: hit.url,
      source: 'search',
      sourceLabel: 'תוצאה מחיפוש באתר הספק — כדאי לוודא שזה אותו פריט',
      title: hit.title,
    })),
  ]

  const checked = await Promise.all(
    candidates.map(async (candidate) => ({ candidate, result: await checkLink(candidate.url, { delay: 800 }) })),
  )
  for (const { candidate, result } of checked) {
    // The original is known to be broken, so a variant is only worth offering once it really opens.
    if (candidate.source !== 'variant' || result.status !== 'ok') continue
    push({ ...candidate, verified: true })
  }

  for (const match of sameItemElsewhere(await workingRows(), check).slice(0, 3)) {
    push({
      url: match.url,
      source: 'other-package',
      sourceLabel: `אותו פריט בחבילה "${match.packageName}" — ייתכן שונה בצבע`,
      title: match.itemName,
      verified: true,
    })
  }

  for (const { candidate, result } of checked) {
    if (candidate.source !== 'search' || result.status === 'broken') continue
    push({ ...candidate, verified: result.status === 'ok' })
  }

  return suggestions
}

/**
 * Replaces broken links with a cleaned-up form of the same link that opens.
 * Same product, so it is safe to apply on its own; anything else is left for the admin to choose.
 * Call again with the returned `attempted` urls as `exclude` until `remaining` is 0.
 */
export async function autoFixBrokenLinks({ exclude = [], budgetMs = 80000 } = {}) {
  const deadline = Date.now() + budgetMs
  const skip = new Set(exclude)
  const broken = await fetchAll('product_link_checks', (q) => q.select('*').eq('status', 'broken'))
  const groups = new Map()
  for (const row of broken) {
    if (skip.has(row.url)) continue
    if (!groups.has(row.url)) groups.set(row.url, row)
  }

  const attempted = []
  const fixed = []
  const urls = [...groups.keys()]
  let cursor = 0

  while (cursor < urls.length && Date.now() < deadline) {
    const url = urls[cursor]
    cursor += 1
    attempted.push(url)
    const row = groups.get(url)

    let working = null
    for (const variant of urlVariants(url)) {
      const result = await checkLink(variant, { delay: 800 })
      if (result.status === 'ok') {
        working = variant
        break
      }
    }
    if (!working) continue

    const result = await replaceLinkInPackage(row.id, working, { everywhere: true })
    if (result.status === 'ok') fixed.push({ from: url, to: working, itemName: row.item_name, packages: result.replaced })
  }

  return { fixed, attempted, remaining: urls.length - cursor }
}
