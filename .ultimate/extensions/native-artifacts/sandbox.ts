import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { html as htmlSpec, parse, serialize } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_HTML_BYTES } from '../artifacts/types.ts'
import type { ArtifactSnapshot } from '../artifacts/types.ts'
import { bridgeSource } from './bridge.ts'

type Node = DefaultTreeAdapterMap['node']
type ChildNode = DefaultTreeAdapterMap['childNode']
type Element = DefaultTreeAdapterMap['element']
const tags = new Set(
  `html head body title style a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup dd del details dfn dialog div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr`.split(
    ' ',
  ),
)
const attributes = new Set(
  `id class title lang dir role width height colspan rowspan scope span start reversed type value placeholder checked selected multiple min max step open datetime cite alt for rows cols size wrap`.split(
    ' ',
  ),
)
const assetMimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  'text/css',
])

/** Parse and regenerate a passive HTML document. Only retained, explicitly named assets can become URLs. */
export function buildDocument(
  snapshot: ArtifactSnapshot,
  parentOrigin: string,
): { srcdoc: string; channel: string } {
  const origin = new URL(parentOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parentOrigin)
    throw new Error('The artifact bridge requires an exact HTTP parent origin.')
  const htmlBytes = Buffer.byteLength(snapshot.html)
  if (htmlBytes > MAX_ARTIFACT_HTML_BYTES) throw new Error('Artifact HTML exceeds 2 MiB.')
  const channel = randomBytes(24).toString('hex')
  const nonce = randomBytes(24).toString('base64')
  const retained = new Set(snapshot.artifact.source.assets)
  const assets = new Map<string, { mime: string; bytes: Buffer }>()
  let total = htmlBytes
  for (const asset of snapshot.assets) {
    if (!retained.has(asset.path) || !assetMimes.has(asset.mime)) continue
    if (asset.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4)
      throw new Error(`Artifact asset "${asset.path}" exceeds the 10 MiB bundle limit.`)
    const bytes = Buffer.from(asset.base64, 'base64')
    if (bytes.toString('base64') !== asset.base64)
      throw new Error(`Artifact asset "${asset.path}" has invalid base64 data.`)
    total += bytes.length
    if (total > MAX_ARTIFACT_BYTES) throw new Error('Artifact bundle exceeds 10 MiB.')
    assets.set(asset.path, { mime: asset.mime, bytes })
  }
  const resolve = (value: string, from: string) => {
    let local: string
    try {
      local = decodeURIComponent(value.trim().split(/[?#]/, 1)[0])
    } catch {
      return undefined
    } // A malformed URL is not a retained local asset.
    if (
      !local ||
      local.startsWith('/') ||
      /[:\\]/.test(local) ||
      local.split('').some((c) => c.charCodeAt(0) <= 32)
    )
      return undefined
    return posix.normalize(posix.join(posix.dirname(from), local))
  }
  // Count every emitted reference, not only distinct assets: repeated images must not expand srcdoc without bound.
  let embeddedBytes = 0
  const maxEmbeddedBytes = 25 * 1024 * 1024
  const data = (value: string, from: string, kind: 'image' | 'css-resource') => {
    const key = resolve(value, from)
    const asset = key ? assets.get(key) : undefined
    if (
      !asset ||
      asset.mime === 'text/css' ||
      (kind === 'image' && !asset.mime.startsWith('image/'))
    )
      return ''
    const url = `data:${asset.mime};base64,${asset.bytes.toString('base64')}`
    if (embeddedBytes + url.length > maxEmbeddedBytes)
      throw new Error('Artifact embedded resources exceed 25 MiB after data URL expansion.')
    embeddedBytes += url.length
    return url
  }
  const css = (source: string, from: string) => {
    if (embeddedBytes + source.length > maxEmbeddedBytes)
      throw new Error('Artifact embedded resources exceed 25 MiB after data URL expansion.')
    embeddedBytes += source.length
    // CSS escapes can disguise URL tokens and imports. Reject those sheets instead of guessing their grammar.
    // CSP independently denies external styles, imports and every non-data resource, including malformed CSS.
    if (source.includes('\\')) return ''
    const plain = source.replace(/\/\*[\s\S]*?\*\//g, '')
    // image-set() also accepts bare URL strings, so rejecting authored data schemes must not depend on url().
    if (/@import\b|data\s*:/i.test(plain)) return ''
    return plain
      .replace(
        /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)'"\s]*))\s*\)/gi,
        (
          _token,
          double: string | undefined,
          single: string | undefined,
          bare: string | undefined,
        ) => `url("${data(double ?? single ?? bare ?? '', from, 'css-resource')}")`,
      )
      .replaceAll('<', '\\3c ')
  }
  const document = parse(snapshot.html, { scriptingEnabled: true })
  const sanitize = (node: Node): ChildNode[] => {
    if ('value' in node && node.nodeName === '#text') return [node]
    if (!('tagName' in node) || node.namespaceURI !== htmlSpec.NS.HTML) return []
    if (node.tagName === 'link') {
      const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value
      const key = resolve(attr('href') ?? '', snapshot.artifact.source.path)
      const asset = key ? assets.get(key) : undefined
      if (attr('rel')?.toLowerCase() !== 'stylesheet' || !asset || asset.mime !== 'text/css')
        return []
      node.nodeName = node.tagName = 'style'
      node.attrs = []
      node.childNodes = [
        { nodeName: '#text', value: css(asset.bytes.toString('utf8'), key!), parentNode: node },
      ]
      return [node]
    }
    if (!tags.has(node.tagName)) {
      // Preserve a form's static layout, never its submission semantics or navigation attributes.
      if (node.tagName !== 'form') return []
      node.nodeName = node.tagName = 'div'
    }
    node.attrs = node.attrs.flatMap((attr) => {
      if (attr.namespace || attr.prefix) return []
      if (attr.name === 'style')
        return [{ ...attr, value: css(attr.value, snapshot.artifact.source.path) }]
      if (attr.name === 'src' && node.tagName === 'img') {
        const url = data(attr.value, snapshot.artifact.source.path, 'image')
        return url ? [{ ...attr, value: url }] : []
      }
      if (attributes.has(attr.name) || /^aria-[a-z-]+$/.test(attr.name)) return [attr]
      return []
    })
    if (node.tagName === 'img' && !node.attrs.some((a) => a.name === 'src')) {
      const alt = node.attrs.find((a) => a.name === 'alt')
      const message = '[Image unavailable: only retained raster images are supported]'
      if (alt) alt.value = `${message} ${alt.value}`
      else node.attrs.push({ name: 'alt', value: message })
    }
    if (['input', 'textarea'].includes(node.tagName))
      node.attrs.push({ name: 'readonly', value: '' })
    if (node.tagName === 'style') {
      const source = node.childNodes
        .filter((n) => n.nodeName === '#text')
        .map((n) => ('value' in n ? n.value : ''))
        .join('')
      node.childNodes = [
        { nodeName: '#text', value: css(source, snapshot.artifact.source.path), parentNode: node },
      ]
    } else {
      node.childNodes = node.childNodes.flatMap(sanitize)
      for (const child of node.childNodes) if ('parentNode' in child) child.parentNode = node
    }
    return [node]
  }
  const html = document.childNodes.find(
    (n): n is Element => 'tagName' in n && n.tagName === 'html',
  )!
  sanitize(html)
  const head = html.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === 'head')!
  const body = html.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === 'body')!
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'`
  const trusted = parse(
    `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script nonce="${nonce}"></script></body></html>`,
  )
  const shell = trusted.childNodes.find(
    (n): n is Element => 'tagName' in n && n.tagName === 'html',
  )!
  const trustedHead = shell.childNodes[0] as Element
  const trustedBody = shell.childNodes[1] as Element
  head.childNodes.unshift(...trustedHead.childNodes)
  for (const child of head.childNodes) if ('parentNode' in child) child.parentNode = head
  const script = trustedBody.childNodes[0] as Element
  script.childNodes = [
    { nodeName: '#text', value: bridgeSource(channel, parentOrigin), parentNode: script },
  ]
  script.parentNode = body
  body.childNodes.push(script)
  // Discard source doctypes/comments; serialize only the regenerated HTML tree.
  document.childNodes = [html]
  return { srcdoc: '<!doctype html>' + serialize(document), channel }
}
