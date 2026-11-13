"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

export type MappableSite = {
  id: string;
  name: string;
  city: string;
  state: string;
  latitude: string;
  longitude: string;
};

function mappedSites(sites: MappableSite[]) {
  return sites.flatMap((site) => {
    const latitude = Number(site.latitude);
    const longitude = Number(site.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? [{ ...site, latitude, longitude }]
      : [];
  });
}

export default function SiteMap({ sites }: { sites: MappableSite[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const validSites = useMemo(() => mappedSites(sites), [sites]);
  const siteKey = validSites
    .map((site) => `${site.id}:${site.latitude}:${site.longitude}`)
    .join("|");

  useEffect(() => {
    if (!containerRef.current || !validSites.length) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void import("maplibre-gl").then((maplibregl) => {
      if (disposed || !containerRef.current) return;
      const first = validSites[0];
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: "https://tiles.openfreemap.org/styles/fiord",
        center: [first.longitude, first.latitude],
        zoom: validSites.length === 1 ? 8 : 3,
        dragPan: true,
        scrollZoom: true,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      const bounds = new maplibregl.LngLatBounds();
      validSites.forEach((site) => {
        bounds.extend([site.longitude, site.latitude]);
        const popupContent = document.createElement("div");
        popupContent.className = "site-map-popup";
        const name = document.createElement("strong");
        name.textContent = site.name;
        const location = document.createElement("span");
        location.textContent = [site.city, site.state].filter(Boolean).join(", ");
        const coordinates = document.createElement("small");
        coordinates.textContent = `${site.latitude.toFixed(5)}, ${site.longitude.toFixed(5)}`;
        popupContent.append(name, location, coordinates);

        new maplibregl.Marker({ color: "#d7a739" })
          .setLngLat([site.longitude, site.latitude])
          .setPopup(new maplibregl.Popup({ offset: 24 }).setDOMContent(popupContent))
          .addTo(map);
      });

      if (validSites.length > 1) {
        map.fitBounds(bounds, { padding: 72, maxZoom: 10, duration: 0 });
      }
      resizeObserver = new ResizeObserver(() => map.resize());
      resizeObserver.observe(containerRef.current);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [siteKey]);

  return (
    <section className="site-map-view" aria-labelledby="site-map-title">
      <header className="site-map-header">
        <div>
          <p className="eyebrow">PORTFOLIO OVERVIEW</p>
          <h1 id="site-map-title">Site map</h1>
          <p>Explore the geographic footprint of configured solar sites.</p>
        </div>
        <div className="map-site-count">
          <strong>{validSites.length}</strong>
          <span>of {sites.length} sites mapped</span>
        </div>
      </header>
      {validSites.length ? (
        <div className="site-map-shell">
          <div ref={containerRef} className="site-map-canvas" aria-label="Interactive map of solar sites" />
          <div className="map-gesture-hint">Drag to pan · Scroll to zoom</div>
        </div>
      ) : (
        <div className="performance-empty map-empty">
          <span>⌖</span>
          <strong>No site coordinates available</strong>
          <p>Add latitude and longitude in Site Settings to plot sites on the map.</p>
        </div>
      )}
    </section>
  );
}
