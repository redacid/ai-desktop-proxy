import { useLayoutEffect, useRef, useState } from 'react'
import type { FlowState } from './routes'

/** Wide enough for four cards in a row; narrower windows stack them. */
const ROW_MIN = 1020

type Box = { x: number; y: number; w: number; h: number }
type Path = { d: string; kind: 'main' | 'bypass' | 'direct'; active: boolean; label?: { x: number; y: number; text: string } }

function paths(boxes: Box[], width: number, row: boolean, flow: FlowState): Path[] {
  const [clients, proxy, , provider] = boxes
  const out: Path[] = []
  // Main path: consecutive cards, right edge → left edge (row) or bottom → top (column).
  boxes.slice(0, 3).forEach((a, i) => {
    const b = boxes[i + 1]
    const d = row
      ? `M${a.x + a.w} ${a.y + 28}H${b.x - 3}`
      : `M${a.x + 36} ${a.y + a.h}V${b.y - 3}`
    out.push({ d, kind: 'main', active: flow.main[i] })
  })
  // Detours run in a lane below the cards (row) or to their right (column), so they never cross a card.
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  if (row) {
    const lane1 = bottom + 22
    const lane2 = bottom + 50
    const px = proxy.x + proxy.w / 2
    const cx = clients.x + clients.w / 2
    const t1 = provider.x + provider.w * 0.38
    const t2 = provider.x + provider.w * 0.68
    out.push({ d: `M${px} ${proxy.y + proxy.h}V${lane1}H${t1}V${provider.y + provider.h + 3}`, kind: 'bypass', active: flow.bypass,
      label: { x: (px + t1) / 2, y: lane1 - 6, text: 'headroom down: mitmproxy sends requests straight to the provider' } })
    out.push({ d: `M${cx} ${clients.y + clients.h}V${lane2}H${t2}V${provider.y + provider.h + 3}`, kind: 'direct', active: flow.direct,
      label: { x: (cx + t2) / 2, y: lane2 - 6, text: 'not routed, or proxy down: the client goes direct' } })
  } else {
    const lane1 = Math.min(right + 18, width - 30)
    const lane2 = Math.min(right + 40, width - 8)
    const py = proxy.y + 40
    const cy = clients.y + 40
    const t1 = provider.y + 30
    const t2 = provider.y + 54
    out.push({ d: `M${proxy.x + proxy.w} ${py}H${lane1}V${t1}H${provider.x + provider.w + 3}`, kind: 'bypass', active: flow.bypass })
    out.push({ d: `M${clients.x + clients.w} ${cy}H${lane2}V${t2}H${provider.x + provider.w + 3}`, kind: 'direct', active: flow.direct })
  }
  return out
}

/**
 * Lays the four cards out in request order and draws how requests travel between them. Moving dots mark the
 * paths in use right now; unused paths stay as faint dashes so the fallbacks are always visible.
 */
export function Flow({ flow, children }: { flow: FlowState; children: [React.ReactNode, React.ReactNode, React.ReactNode, React.ReactNode] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const [geo, setGeo] = useState<{ width: number; height: number; row: boolean; boxes: Box[] } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const base = el.getBoundingClientRect()
      const boxes = nodes.current.map((n) => {
        const r = n!.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      })
      setGeo({ width: base.width, height: base.height, row: base.width >= ROW_MIN, boxes })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    nodes.current.forEach((n) => n && observer.observe(n))
    return () => observer.disconnect()
  }, [])

  const row = geo ? geo.row : true
  return (
    <div className={`flow ${row ? 'flow-row' : 'flow-column'}`} ref={ref}>
      {children.map((child, i) => (
        <div key={i} className="flow-node" ref={(n) => { nodes.current[i] = n }}>{child}</div>
      ))}
      {geo && (
        <svg className="flow-lines" width={geo.width} height={geo.height} aria-hidden="true">
          <defs>
            {(['main', 'bypass', 'direct'] as const).flatMap((k) => (['on', 'off'] as const).map((on) => (
              <marker key={k + on} id={`flow-arrow-${k}-${on}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L10 5L0 10z" className={`flow-head ${k} ${on}`} />
              </marker>
            )))}
          </defs>
          {paths(geo.boxes, geo.width, geo.row, flow).map((p, i) => (
            <g key={i} className={`flow-path ${p.kind} ${p.active ? 'active' : 'idle'}`}>
              <path d={p.d} className="track" markerEnd={`url(#flow-arrow-${p.kind}-${p.active ? 'on' : 'off'})`} />
              {p.active && <path d={p.d} className="dots" />}
              {p.label && <text x={p.label.x} y={p.label.y} textAnchor="middle">{p.label.text}</text>}
            </g>
          ))}
        </svg>
      )}
    </div>
  )
}
