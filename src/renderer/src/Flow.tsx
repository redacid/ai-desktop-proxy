import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FlowState, Route } from './routes'

/** Below this width the cards get too cramped in a row, so they stack instead. */
const ROW_MIN = 940
const SPEED = 0.15 // px per ms
const DWELL_MS = 900 // time a request spends "inside" a card
const MIN_LINE_MS = 1300 // short connectors still take long enough to follow
const PAUSE_MS = 900 // between two requests

type Box = { x: number; y: number; w: number; h: number }
type Pt = [number, number]
type Kind = 'main' | 'bypass' | 'direct'
type Track = { pts: Pt[]; kind: Kind; active: boolean; label?: { at: Pt; text: string } }
/** A request's journey: lines it travels and cards it passes through, in order. */
type Leg = { line: Pt[] } | { node: number; at: Pt }

interface Geometry { width: number; height: number; row: boolean; clients: Box[]; proxy: Box; headroom: Box; provider: Box }
interface Lines { toProxy: Pt[][]; direct: Pt[][]; proxyHeadroom: Pt[]; headroomProvider: Pt[]; bypass: Pt[]; labels: [Pt, Pt] | null }

function layout(g: Geometry): Lines {
  const { clients, proxy, headroom, provider, row, width } = g
  if (row) {
    // Clients are stacked in the first column; each joins the proxy's input, and goes down to the direct lane.
    const bottom = Math.max(...[...clients, proxy, headroom, provider].map((b) => b.y + b.h))
    const l1 = bottom + 22
    const l2 = bottom + 50
    const py = proxy.y + 28
    const right = clients[0].x + clients[0].w
    const join = right + (proxy.x - right) * 0.62
    const drop = right + 14
    const px = proxy.x + proxy.w / 2
    const t1 = provider.x + provider.w * 0.38
    const t2 = provider.x + provider.w * 0.68
    const end = provider.y + provider.h + 3
    return {
      toProxy: clients.map((c) => [[c.x + c.w, c.y + 28], [join, c.y + 28], [join, py], [proxy.x - 3, py]]),
      direct: clients.map((c) => [[c.x + c.w, c.y + c.h - 24], [drop, c.y + c.h - 24], [drop, l2], [t2, l2], [t2, end]]),
      proxyHeadroom: [[proxy.x + proxy.w, py], [headroom.x - 3, py]],
      headroomProvider: [[headroom.x + headroom.w, py], [provider.x - 3, py]],
      bypass: [[px, proxy.y + proxy.h], [px, l1], [t1, l1], [t1, end]],
      labels: [[(px + t1) / 2, l1 - 6], [(drop + t2) / 2, l2 - 6]]
    }
  }
  // Clients side by side on top, the rest stacked below; fallbacks run in lanes on the right.
  const lane1 = Math.min(Math.max(...[proxy, headroom, provider].map((b) => b.x + b.w)) + 18, width - 30)
  const lane2 = Math.min(lane1 + 22, width - 8)
  const end = provider.x + provider.w + 3
  return {
    toProxy: clients.map((c) => [[c.x + c.w * 0.3, c.y + c.h], [c.x + c.w * 0.3, proxy.y - 3]]),
    direct: clients.map((c) => [[c.x + c.w * 0.75, c.y + c.h], [c.x + c.w * 0.75, c.y + c.h + 12], [lane2, c.y + c.h + 12],
      [lane2, provider.y + 54], [end, provider.y + 54]]),
    proxyHeadroom: [[proxy.x + 36, proxy.y + proxy.h], [proxy.x + 36, headroom.y - 3]],
    headroomProvider: [[headroom.x + 36, headroom.y + headroom.h], [headroom.x + 36, provider.y - 3]],
    bypass: [[proxy.x + proxy.w, proxy.y + 40], [lane1, proxy.y + 40], [lane1, provider.y + 30], [end, provider.y + 30]],
    labels: null
  }
}

const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2]

