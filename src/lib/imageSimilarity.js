import sharp from 'sharp'

const WIDTH = 48
const HEIGHT = 32

/** Edge map of a small grayscale thumbnail, so repainted walls don't hide an identical layout. */
async function edgeSignature(buffer) {
  const pixels = await sharp(buffer).resize(WIDTH, HEIGHT, { fit: 'fill' }).grayscale().raw().toBuffer()
  const edges = []
  for (let y = 0; y < HEIGHT - 1; y += 1) {
    for (let x = 0; x < WIDTH - 1; x += 1) {
      const i = y * WIDTH + x
      edges.push(Math.abs(pixels[i + 1] - pixels[i]) + Math.abs(pixels[i + WIDTH] - pixels[i]))
    }
  }
  return edges
}

function correlation(a, b) {
  const n = a.length
  const meanA = a.reduce((sum, v) => sum + v, 0) / n
  const meanB = b.reduce((sum, v) => sum + v, 0) / n
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  return varA && varB ? cov / Math.sqrt(varA * varB) : 0
}

/** Layout similarity between two images, from -1 to 1. */
export async function layoutSimilarity(first, second) {
  const [a, b] = await Promise.all([edgeSignature(first), edgeSignature(second)])
  return correlation(a, b)
}
