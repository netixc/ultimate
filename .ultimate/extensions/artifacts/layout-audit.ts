import type { LayoutDiagnostics } from './viewer-types.ts'

/**
 * A small, read-only rectangular overflow/clipping heuristic, not general layout or accessibility QA.
 * Scrollable/below-fold content is not defective merely because it is offscreen. Budgets, animations and
 * unsupported clipping leave an incomplete pass, never an all-clear assertion.
 */
export function auditLayout(selector: (element: Element) => string): LayoutDiagnostics {
  const viewport = { width: innerWidth, height: innerHeight }
  const findings: LayoutDiagnostics['findings'] = []
  let complete = true
  let error: string | undefined
  const incomplete = (message: string) => {
    complete = false
    error ??= message
  }
  const add = (finding: LayoutDiagnostics['findings'][number]) => {
    if (!Number.isFinite(finding.overflowPx) || finding.overflowPx > 1_000_000) {
      incomplete('Some overflow measurements exceed the supported geometry bounds.')
      return
    }
    if (findings.length >= 100) {
      incomplete('The layout pass reached its 100-finding limit.')
      return
    }
    findings.push(finding)
  }
  const scrollable = (overflow: string, size: number, client: number) =>
    (overflow === 'auto' || overflow === 'scroll') && client > 0 && size > client + 1
  const clipped = (overflow: string) => overflow === 'hidden' || overflow === 'clip'
  const material = Math.max(16, viewport.width * 0.02)
  const pageOverflow =
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport.width
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
  let node: Element | null = document.documentElement
  let measured = 0
  let controls = 0
  let escaped: { element: Element; amount: number } | undefined
  try {
    const rootStyle = getComputedStyle(document.documentElement)
    const bodyOverflowPropagates =
      rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
    while (node) {
      if (++measured > 2000) {
        incomplete('The layout pass reached its 2,000-element limit.')
        break
      }
      const element = node as HTMLElement
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const control = ['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(
        element.localName,
      )
      if (
        style.clipPath !== 'none' ||
        style.maskImage !== 'none' ||
        style.clip !== 'auto' ||
        style.contentVisibility !== 'visible' ||
        /\b(paint|strict|content)\b/.test(style.contain)
      )
        incomplete('Some non-rectangular or skipped clipping regions were not measured.')
      const animations = element.getAnimations()
      if (
        animations.length > 8 ||
        animations
          .slice(0, 8)
          .some((animation) => animation.pending || animation.playState === 'running')
      )
        incomplete('Active animations prevented a stable layout pass.')
      if (
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        style.display !== 'none' &&
        style.visibility === 'visible' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        if (control && ++controls > 500) {
          incomplete('The layout pass reached its 500-control limit.')
          break
        }
        let xScrollable = false
        let yScrollable = false
        let clippingRegion = false
        const candidates: LayoutDiagnostics['findings'] = []
        let xEnvelope = { left: rect.left, right: rect.right }
        let yEnvelope = { top: rect.top, bottom: rect.bottom }
        let xClipped = false
        let horizontalEscape = Math.max(
          0,
          -(rect.left + scrollX),
          rect.right + scrollX - viewport.width,
        )
        let ancestor = element.parentElement
        let positioned = style.position === 'absolute' || style.position === 'fixed'
        let depth = 0
        while (ancestor) {
          if (++depth > 32) {
            incomplete('Some layout ancestor chains exceed 32 elements.')
            break
          }
          const parentStyle = getComputedStyle(ancestor)
          const sx = scrollable(parentStyle.overflowX, ancestor.scrollWidth, ancestor.clientWidth)
          const sy = scrollable(parentStyle.overflowY, ancestor.scrollHeight, ancestor.clientHeight)
          const cx =
            clipped(parentStyle.overflowX) ||
            (['auto', 'scroll'].includes(parentStyle.overflowX) && ancestor.clientWidth === 0)
          const cy =
            clipped(parentStyle.overflowY) ||
            (['auto', 'scroll'].includes(parentStyle.overflowY) && ancestor.clientHeight === 0)
          if (
            (cx || cy || sx || sy) &&
            (ancestor === document.documentElement ||
              (ancestor === document.body && bodyOverflowPropagates))
          ) {
            incomplete('Viewport overflow propagation was not measured.')
            break
          }
          if ((cx || cy || sx || sy) && ['contents', 'inline'].includes(parentStyle.display)) {
            incomplete('Non-box or inline clipping regions were not measured.')
            break
          }
          if (
            [parentStyle.overflowX, parentStyle.overflowY].includes('clip') &&
            parentStyle.overflowClipMargin !== '0px'
          ) {
            incomplete('Non-default overflow clip margins were not measured.')
            break
          }
          clippingRegion ||= cx || cy || sx || sy
          if (
            clippingRegion &&
            (parentStyle.transform !== 'none' ||
              parentStyle.scale !== 'none' ||
              parentStyle.rotate !== 'none' ||
              parentStyle.translate !== 'none' ||
              parentStyle.perspective !== 'none' ||
              parentStyle.offsetPath !== 'none' ||
              parentStyle.zoom !== '1')
          ) {
            incomplete('Transformed or zoomed clipping regions were not measured.')
            break
          }
          const parentRect = ancestor.getBoundingClientRect()
          const box = {
            left: parentRect.left + ancestor.clientLeft,
            top: parentRect.top + ancestor.clientTop,
            right: parentRect.left + ancestor.clientLeft + ancestor.clientWidth,
            bottom: parentRect.top + ancestor.clientTop + ancestor.clientHeight,
          }
          // Out-of-flow descendants can escape ordinary ancestor clipping. Their containing blocks are not resolved here.
          if (
            positioned &&
            ((cx && Math.max(box.left - xEnvelope.left, xEnvelope.right - box.right) >= 4) ||
              (cy && Math.max(box.top - yEnvelope.top, yEnvelope.bottom - box.bottom) >= 4))
          ) {
            incomplete('Positioned descendants crossing a clipping region were not measured.')
            break
          }
          if (sx) {
            xScrollable = true
            horizontalEscape = 0
            xEnvelope = { left: box.left, right: box.right }
          }
          if (sy) {
            yScrollable = true
            yEnvelope = { top: box.top, bottom: box.bottom }
          }
          if (cx) xClipped = true
          if (control) {
            const check = (
              axis: 'horizontal' | 'vertical',
              clip: boolean,
              reachable: boolean,
              start: number,
              end: number,
              lower: number,
              upper: number,
            ) => {
              if (!clip || upper < lower) return
              const excluded = upper === lower || end <= lower || start >= upper
              // An inner native scroller can move a control through its visible scrollport. Do not report its current position.
              if (reachable && !excluded) return
              const amount = Math.max(0, lower - start, end - upper)
              if (amount < 4) return
              candidates.push({
                rule: excluded ? 'unreachable-control' : 'clipped-control',
                selector: selector(element),
                axis,
                overflowPx: Math.round(amount * 100) / 100,
              })
            }
            check(
              'horizontal',
              cx,
              xScrollable,
              xEnvelope.left,
              xEnvelope.right,
              box.left,
              box.right,
            )
            check('vertical', cy, yScrollable, yEnvelope.top, yEnvelope.bottom, box.top, box.bottom)
          }
          positioned ||= parentStyle.position === 'absolute' || parentStyle.position === 'fixed'
          ancestor = ancestor.parentElement
        }
        // A higher ancestor can invalidate earlier clip measurements. Publish only after the whole bounded chain.
        if (!ancestor) {
          for (const finding of candidates) add(finding)
          if (
            pageOverflow > material &&
            horizontalEscape > material &&
            !xClipped &&
            (!escaped || horizontalEscape > escaped.amount)
          )
            escaped = { element, amount: horizontalEscape }
        }
      }
      node = walker.nextNode() as Element | null
    }
    if (escaped)
      add({
        rule: 'page-horizontal-overflow',
        selector: selector(escaped.element),
        axis: 'horizontal',
        overflowPx: Math.round(Math.min(pageOverflow, escaped.amount) * 100) / 100,
      })
  } catch {
    incomplete('The layout pass could not measure all document geometry.')
  }
  // A control may meet several clipping ancestors; keep one finding per rule/selector/axis.
  const unique = findings.filter(
    (finding, index) =>
      findings.findIndex(
        (other) =>
          other.rule === finding.rule &&
          other.selector === finding.selector &&
          other.axis === finding.axis,
      ) === index,
  )
  return { viewport, complete, findings: unique, ...(error ? { error } : {}) }
}
