export type EquipmentType = "revenue_meter" | "transformer" | "inverter" | "module_group" | "weather_sensor";

export type EquipmentAsset = {
  id: string;
  siteId: string;
  parentId: string | null;
  type: EquipmentType;
  name: string;
  externalId: string;
  manufacturer: string;
  model: string;
  capacityKw: string;
  acRatedCapacityKw: string;
  maxDcCapacityKw: string;
  moduleRatedCapacityW: string;
  acLineLossPercent: string;
  transformerLossPercent: string;
  nameplateKva?: string;
  pvCeilingOverrideEnabled?: boolean;
  pvCeilingOverrideKw?: string;
  notes?: string;
  quantity: number;
  aliases: string[];
  channels: string[];
  position: number;
  updatedAt?: string;
};

export const equipmentLabels: Record<EquipmentType,string> = {
  revenue_meter: "Revenue meter",
  transformer: "Transformer",
  inverter: "Inverter",
  module_group: "Module group",
  weather_sensor: "Weather sensor",
};

export function starterEquipment(siteId: string): EquipmentAsset[] {
  const meter = `${siteId}-meter`;
  const inverters = [1,2,3].map(index => ({
    id:`${siteId}-inv-${index}`, siteId, parentId:meter, type:"inverter" as const,
    name:`Inverter ${String(index).padStart(2,"0")}`, externalId:`INV-${String(index).padStart(2,"0")}`,
    manufacturer:"Sungrow", model:"SG350HX", capacityKw:"", acRatedCapacityKw:"30000", maxDcCapacityKw:"36000", moduleRatedCapacityW:"", acLineLossPercent:"", transformerLossPercent:"", quantity:1,
    aliases:[`INV${String(index).padStart(2,"0")}`,`Inverter ${index}`], channels:["AC power","DC power","Energy","Availability"], position:index,
  }));
  return [
    { id:meter, siteId, parentId:null, type:"revenue_meter", name:"Main revenue meter", externalId:"MTR-001", manufacturer:"Schneider Electric", model:"ION9000", capacityKw:"", acRatedCapacityKw:"", maxDcCapacityKw:"", moduleRatedCapacityW:"", acLineLossPercent:"1", transformerLossPercent:"0.75", quantity:1, aliases:["Revenue Meter","PCC Meter","Main Meter"], channels:["Energy","Active power","Reactive power"], position:0 },
    ...inverters,
    ...inverters.map((inverter,index) => ({ id:`${siteId}-modules-${index+1}`, siteId, parentId:inverter.id, type:"module_group" as const, name:`Array block ${String.fromCharCode(65+index)}`, externalId:`ARRAY-${String.fromCharCode(65+index)}`, manufacturer:"First Solar", model:"Series 6 Plus", capacityKw:"", acRatedCapacityKw:"", maxDcCapacityKw:"", moduleRatedCapacityW:"495", acLineLossPercent:"", transformerLossPercent:"", quantity:68000, aliases:[`Block ${String.fromCharCode(65+index)}`,`Array ${index+1}`], channels:["DC power","String current"], position:index+1 })),
    { id:`${siteId}-weather-poa`, siteId, parentId:null, type:"weather_sensor", name:"POA irradiance sensor", externalId:"WS-POA-01", manufacturer:"Kipp & Zonen", model:"SMP10", capacityKw:"", acRatedCapacityKw:"", maxDcCapacityKw:"", moduleRatedCapacityW:"", acLineLossPercent:"", transformerLossPercent:"", quantity:1, aliases:["POA","POA Irradiance","Pyranometer"], channels:["POA irradiance"], position:1 },
    { id:`${siteId}-weather-temp`, siteId, parentId:null, type:"weather_sensor", name:"Module temperature sensor", externalId:"WS-TMOD-01", manufacturer:"Campbell Scientific", model:"CS241", capacityKw:"", acRatedCapacityKw:"", maxDcCapacityKw:"", moduleRatedCapacityW:"", acLineLossPercent:"", transformerLossPercent:"", quantity:1, aliases:["Module Temp","Tmod","Backsheet Temperature"], channels:["Module temperature"], position:2 },
  ];
}
