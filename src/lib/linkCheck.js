import { getAdmin, unwrap, fetchAll } from './supabaseAdmin.js'
import { fetchHtmlViaScrapingBee, isBlockedHtml } from '../scraperFetch.js'
import { escapeHtml, layout, sendEmail, siteUrl, button } from './email.js'

/**
 * Weekly product link monitor.
 *
 * Supplier sites (mostly AliExpress) often block automated requests, so a link
 * is reported broken only on a clear signal — 404/410, a "product not available"
 * page, or a redirect away from the product — and only when a second check a
 * few seconds later agrees. Blocks, captchas and timeouts are "unverified",
 * never "broken", so the admin is not flooded with false alarms.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15000
const RECHECK_DELAY_MS = 3000
const CONCURRENCY = 6
export const RUN_INTERVAL_DAYS = 7

const REMOVED_PATTERNS = [
  /this (item|product) is no longer available/i,
  /sorry, this (item|product)/i,
  /item[_-]?not[_-]?found/i,
  /product[_-]?not[_-]?found/i,
  /"(?:isOffline|itemOffline|offline)"\s*:\s*true/i,
  /המוצר (?:אינו|לא) זמין/,
  /הפריט (?:אינו|לא) זמין/,
  /page not found/i,
]

const ERROR_URL_PATTERNS = [/\/error\//i, /404/, /item-not-found/i, /notfound/i]

const PRODUCT_ID_RE = /\/item\/(\d+)\.html/i

export function classifyResponse({ status, finalUrl, originalUrl, html }) {
  if (status === 404 || status === 410) return { status: 'broken', problem: `השרת החזיר שגיאה ${status}` }
  if (status === 403 || status === 429) return { status: 'unverified', problem: 'האתר חסם בדיקה אוטומטית' }
  if (status >= 500) return { status: 'unverified', problem: `שגיאת שרת זמנית (${status})` }
  if (status >= 400) return { status: 'broken', problem: `השרת החזיר שגיאה ${status}` }

  if (finalUrl && ERROR_URL_PATTERNS.some((re) => re.test(new URL(finalUrl).pathname))) {
    return { status: 'broken', problem: 'הקישור מפנה לעמוד שגיאה' }
  }

  const originalId = originalUrl?.match(PRODUCT_ID_RE)?.[1]
  const finalId = finalUrl?.match(PRODUCT_ID_RE)?.[1]
  if (originalId && finalUrl && !finalId) {
    try {
      const path = new URL(finalUrl).pathname
      if (path === '/' || path === '') return { status: 'broken', problem: 'הקישור מפנה לדף הבית — המוצר הוסר' }
    } catch {
      // ignore unparsable redirect targets
    }
  }

  if (html) {
    // AliExpress ships its whole translation table (including "item is not
    // available" messages) inside every page, so strip it before matching.
    const page = html.replace(/"i18nMap"\s*:\s*\{[^}]*\}/g, '')
    if (originalId) {
      const ogTitle = page.match(/property=["']og:title["']\s+content=["']([^"']*)["']/i)
      // A live product page always has a title; a removed one has an empty one.
      if (ogTitle && ogTitle[1].trim()) return { status: 'ok', problem: '' }
      if (ogTitle && !isBlockedHtml(page)) {
        return { status: 'broken', problem: 'המוצר אינו זמין יותר אצל הספק' }
      }
    }
    if (REMOVED_PATTERNS.some((re) => re.test(page))) {
      return { status: 'broken', problem: 'המוצר אינו זמין יותר אצל הספק' }
    }
    if (isBlockedHtml(page)) return { status: 'unverified', problem: 'האתר חסם בדיקה אוטומטית' }
  }

  return { status: 'ok', problem: '' }
}

async function checkOnce(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const html = response.ok ? (await response.text()).slice(0, 600000) : ''
    let result = classifyResponse({ status: response.status, finalUrl: response.url, originalUrl: url, html })

    // A blocked page tells us nothing — try the scraping proxy when configured.
    if (result.status === 'unverified' && process.env.SCRAPINGBEE_API_KEY) {
      const proxied = await fetchHtmlViaScrapingBee(url)
      if (proxied) result = classifyResponse({ status: 200, finalUrl: url, originalUrl: url, html: proxied })
    }
    return { ...result, httpStatus: response.status }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return {
      status: 'unverified',
      problem: timedOut ? 'הבדיקה לא הסתיימה בזמן' : 'לא הצלחנו להתחבר לאתר הספק',
      httpStatus: null,
    }
  }
}

/** Checks a link, and re-checks before ever calling it broken. */
export async function checkLink(url, { delay = RECHECK_DELAY_MS } = {}) {
  const first = await checkOnce(url)
  if (first.status !== 'broken') return first
  await new Promise((resolve) => setTimeout(resolve, delay))
  const second = await checkOnce(url)
  return second.status === 'broken' ? second : { ...second, status: second.status === 'ok' ? 'ok' : 'unverified' }
}

