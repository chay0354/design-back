import { createAdminClient } from '@supabase/server/core'

let adminClient = null

/** Secret-key client. Bypasses RLS — use only on the server, never expose the key. */
export function getAdmin() {
  if (!adminClient) adminClient = createAdminClient()
  return adminClient
}

/** Throws the Supabase error so route handlers return a 500 with its message. */
export function unwrap({ data, error }) {
  if (error) throw error
  return data
}

/**
 * Reads every row of a query, past PostgREST's 1000 row page limit.
 * `build` gets a fresh query builder each call, e.g. (q) => q.select('*').gte(...)
 */
export async function fetchAll(table, build, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const query = build(getAdmin().from(table)).range(from, from + pageSize - 1)
    const page = unwrap(await query)
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}
