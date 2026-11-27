"use client";

import {useEffect, useId, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import type {ChartMetricId, ChartPanel, ChartPoint, ChartSeries, ChartType, ChartUnit} from './chart-types';
import {formatChartMonth, groupChartPanels} from './monthly-chart-model';

type Props = {series: ChartSeries[]; type: Exclude<ChartType, 'waterfall'>; onRemoveMetric?: (id: ChartMetricId) => void};
type ActiveMonth = {index: number; panel: number; mode: 'hover' | 'focus' | 'pinned'};
const dash = (offset: number) => offset === 1 ? '7 5' : offset === 2 ? '2 4' : undefined;
const opacity = (offset: number) => offset === 1 ? .9 : offset === 2 ? .8 : 1;
// Preserve each metric's hue while keeping it readable on the app's light and
// dark surfaces. Use the identical color for plot, chips, table and legend.
export const chartSeriesColor = (color: string) => `color-mix(in srgb, ${color} 70%, var(--ink))`;
const unitTitles: Record<ChartUnit, string> = {'kWh': 'Production & energy', '$': 'Revenue & costs', 'kWh/m²': 'Insolation', 'kWh/kWp': 'Specific yield', '%': 'Performance'};

// Normalize the geometry before subtracting bounds: finite but extreme positive and
// negative values can otherwise overflow their span. Display always uses model text.
function scaleFor(panel: ChartPanel, unit: ChartUnit) {
  let magnitude = 0;
  for (const s of panel.series) if (s.metric.unit === unit) for (const p of s.points) {
    if (p.plotValue !== null) magnitude = Math.max(magnitude, Math.abs(p.plotValue));
  }
  magnitude ||= 1;
  let low = 0, high = 0;
  for (const s of panel.series) if (s.metric.unit === unit) for (const p of s.points) {
    if (p.plotValue !== null) {low = Math.min(low, p.plotValue / magnitude); high = Math.max(high, p.plotValue / magnitude);}
  }
  if (low === high) high = 1;
  return {magnitude, low, high, fraction: (value: number) => (value / magnitude - low) / (high - low)};
}
function axisNumber(value: number) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e12 || abs < .01) return value.toExponential(1);
  return new Intl.NumberFormat('en-US', {notation: abs >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 2}).format(value);
}
function period(series: ChartSeries) {
  const first = series.points[0]?.sourceMonth, last = series.points.at(-1)?.sourceMonth;
  return first && last ? first === last ? formatChartMonth(first) : `${formatChartMonth(first)} to ${formatChartMonth(last)}` : '';
}
function displayUnit(point: ChartPoint, unit: ChartUnit) {
  return unit === '%' && point.display.endsWith('%') ? '' : unit;
}
function pointLabel(point: ChartPoint, series: ChartSeries) {
  const unit = displayUnit(point, series.metric.unit);
  return `${series.label}: ${point.display}${unit ? ` ${unit}` : ''}. Source ${formatChartMonth(point.sourceMonth)}. ${point.state}${point.reason ? `: ${point.reason}` : ''}`;
}
function PointDetails({point}: {point: ChartPoint}) {
  return <>
    {point.state !== 'available' && <span className={`mc-quality mc-quality-${point.state}`}>{point.state}</span>}
    {point.reason && <span className="mc-point-reason">{point.reason}</span>}
    {point.details.length > 0 && <ul className="mc-provenance">{point.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
  </>;
}

export default function MonthlyChartPlot({series, type, onRemoveMetric}: Props) {
  const instanceId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHitRef = useRef<SVGRectElement | null>(null);
  const skipFocusRef = useRef(false);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<ActiveMonth | null>(null);
  const panels = useMemo(() => groupChartPanels(series), [series]);
  const anchors = series[0]?.points.map(point => point.anchorMonth) ?? [];
  const shown = active && active.index < anchors.length ? active : null;
  const detailId = `${instanceId}-month-details`;
  const instructionId = `${instanceId}-instructions`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = () => setWidth(Math.max(280, root.clientWidth));
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!shown) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const details = rootRef.current?.querySelector('[data-month-details]');
      if (details?.contains(document.activeElement)) dismiss();
      else setActive(null);
    };
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setActive(previous => previous?.mode === 'pinned' ? previous : null);
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    return () => {document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside);};
  }, [shown]);

  function dismiss() {
    skipFocusRef.current = true;
    lastHitRef.current?.focus({preventScroll: true});
    skipFocusRef.current = false;
    setActive(null);
  }
  function move(event: KeyboardEvent<SVGRectElement>, panel: number, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? anchors.length - 1
      : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(anchors.length - 1, index + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, index - 1) : null;
    if (next !== null) {
      event.preventDefault();
      const hit = rootRef.current?.querySelector<SVGRectElement>(`[data-chart-hit="${panel}:${next}"]`);
      setActive({panel, index: next, mode: 'focus'});
      hit?.focus({preventScroll: true});
      hit?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); setActive({panel, index, mode: 'pinned'});
    } else if (event.key === 'Escape') {
      event.preventDefault(); setActive(null);
    }
  }

  if (!series.length || !anchors.length) return null;
  if (type === 'table') return <div className="mc-table-scroll" tabIndex={0} role="region" aria-label="Monthly chart values, horizontally scrollable">
    <table className="mc-table">
      <caption>Monthly source values. Prior periods show their original source month; blank values are not zero.</caption>
      <thead><tr><th scope="col">Selected month</th>{series.map(s => <th scope="col" key={s.id}>
        <span className="mc-table-series" style={{borderColor: chartSeriesColor(s.metric.color), borderTopStyle: s.yearOffset === 1 ? 'dashed' : s.yearOffset === 2 ? 'dotted' : 'solid'}}>{s.label}</span>
        <small>{s.metric.unit} / {period(s)}</small>
      </th>)}</tr></thead>
      <tbody>{anchors.map((month, index) => <tr key={month}>
        <th scope="row">{formatChartMonth(month)}</th>
        {series.map(s => {const point = s.points[index]; return <td key={s.id} data-series={s.id} data-source-month={point.sourceMonth}>
          <strong>{point.display}</strong> <span className="mc-value-unit">{displayUnit(point, s.metric.unit)}</span>
          <small>Source: {formatChartMonth(point.sourceMonth)}</small>
          {(point.reason || point.details.length > 0 || point.state !== 'available') && <details className="mc-cell-details"><summary>{point.state === 'available' ? 'Source details' : `${point.state} / details`}</summary><PointDetails point={point}/></details>}
        </td>;})}
      </tr>)}</tbody>
    </table>
  </div>;

  return <div className="mc-chart-result" ref={rootRef}
    onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(previous => previous?.mode === 'focus' ? null : previous);}}>
    <p id={instructionId} className="mc-interaction-hint">Hover or focus a month for details. Arrow keys move between months; tap or press Enter to pin. Close or Escape dismisses.</p>
    {panels.map((panel, panelIndex) => {
      const title = panel.units.length === 1 ? unitTitles[panel.units[0]] : 'Monthly performance';
      const left = 70, right = panel.units.length === 2 ? 84 : 22, top = 30, bottom = 44, height = 290;
      const minimumSlot = type === 'bar' ? Math.max(24, panel.series.length * 7 + 8) : anchors.length > 24 ? 24 : 0;
      const plotWidth = Math.max(width, left + right + anchors.length * minimumSlot);
      const innerWidth = plotWidth - left - right, innerHeight = height - top - bottom;
      const slotWidth = innerWidth / anchors.length;
      const x = (index: number) => left + slotWidth * (index + .5);
      const scales = new Map(panel.units.map(unit => [unit, scaleFor(panel, unit)]));
      const y = (value: number, unit: ChartUnit) => top + innerHeight * (1 - scales.get(unit)!.fraction(value));
      const every = Math.max(1, Math.ceil(78 / slotWidth));
      const titleId = `${instanceId}-panel-${panelIndex}`;
      return <section className="mc-plot-panel" key={panel.units.join(':')} aria-labelledby={titleId}>
        <div className="mc-plot-heading"><h3 id={titleId}>{title}</h3><span>{panel.units.length === 2 ? `${panel.units[0]} left / ${panel.units[1]} right` : panel.units[0]}</span></div>
        <div className="mc-plot-scroll" tabIndex={plotWidth > width ? 0 : undefined} role="region" aria-label={`${title} plot${plotWidth > width ? ', horizontally scrollable' : ''}`}>
          <svg width={plotWidth} height={height} viewBox={`0 0 ${plotWidth} ${height}`} className="mc-svg" role="group" aria-labelledby={titleId} aria-describedby={instructionId}>
            {Array.from({length: 5}, (_, tick) => {
              const yy = top + innerHeight * tick / 4;
              return <g key={tick}><line className="mc-grid-line" x1={left} x2={plotWidth - right} y1={yy} y2={yy}/>
                {panel.units.map((unit, axis) => {const scale = scales.get(unit)!, value = (scale.high - (scale.high - scale.low) * tick / 4) * scale.magnitude;
                  return <text key={unit} data-axis-value={value} x={axis ? plotWidth - right + 9 : left - 9} y={yy + 4} textAnchor={axis ? 'start' : 'end'}>{axisNumber(value)}</text>;
                })}</g>;
            })}
            {panel.units.map((unit, axis) => <g key={unit}>
              <text className="mc-axis-title" x={axis ? plotWidth - right + 9 : left - 9} y={16} textAnchor={axis ? 'start' : 'end'}>{unit}</text>
              <line className="mc-zero-line" x1={left} x2={plotWidth - right} y1={y(0, unit)} y2={y(0, unit)}/>
            </g>)}
            {anchors.map((month, index) => (index === 0 || index === anchors.length - 1 || (index % every === 0 && anchors.length - 1 - index >= every)) &&
              <text key={month} x={x(index)} y={height - 16} textAnchor={index === 0 ? 'start' : index === anchors.length - 1 ? 'end' : 'middle'}>{formatChartMonth(month)}</text>)}
            {panel.series.map((s, seriesIndex) => {
              const color = chartSeriesColor(s.metric.color);
              const shared = {stroke: color, opacity: opacity(s.yearOffset)};
              if (type === 'bar') {
                const groupWidth = slotWidth * .8, barWidth = groupWidth / panel.series.length;
                return <g key={s.id}>{s.points.map((point, index) => {
                  if (point.plotValue === null) return null;
                  const xx = x(index) - groupWidth / 2 + seriesIndex * barWidth, base = y(0, s.metric.unit), yy = y(point.plotValue, s.metric.unit);
                  return point.plotValue === 0 ? <line key={point.anchorMonth} {...shared} data-series={s.id} data-value={0} data-anchor={point.anchorMonth} x1={xx} x2={xx + barWidth - 1} y1={base} y2={base} strokeWidth={2}><title>{pointLabel(point, s)}</title></line>
                    : <rect key={point.anchorMonth} {...shared} data-series={s.id} data-value={point.plotValue} data-anchor={point.anchorMonth} x={xx} y={Math.min(base, yy)} width={Math.max(.5, barWidth - 1)} height={Math.abs(base - yy)} fill={color} fillOpacity={s.yearOffset ? .45 : .8} strokeDasharray={point.state === 'partial' ? '2 2' : dash(s.yearOffset)}><title>{pointLabel(point, s)}</title></rect>;
                })}</g>;
              }
              let path = '', connected = false;
              for (const [index, point] of s.points.entries()) {
                if (point.plotValue === null) {connected = false; continue;}
                path += `${connected ? 'L' : 'M'}${x(index)},${y(point.plotValue, s.metric.unit)} `; connected = true;
              }
              return <g key={s.id}>
                <path {...shared} data-series={s.id} d={path} fill="none" strokeWidth={2} strokeDasharray={dash(s.yearOffset)}/>
                {s.points.map((point, index) => point.plotValue !== null && <circle key={point.anchorMonth} {...shared} cx={x(index)} cy={y(point.plotValue, s.metric.unit)} r={point.state === 'partial' ? 4 : 2.5} fill={point.state === 'partial' ? 'var(--panel, var(--white))' : color} strokeWidth={1.5}><title>{pointLabel(point, s)}</title></circle>)}
              </g>;
            })}
            {shown && <line className="mc-guide" x1={x(shown.index)} x2={x(shown.index)} y1={top} y2={height - bottom}/>}
            {anchors.map((month, index) => <rect key={month} className="mc-hit" data-chart-hit={`${panelIndex}:${index}`} x={left + slotWidth * index} y={top - 4} width={slotWidth} height={innerHeight + 8}
              tabIndex={index === (shown?.index ?? 0) ? 0 : -1} role="button" aria-label={`Show ${formatChartMonth(month)} details for ${title}`} aria-pressed={shown?.index === index && shown.mode === 'pinned'}
              aria-describedby={shown?.index === index ? detailId : instructionId} aria-controls={shown ? detailId : undefined}
              onPointerMove={event => {if (event.pointerType !== 'touch') setActive(previous => previous?.mode === 'pinned' ? previous : previous?.index === index && previous.panel === panelIndex ? previous : {panel: panelIndex, index, mode: 'hover'});}}
              // Avoid compatibility focus opening an overlay under the finger before click; scrolling stays native.
              onPointerDown={event => {if (event.pointerType === 'touch') event.preventDefault();}}
              onFocus={event => {lastHitRef.current = event.currentTarget; if (!skipFocusRef.current) setActive({panel: panelIndex, index, mode: 'focus'});}}
              onClick={event => {lastHitRef.current = event.currentTarget; setActive({panel: panelIndex, index, mode: 'pinned'});}}
              onKeyDown={event => move(event, panelIndex, index)}/>)}
          </svg>
        </div>
        <ul className="mc-legend" aria-label={`${title} series`}>
          {panel.series.map(s => <li key={s.id}><span className="mc-swatch" aria-hidden="true" style={{borderColor: chartSeriesColor(s.metric.color), opacity: opacity(s.yearOffset), borderTopStyle: s.yearOffset === 1 ? 'dashed' : s.yearOffset === 2 ? 'dotted' : 'solid'}}/>
            {onRemoveMetric ? <button type="button" onClick={() => onRemoveMetric(s.metric.id)} title={`Remove ${s.metric.label} from all periods`} aria-label={`Remove ${s.metric.label} from all periods`}>{s.label}<small>{period(s)}</small></button> : <span>{s.label}<small>{period(s)}</small></span>}
          </li>)}
        </ul>
      </section>;
    })}
    {shown && <section id={detailId} className="mc-month-details" data-month-details role="region" aria-labelledby={`${detailId}-title`}>
      <header><h3 id={`${detailId}-title`}>{formatChartMonth(anchors[shown.index])}{shown.mode === 'pinned' ? ' / pinned details' : ' / month details'}</h3><button type="button" onClick={dismiss} aria-label="Dismiss month details">Close</button></header>
      <div className="mc-detail-grid">{series.map(s => {const point = s.points[shown.index]; return <div className="mc-detail-item" key={s.id}>
        <div><span className="mc-swatch" aria-hidden="true" style={{borderColor: chartSeriesColor(s.metric.color), borderTopStyle: s.yearOffset === 1 ? 'dashed' : s.yearOffset === 2 ? 'dotted' : 'solid'}}/><strong>{s.label}</strong></div>
        <p className="mc-detail-value">{point.display} <span>{displayUnit(point, s.metric.unit)}</span></p>
        <p>Source month: {formatChartMonth(point.sourceMonth)}</p>
        {/* Hover summarizes selected series only; focus and pin retain source detail. */}
        {shown.mode !== 'hover' && <PointDetails point={point}/>}
      </div>;})}</div>
    </section>}
  </div>;
}
