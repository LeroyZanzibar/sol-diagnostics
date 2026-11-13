/** Validate wide-format meter assignment; long-format values are checked after parsing. */
export function meterMappingError(assets: { id: string; type: string; name?: string }[], roles: Record<string,string>, signals: { column?: string; equipmentId?: string; measurement?: string }[]) {
  if (roles.equipment && roles.measurement && roles.value) return '';
  const meters=assets.filter(a=>a.type==='revenue_meter');
  const missing=meters.filter(m=>!signals.some(s=>s.equipmentId===m.id&&s.column&&['Energy','Active power'].includes(s.measurement || '')));
  return missing.length ? `Map the revenue meter ${missing.map(m=>m.name || m.id).join(', ')} to Energy (interval kWh) or Active power (kW). “Other” and unmapped columns cannot support site-outage analysis.` : '';
}
