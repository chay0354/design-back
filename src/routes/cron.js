import { Router } from 'express'
import { route } from '../lib/http.js'
import { lastFinishedRun, processRun, sendLinkReport, startRun, RUN_INTERVAL_DAYS } from '../lib/linkCheck.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { siteUrl } from '../lib/email.js'

const router = Router()

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
function authorized(req) {
  const secret = process.env.CRON_SECRET
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`
}

/**
 * Runs daily. Starts a new link check once a week and keeps going until all
 * links are checked (chaining itself when one invocation is not enough),
 * then emails the report.
 */
router.get(
  '/link-check',
  route(async (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const active = unwrap(
      await getAdmin().from('link_check_runs').select('*').is('finished_at', null).limit(1).maybeSingle(),
    )
    if (!active) {
      const last = await lastFinishedRun()
      const dueAt = last ? new Date(last.finished_at).getTime() + (RUN_INTERVAL_DAYS - 0.5) * 86400000 : 0
      if (Date.now() < dueAt) {
        res.json({ skipped: true, nextRunAfter: new Date(dueAt).toISOString() })
        return
      }
    }

    const run = active || (await startRun('cron'))
    const result = await processRun(run, { budgetMs: 45000 })

    if (result.remaining === 0) {
      const report = await sendLinkReport(result.run)
      res.json({ done: true, run: result.run, report })
      return
    }

    // Not finished: trigger the next batch as a separate invocation.
    const next = `${process.env.SELF_URL || siteUrl() + '/api'}/cron/link-check`.replace(/\/api\/api\//, '/api/')
    fetch(next, {
      headers: { Authorization: req.headers.authorization },
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 500))
    res.json({ done: false, remaining: result.remaining })
  }),
)

export default router
