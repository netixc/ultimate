import type { ArtifactAnchor } from '../artifacts/types.ts'
import type { LayoutDiagnostics, TargetRect, TargetStatus } from './types.ts'
import { auditLayout } from './layout-audit.ts'

export function decodeRect(value: unknown): TargetRect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rect = value as Record<string, unknown>
  if (
    Object.keys(rect).length !== 4 ||
    !['x', 'y', 'width', 'height'].every(
      (key) =>
        typeof rect[key] === 'number' &&
        Number.isFinite(rect[key]) &&
        Math.abs(rect[key]) <= 1_000_000,
    ) ||
    (rect.width as number) < 0 ||
    (rect.height as number) < 0
  )
    return undefined
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  }
}

export function decodeDiagnostics(value: unknown): LayoutDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const pass = value as Record<string, unknown>
  if (
    Object.keys(pass).length !== (pass.error === undefined ? 3 : 4) ||
    typeof pass.complete !== 'boolean' ||
    !pass.viewport ||
    typeof pass.viewport !== 'object' ||
    !Array.isArray(pass.findings) ||
    pass.findings.length > 100
  )
    return undefined
  const viewport = pass.viewport as Record<string, unknown>
  if (
    Object.keys(viewport).length !== 2 ||
    !['width', 'height'].every(
      (key) =>
        Number.isInteger(viewport[key]) &&
        (viewport[key] as number) >= 1 &&
        (viewport[key] as number) <= 100_000,
    )
  )
    return undefined
  if (
    pass.error !== undefined &&
    (pass.complete ||
      typeof pass.error !== 'string' ||
      !pass.error.length ||
      pass.error.length > 256)
  )
    return undefined
  const findings: LayoutDiagnostics['findings'] = []
  for (const item of pass.findings) {
    if (!item || typeof item !== 'object') return undefined
    const f = item as Record<string, unknown>
    if (
      Object.keys(f).length !== 4 ||
      !['page-horizontal-overflow', 'clipped-control', 'unreachable-control'].includes(
        f.rule as string,
      ) ||
      typeof f.selector !== 'string' ||
      !f.selector.length ||
      f.selector.length > 2048 ||
      (f.axis !== 'horizontal' && f.axis !== 'vertical') ||
      (f.rule === 'page-horizontal-overflow' && f.axis !== 'horizontal') ||
      typeof f.overflowPx !== 'number' ||
      !Number.isFinite(f.overflowPx) ||
      f.overflowPx <= 0 ||
      f.overflowPx > 1_000_000
    )
      return undefined
    findings.push({
      rule: f.rule as LayoutDiagnostics['findings'][number]['rule'],
      selector: f.selector,
      axis: f.axis,
      overflowPx: f.overflowPx,
    })
  }
  return {
    viewport: { width: viewport.width as number, height: viewport.height as number },
    complete: pass.complete,
    findings,
    ...(pass.error === undefined ? {} : { error: pass.error }),
  }
}

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
  if (a.kind !== 'text' || Object.keys(a).length !== 5 || !a.text.trim().length) return undefined
  const start = boundary(a.start)
  const end = boundary(a.end)
  if (start && end) return { kind: 'text', selector: a.selector, text: a.text, start, end }
  return undefined
}

export type FrameMessage =
  | { type: 'ready' }
  | { type: 'target'; anchor: ArtifactAnchor; rect: TargetRect }
  | { type: 'rect'; rect: TargetRect | null }
  | { type: 'diagnostics'; pass: LayoutDiagnostics }
  | { type: 'statuses'; statuses: TargetStatus[] }
  | { type: 'error'; message: string }
  | { type: 'interaction'; active: boolean }

