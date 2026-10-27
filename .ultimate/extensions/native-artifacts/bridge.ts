import type { ArtifactAnchor } from '../artifacts/types.ts'
import type { TargetStatus } from './types.ts'

/** Decode at both ends. Messages are input, not authority, even with a matching channel. */
export function decodeAnchor(value: unknown): ArtifactAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const a = value as Record<string, unknown>
  if (
    typeof a.selector !== 'string' ||
    !a.selector.length ||
    a.selector.length > 2048 ||
    typeof a.text !== 'string' ||
    a.text.length > 2000
  )
    return undefined
  if (a.kind === 'element' && Object.keys(a).length === 3)
    return { kind: 'element', selector: a.selector, text: a.text }
  const boundary = (v: unknown) => {
    if (!v || typeof v !== 'object') return undefined
    const b = v as Record<string, unknown>
    if (
      Object.keys(b).length !== 2 ||
      !Array.isArray(b.path) ||
      b.path.length > 64 ||
      !Array.from(b.path).every((n) => Number.isInteger(n) && n >= 0 && n <= 100_000) ||
      !Number.isInteger(b.offset) ||
      (b.offset as number) < 0 ||
      (b.offset as number) > 10_000_000
    )
      return undefined
    return { path: [...b.path] as number[], offset: b.offset as number }
  }
  if (a.kind !== 'text' || Object.keys(a).length !== 5 || !a.text.length) return undefined
  const start = boundary(a.start)
  const end = boundary(a.end)
  if (start && end) return { kind: 'text', selector: a.selector, text: a.text, start, end }
  return undefined
}

export type FrameMessage =
  | { type: 'ready' }
  | { type: 'target'; anchor: ArtifactAnchor }
  | { type: 'statuses'; statuses: TargetStatus[] }
  | { type: 'error'; message: string }

export function decodeFrameMessage(value: unknown, channel: string): FrameMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const m = value as Record<string, unknown>
  if (m.channel !== channel) return undefined
  if (m.type === 'ready' && Object.keys(m).length === 2) return { type: 'ready' }
  if (Object.keys(m).length !== 3) return undefined
  if (m.type === 'target') {
    const anchor = decodeAnchor(m.anchor)
    if (anchor) return { type: 'target', anchor }
  }
  if (
    m.type === 'statuses' &&
    Array.isArray(m.statuses) &&
    m.statuses.length <= 200 &&
    m.statuses.every((s) => s === 'same' || s === 'changed' || s === 'missing')
  )
    return { type: 'statuses', statuses: m.statuses }
  if (m.type === 'error' && typeof m.message === 'string' && m.message.length <= 256)
    return { type: 'error', message: m.message }
  return undefined
}

