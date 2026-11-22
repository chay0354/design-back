function cell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV with a UTF-8 BOM so Excel shows Hebrew correctly. */
export function toCsv(headers, rows) {
  const lines = [headers.map((h) => cell(h.label)).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => cell(typeof h.value === 'function' ? h.value(row) : row[h.key])).join(','))
  }
  return `﻿${lines.join('\r\n')}`
}

export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
}