export function decodeFrameMessage(value: unknown, channel: string): FrameMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const m = value as Record<string, unknown>
  if (m.channel !== channel) return undefined
  if (m.type === 'ready' && Object.keys(m).length === 2) return { type: 'ready' }
  if (m.type === 'target' && Object.keys(m).length === 4) {
    const anchor = decodeAnchor(m.anchor)
    const rect = decodeRect(m.rect)
    if (anchor && rect) return { type: 'target', anchor, rect }
    return undefined
  }
  if (Object.keys(m).length !== 3) return undefined
  if (m.type === 'rect') {
    const rect = m.rect === null ? null : decodeRect(m.rect)
    if (rect !== undefined) return { type: 'rect', rect }
  }
  if (m.type === 'diagnostics') {
    const pass = decodeDiagnostics(m.pass)
    if (pass) return { type: 'diagnostics', pass }
  }
  if (m.type === 'interaction' && typeof m.active === 'boolean')
    return { type: 'interaction', active: m.active }
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
function annotationBridge(
  channel: string,
  parentOrigin: string,
  decode: typeof decodeAnchor,
  rectDecode: typeof decodeRect,
  audit: typeof auditLayout,
) {
  let mode = 'view'
  const send = (message: object) => parent.postMessage({ ...message, channel }, parentOrigin)
  const error = (message: string) => send({ type: 'error', message })
  let interacting = false
  const interaction = (active: boolean) => {
    if (interacting === active) return
    interacting = active
    send({ type: 'interaction', active })
  }
  let hovered: HTMLElement | null = null
  let focused: HTMLElement | null = null
  let outlined: HTMLElement | null = null
  let originalStyle: string | null = null
  let selected: ArtifactAnchor | undefined
  let revealed: HTMLElement | null = null
  let lastReveal = -1
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('::highlight(ultimate-native-target){background:Highlight;color:HighlightText}')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
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
    CSS.highlights.delete('ultimate-native-target')
    const locked = selected ? locate(selected) : undefined
    if (locked?.range) {
      CSS.highlights.set('ultimate-native-target', new Highlight(locked.range))
      return
    }
    const target = locked?.root ?? revealed ?? (mode === 'annotate' ? (hovered ?? focused) : null)
    if (!target) return
    outlined = target
    originalStyle = target.getAttribute('style')
    target.style.setProperty('outline', '2px solid Highlight', 'important')
    // Paint inside the target: an outside outline disappears when it fills a clipped ancestor.
    target.style.setProperty('outline-offset', '-2px', 'important')
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
  const locate = (anchor: ArtifactAnchor) => {
    if (status(anchor) !== 'same') return undefined
    const root = document.querySelector(anchor.selector) as HTMLElement
    if (anchor.kind === 'element') return { root, range: undefined }
    const range = document.createRange()
    range.setStart(boundaryNode(root, anchor.start)!, anchor.start.offset)
    range.setEnd(boundaryNode(root, anchor.end)!, anchor.end.offset)
    return { root, range }
  }
  const measure = (anchor: ArtifactAnchor) => {
    const target = locate(anchor)
    if (!target) return null
    const rect = (target.range ?? target.root).getBoundingClientRect()
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)
      return null
    return rectDecode({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }) ?? null
  }
  let lastRect = ''
  const reportRect = () => {
    const rect = selected ? measure(selected) : null
    const key = JSON.stringify(rect)
    if (key !== lastRect) {
      lastRect = key
      send({ type: 'rect', rect })
    }
  }
  const pick = (anchor: ArtifactAnchor) => {
    const rect = measure(anchor)
    if (!rect) throw new Error('This target has no bounded, visible geometry.')
    selected = anchor
    revealed = null
    highlight()
    send({ type: 'target', anchor, rect })
    reportRect()
  }
  let positionFrame = 0
  const reposition = () => {
    if (positionFrame) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0
      reportRect()
    })
  }
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
  const fontsReady = document.fonts.ready.then(
    () => true,
    () => false,
  )
  let auditTimer: ReturnType<typeof setTimeout> | undefined
  let auditGeneration = 0
  const scheduleAudit = () => {
    if (document.readyState !== 'complete') return
    clearTimeout(auditTimer)
    const generation = ++auditGeneration
    auditTimer = setTimeout(async () => {
      let fontTimer: ReturnType<typeof setTimeout> | undefined
      const fontsSettled = await Promise.race([
        document.fonts.ready.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          fontTimer = setTimeout(() => resolve(false), 1500)
        }),
      ])
      clearTimeout(fontTimer)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      if (generation !== auditGeneration) return
      const pass = audit(selector)
      reportRect()
      if (!fontsSettled) {
        pass.complete = false
        pass.error = 'Fonts did not settle before the layout pass deadline.'
      }
      send({ type: 'diagnostics', pass })
    }, 120)
  }
  if (document.readyState === 'complete') scheduleAudit()
  else window.addEventListener('load', scheduleAudit, { once: true })
  fontsReady.then(scheduleAudit, scheduleAudit)
  document.fonts.addEventListener('loadingdone', scheduleAudit)
  window.addEventListener('resize', scheduleAudit)
  document.addEventListener('toggle', scheduleAudit, true)
  document.addEventListener('change', scheduleAudit, true)
  let ignoreNextClick = false
  let lastSelection = ''
  const captureSelection = () => {
    if (mode !== 'annotate') return false
    const selection = window.getSelection()
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      lastSelection = ''
      return false
    }
    try {
      const range = selection.getRangeAt(0)
      if (!document.body.contains(range.commonAncestorContainer)) return false
      const quote = range.toString()
      // Native block/word selection can include an empty or whitespace-only intermediate range. It is not a note.
      if (!quote.trim()) {
        lastSelection = ''
        return true
      }
      let root: Node = range.commonAncestorContainer
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentNode!
      const anchor = decode({
        kind: 'text',
        selector: selector(root as Element),
        text: quote,
        start: { path: path(root, range.startContainer), offset: range.startOffset },
        end: { path: path(root, range.endContainer), offset: range.endOffset },
      })
      if (!anchor || status(anchor) !== 'same')
        throw new Error('Select between 1 and 2,000 characters of text.')
      const key = JSON.stringify(anchor)
      if (key !== lastSelection) {
        lastSelection = key
        restoreOutline()
        pick(anchor)
      }
    } catch (e) {
      error(e instanceof Error ? e.message : 'Cannot capture this selection.')
    }
    return true
  }
  document.addEventListener('pointerdown', () => {
    ignoreNextClick = false
    if (mode === 'annotate') interaction(true)
  })
  document.addEventListener('pointerup', () => {
    ignoreNextClick = captureSelection()
    interaction(false)
  })
  document.addEventListener('pointercancel', () => interaction(false))
  window.addEventListener('blur', () => interaction(false))
  document.addEventListener('keydown', (event) => {
    if (
      mode === 'annotate' &&
      (event.shiftKey ||
        event.key === 'Shift' ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'))
    )
      interaction(true)
  })
  document.addEventListener('keyup', (event) => {
    // Wait for selection modifiers to be released, not each intermediate Shift+Arrow step.
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      captureSelection()
      interaction(false)
    }
  })
  document.addEventListener(
    'click',
    (event) => {
      if (mode !== 'annotate' || !(event.target instanceof Element)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (ignoreNextClick) {
        ignoreNextClick = false
        return
      }
      // Keep an existing native selection intact when a platform emits click without pointerup.
      if (captureSelection()) return
      restoreOutline()
      try {
        const anchor = decode({
          kind: 'element',
          selector: selector(event.target),
          text: (event.target.textContent ?? '').slice(0, 2000),
        })
        if (!anchor) throw new Error('This element cannot be captured.')
        pick(anchor)
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
        !['view', 'annotate'].includes(m.mode) ||
        !Array.isArray(m.anchors) ||
        m.anchors.length > 200
      )
        return
      const anchors = m.anchors.map(decode)
      if (anchors.some((a: ArtifactAnchor | undefined) => !a)) return
      const nextSelected = m.selected === undefined ? undefined : decode(m.selected)
      if (m.selected !== undefined && !nextSelected) return
      if (
        m.reveal !== undefined &&
        (!m.reveal ||
          typeof m.reveal !== 'object' ||
          Object.keys(m.reveal).length !== 2 ||
          typeof m.reveal.selector !== 'string' ||
          !m.reveal.selector.length ||
          m.reveal.selector.length > 2048 ||
          !Number.isSafeInteger(m.reveal.request) ||
          m.reveal.request < 0)
      )
        return
      selected = nextSelected
      if (m.reveal && m.reveal.request !== lastReveal) {
        lastReveal = m.reveal.request
        try {
          const matches = document.querySelectorAll(m.reveal.selector)
          revealed = matches.length === 1 ? (matches[0] as HTMLElement) : null
          revealed?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        } catch {
          revealed = null
        } // A missing/invalid reveal selector has no action beyond clearing its visual marker.
      }
      if (!m.reveal) revealed = null
      if (mode !== m.mode) {
        lastSelection = ''
        ignoreNextClick = false
      }
      mode = m.mode
      if (mode !== 'annotate') interaction(false)
      highlight()
      reportRect()
      send({ type: 'statuses', statuses: anchors.map(status) })
    }
  })
  // Keep trusted bridge source out of body text, native selections and authored CSS display rules.
  document.currentScript?.remove()
  send({ type: 'ready' })
}

export function bridgeSource(channel: string, parentOrigin: string): string {
  const literal = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')
  return `(${annotationBridge.toString()})(${literal(channel)},${literal(parentOrigin)},${decodeAnchor.toString()},${decodeRect.toString()},${auditLayout.toString()})`
}
