import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatedRows, fraction} from '../app/monthly-domain.mjs';
import {loadChartModel, metricIds, telemetryIds, oracle, snapshot, settings, plain, emptyUtility, freezeDeep} from './monthly-chart-model-fixture.mjs';

test('production waterfall uses exact inclusive totals and reconciles only known sources', () => {
  const model=loadChartModel(), start='2026-04', end='2026-06';
  const inputs=settings({start,end,type:'waterfall',metrics:['projectedProduction','expectedProduction','confirmedLoss','utilityTotal']});
  function run({actual='288000',loss='44000',quality='complete',read,edit}={}) {
    const s=snapshot(), months=['2026-04','2026-05','2026-06'];
    s.projections=months.map((month,i)=>({month,production:fraction(['410000','398000','432000'][i])}));
    s.utility=Object.fromEntries(months.map((month,i)=>[month,{onPeak:['312000','288000',actual][i],offPeak:'10000',unpaidEnergy:i===2?'0':null}]));
    const expected=Object.values(s.telemetry.months)[0];
    s.telemetry.months=Object.fromEntries(months.map((month,i)=>[month,{...expected,expected:{...expected.expected,value:fraction(['360000','344000','376000'][i]),state:i===2?quality:'complete'}}]));
    s.confirmedLoss={state:'current',analysisRunId:'published',months:Object.fromEntries(months.map((month,i)=>[month,{state:'complete',value:i===2&&loss===null?null:fraction(['34000','42000',loss][i]),confirmedCount:1,unknownCount:0}]))};
    edit?.(s);
    return model.buildProductionWaterfall(freezeDeep(s),inputs,read);
  }
  const values=r=>Object.fromEntries(r.rows.map(row=>[row.id,row.display]));
  const sample=run();
  assert.deepEqual(values(sample),{projected:'1,240,000',adjustment:'−160,000',expected:'1,080,000',loss:'−120,000',afterLoss:'960,000',variance:'−42,000',actual:'918,000'});
  assert.equal(sample.vsProjected.display,'−322,000');assert.equal(sample.vsProjected.percent,'−26.0%');
  assert.deepEqual(plain(sample.stages.map(({id,start,end})=>[id,start,end])),[['projected',0,1240000],['expected',1240000,1080000],['loss',1080000,960000],['variance',960000,918000],['actual',0,918000]]);
  assert.equal(values(run({actual:'342000'})).variance,'+12,000');
  const exact=run({actual:'330000'});assert.equal(values(exact).variance,'0');assert.ok(!exact.stages.some(s=>s.id==='variance'));
  const tiny=run({actual:'330000.0001'});assert.equal(values(tiny).variance,'+0.0001');assert.ok(tiny.stages.some(s=>s.id==='variance'));
  const zero=run({edit(s){for(const month of Object.values(s.confirmedLoss.months))month.value=fraction('0');}});
  assert.equal(values(zero).loss,'0');assert.equal(values(zero).afterLoss,'1,080,000');
  for(const result of [run({loss:null}),run({edit:s=>{s.confirmedLoss.months[end].unknownCount=1;}})]) {
    assert.equal(values(result).loss,'Unavailable');assert.equal(values(result).afterLoss,'Unavailable');assert.equal(values(result).variance,'Unavailable');assert.equal(values(result).actual,'918,000');
    assert.equal(result.stages.find(s=>s.id==='loss').end,null);
  }
  for(const result of [run({quality:'partial'}),run({read:{refreshing:true,error:''}}),run({read:{refreshing:false,error:'Read failed'}}),run({edit:s=>{s.telemetry.state='stale';}})]) {
    assert.equal(values(result).expected,'Unavailable');assert.equal(values(result).adjustment,'Unavailable');assert.equal(values(result).variance,'Unavailable');assert.equal(values(result).actual,'918,000');assert.equal(values(result).projected,'1,240,000');
  }
  const noProjection=run({edit:s=>{s.projections.pop();}});
  assert.equal(values(noProjection).expected,'1,080,000');assert.equal(values(noProjection).variance,'−42,000');assert.equal(noProjection.vsProjected,null);
  const noActual=run({edit:s=>{delete s.utility[end];}});
  assert.equal(values(noActual).actual,'Unavailable');assert.equal(values(noActual).variance,'Unavailable');assert.equal(values(noActual).afterLoss,'960,000');
  const zeroProjection=run({edit:s=>{for (const row of s.projections) row.production=fraction('0');}});
  assert.equal(zeroProjection.vsProjected.percent,null);assert.equal(zeroProjection.vsProjected.display,'+918,000');
  assert.throws(()=>model.validateChartSettings({...inputs,comparisonYears:1}),/comparison|prior year/i);
  assert.throws(()=>model.validateChartSettings({...inputs,metrics:['utilityTotal']}),/fixed/i);
});

