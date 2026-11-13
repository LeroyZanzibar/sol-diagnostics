const fallback: Record<string, { city: string; state: string }> = {
  "85001": { city: "Phoenix", state: "AZ" }, "79735": { city: "Fort Stockton", state: "TX" },
  "28358": { city: "Lumberton", state: "NC" }, "89044": { city: "Henderson", state: "NV" },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const country = (searchParams.get("country") || "US").toUpperCase();
  const zip = (searchParams.get("zip") || "").trim();
  if (country === "US" && !/^\d{5}$/.test(zip)) return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  try {
    const response = await fetch(`https://api.zippopotam.us/${encodeURIComponent(country.toLowerCase())}/${encodeURIComponent(zip)}`);
    if (!response.ok) throw new Error("Postal code not found");
    const data = await response.json() as { places?: Array<{ "place name"?: string; "state abbreviation"?: string; state?: string }> };
    const place = data.places?.[0];
    if (!place) throw new Error("Postal code not found");
    return Response.json({ city: place["place name"] || "", state: place["state abbreviation"] || place.state || "" });
  } catch {
    const local = country === "US" ? fallback[zip] : null;
    if (local) return Response.json(local);
    return Response.json({ error: "We couldn’t find that postal code. Enter the city and state manually." }, { status: 404 });
  }
}
