import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..')
const BOARDS_DIR = path.join(REPO_ROOT, 'data', 'boards')
const BOARD_IMAGES_DIR = path.join(REPO_ROOT, 'frontend', 'public', 'board-images')

const SLUG_RE = /^[A-Za-z0-9_.+-]+$/
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

function safeSlug(s: string): string | null { return SLUG_RE.test(s) ? s : null }
function safeImageName(name: string): string | null {
  const base = path.basename(name)
  if (base !== name) return null
  if (base.includes('/') || base.includes('\\') || base.startsWith('.')) return null
  if (!IMAGE_EXT_RE.test(base)) return null
  return base
}

// Tiny dev-only API that backs the admin UI.
// - GET  /api/admin/capabilities  → { canWrite, llm }
// - PUT  /api/admin/board/:slug   → merges `manual` into the per-board file
//                                    on disk, then re-bundles boards.json.
// - POST /api/admin/extract       → LLM pass over pasted product-page text,
//                                    returns ExtractResult-shaped JSON.
// Only registered in `vite serve` (dev). Cloudflare Pages never sees it.
function adminApi(): Plugin {
  return {
    name: 'fcpicker-admin-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/admin', async (req, res, next) => {
        try {
          if (req.method === 'GET' && req.url === '/capabilities') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              canWrite: true,
              llm: Boolean(process.env.ANTHROPIC_API_KEY),
            }))
            return
          }

          if (req.method === 'POST' && req.url === '/fetch-url') {
            const body = await readBody(req)
            const { url } = JSON.parse(body) as { url?: string }
            if (!url) { res.statusCode = 400; res.end('expected { url }'); return }
            let parsed: URL
            try { parsed = new URL(url) } catch {
              res.statusCode = 400; res.end('invalid url'); return
            }
            // Whitelist to avoid being an open proxy.
            const ok = parsed.protocol === 'https:' && (
              parsed.hostname === 'ardupilot.org' ||
              parsed.hostname.endsWith('.ardupilot.org') ||
              parsed.hostname === 'github.com' ||
              parsed.hostname === 'raw.githubusercontent.com'
            )
            if (!ok) {
              res.statusCode = 403
              res.end('host not allowed (ardupilot.org / github.com only)')
              return
            }
            const upstream = await fetch(parsed.toString(), {
              headers: { 'User-Agent': 'fcpicker-admin/1.0' },
            })
            if (!upstream.ok) {
              res.statusCode = 502
              res.end(`upstream ${upstream.status}`); return
            }
            const html = await upstream.text()
            const text = htmlToText(html)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ text, source: parsed.toString() }))
            return
          }

          if (req.method === 'POST' && req.url === '/extract') {
            const apiKey = process.env.ANTHROPIC_API_KEY
            if (!apiKey) {
              res.statusCode = 503
              res.end('ANTHROPIC_API_KEY not set in this dev shell')
              return
            }
            const body = await readBody(req)
            const parsed = JSON.parse(body) as {
              text?: string;
              images?: Array<{ media_type: string; data: string }>;
            }
            const hasText = typeof parsed.text === 'string' && parsed.text.trim().length > 0
            const hasImages = Array.isArray(parsed.images) && parsed.images.length > 0
            if (!hasText && !hasImages) {
              res.statusCode = 400
              res.end('expected { text?: string, images?: [...] }')
              return
            }
            const extracted = await llmExtract(parsed.text ?? '', parsed.images ?? [], apiKey)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(extracted))
            return
          }

          // POST /board/:slug/image  — upload an image
          const upMatch = req.url?.match(/^\/board\/([^/?#]+)\/image$/)
          if (upMatch && req.method === 'POST') {
            const slug = safeSlug(decodeURIComponent(upMatch[1]))
            if (!slug) { res.statusCode = 400; res.end('invalid slug'); return }
            const body = await readBody(req)
            const { filename, data, media_type } = JSON.parse(body) as {
              filename?: string; data?: string; media_type?: string;
            }
            if (!data || typeof data !== 'string') {
              res.statusCode = 400; res.end('expected { filename, data, media_type }'); return
            }
            const ext = MIME_TO_EXT[media_type ?? ''] ?? (filename ? path.extname(filename).toLowerCase() : '')
            if (!ext) { res.statusCode = 400; res.end('unsupported media_type'); return }
            // Build a safe unique filename: prefer the user's basename, suffix with timestamp if collision.
            const baseHint = filename ? path.basename(filename).replace(IMAGE_EXT_RE, '') : 'image'
            const cleanHint = baseHint.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'image'
            const stamp = Date.now().toString(36)
            const finalName = `${cleanHint}-${stamp}${ext}`
            const safe = safeImageName(finalName)
            if (!safe) { res.statusCode = 400; res.end('unsafe filename'); return }
            const dir = path.join(BOARD_IMAGES_DIR, slug)
            await mkdir(dir, { recursive: true })
            await writeFile(path.join(dir, safe), Buffer.from(data, 'base64'))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, filename: safe }))
            return
          }

          // DELETE /board/:slug/image/:filename
          const delMatch = req.url?.match(/^\/board\/([^/?#]+)\/image\/([^/?#]+)$/)
          if (delMatch && req.method === 'DELETE') {
            const slug = safeSlug(decodeURIComponent(delMatch[1]))
            const fn = safeImageName(decodeURIComponent(delMatch[2]))
            if (!slug || !fn) { res.statusCode = 400; res.end('invalid'); return }
            try {
              await unlink(path.join(BOARD_IMAGES_DIR, slug, fn))
            } catch { /* already gone — fine */ }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
            return
          }

          const m = req.url?.match(/^\/board\/([^/?#]+)$/)
          if (m && req.method === 'PUT') {
            const slug = safeSlug(decodeURIComponent(m[1]))
            if (!slug) {
              res.statusCode = 400
              res.end('invalid slug')
              return
            }
            const body = await readBody(req)
            const payload = JSON.parse(body)
            if (!payload || typeof payload.manual !== 'object') {
              res.statusCode = 400
              res.end('expected { manual: {...} }')
              return
            }
            const filePath = path.join(BOARDS_DIR, `${slug}.json`)
            const existingRaw = await readFile(filePath, 'utf8')
            const existing = JSON.parse(existingRaw)
            existing.manual = payload.manual
            await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n')
            await runBundler()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
            return
          }

          next()
        } catch (err) {
          res.statusCode = 500
          res.end(String(err))
        }
      })
    },
  }
}

