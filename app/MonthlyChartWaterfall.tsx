"use client";

import {useEffect, useId, useRef, useState} from 'react';
import type {MonthRange} from './chart-types';
import {formatChartMonth, type ProductionWaterfall} from './monthly-chart-model';

type Props = {model: ProductionWaterfall; range: MonthRange; refreshing: boolean};
const stageLabels = {
  projected: ['Projected', 'production'], expected: ['Expected', 'production'], loss: ['Confirmed estimated', 'losses'],
  variance: ['Unexplained', 'variance'], actual: ['Utility actual', 'production'],
};
const descriptions = {
  projected: 'Saved projection, including operations-start proration and degradation.',
  expected: 'Imported monthly Expected Production is already weather-adjusted. The floating step is its difference from the projection.',
  loss: 'Estimated energy lost in confirmed findings from the current published analysis. Subtract this amount from expected production.',
  variance: 'Utility actual minus expected production after confirmed losses. This difference is not attributed to confirmed findings.',
  actual: 'Saved utility production across the selected months: on-peak, off-peak and unpaid energy. This total does not depend on the loss estimate.',
};
const axisFormatter = new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 2});
function axisLabel(value: number) {
  const magnitude = Math.abs(value);
  return magnitude > 0 && (magnitude < .01 || magnitude >= 1e15) ? value.toExponential(1) : axisFormatter.format(value);
}

