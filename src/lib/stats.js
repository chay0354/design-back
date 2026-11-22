import { fetchAll } from './supabaseAdmin.js'

/**
 * Admin dashboard statistics.
 *
 * Counting rules (from the spec):
 * - A child and a room are different units: two children sharing a room are
 *   two children and one room.
 * - A customer buying several packages is one customer with several purchases.
 * - Only paid orders count; cancelled and refunded orders are excluded.
 */

export const STAT_AGE_BUCKETS = [
  { id: '0-2', label: '0–2', min: 0, max: 2 },
  { id: '3-5', label: '3–5', min: 3, max: 5 },
  { id: '6-8', label: '6–8', min: 6, max: 8 },
  { id: '9-12', label: '9–12', min: 9, max: 12 },
  { id: '13+', label: '13+', min: 13, max: Infinity },
]

export function ageBucket(age) {
  const value = Number(age)
  if (!Number.isFinite(value)) return null
  return STAT_AGE_BUCKETS.find((bucket) => value >= bucket.min && value <= bucket.max)?.id ?? null
}

const inc = (map, key, by = 1) => {
  if (key === null || key === undefined || key === '') return
  map[key] = (map[key] || 0) + by
}

const sortedEntries = (map, limit = Infinity) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))

const nested = (map) =>
  Object.fromEntries(Object.entries(map).map(([key, inner]) => [key, sortedEntries(inner, 8)]))

const round2 = (value) => Math.round(value * 100) / 100

export function bucketKey(date, granularity) {
  const d = new Date(date)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  if (granularity === 'year') return `${y}`
  if (granularity === 'month') return `${y}-${m}`
  if (granularity === 'week') {
    const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()))
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
    return monday.toISOString().slice(0, 10)
  }
  return `${y}-${m}-${day}`
}

