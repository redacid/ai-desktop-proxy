import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FlowState, Route } from './routes'

/** Below this width the cards get too cramped in a row, so the diagram turns to run top to bottom. */
const ROW_MIN = 940
const SPEED = 0.15 // px per ms
const DWELL_MS = 900 // time a request spends "inside" a card
const MIN_LINE_MS = 1300 // short connectors still take long enough to follow
const PAUSE_MS = 900 // between two requests
/** How far into a client card its lane runs, and the space kept around the shared cards for the fallbacks. */
const LANE = 56

type Box = { x: number; y: number; w: number; h: number }
type Pt = [number, number]
type Kind = 'main' | 'bypass' | 'direct'
/** A request's journey: lines it travels and cards it passes through, in order. */
type Leg = { line: Pt[] } | { node: number; at: Pt }

interface Geometry { width: number; height: number; row: boolean; clients: Box[]; proxy: Box; headroom: Box; providers: Box[] }
/** One client's own paths. Lanes never share a line: each client talks only to its own provider. */
interface Lane {
  toProxy: Pt[]; toHeadroom: Pt[]; toProvider: Pt[]
  bypass: Pt[] // mitmproxy straight to the provider while headroom is down
  direct: Pt[] // the client straight to its provider, not through the proxy
  port: Pt // where the listener port is written
  y: number // the lane's line through the shared cards
}

// The diagram is computed left to right; top to bottom is the same picture with x and y swapped.
const swapBox = (b: Box): Box => ({ x: b.y, y: b.x, w: b.h, h: b.w })
const swapPt = (p: Pt): Pt => [p[1], p[0]]

function lanes(g: Geometry): Lane[] {
  const t = g.row ? (b: Box): Box => b : swapBox
  const proxy = t(g.proxy)
  const headroom = t(g.headroom)
  const pr = proxy.x + proxy.w
  const hr = headroom.x + headroom.w
  const out = g.clients.map((cb, i): Lane => {
    const c = t(cb)
    const p = t(g.providers[i])
    const first = i === 0
    // The first lane keeps to the top edge of the shared cards, the last to the bottom edge.
    const sign = first ? -1 : 1
    const y = first ? c.y + LANE : c.y + c.h - LANE
    const edge = first ? proxy.y : proxy.y + proxy.h
    const near = y + sign * 14 // bypass, just beside the main line
    const bypassBand = edge + sign * 12
    const directBand = edge + sign * 28
    const directY = first ? c.y + 24 : c.y + c.h - 24
    const cr = c.x + c.w
    return {
      y,
      toProxy: [[cr, y], [proxy.x - 3, y]],
      toHeadroom: [[pr, y], [headroom.x - 3, y]],
      toProvider: [[hr, y], [p.x - 3, y]],
      bypass: [[pr, near], [pr + 12, near], [pr + 12, bypassBand], [hr + 12, bypassBand], [hr + 12, near], [p.x - 3, near]],
      direct: [[cr, directY], [cr + 10, directY], [cr + 10, directBand], [p.x - 10, directBand], [p.x - 10, directY], [p.x - 3, directY]],
      port: [(cr + proxy.x) / 2, y - 6]
    }
  })
  if (g.row) return out
  const back = (pts: Pt[]): Pt[] => pts.map(swapPt)
  return out.map((l) => ({ ...l, toProxy: back(l.toProxy), toHeadroom: back(l.toHeadroom), toProvider: back(l.toProvider),
    bypass: back(l.bypass), direct: back(l.direct), port: [l.port[1] + 6, l.port[0] + 4] }))
}

/** The legs of one client's request: through every card it passes, along that client's own lines. */
function journey(i: number, route: Route, g: Geometry, lane: Lane): Leg[] {
  const n = g.clients.length
  // Inside a shared card the request stays on its own lane, so two clients never seem to meet.
  const on = (b: Box): Pt => g.row ? [b.x + b.w / 2, lane.y] : [lane.y, b.y + b.h / 2]
  const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2]
  const client = { node: i, at: centre(g.clients[i]) }
  const provider = { node: n + 2 + i, at: centre(g.providers[i]) }
  if (route === 'compressed') {
    return [client, { line: lane.toProxy }, { node: n, at: on(g.proxy) }, { line: lane.toHeadroom },
      { node: n + 1, at: on(g.headroom) }, { line: lane.toProvider }, provider]
  }
  if (route === 'uncompressed') return [client, { line: lane.toProxy }, { node: n, at: on(g.proxy) }, { line: lane.bypass }, provider]
  return [client, { line: lane.direct }, provider]
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
 * The request path, one lane per client app: client → its mitmproxy listener → headroom → that client's provider,
 * with the fallbacks (mitmproxy straight to the provider while headroom is down; the client going direct when it is
 * not routed) drawn around the shared cards. A request labelled with its client travels the lane in use and lights up
 * each card it passes through; clients take turns.
 */