const first = (model, s, id, read) => model.buildChartSeries(s, settings({metrics: [id]}), read)[0].points[0];

test('catalog has exactly the approved 26 metrics and unchanged quick views, with stable source/unit metadata', () => {
  const model = loadChartModel();
  assert.deepEqual(plain(model.chartMetrics.map(m => m.id)), metricIds);
  assert.equal(new Set(model.chartMetrics.map(m => m.color)).size, 26);
  assert.deepEqual(plain(model.chartMetrics.filter(m => m.telemetry).map(m => m.id)).sort(), [...telemetryIds].sort());
  for (const metric of model.chartMetrics) {
    assert.ok(metric.label && metric.description && metric.color);
    assert.ok(['kWh', '$', 'kWh/m²', 'kWh/kWp', '%'].includes(metric.unit));
    assert.ok(['Production', 'Revenue', 'Insolation', 'Performance'].includes(metric.group));
  }
  assert.deepEqual(plain(model.quickViews.map(v => ({id: v.id, metrics: v.metrics}))), [
    {id: 'overview', metrics: ['utilityTotal', 'projectedProduction', 'actualInsolation']},
    {id: 'production', metrics: ['utilityTotal', 'projectedProduction', 'expectedProduction']},
    {id: 'revenue', metrics: ['revenue', 'budgetRevenue']},
    {id: 'performance', metrics: ['iapr', 'iar', 'productionProjectionRatio']},
  ]);
});