function emptySeries(from, to, granularity) {
  const keys = []
  const cursor = new Date(from)
  while (cursor < to) {
    const key = bucketKey(cursor, granularity)
    if (keys[keys.length - 1] !== key) keys.push(key)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return keys
}

/** Pure aggregation over already-loaded rows, so it can be tested without a database. */
export function aggregate({ orders, items, priorOrders, submissions, events, archivedItems, from, to, granularity }) {
  const paid = orders.filter((o) => o.status === 'paid')
  const paidIds = new Set(paid.map((o) => o.id))
  const paidItems = items.filter((i) => paidIds.has(i.order_id))
  const packageOrders = paid.filter((o) => o.kind === 'packages')
  const voucherOrders = paid.filter((o) => o.kind === 'gift_voucher')

  const itemsByOrder = new Map()
  for (const item of paidItems) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, [])
    itemsByOrder.get(item.order_id).push(item)
  }

  // First-ever package order of each customer (looking at all history up to `to`).
  const firstOrderByUser = new Map()
  for (const order of [...priorOrders, ...packageOrders].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (order.user_id && !firstOrderByUser.has(order.user_id)) firstOrderByUser.set(order.user_id, order.id)
  }
  const firstPackageOrders = packageOrders.filter((o) => firstOrderByUser.get(o.user_id) === o.id)
  const returningCustomers = new Set(
    packageOrders.filter((o) => o.user_id && firstOrderByUser.get(o.user_id) !== o.id).map((o) => o.user_id),
  )

  const revenue = round2(paid.reduce((sum, o) => sum + Number(o.total), 0))
  const upgradeItems = paidItems.filter((i) => i.is_upgrade)
  const topPackages = {}
  const byTheme = {}
  const byColor = {}
  for (const item of paidItems) {
    inc(topPackages, item.package_name || item.package_id)
    inc(byTheme, item.theme)
    inc(byColor, item.color_preference)
  }

  const sales = {
    totalPurchases: paid.length,
    packageOrders: packageOrders.length,
    voucherOrders: voucherOrders.length,
    uniqueBuyers: new Set(paid.map((o) => o.user_id).filter(Boolean)).size,
    revenue,
    voucherRevenue: round2(voucherOrders.reduce((sum, o) => sum + Number(o.total), 0)),
    averageOrder: paid.length ? round2(revenue / paid.length) : 0,
    packagesSold: paidItems.length,
    firstPackagePurchases: firstPackageOrders.length,
    upgradePurchases: upgradeItems.length,
    multiRoomOrders: packageOrders.filter((o) => (itemsByOrder.get(o.id) || []).length > 1).length,
    siblingDiscountOrders: packageOrders.filter((o) =>
      (itemsByOrder.get(o.id) || []).some((i) => i.discount_type === 'sibling'),
    ).length,
    couponOrders: packageOrders.filter((o) => o.coupon_id).length,
    voucherRedemptionOrders: packageOrders.filter((o) => o.voucher_packages_used > 0).length,
    newPackageRevenue: round2(paidItems.filter((i) => !i.is_upgrade).reduce((s, i) => s + Number(i.price), 0)),
    upgradeRevenue: round2(upgradeItems.reduce((s, i) => s + Number(i.price), 0)),
    topPackages: sortedEntries(topPackages, 10),
    byTheme: sortedEntries(byTheme, 12),
    byColor: sortedEntries(byColor, 12),
  }

  // Children: questionnaire answers vs. children in purchased rooms.
  const qAges = {}
  const qBuckets = {}
  const qGender = {}
  const themesByAge = {}
  const themesByGender = {}
  let childrenEntered = 0
  let crossAgeRooms = 0
  for (const submission of submissions) {
    for (const room of submission.rooms || []) {
      if (room.ageTrack === 'cross-age') crossAgeRooms += 1
      if (room.theme) {
        const ageKey = room.ageGroup || 'unknown'
        themesByAge[ageKey] = themesByAge[ageKey] || {}
        inc(themesByAge[ageKey], room.theme)
        const genderKey = room.designGender || 'unknown'
        themesByGender[genderKey] = themesByGender[genderKey] || {}
        inc(themesByGender[genderKey], room.theme)
      }
      for (const child of room.children || []) {
        childrenEntered += 1
        inc(qAges, child.age === null || child.age === undefined ? null : String(child.age))
        inc(qBuckets, ageBucket(child.age))
        inc(qGender, child.gender || 'unknown')
      }
    }
  }

  const buyerBuckets = {}
  const buyerAges = {}
  let childrenPurchased = 0
  for (const item of paidItems) {
    for (const child of item.children || []) {
      childrenPurchased += 1
      inc(buyerBuckets, ageBucket(child.age))
      inc(buyerAges, String(child.age))
    }
  }

  const children = {
    childrenEntered,
    childrenPurchased,
    byAge: qAges,
    byAgeBucket: STAT_AGE_BUCKETS.map((b) => ({ name: b.label, id: b.id, count: qBuckets[b.id] || 0 })),
    byGender: qGender,
    themesByAgeGroup: nested(themesByAge),
    themesByGender: nested(themesByGender),
    purchasedByAgeBucket: STAT_AGE_BUCKETS.map((b) => ({ name: b.label, id: b.id, count: buyerBuckets[b.id] || 0 })),
    purchasedByAge: buyerAges,
    crossAgeRooms,
  }

  // Rooms.
  const roomIds = new Set(paidItems.map((i) => i.room_id).filter(Boolean))
  const roomsByUser = {}
  for (const item of paidItems) {
    if (!item.user_id || !item.room_id) continue
    roomsByUser[item.user_id] = roomsByUser[item.user_id] || new Set()
    roomsByUser[item.user_id].add(item.room_id)
  }
  const rooms = {
    roomsPurchased: roomIds.size,
    sharedRooms: paidItems.filter((i) => (i.children || []).length > 1).length,
    familiesMultipleRooms: Object.values(roomsByUser).filter((set) => set.size > 1).length,
    returningCustomers: returningCustomers.size,
    upgradesForExistingRooms: upgradeItems.length,
    archivedPackages: archivedItems.length,
  }

  // Questionnaire funnel, by session.
  const sessions = {}
  for (const event of events) {
    const s = (sessions[event.session_id] = sessions[event.session_id] || { events: new Set(), lastStep: null, lastIndex: -1 })
    s.events.add(event.event)
    if (event.event === 'step' && (event.step_index ?? -1) >= s.lastIndex) {
      s.lastIndex = event.step_index ?? -1
      s.lastStep = event.step_kind
    }
  }
  const all = Object.values(sessions)
  const count = (name) => all.filter((s) => s.events.has(name)).length
  const started = count('start')
  const dropOff = {}
  for (const s of all) {
    if (s.events.has('start') && !s.events.has('complete')) inc(dropOff, s.lastStep || 'rooms')
  }
  const questionnaire = {
    started,
    completed: count('complete'),
    reachedCart: count('cart'),
    purchased: count('purchase'),
    conversionRate: started ? round2((count('purchase') / started) * 100) : 0,
    dropOffSteps: sortedEntries(dropOff),
  }

  // Time series.
  const keys = emptySeries(from, to, granularity)
  const series = Object.fromEntries(keys.map((k) => [k, { key: k, orders: 0, revenue: 0, packages: 0 }]))
  for (const order of paid) {
    const key = bucketKey(order.created_at, granularity)
    if (!series[key]) continue
    series[key].orders += 1
    series[key].revenue = round2(series[key].revenue + Number(order.total))
    series[key].packages += (itemsByOrder.get(order.id) || []).length
  }

  return { sales, children, rooms, questionnaire, series: keys.map((k) => series[k]) }
}