/** This function is serialized into the sole nonce-authorized script. It has no host DOM access. */
function annotationBridge(channel: string, parentOrigin: string, decode: typeof decodeAnchor) {
  let mode = 'view'
  const send = (message: object) => parent.postMessage({ ...message, channel }, parentOrigin)
  const error = (message: string) => send({ type: 'error', message })
  let hovered: HTMLElement | null = null
  let focused: HTMLElement | null = null
  let outlined: HTMLElement | null = null
  let originalStyle: string | null = null
  const restoreOutline = () => {
    if (!outlined) return
    // Flush Chromium's lazy CSSOM attribute sync before removal, or it can leave an empty style attribute.
    outlined.getAttribute('style')
    if (originalStyle === null) outlined.removeAttribute('style')
    else outlined.setAttribute('style', originalStyle)
    outlined = null
  }
  const highlight = () => {
    restoreOutline()
    const target = hovered ?? focused
    if (mode !== 'element' || !target) return
    outlined = target
    originalStyle = target.getAttribute('style')
    target.style.setProperty('outline', '2px solid Highlight', 'important')
    target.style.setProperty('outline-offset', '2px', 'important')
  }
  const candidate = (target: EventTarget | null) =>
    target instanceof HTMLElement && document.body.contains(target) ? target : null
  document.addEventListener('pointerover', (event) => {
    hovered = candidate(event.target)
    highlight()
  })
  document.addEventListener('pointerout', (event) => {
    hovered = candidate(event.relatedTarget)
    highlight()
  })
  document.addEventListener('focusin', (event) => {
    focused = candidate(event.target)
    hovered = null
    highlight()
  })
  document.addEventListener('focusout', (event) => {
    focused = candidate(event.relatedTarget)
    highlight()
  })
  const selector = (element: Element) => {
    const parts: string[] = []
    let node: Element | null = element
    while (node) {
      const tag = node.localName
      const siblings = node.parentElement ? [...node.parentElement.children] : [node]
      parts.unshift(
        `${tag}:nth-of-type(${siblings.filter((s) => s.localName === tag).indexOf(node) + 1})`,
      )
      node = node.parentElement
      if (parts.length > 64) throw new Error('Target is nested too deeply.')
    }
    const result = parts.join(' > ')
    if (result.length > 2048) throw new Error('Target selector is too long.')
    return result
  }
  const path = (root: Node, node: Node): number[] => {
    const result: number[] = []
    while (node !== root) {
      const p = node.parentNode
      if (!p || result.length >= 64) throw new Error('Selection is outside the document.')
      result.unshift([...p.childNodes].indexOf(node as ChildNode))
      node = p
    }
    return result
  }
  const boundaryNode = (root: Node, boundary: { path: number[]; offset: number }) => {
    let node: Node | undefined = root
    for (const index of boundary.path) node = node?.childNodes[index]
    if (!node) return undefined
    const limit =
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent?.length ?? 0)
        : node.nodeType === Node.ELEMENT_NODE
          ? node.childNodes.length
          : -1
    return boundary.offset <= limit ? node : undefined
  }
  const status = (anchor: ArtifactAnchor): TargetStatus => {
    let nodes: NodeListOf<Element>
    try {
      nodes = document.querySelectorAll(anchor.selector)
    } catch {
      return 'missing'
    } // Invalid selectors are missing targets, not executable commands.
    if (nodes.length !== 1) return 'missing'
    const root = nodes[0]
    if (anchor.kind === 'element')
      return (root.textContent ?? '').slice(0, 2000) === anchor.text ? 'same' : 'changed'
    const start = boundaryNode(root, anchor.start)
    const end = boundaryNode(root, anchor.end)
    if (!start || !end) return 'changed'
    const range = document.createRange()
    range.setStart(start, anchor.start.offset)
    range.setEnd(end, anchor.end.offset)
    return !range.collapsed && range.toString() === anchor.text ? 'same' : 'changed'
  }
  document.addEventListener(
    'click',
    (event) => {
      if (mode !== 'element' || !(event.target instanceof Element)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      restoreOutline()
      try {
        const anchor = decode({
          kind: 'element',
          selector: selector(event.target),
          text: (event.target.textContent ?? '').slice(0, 2000),
        })
        if (!anchor) throw new Error('This element cannot be captured.')
        send({ type: 'target', anchor })
      } catch (e) {
        error(e instanceof Error ? e.message : 'Cannot capture this element.')
      }
    },
    true,
  )
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== parentOrigin) return
    const m = event.data
    if (!m || typeof m !== 'object' || m.channel !== channel) return
    if (m.type === 'configure') {
      if (
        !['view', 'element', 'text'].includes(m.mode) ||
        !Array.isArray(m.anchors) ||
        m.anchors.length > 200
      )
        return
      const anchors = m.anchors.map(decode)
      if (anchors.some((a: ArtifactAnchor | undefined) => !a)) return
      mode = m.mode
      highlight()
      send({ type: 'statuses', statuses: anchors.map(status) })
    } else if (m.type === 'capture' && mode === 'text') {
      try {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
          throw new Error('Select some text in the artifact first.')
        const range = selection.getRangeAt(0)
        if (!document.body.contains(range.commonAncestorContainer))
          throw new Error('Select text inside the artifact.')
        let root: Node = range.commonAncestorContainer
        if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentNode!
        const anchor = decode({
          kind: 'text',
          selector: selector(root as Element),
          text: range.toString(),
          start: { path: path(root, range.startContainer), offset: range.startOffset },
          end: { path: path(root, range.endContainer), offset: range.endOffset },
        })
        if (!anchor || status(anchor) !== 'same')
          throw new Error('Select between 1 and 2,000 characters of text.')
        send({ type: 'target', anchor })
      } catch (e) {
        error(e instanceof Error ? e.message : 'Cannot capture this selection.')
      }
    }
  })
  // Keep trusted bridge source out of body text, native selections and authored CSS display rules.
  document.currentScript?.remove()
  send({ type: 'ready' })
}

export function bridgeSource(channel: string, parentOrigin: string): string {
  const literal = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')
  return `(${annotationBridge.toString()})(${literal(channel)},${literal(parentOrigin)},${decodeAnchor.toString()})`
}
