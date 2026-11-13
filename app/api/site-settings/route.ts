import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { siteSettings, telemetryImports } from "../../../db/schema";

type SiteSettingsInput = {
  id?: string;
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  latitude?: string;
  longitude?: string;
  expectedShading?: string;
  expectedSnow?: string;
  expectedProductionNotes?: string;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const postalCodePatterns: Record<string, RegExp> = {
  US: /^\d{5}(?:-\d{4})?$/,
  CA: /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/i,
  DE: /^\d{5}$/,
  JP: /^\d{3}-?\d{4}$/,
  PL: /^\d{2}-?\d{3}$/,
  IT: /^\d{5}$/,
};

function siteIdFromName(name:string) {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48) || "site";
}

function recordFrom(payload:SiteSettingsInput,id:string) {
  return {
    id, name: clean(payload.name), address: clean(payload.address), city: clean(payload.city),
    state: clean(payload.state), zip: clean(payload.zip).toUpperCase(), country: clean(payload.country).toUpperCase() || "US",
    expectedShading: payload.expectedShading ?? "not_included", expectedSnow: payload.expectedSnow ?? "not_included",
    expectedProductionNotes: clean(payload.expectedProductionNotes),
    latitude: clean(payload.latitude), longitude: clean(payload.longitude), updatedAt: new Date().toISOString(),
  };
}

function validationError(record:ReturnType<typeof recordFrom>) {
  if (!record.id || !record.name) return "Site and site name are required.";
  if (![record.expectedShading, record.expectedSnow].every(value => ["included", "not_included", "unknown"].includes(value))) return "Choose a valid expected production assumption.";
  const postalPattern = postalCodePatterns[record.country];
  if (record.zip && postalPattern && !postalPattern.test(record.zip)) return `Enter a valid postal code for ${record.country}.`;
  const latitude = Number(record.latitude), longitude = Number(record.longitude);
  if (record.latitude && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) return "Latitude must be between -90 and 90.";
  if (record.longitude && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) return "Longitude must be between -180 and 180.";
  return "";
}

export async function GET() {
  try {
    const db = getDb();
    const [sites, importedSites] = await Promise.all([
      db.select().from(siteSettings).orderBy(asc(siteSettings.name)),
      db.selectDistinct({ siteId: telemetryImports.siteId }).from(telemetryImports),
    ]);
    const importedIds = new Set(importedSites.map(site => site.siteId));
    return Response.json({ sites, sitesWithPerformanceData: sites.filter(site => importedIds.has(site.id)).map(site => site.id) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load site settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json()) as SiteSettingsInput;
    const record = recordFrom(payload,clean(payload.id));
    const error=validationError(record);if(error)return Response.json({error},{status:400});
    const db = getDb();
    const [existing]=await db.select({id:siteSettings.id}).from(siteSettings).where(eq(siteSettings.id,record.id)).limit(1);
    if(!existing)return Response.json({error:"This site is not available."},{status:404});
    await db.update(siteSettings).set({ name: record.name, address: record.address, city: record.city, state: record.state, zip: record.zip, country: record.country, latitude: record.latitude, longitude: record.longitude, ...(payload.expectedShading !== undefined ? { expectedShading: record.expectedShading } : {}), ...(payload.expectedSnow !== undefined ? { expectedSnow: record.expectedSnow } : {}), ...(payload.expectedProductionNotes !== undefined ? { expectedProductionNotes: record.expectedProductionNotes } : {}), updatedAt: record.updatedAt }).where(eq(siteSettings.id,record.id));
    const [saved] = await db.select().from(siteSettings).where(eq(siteSettings.id, record.id)).limit(1);
    return Response.json({ site: saved });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save site settings" }, { status: 500 });
  }
}

export async function POST(request:Request) {
  try {
    const payload=(await request.json()) as SiteSettingsInput;
    const db=getDb();const existing=await db.select({id:siteSettings.id}).from(siteSettings);
    const used=new Set(existing.map(item=>item.id));const base=siteIdFromName(clean(payload.name));let id=base,index=2;
    while(used.has(id)){id=`${base.slice(0,Math.max(1,48-String(index).length-1))}-${index}`;index+=1}
    const record=recordFrom(payload,id);const error=validationError(record);if(error)return Response.json({error},{status:400});
    await db.insert(siteSettings).values(record);
    const [saved]=await db.select().from(siteSettings).where(eq(siteSettings.id,id)).limit(1);
    return Response.json({site:saved},{status:201});
  } catch(error) {
    return Response.json({error:error instanceof Error?error.message:"Unable to add site"},{status:500});
  }
}