export function Flow({ flow, clients, providers, ports, children }: {
  flow: FlowState
  /** One card per client app, in the order of `flow.routes`. */
  clients: React.ReactNode[]
  /** Each client's provider card, in the same order. */
  providers: React.ReactNode[]
  /** Each client's mitmproxy listener, e.g. ":8877". */
  ports: string[]
  /** The shared cards: mitmproxy, headroom. */
  children: [React.ReactNode, React.ReactNode]
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Node order: clients, proxy, headroom, providers.
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const packet = useRef<SVGGElement>(null)
  const [measured, setGeo] = useState<Geometry | null>(null)
  const n = clients.length
  // A measurement taken before the client list arrived (or changed) describes other cards: wait for the next one.
  const geo = measured && measured.clients.length === n && measured.providers.length === n ? measured : null

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const els = nodes.current.slice(0, 2 * n + 2)
      if (els.length < 2 * n + 2 || els.some((e) => !e)) return // mid re-render; the next resize measures again
      const base = el.getBoundingClientRect()
      const boxes = els.map((node) => {
        const r = node!.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      })
      setGeo((old) => {
        const next = { width: base.width, height: base.height, row: base.width >= ROW_MIN,
          clients: boxes.slice(0, n), proxy: boxes[n], headroom: boxes[n + 1], providers: boxes.slice(n + 2) }
        return JSON.stringify(old) === JSON.stringify(next) ? old : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    nodes.current.forEach((node) => node && observer.observe(node))
    return () => observer.disconnect()
  }, [n])

  const plan = JSON.stringify(flow.routes.map((r) => r.route))
  useEffect(() => {
    const g = geo
    const dot = packet.current
    const senders = flow.routes.map((r, i) => ({ ...r, i })).filter((r) => r.route !== 'none')
    if (!g || !dot || !senders.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ls = lanes(g)
    const trips = senders.map((s) => ({ name: s.name, kind: KIND[s.route], legs: journey(s.i, s.route, g, ls[s.i]) }))
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
  const ls = geo ? lanes(geo) : []
  const tracks = ls.flatMap((l, i) => {
    const r = flow.routes[i]?.route ?? 'none'
    const proxied = r === 'compressed' || r === 'uncompressed'
    return [
      { pts: l.direct, kind: 'direct' as Kind, active: r === 'direct' },
      { pts: l.bypass, kind: 'bypass' as Kind, active: r === 'uncompressed' },
      { pts: l.toProxy, kind: 'main' as Kind, active: proxied },
      { pts: l.toHeadroom, kind: 'main' as Kind, active: r === 'compressed' },
      { pts: l.toProvider, kind: 'main' as Kind, active: r === 'compressed' }
    ]
  })
  // Explicit grid places: clients and their providers share a row (column when stacked), the shared cards span them.
  const place = (line: number, span: boolean, track: number): React.CSSProperties => row
    ? { gridColumn: line, gridRow: span ? `1 / span ${n}` : track }
    : { gridRow: line, gridColumn: span ? `1 / span ${n}` : track }
  const node = (i: number) => (el: HTMLDivElement | null): void => { nodes.current[i] = el }
  return (
    <>
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
            {/* Idle paths first, so the ones in use are drawn on top. */}
            {[...tracks.filter((t) => !t.active), ...tracks.filter((t) => t.active)].map((t, i) => (
              <g key={i} className={`flow-path ${t.kind} ${t.active ? 'active' : 'idle'}`}>
                <path d={pathD(t.pts)} className="track" markerEnd={`url(#flow-arrow-${t.kind}-${t.active ? 'on' : 'off'})`} />
                {t.active && <path d={pathD(t.pts)} className="dots" />}
              </g>
            ))}
            {ls.map((l, i) => (
              <text key={i} className="flow-port" x={l.port[0]} y={l.port[1]} textAnchor="middle">{ports[i]}</text>
            ))}
          </svg>
        )}
        {clients.map((child, i) => <div key={`c${i}`} className="flow-node" style={place(1, false, i + 1)} ref={node(i)}>{child}</div>)}
        {children.map((child, i) => <div key={`s${i}`} className="flow-node shared" style={place(i + 2, true, 1)} ref={node(n + i)}>{child}</div>)}
        {providers.map((child, i) => <div key={`p${i}`} className="flow-node" style={place(4, false, i + 1)} ref={node(n + 2 + i)}>{child}</div>)}
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
      <ul className="flow-legend">
        <li className="main">through headroom, compressed</li>
        <li className="bypass">headroom down: mitmproxy sends it straight to the provider</li>
        <li className="direct">not routed, or proxy down: the client goes direct</li>
      </ul>
    </>
  )
}