const EXTRACT_SYSTEM = `You extract structured flight-controller board info from product-page, wiki, or datasheet text.

Return STRICT JSON matching this shape, no prose:
{
  "dimensions": { "length": number|null, "width": number|null, "height": number|null } | null,
  "weight_g": number | null,
  "mounting": string | null,
  "connectors": [
    { "function": string|null, "type": string, "pin_count": number|null, "quantity": number, "label": string|null }
  ]
}

Rules:
- Dimensions are the BOARD OUTLINE in millimetres. If the text says inches, convert.
- "mounting" is the hole-grid pattern — one of "16x16", "20x20", "25.5x25.5", "30.5x30.5", "35x35", "pixhawk", "cube", or null. "30.5 x 30.5 mm hole grid" → "30.5x30.5". Do NOT confuse with dimensions.
- "function" must be one of: GPS, CAN, UART / Telem, I2C, SPI, RC in, PWM out, Power input, Power output / BEC, Battery, USB, Debug / SWD, Ethernet, SBUS out, Servo rail, Sensor, Other. Null if unclear.
- "type" must be one of: JST-GH, JST-SH, JST-ZH, JST-XH, Molex-PicoBlade, Molex-ClikMate, Header-2.54, Header-1.27, Solder-pad, USB-C, Micro-USB, DF13, XT30, XT60, Other.
- Group identical connectors (same type, pin count, function) into one row with quantity = sum.
- Omit fields you can't determine (use null / empty array). Don't invent.`

// Crude HTML → plain text. Good enough for ardupilot.org wiki pages.
function htmlToText(html: string): string {
  let t = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  t = t.replace(/<\/(?:p|div|li|tr|h[1-6]|br)\s*>/gi, '\n')
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<[^>]+>/g, ' ')
  const namedEntities: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    mdash: '—', ndash: '–', hellip: '…', times: '×', deg: '°',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  }
  t = t.replace(/&([a-zA-Z]+);/g, (_m, name) => namedEntities[name] ?? _m)
  t = t.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  return t
}

type ImagePayload = { media_type: string; data: string }

async function llmExtract(text: string, images: ImagePayload[], apiKey: string): Promise<unknown> {
  const userBlocks: Array<Record<string, unknown>> = []
  for (const img of images) {
    userBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    })
  }
  if (text.trim()) {
    userBlocks.push({ type: 'text', text })
  } else if (images.length > 0) {
    userBlocks.push({ type: 'text', text: 'Extract from the image(s) above.' })
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: userBlocks }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`)
  const data = await r.json() as { content: Array<{ type: string; text?: string }> }
  const textOut = data.content.find((b) => b.type === 'text')?.text ?? '{}'
  // Strip markdown code fences if the model wrapped them.
  const cleaned = textOut.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(cleaned)
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function runBundler(): Promise<void> {
  return new Promise((resolve, reject) => {
    const venvPy = path.join(REPO_ROOT, '.venv', 'bin', 'python')
    const tryRun = (cmd: string) => {
      const p = spawn(cmd, ['tools/bundle.py'], { cwd: REPO_ROOT })
      let settled = false
      p.on('error', (e) => {
        if (settled) return
        settled = true
        if (cmd !== 'python3') tryRun('python3')
        else reject(e)
      })
      p.on('exit', (code) => {
        if (settled) return
        settled = true
        if (code === 0) resolve()
        else reject(new Error(`bundle exit ${code}`))
      })
    }
    tryRun(venvPy)
  })
}

// Served at the domain root in development and on the standalone deploy, and
// under a sub-path when it lands at ardupilot.org/fcpicker. BASE_PATH drives
// both the asset URLs and the router basename, so the same source builds for
// either. Must have a trailing slash.
const BASE_PATH = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base: BASE_PATH,
  plugins: [react(), adminApi()],
})