export default function MonthlyChartWaterfall({model, range, refreshing}: Props) {
  const uid = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [selection, setSelection] = useState<ProductionWaterfall['stages'][number]['id'] | null>(null);
  const {rows, stages, vsProjected} = model;
  const active = stages.find(stage => stage.id === selection) ?? stages.find(stage => stage.id === 'variance') ?? stages.find(stage => stage.id === 'loss')!;
  const adjustment = rows.find(row => row.id === 'adjustment')!;
  const afterLoss = rows.find(row => row.id === 'afterLoss')!;
  const variance = rows.find(row => row.id === 'variance')!;
  const hasVariance = stages.some(stage => stage.id === 'variance');
  const missing = rows.filter(row => row.reason && ['projected', 'expected', 'loss', 'actual'].includes(row.id));
  const unplottable = stages.some(stage => stage.row.value && (stage.start === null || stage.end === null) && (stage.id !== 'loss' || !afterLoss.reason));
  const endpoints = stages.flatMap(({start,end}) => start === null || end === null ? [] : [start,end]);
  const hasPlot = endpoints.length > 0;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const resize = () => setWidth(Math.max(540, root.clientWidth));
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, [hasPlot]);
  const scale = Math.max(0, ...endpoints.map(Math.abs)) || 1;
  const lower = Math.min(0, ...endpoints.map(value => value / scale));
  const upper = Math.max(0, ...endpoints.map(value => value / scale));
  const axisMin = lower, axisMax = lower === upper ? 1 : upper;
  const axisX = 60, axisRight = width - 12, top = 33, bottom = 205;
  const y = (value: number) => bottom - (value / scale - axisMin) / (axisMax - axisMin) * (bottom - top);
  const ticks = [...new Set([axisMin, axisMin * .5, 0, axisMax * .5, axisMax])].sort((a,b) => a-b)
    .filter(tick => tick === 0 || Math.abs(y(tick * scale) - y(0)) >= 16)
    .filter((tick, index, all) => tick === 0 || index === 0 || Math.abs(y(tick * scale) - y(all[index - 1] * scale)) >= 16);
  const pitch = (axisRight - axisX) / stages.length, barWidth = Math.min(82, pitch * .63);
  const x = (index: number) => axisX + pitch * (index + .5);
  const period = range.start === range.end ? formatChartMonth(range.start) : `${formatChartMonth(range.start)} to ${formatChartMonth(range.end)}`;
  const amounts = (stage: ProductionWaterfall['stages'][number]) => {
    if (stage.row.reason) return 'Unavailable';
    const amount = `${stage.row.display} kWh`;
    if (stage.id === 'expected' && !adjustment.reason) return `${amount} (${adjustment.display} kWh vs projected)`;
    if (stage.id === 'loss' && !afterLoss.reason) return `${amount}; ${afterLoss.display} kWh after losses`;
    return amount;
  };
  return <section className="mc-waterfall" aria-labelledby={`${uid}-title`}>
    <header className="mc-wf-heading">
      <div><h2 id={`${uid}-title`}>Production waterfall</h2><p>{period} / Energy in kWh{refreshing ? ' / Refreshing saved data…' : ''}</p></div>
      <div className="mc-wf-readout" data-sign={vsProjected?.sign}>
        <strong>{vsProjected ? `${vsProjected.display} kWh${vsProjected.percent ? ` (${vsProjected.percent})` : ''}` : 'Unavailable'}</strong>
        <span>Utility actual vs projected</span>
      </div>
    </header>
    <div className="mc-wf-layout">
      <div className="mc-wf-plot">
        {(missing.length > 0 || unplottable) && <div className="mc-wf-notice" role="status">
          {missing.length > 0 && <p><strong>Unavailable:</strong> {missing.map(row => row.label).join(', ')}.</p>}
          {unplottable && <p>Some amounts cannot be shown on the chart scale. Their values are listed in Reconciliation.</p>}
        </div>}
        {!hasPlot ? <div className="mc-empty"><p>No production values can be plotted for this period.</p></div> : <>
        <div ref={scrollRef} className="mc-wf-scroll" tabIndex={0} role="region" aria-label="Production waterfall plot (scroll horizontally on narrow screens)">
          <svg width={width} height="260" viewBox={`0 0 ${width} 260`} role="group" aria-label="Production waterfall stages" className="mc-wf-svg">
            <defs><pattern id={`${uid}-variance`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="mc-wf-hatch-bg"/><path d="M 0 0 V 6" className="mc-wf-hatch-line"/>
            </pattern></defs>
            <text x="12" y="17" className="mc-wf-tick">kWh</text>
            {ticks.map(tick => <g key={tick} aria-hidden="true"><line className={tick === 0 ? 'mc-zero-line' : 'mc-grid-line'} x1={axisX} x2={axisRight} y1={y(tick * scale)} y2={y(tick * scale)}/><text className="mc-wf-tick" x={axisX - 8} y={y(tick * scale) + 4} textAnchor="end">{axisLabel(tick * scale)}</text></g>)}
            {stages.slice(0,-1).map(({id,start,end}, index) => {
              const next = stages[index + 1];
              if (start === null || end === null || next.start === null || next.end === null || (next.id === 'actual' ? variance.value === null : end !== next.start)) return null;
              return <line key={id} className="mc-wf-carry" x1={x(index) + barWidth/2} x2={x(index + 1) - barWidth/2} y1={y(end)} y2={y(end)} aria-hidden="true"/>;
            })}
            {stages.map((stage,index) => {
              const {id,row,start,end,flat} = stage;
              const cx = x(index), left = cx - barWidth/2;
              const placed = start !== null && end !== null;
              const barTop = placed ? Math.min(y(start),y(end)) : 132;
              const barHeight = placed ? Math.abs(y(start) - y(end)) : 0;
              const fitted = placed && (id === 'loss' || id === 'variance' || id === 'expected') && end < start;
              const valueY = fitted ? Math.min(220,barTop + barHeight + 15) : barTop - 8;
              const color = id === 'expected' && adjustment.reason ? 'projected' : id;
              const pick = () => setSelection(id);
              return <g key={id} className="mc-wf-stage" role="button" tabIndex={0} data-waterfall-stage={id}
                aria-pressed={active.id === id} aria-controls={`${uid}-detail`} aria-label={`${row.label}: ${amounts(stage)}`}
                onPointerEnter={e => {if (e.pointerType === 'mouse') pick();}} onFocus={pick} onClick={pick}
                onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); pick();}}}>
                <rect className="mc-wf-hit" x={cx - pitch/2 + 2} y="8" width={pitch - 4} height="243" rx="4"/>
                {placed && (flat ? <line className={`mc-wf-bar mc-wf-${color}`} x1={left} x2={left + barWidth} y1={barTop} y2={barTop}/> :
                  <rect className={`mc-wf-bar mc-wf-${color}`} x={left} y={barTop} width={barWidth} height={Math.max(1,barHeight)} fill={id === 'variance' ? `url(#${uid}-variance)` : undefined}/>)}
                <text className="mc-wf-value" textAnchor="middle" x={cx} y={valueY}>{row.display}</text>
                {id === 'expected' && !adjustment.reason && <text className="mc-wf-tick" textAnchor="middle" x={cx} y={valueY + 12}>{adjustment.display} vs projected</text>}
                <text className="mc-wf-category" textAnchor="middle" x={cx} y="237">{stageLabels[id][0]}<tspan x={cx} dy="12">{stageLabels[id][1]}</tspan></text>
              </g>;
            })}
          </svg>
        </div>
        <p className="mc-wf-scroll-hint">Scroll the chart horizontally to see all stages.</p>
        <ul className="mc-wf-legend" aria-label="Chart legend">
          <li className="mc-wf-projected">Production total</li><li className="mc-wf-expected">Projected to expected</li>
          <li className="mc-wf-loss">Confirmed losses</li>{hasVariance && <li className="mc-wf-variance">Unexplained variance</li>}
        </ul></>}
      </div>
      <aside className="mc-wf-ledger" aria-label="Reconciliation">
        <h3>Reconciliation</h3><table><caption>Period totals and adjustments (kWh)</caption>
          <tbody>{rows.map(row => <tr key={row.id} data-waterfall-row={row.id}><th scope="row">{row.label}</th><td data-unavailable={!!row.reason}>{row.display}</td></tr>)}</tbody>
        </table>
        <div className="mc-wf-detail" id={`${uid}-detail`} aria-live="polite">
          <strong>{active.row.label}: {amounts(active)}</strong>
          <p>{active.row.reason ?? (active.id === 'expected' && adjustment.reason ? 'Weather-adjusted expected production from the imported readings. No projection is available for comparison.' : descriptions[active.id])}</p>
          {active.id === 'loss' && !active.row.reason && afterLoss.reason && <p>{afterLoss.reason}</p>}
        </div>
      </aside>
    </div>
    <p className="mc-wf-foot">Uses the values available for the selected period. Unexplained variance is shown separately from confirmed losses.</p>
  </section>;
}
