import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FlowState, Route } from './routes'

/** Below this width four cards in a row get too cramped, so they stack instead. */
const ROW_MIN = 940
const SPEED = 0.32 // px per ms
const DWELL_MS = 500 // time a request spends "inside" a card
const MIN_LINE_MS = 700 // short connectors still take long enough to follow
const PAUSE_MS = 500 // between two requests

type Box = { x: number; y: number; w: number; h: number }
type Pt = [number, number]
type Kind = 'main' | 'bypass' | 'direct'
type Track = { pts: Pt[]; kind: Kind; active: boolean; label?: { x: number; y: number; text: string } }
/** A request's journey: lines it travels and cards it passes through, in order. */
type Leg = { line: Pt[] } | { node: number; at: Pt }

interface Geometry { width: number; height: number; row: boolean; boxes: Box[] }

function layout(g: Geometry): { connectors: Pt[][]; bypass: Pt[]; direct: Pt[]; labels: [Pt, Pt] | null } {
  const { boxes, row, width } = g
  const [clients, proxy, , provider] = boxes
  const connectors = boxes.slice(0, 3).map((a, i): Pt[] => {
    const b = boxes[i + 1]
    return row ? [[a.x + a.w, a.y + 28], [b.x - 3, a.y + 28]] : [[a.x + 36, a.y + a.h], [a.x + 36, b.y - 3]]
  })
  // Fallbacks run in lanes below the cards (row) or to their right (column), so they never cross a card.
  if (row) {
    const bottom = Math.max(...boxes.map((b) => b.y + b.h))
    const l1 = bottom + 22
    const l2 = bottom + 50
    const px = proxy.x + proxy.w / 2
    const cx = clients.x + clients.w / 2
    const t1 = provider.x + provider.w * 0.38
    const t2 = provider.x + provider.w * 0.68
    const end = provider.y + provider.h + 3
    return {
      connectors,
      bypass: [[px, proxy.y + proxy.h], [px, l1], [t1, l1], [t1, end]],
      direct: [[cx, clients.y + clients.h], [cx, l2], [t2, l2], [t2, end]],
      labels: [[(px + t1) / 2, l1 - 6], [(cx + t2) / 2, l2 - 6]]
    }
  }
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const l1 = Math.min(right + 18, width - 30)
  const l2 = Math.min(right + 40, width - 8)
  const end = provider.x + provider.w + 3
  return {
    connectors,
    bypass: [[proxy.x + proxy.w, proxy.y + 40], [l1, proxy.y + 40], [l1, provider.y + 30], [end, provider.y + 30]],
    direct: [[clients.x + clients.w, clients.y + 40], [l2, clients.y + 40], [l2, provider.y + 54], [end, provider.y + 54]],
    labels: null
  }
}

const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2]

/** The legs of one request on a route: through every card it passes, along the lines between them. */
function journey(route: Route, g: Geometry, l: ReturnType<typeof layout>): Leg[] {
  const node = (i: number): Leg => ({ node: i, at: centre(g.boxes[i]) })
  if (route === 'compressed') {
    return [node(0), { line: l.connectors[0] }, node(1), { line: l.connectors[1] }, node(2), { line: l.connectors[2] }, node(3)]
  }
  if (route === 'uncompressed') return [node(0), { line: l.connectors[0] }, node(1), { line: l.bypass }, node(3)]
  return [node(0), { line: l.direct }, node(3)]
}

const length = (pts: Pt[]): number => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0)
function pointAt(pts: Pt[], dist: number): Pt {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (dist <= seg) {
      const t = seg ? dist / seg : 0
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]
    }
    dist -= seg
  }
  return pts[pts.length - 1]
}
const legMs = (leg: Leg): number => 'line' in leg ? Math.max(length(leg.line) / SPEED, MIN_LINE_MS) : DWELL_MS
const pathD = (pts: Pt[]): string => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')
const KIND: Record<Route, Kind> = { compressed: 'main', uncompressed: 'bypass', direct: 'direct', none: 'direct' }

/**
 * Lays the four cards out in request order and animates requests through them: a dot travels each route in use,
 * the card it passes through lights up, and the fallbacks stay visible as dashed lanes even when unused.
 */