async function loadPeriod(from, to) {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const orders = await fetchAll('orders', (q) =>
    q
      .select('id, user_id, kind, status, total, coupon_id, voucher_packages_used, created_at')
      .gte('created_at', fromIso)
      .lt('created_at', toIso),
  )
  const orderIds = orders.map((o) => o.id)
  const items = []
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = orderIds.slice(i, i + 200)
    items.push(
      ...(await fetchAll('order_items', (q) =>
        q
          .select('id, order_id, user_id, room_id, package_id, package_name, theme, color_preference, children, price, discount_type, is_upgrade')
          .in('order_id', chunk),
      )),
    )
  }
  const priorOrders = await fetchAll('orders', (q) =>
    q.select('id, user_id, created_at').eq('kind', 'packages').eq('status', 'paid').lt('created_at', fromIso),
  )
  const submissions = await fetchAll('questionnaire_submissions', (q) =>
    q.select('rooms, created_at').gte('created_at', fromIso).lt('created_at', toIso),
  )
  const events = await fetchAll('questionnaire_events', (q) =>
    q.select('session_id, event, step_kind, step_index').gte('created_at', fromIso).lt('created_at', toIso),
  )
  const archivedItems = await fetchAll('order_items', (q) =>
    q.select('id').gte('archived_at', fromIso).lt('archived_at', toIso),
  )
  return { orders, items, priorOrders, submissions, events, archivedItems }
}

export async function computeStats({ from, to, granularity = 'day', compare = true }) {
  const current = aggregate({ ...(await loadPeriod(from, to)), from, to, granularity })
  let previous = null
  if (compare) {
    const length = to.getTime() - from.getTime()
    const prevFrom = new Date(from.getTime() - length)
    const prevResult = aggregate({ ...(await loadPeriod(prevFrom, from)), from: prevFrom, to: from, granularity })
    previous = {
      from: prevFrom.toISOString(),
      to: from.toISOString(),
      sales: prevResult.sales,
      rooms: prevResult.rooms,
      questionnaire: prevResult.questionnaire,
      children: { childrenEntered: prevResult.children.childrenEntered, childrenPurchased: prevResult.children.childrenPurchased },
    }
  }
  return { from: from.toISOString(), to: to.toISOString(), granularity, ...current, previous }
}