/** Every shopping-list link in the published packages, one row per package + url. */
export async function collectLinks() {
  const packages = await fetchAll('app_packages', (q) => q.select('id, data').order('sort_order'))
  const links = new Map()
  for (const row of packages) {
    const pkg = row.data || {}
    for (const category of pkg.shoppingCategories || []) {
      for (const item of category.items || []) {
        const url = String(item.link || '').trim()
        if (!/^https?:\/\//i.test(url) || item.hidden) continue
        const key = `${row.id}::${url}`
        if (!links.has(key)) {
          links.set(key, {
            package_id: row.id,
            package_name: pkg.name || row.id,
            category: category.category || '',
            item_name: item.name || '',
            url,
          })
        }
      }
    }
  }
  return [...links.values()]
}

/** Syncs the link table with the current packages (adds new links, drops removed ones). */
export async function syncLinks() {
  const db = getAdmin()
  const current = await collectLinks()
  const existing = await fetchAll('product_link_checks', (q) => q.select('id, package_id, url'))
  const currentKeys = new Set(current.map((l) => `${l.package_id}::${l.url}`))

  for (let i = 0; i < current.length; i += 500) {
    unwrap(
      await db
        .from('product_link_checks')
        .upsert(current.slice(i, i + 500), { onConflict: 'package_id,url', ignoreDuplicates: false }),
    )
  }
  const stale = existing.filter((row) => !currentKeys.has(`${row.package_id}::${row.url}`)).map((row) => row.id)
  for (let i = 0; i < stale.length; i += 200) {
    unwrap(await db.from('product_link_checks').delete().in('id', stale.slice(i, i + 200)))
  }
  return current.length
}

function firstFailedAt(row, result, now) {
  if (result.status === 'broken') return row.first_failed_at || now
  // An inconclusive check never clears a known break.
  if (result.status === 'unverified' && row.status === 'broken') return row.first_failed_at
  return null
}

async function activeRun() {
  return unwrap(
    await getAdmin()
      .from('link_check_runs')
      .select('*')
      .is('finished_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
}

export async function lastFinishedRun() {
  return unwrap(
    await getAdmin()
      .from('link_check_runs')
      .select('*')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
}

export async function startRun(trigger) {
  const existing = await activeRun()
  if (existing) return existing
  const total = await syncLinks()
  return unwrap(
    await getAdmin()
      .from('link_check_runs')
      .insert({ trigger, total_links: total })
      .select('*')
      .single(),
  )
}

/**
 * Checks the links of a run that were not checked since it started, within a
 * time budget so it fits one serverless invocation. Call again until done.
 * Each unique URL is fetched once even when several packages share it.
 */
export async function processRun(run, { budgetMs = 45000 } = {}) {
  const db = getAdmin()
  const deadline = Date.now() + budgetMs
  const pending = await fetchAll('product_link_checks', (q) =>
    q.select('*').or(pendingFilter(run)),
  )

  const byUrl = new Map()
  for (const row of pending) {
    if (!byUrl.has(row.url)) byUrl.set(row.url, [])
    byUrl.get(row.url).push(row)
  }
  const urls = [...byUrl.keys()]
  let cursor = 0

  async function worker() {
    while (cursor < urls.length && Date.now() < deadline) {
      const url = urls[cursor]
      cursor += 1
      const result = await checkLink(url)
      const now = new Date().toISOString()
      for (const row of byUrl.get(url)) {
        const failures = result.status === 'broken' ? row.consecutive_failures + 1 : 0
        unwrap(
          await db
            .from('product_link_checks')
            .update({
              status: result.status === 'unverified' && row.status === 'broken' ? 'broken' : result.status,
              http_status: result.httpStatus,
              problem: result.problem,
              consecutive_failures: failures,
              first_failed_at: firstFailedAt(row, result, now),
              handled_at: result.status === 'ok' ? null : row.handled_at,
              last_checked_at: now,
            })
            .eq('id', row.id),
        )
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker))

  const remaining = urls.length - cursor
  const counts = await linkCounts()
  const patch = {
    checked_links: run.total_links - (await countPending(run)),
    ok_count: counts.ok,
    broken_count: counts.broken,
    unverified_count: counts.unverified,
  }
  if (remaining === 0) patch.finished_at = new Date().toISOString()
  const updated = unwrap(await db.from('link_check_runs').update(patch).eq('id', run.id).select('*').single())
  return { run: updated, remaining }
}

function pendingFilter(run) {
  const since = new Date(run.started_at).toISOString()
  return `last_checked_at.is.null,last_checked_at.lt."${since}"`
}

async function countPending(run) {
  const { count, error } = await getAdmin()
    .from('product_link_checks')
    .select('id', { count: 'exact', head: true })
    .or(pendingFilter(run))
  if (error) throw error
  return count || 0
}

export async function linkCounts() {
  const rows = await fetchAll('product_link_checks', (q) => q.select('status'))
  const counts = { ok: 0, broken: 0, unverified: 0, total: rows.length }
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1
  return counts
}

export async function sendLinkReport(run) {
  const broken = await fetchAll('product_link_checks', (q) =>
    q.select('*').eq('status', 'broken').order('package_name'),
  )
  const to = (process.env.ADMIN_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (to.length === 0) return { sent: false, reason: 'ADMIN_EMAIL not set' }

  const rows = broken
    .map(
      (row) => `<tr>
<td style="padding:6px;border-bottom:1px solid #EEE;">${escapeHtml(row.package_name)}</td>
<td style="padding:6px;border-bottom:1px solid #EEE;">${escapeHtml(row.category)}</td>
<td style="padding:6px;border-bottom:1px solid #EEE;">${escapeHtml(row.item_name)}</td>
<td style="padding:6px;border-bottom:1px solid #EEE;"><a href="${escapeHtml(row.url)}">קישור</a></td>
<td style="padding:6px;border-bottom:1px solid #EEE;">${escapeHtml(row.problem)}</td></tr>`,
    )
    .join('')

  const inner = `
<p style="font-size:20px;margin:0 0 12px;">דוח קישורים שבועי</p>
<p style="margin:0 0 12px;">נבדקו ${run.total_links} קישורים: ${run.ok_count} תקינים, ${run.broken_count} שבורים, ${run.unverified_count} שלא ניתן היה לאמת.</p>
${
  broken.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
<tr style="background:#F7F4EF;"><th style="padding:6px;text-align:right;">חבילה</th><th style="padding:6px;text-align:right;">קטגוריה</th><th style="padding:6px;text-align:right;">מוצר</th><th style="padding:6px;text-align:right;">קישור</th><th style="padding:6px;text-align:right;">תקלה</th></tr>
${rows}</table>`
    : '<p>לא נמצאו קישורים שבורים השבוע 🎉</p>'
}
${button(`${siteUrl()}/admin?tab=links`, 'לניהול הקישורים')}`

  const result = await sendEmail({
    to,
    subject: broken.length ? `נמצאו ${broken.length} קישורים שבורים — Petite Dreams` : 'כל הקישורים תקינים — Petite Dreams',
    html: layout(inner),
    text: `נבדקו ${run.total_links} קישורים. שבורים: ${broken.length}. ${siteUrl()}/admin?tab=links`,
  })
  if (result.sent) {
    unwrap(
      await getAdmin().from('link_check_runs').update({ report_sent_at: new Date().toISOString() }).eq('id', run.id),
    )
  }
  return result
}

/**
 * Replaces a product link in a package (published data, and the draft when
 * there is one) and resets its check status.
 */
export async function replaceLinkInPackage(checkId, newUrl, { everywhere = false } = {}) {
  const db = getAdmin()
  const check = unwrap(await db.from('product_link_checks').select('*').eq('id', checkId).single())
  // The same product link is usually shared by many packages — fix them all in one go.
  const rows = everywhere
    ? unwrap(await db.from('product_link_checks').select('*').eq('url', check.url))
    : [check]
  const result = await checkLink(newUrl, { delay: 1000 })
  const now = new Date().toISOString()

  const swap = (pkg) => {
    if (!pkg) return pkg
    let changed = 0
    const shoppingCategories = (pkg.shoppingCategories || []).map((category) => ({
      ...category,
      items: (category.items || []).map((item) => {
        if (String(item.link || '').trim() !== check.url) return item
        changed += 1
        return { ...item, link: newUrl }
      }),
    }))
    return changed ? { ...pkg, shoppingCategories } : pkg
  }

  for (const row of rows) {
    const pkgRow = unwrap(await db.from('app_packages').select('*').eq('id', row.package_id).single())
    unwrap(
      await db
        .from('app_packages')
        .update({ data: swap(pkgRow.data), draft: swap(pkgRow.draft), updated_at: now })
        .eq('id', row.package_id),
    )

    unwrap(await db.from('product_link_checks').delete().eq('id', row.id))
    unwrap(
      await db.from('product_link_checks').upsert(
        {
          package_id: row.package_id,
          package_name: row.package_name,
          category: row.category,
          item_name: row.item_name,
          url: newUrl,
          status: result.status,
          http_status: result.httpStatus,
          problem: result.problem,
          last_checked_at: now,
        },
        { onConflict: 'package_id,url' },
      ),
    )
  }
  return { ...result, replaced: rows.length }
}