export function Flow({ flow, children }: { flow: FlowState; children: [React.ReactNode, React.ReactNode, React.ReactNode, React.ReactNode] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const packet = useRef<SVGGElement>(null)
  const [geo, setGeo] = useState<Geometry | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const base = el.getBoundingClientRect()
      const boxes = nodes.current.map((n) => {
        const r = n!.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      })
      setGeo((old) => {
        const next = { width: base.width, height: base.height, row: base.width >= ROW_MIN, boxes }
        return JSON.stringify(old) === JSON.stringify(next) ? old : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    nodes.current.forEach((n) => n && observer.observe(n))
    return () => observer.disconnect()
  }, [])

  // One request at a time, taking turns between the clients that send any, so each client's path is shown.
  const senders = flow.routes.filter((r) => r.route !== 'none')
  const plan = JSON.stringify(senders.map((r) => [r.name, r.route]))
  useEffect(() => {
    const g = geo
    const dot = packet.current
    if (!g || !dot || !senders.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const l = layout(g)
    const trips = senders.map((s) => ({ name: s.name, kind: KIND[s.route], legs: journey(s.route, g, l) }))
    const label = dot.querySelector('text')!
    let trip = 0
    let start = performance.now()
    let frame = 0
    let lit = -1
    const light = (i: number, kind?: Kind): void => {
      if (i === lit) return
      nodes.current[lit]?.classList.remove('visiting', 'main', 'bypass', 'direct')
      if (kind) nodes.current[i]?.classList.add('visiting', kind)
      lit = i
    }
    const tick = (now: number): void => {
      const t = trips[trip]
      let elapsed = now - start
      let found = false
      let onLine = false
      for (const leg of t.legs) {
        const ms = legMs(leg)
        if (elapsed <= ms) {
          const [x, y] = 'line' in leg ? pointAt(leg.line, (elapsed / ms) * length(leg.line)) : leg.at
          dot.setAttribute('transform', `translate(${x} ${y})`)
          light('node' in leg ? leg.node : -1, t.kind)
          found = true
          onLine = 'line' in leg
          break
        }
        elapsed -= ms
      }
      if (!found) {
        light(-1)
        if (elapsed > PAUSE_MS) {
          trip = (trip + 1) % trips.length
          start = now
        }
      }
      dot.setAttribute('class', `flow-packet ${t.kind}${onLine ? '' : ' gone'}`)
      label.textContent = t.name
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      light(-1)
    }
  }, [geo, plan])

  const row = geo ? geo.row : true
  const l = geo ? layout(geo) : null
  const tracks: Track[] = l ? [
    ...l.connectors.map((pts, i): Track => ({ pts, kind: 'main', active: flow.main[i] })),
    { pts: l.bypass, kind: 'bypass', active: flow.bypass,
      label: l.labels ? { x: l.labels[0][0], y: l.labels[0][1], text: 'headroom down: mitmproxy sends requests straight to the provider' } : undefined },
    { pts: l.direct, kind: 'direct', active: flow.direct,
      label: l.labels ? { x: l.labels[1][0], y: l.labels[1][1], text: 'not routed, or proxy down: the client goes direct' } : undefined }
  ] : []
  return (
    <div className={`flow ${row ? 'flow-row' : 'flow-column'}`} ref={ref}>
      {geo && (
        <svg className="flow-lines" width={geo.width} height={geo.height} aria-hidden="true">
          <defs>
            {(['main', 'bypass', 'direct'] as const).flatMap((k) => (['on', 'off'] as const).map((on) => (
              <marker key={k + on} id={`flow-arrow-${k}-${on}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L10 5L0 10z" className={`flow-head ${k} ${on}`} />
              </marker>
            )))}
          </defs>
          {tracks.map((t, i) => (
            <g key={i} className={`flow-path ${t.kind} ${t.active ? 'active' : 'idle'}`}>
              <path d={pathD(t.pts)} className="track" markerEnd={`url(#flow-arrow-${t.kind}-${t.active ? 'on' : 'off'})`} />
              {t.active && <path d={pathD(t.pts)} className="dots" />}
              {t.label && <text x={t.label.x} y={t.label.y} textAnchor="middle">{t.label.text}</text>}
            </g>
          ))}
        </svg>
      )}
      {geo && (
        // Above the cards so its label is never covered; hidden while the request is "inside" a card.
        <svg className="flow-lines flow-top" width={geo.width} height={geo.height} aria-hidden="true">
          <g ref={packet} className="flow-packet gone">
            <circle r="10" className="halo" />
            <circle r="5.5" className="core" />
            <text y="-15" textAnchor="middle" />
          </g>
        </svg>
      )}
      {children.map((child, i) => (
        <div key={i} className="flow-node" ref={(n) => { nodes.current[i] = n }}>{child}</div>
      ))}
    </div>
  )
}