/** The legs of one client's request: through every card it passes, along the lines between them. */
function journey(i: number, route: Route, g: Geometry, l: Lines): Leg[] {
  const n = g.clients.length
  const node = (k: number, b: Box): Leg => ({ node: k, at: centre(b) })
  const start = node(i, g.clients[i])
  if (route === 'compressed') {
    return [start, { line: l.toProxy[i] }, node(n, g.proxy), { line: l.proxyHeadroom }, node(n + 1, g.headroom),
      { line: l.headroomProvider }, node(n + 2, g.provider)]
  }
  if (route === 'uncompressed') return [start, { line: l.toProxy[i] }, node(n, g.proxy), { line: l.bypass }, node(n + 2, g.provider)]
  return [start, { line: l.direct[i] }, node(n + 2, g.provider)]
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
 * Lays the cards out in request order, one card per client app, and animates requests through them: a dot labelled
 * with the client travels that client's route, the card it passes through lights up, and the fallbacks stay visible
 * as dashed lanes even when unused.
 */
export function Flow({ flow, clients, children }: {
  flow: FlowState
  /** One card per client app, in the order of `flow.routes`. */
  clients: React.ReactNode[]
  children: [React.ReactNode, React.ReactNode, React.ReactNode]
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Client cards first, then proxy, headroom, provider.
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const packet = useRef<SVGGElement>(null)
  const [geo, setGeo] = useState<Geometry | null>(null)
  const n = clients.length

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const base = el.getBoundingClientRect()
      const boxes = nodes.current.slice(0, n + 3).map((node) => {
        const r = node!.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      })
      setGeo((old) => {
        const next = { width: base.width, height: base.height, row: base.width >= ROW_MIN,
          clients: boxes.slice(0, n), proxy: boxes[n], headroom: boxes[n + 1], provider: boxes[n + 2] }
        return JSON.stringify(old) === JSON.stringify(next) ? old : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    nodes.current.forEach((node) => node && observer.observe(node))
    return () => observer.disconnect()
  }, [n])

  // One request at a time, taking turns between the clients that send any, so each client's path is shown.
  const plan = JSON.stringify(flow.routes.map((r) => r.route))
  useEffect(() => {
    const g = geo
    const dot = packet.current
    const senders = flow.routes.map((r, i) => ({ ...r, i })).filter((r) => r.route !== 'none')
    if (!g || !dot || !senders.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const l = layout(g)
    const trips = senders.map((s) => ({ name: s.name, kind: KIND[s.route], legs: journey(s.i, s.route, g, l) }))
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
  const route = (i: number): Route => flow.routes[i]?.route ?? 'none'
  const tracks: Track[] = l ? [
    ...l.direct.map((pts, i): Track => ({ pts, kind: 'direct', active: route(i) === 'direct' })),
    ...l.toProxy.map((pts, i): Track => ({ pts, kind: 'main', active: route(i) === 'compressed' || route(i) === 'uncompressed' })),
    { pts: l.proxyHeadroom, kind: 'main', active: flow.main[1] },
    { pts: l.headroomProvider, kind: 'main', active: flow.main[2] },
    { pts: l.bypass, kind: 'bypass', active: flow.bypass,
      label: l.labels ? { at: l.labels[0], text: 'headroom down: mitmproxy sends requests straight to the provider' } : undefined }
  ] : []
  if (l?.labels) tracks.push({ pts: [], kind: 'direct', active: flow.direct, label: { at: l.labels[1], text: 'not routed, or proxy down: the client goes direct' } })
  const node = (i: number) => (el: HTMLDivElement | null): void => { nodes.current[i] = el }
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
          {/* Idle paths first, so the ones in use are drawn on top where lanes share a line. */}
          {[...tracks.filter((t) => !t.active), ...tracks.filter((t) => t.active)].map((t, i) => (
            <g key={i} className={`flow-path ${t.kind} ${t.active ? 'active' : 'idle'}`}>
              {t.pts.length > 0 && <path d={pathD(t.pts)} className="track" markerEnd={`url(#flow-arrow-${t.kind}-${t.active ? 'on' : 'off'})`} />}
              {t.active && t.pts.length > 0 && <path d={pathD(t.pts)} className="dots" />}
              {t.label && <text x={t.label.at[0]} y={t.label.at[1]} textAnchor="middle">{t.label.text}</text>}
            </g>
          ))}
        </svg>
      )}
      <div className="flow-clients">
        {clients.map((child, i) => <div key={i} className="flow-node" ref={node(i)}>{child}</div>)}
      </div>
      {children.map((child, i) => <div key={i} className="flow-node" ref={node(n + i)}>{child}</div>)}
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
    </div>
  )
}