test('inclusive calendar selection and strict settings accept only the settled bounded contract', () => {
  const m = loadChartModel();
  assert.deepEqual(plain(m.monthsInclusive('2025-11', '2026-02')), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(plain(m.monthsInclusive('9999-12', '9999-12')), ['9999-12']);
  assert.equal(m.monthsInclusive('1900-01', '1949-12').length, 600);
  assert.equal(m.shiftMonth('2026-01', -12), '2025-01');
  assert.equal(m.shiftMonth('1900-01', -24), '1898-01');
  assert.equal(m.formatChartMonth('1898-01'), 'Jan 1898');
  assert.equal(m.formatChartMonth('2024-02'), 'Feb 2024');
  assert.throws(() => m.shiftMonth('2026-01', 1.5));
  for (const [start, end] of [['1899-12', '1900-01'], ['2026-1', '2026-02'], ['2026-13', '2027-01'],
    ['2026-00', '2026-01'], ['2026-01-01', '2026-02'], ['2026-02', '2026-01'],
    ['1900-01', '1950-01'], ['9999-12', '10000-01']]) {
    assert.throws(() => m.monthsInclusive(start, end), `${start} .. ${end}`);
    assert.throws(() => m.validateChartSettings(settings({start, end})), `${start} .. ${end}`);
  }
  for (const input of [null, [], 'settings', {}, settings({extra: true}), settings({siteId: 'private-site'}),
    settings({metrics: []}), settings({metrics: ['budgetedRevenue']}), settings({metrics: ['revenue', 'revenue']}),
    settings({metrics: 'revenue'}), settings({metrics: Array(1)}), settings({comparisonYears: 3}), settings({comparisonYears: '1'}),
    settings({comparisonYears: 0.5}), settings({type: 'pie'})]) assert.throws(() => m.validateChartSettings(input));
  assert.deepEqual(plain(m.validateChartSettings(settings({metrics: []}), true).metrics), []);
  const input = settings({metrics: ['utilityTotal'], comparisonYears: 2});
  const validated = m.validateChartSettings(input);
  assert.deepEqual(plain(validated), input);
  assert.notEqual(validated.metrics, input.metrics);
  assert.ok(m.chartSettingsEqual(settings({metrics: ['revenue', 'onPeak']}), settings({metrics: ['onPeak', 'revenue']})));
  for (const change of [{end: '2026-02'}, {start: '2025-12'}, {type: 'table'}, {comparisonYears: 1}, {metrics: ['revenue']}]) {
    assert.equal(m.chartSettingsEqual(settings(), settings(change)), false);
  }
});

test('default range ends at numeric utility/current telemetry including zero and partial, never a future projection', () => {
  const m = loadChartModel(), s = snapshot();
  s.projections.push({...s.projections[0], month: '2050-12'});
  s.utility['2027-02'] = emptyUtility();
  s.utility['2026-04'] = {...emptyUtility(), revenue: '-1'};
  s.telemetry.months['2026-06'] = structuredClone(s.telemetry.months['2026-01']);
  s.telemetry.months['2026-06'].expected = {...s.telemetry.months['2026-06'].expected, value: {n: '0', d: '1'}, state: 'partial'};
  assert.deepEqual(plain(m.defaultRange(s, '2026-11')), {start: '2025-07', end: '2026-06'});
  s.telemetry.state = 'refreshing';
  assert.deepEqual(plain(m.defaultRange(s, '2026-11')), {start: '2025-05', end: '2026-04'});
  s.utility = {'2026-09': {...emptyUtility(), unpaidEnergy: '0'}};
  assert.deepEqual(plain(m.defaultRange(s, '2026-11')), {start: '2025-10', end: '2026-09'});
  s.utility = {};
  assert.deepEqual(plain(m.defaultRange(s, '2026-11')), {start: '2025-12', end: '2026-11'});
  assert.deepEqual(plain(m.defaultRange(s, '1900-01')), {start: '1900-01', end: '1900-01'});
  assert.throws(() => m.defaultRange(s, '2026-13'));
});

test('ordinary populated adapter reads authoritative fields, exact fractions and display without mutating inputs', () => {
  const m = loadChartModel(), s = freezeDeep(snapshot()), config = freezeDeep(settings()), before = JSON.stringify(s);
  const byId = Object.fromEntries(m.buildChartSeries(s, config).map(series => [series.metric.id, series.points[0]]));
  const rawExpected = {
    onPeak: ['8000', 8000, '8,000'], offPeak: ['4000', 4000, '4,000'], unpaidEnergy: [null, null, '—'],
    utilityTotal: [{n: '12000', d: '1'}, 12000, '12,000'], energyUsed: ['0', 0, '0'],
    projectedProduction: [{n: '12000', d: '1'}, 12000, '12,000'],
    expectedProduction: [{n: '10000', d: '1'}, 10000, '10,000'],
    revenue: ['1200', 1200, '1,200'], invoiceCost: ['-0.0001', -0.0001, '0'],
    budgetRevenue: [{n: '1000', d: '1'}, 1000, '1,000'],
    actualInsolation: [{n: '125', d: '1'}, 125, '125.00'],
    projectedInsolation: [{n: '150', d: '1'}, 150, '150.00'],
  };
  for (const [id, [raw, plot, display]] of Object.entries(rawExpected)) {
    assert.deepEqual(plain(byId[id].raw), raw, id);
    assert.equal(byId[id].plotValue, plot, id);
    assert.equal(byId[id].display, display, id);
    assert.equal(byId[id].state, raw === null ? 'missing' : 'available', id);
  }
  for (const id of oracle.keys) {
    assert.deepEqual(plain(byId[id].raw), oracle.cases[0].values[id], id);
    assert.equal(byId[id].display.replaceAll(',', ''), oracle.cases[0].formatted[id], id);
  }
  assert.equal(byId.iapr.plotValue, 120);
  assert.equal(byId.iar.plotValue, 144);
  assert.equal(byId.actualSpecificYield.plotValue, 100);
  assert.match(byId.utilityTotal.details.join(' '), /coverage.*(not verified|unknown)/i);
  assert.equal(JSON.stringify(s), before);
});

test('independent decimal oracle remains exact; signed money, unpaid totals, missing and explicit zero stay distinct', () => {
  const m = loadChartModel();
  for (const c of oracle.cases.slice(0, 4)) {
    const series = m.buildChartSeries(snapshot(c), settings({start: c.month, end: c.month, metrics: [...oracle.keys]}));
    for (const item of series) {
      assert.deepEqual(plain(item.points[0].raw), c.values[item.metric.id], `${c.name}: ${item.metric.id}`);
      assert.equal(item.points[0].display.replaceAll(',', ''), c.formatted[item.metric.id]);
    }
  }
  const s = snapshot();
  s.utility['2026-01'] = {...emptyUtility(), onPeak: '0.49', offPeak: '0.49', unpaidEnergy: '0.49', revenue: '-25.50'};
  assert.deepEqual(plain(first(m, s, 'utilityTotal').raw), {n: '147', d: '100'});
  assert.equal(first(m, s, 'utilityTotal').display, '1');
  assert.equal(first(m, s, 'utilityTotal').plotValue, 1.47);
  assert.equal(first(m, s, 'revenue').display, '-26');
  assert.equal(first(m, s, 'revenue').plotValue, -25.5);
  s.projections[0].insolation = {n: '2469', d: '200'};
  assert.equal(first(m, s, 'projectedInsolation').display, '12.35');
  assert.equal(first(m, s, 'projectedInsolation').plotValue, 12.345);
  s.utility['2026-01'] = {...emptyUtility(), unpaidEnergy: '0'};
  assert.equal(first(m, s, 'utilityTotal').state, 'available');
  assert.equal(first(m, s, 'utilityTotal').plotValue, 0);
  assert.equal(first(m, s, 'onPeak').plotValue, null);
  s.utility['2026-01'] = emptyUtility();
  assert.equal(first(m, s, 'utilityTotal').raw, null);
  assert.equal(first(m, s, 'utilityTotal').state, 'missing');
});

test('geometry conversion handles huge ratios, percent scaling once, invalid numbers and nonzero underflow', () => {
  const {toPlotNumber} = loadChartModel();
  const huge = '0'.repeat(500);
  for (const [raw, scale, expected] of [
    [{n: `12${huge}`, d: `10${huge}`}, 1, 1.2],
    [{n: `12${huge}`, d: `10${huge}`}, 100, 120],
    [{n: `-12${huge}`, d: `10${huge}`}, 100, -120],
    [{n: '1', d: '2'}, 1, 0.5], ['0', 1, 0], ['-0.000', 100, 0],
    [{n: '5', d: `1${'0'.repeat(324)}`}, 1, Number.MIN_VALUE],
    [{n: '1', d: `1${'0'.repeat(324)}`}, 100, 1e-322],
    [{n: '1', d: '-2'}, 1, -0.5],
  ]) assert.equal(toPlotNumber(raw, scale), expected);
  for (const raw of [null, '', ' ', 'NaN', 'Infinity', '1e3', '12bad', {n: '1', d: '0'},
    {n: '1.2', d: '1'}, {n: '1', d: 'NaN'}, {n: `1${huge}`, d: '1'},
    {n: '1', d: `1${huge}`}, {n: '1', d: `1${'0'.repeat(324)}`}]) assert.equal(toPlotNumber(raw), null);
  const s = snapshot();
  s.projections[0].production = {n: `1${huge}`, d: '1'};
  const point = first(loadChartModel(), s, 'projectedProduction');
  assert.equal(point.plotValue, null);
  assert.match(`${point.reason} ${point.details.join(' ')}`, /represent|range|finite|geometry/i);
});

test('YoY anchors use source month minus exact years across year boundaries, with real actual-only months and gaps', () => {
  const m = loadChartModel(), s = snapshot();
  s.utility['2025-12'] = {...emptyUtility(), unpaidEnergy: '25'};
  s.utility['2024-12'] = {...emptyUtility(), onPeak: '24'};
  s.utility['2023-12'] = {...emptyUtility(), onPeak: '23'};
  const config = settings({start: '2025-12', end: '2026-02', metrics: ['utilityTotal', 'iapr'], comparisonYears: 2});
  const series = m.buildChartSeries(s, config);
  assert.equal(series.length, 6);
  const byId = Object.fromEntries(series.map(item => [item.id, item]));
  assert.deepEqual(plain(byId['utilityTotal:0'].points.map(p => p.plotValue)), [25, 12000, null]);
  assert.deepEqual(plain(byId['utilityTotal:1'].points.map(p => p.sourceMonth)), ['2024-12', '2025-01', '2025-02']);
  assert.deepEqual(plain(byId['utilityTotal:2'].points.map(p => p.sourceMonth)), ['2023-12', '2024-01', '2024-02']);
  for (const item of series) {
    assert.deepEqual(plain(item.points.map(p => p.anchorMonth)), ['2025-12', '2026-01', '2026-02']);
    assert.match(item.label, new RegExp(item.metric.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(byId['iapr:0'].points[0].raw, null, 'does not fabricate formulas outside the calculated domain');
  s.telemetry.months['2026-03'] = structuredClone(s.telemetry.months['2026-01']);
  const outside = m.buildChartSeries(s, settings({start: '2026-03', end: '2026-03', metrics: ['expectedProduction', 'actualInsolation', 'iapr']}));
  assert.deepEqual(plain(outside.map(item => item.points[0].plotValue)), [10000, 125, null]);
  assert.notEqual(byId['utilityTotal:0'].label, byId['utilityTotal:1'].label);
  assert.deepEqual(plain(m.buildChartSeries(s, {...config, type: 'bar'})), plain(series));
  assert.deepEqual(plain(m.buildChartSeries(s, {...config, type: 'table'})), plain(series));
  const boundary = m.buildChartSeries(s, settings({start: '1900-01', end: '1900-01', metrics: ['utilityTotal'], comparisonYears: 2}));
  assert.equal(boundary[2].points[0].sourceMonth, '1898-01');
  assert.equal(boundary[2].points[0].state, 'missing');
  assert.deepEqual(plain(m.buildChartSeries(s, settings({metrics: []}))), []);
});

test('partial telemetry retains numeric values, source reasons, coverage, quality counts and channel/revision provenance', () => {
  const m = loadChartModel(), s = snapshot(), row = s.telemetry.months['2026-01'];
  row.insolation = {...row.insolation, state: 'partial', coveredMilliseconds: 1339200000,
    partialIntervals: 3, unknownQualityIntervals: 7, negativeIntervals: 2,
    satelliteIntervals: 100, poaIntervals: 40, unknownSourceIntervals: 7,
    source: 'Measured POA sensor; some evidence unavailable'};
  s.calculated = calculatedRows(s.projections, s.utility, s.telemetry, s.capacity);
  for (const id of ['actualInsolation', 'actualPerformanceRatio', 'iapr', 'iar']) {
    const p = first(m, s, id), text = `${p.reason} ${p.details.join(' ')}`;
    assert.equal(p.state, 'partial', id);
    assert.notEqual(p.plotValue, null, id);
    for (const pattern of [/partial/i, /3/, /7/, /2/, /quality.*unknown|unknown.*quality/i,
      /negative/i, /coverage/i, /1339200000/, /2678400000/, /America\/New_York/,
      /23/, /selected-irradiance/, /Measured/, /POA/, /evidence unavailable/i,
      /Satellite intervals: 100/, /POA intervals: 40/, /Unknown source intervals: 7/]) assert.match(text, pattern, id);
  }
  const expected = first(m, s, 'expectedProduction');
  assert.match(expected.details.join(' '), /site\|named-expected/);
  s.capacity = {dcKwp: null, unavailableReason: 'DC capacity unavailable: missing connected module wattage.'};
  s.calculated = calculatedRows(s.projections, s.utility, s.telemetry, s.capacity);
  assert.match(first(m, s, 'actualSpecificYield').reason, /missing connected module wattage/);
});

test('refresh/error or noncurrent telemetry suppress every dependent value, retaining raw metadata and unrelated sources', () => {
  const m = loadChartModel();
  for (const [serviceState, read, pattern] of [
    ['current', {refreshing: true, error: ''}, /refresh/i],
    ['current', {refreshing: false, error: 'Synthetic read failure'}, /freshness.*Synthetic read failure/i],
    ['refreshing', undefined, /refresh/i], ['missing', undefined, /missing/i],
  ]) {
    const s = snapshot();
    s.telemetry.state = serviceState;
    const series = m.buildChartSeries(s, settings(), read);
    for (const item of series) {
      const p = item.points[0];
      if (telemetryIds.includes(item.metric.id)) {
        assert.equal(p.state, 'stale', item.metric.id);
        assert.equal(p.plotValue, null, item.metric.id);
        assert.equal(p.display, '—', item.metric.id);
        assert.notEqual(p.raw, null, 'retains original source, never rewrites the snapshot');
        assert.match(p.reason, pattern);
        assert.match(p.details.join(' '), /23/);
      } else if (item.metric.id === 'confirmedLoss' || item.metric.id === 'unconfirmedLoss') {
        assert.equal(p.state, read ? 'stale' : 'missing');
        assert.equal(p.plotValue, null, 'fixture has no published analysis');
      } else if (item.metric.id !== 'unpaidEnergy') assert.equal(p.state, 'available', item.metric.id);
    }
  }
});

test('source selection/missing reasons stay explicit and exact unit groups share or split without normalization', () => {
  const m = loadChartModel(), s = snapshot();
  s.telemetry.expectedUnavailableReason = 'Multiple expected channels; reporting source is ambiguous.';
  s.telemetry.selectionRequired = true; s.telemetry.poa.state = 'selection-required';
  assert.equal(first(m, s, 'expectedProduction').plotValue, null);
  assert.match(first(m, s, 'expectedProduction').reason, /ambiguous/);
  assert.equal(first(m, s, 'actualInsolation').plotValue, null);
  assert.match(first(m, s, 'actualInsolation').reason, /select|channel/i);
  assert.equal(first(m, s, 'productionExpectedRatio').plotValue, null);
  assert.match(first(m, s, 'productionExpectedRatio').reason, /ambiguous/);
  assert.equal(first(m, s, 'iapr').plotValue, null);
  assert.match(first(m, s, 'iapr').reason, /select|channel/i);
  assert.deepEqual(plain(m.groupChartPanels([])), []);
  const two = m.buildChartSeries(snapshot(), settings({metrics: ['onPeak', 'utilityTotal', 'revenue']}));
  const shared = m.groupChartPanels(two);
  assert.equal(shared.length, 1);
  assert.deepEqual(plain(shared[0].units), ['kWh', '$']);
  assert.equal(shared[0].series[0], two[0], 'panels retain the same points and values');
  const all = m.buildChartSeries(snapshot(), settings());
  const panels = m.groupChartPanels(all);
  assert.equal(panels.length, 5);
  for (const panel of panels) {
    assert.equal(panel.units.length, 1);
    assert.ok(panel.series.every(series => series.metric.unit === panel.units[0]));
    assert.ok(panel.series.every(series => all.includes(series)));
  }
});
