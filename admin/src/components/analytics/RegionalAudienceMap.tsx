import * as React from 'react';
import { count } from './analytics-model';
export type Position = [number, number, ...number[]];
export type StateGeometry = {
  name: string;
  geometry:
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] };
};
/** Optional, dependency-free renderer for an EXISTING or verified licensed GeoJSON
 * asset. No fabricated state outlines or third-party map requests. State names must
 * match GA4's region labels. The accompanying ranked list remains authoritative. */
export function RegionalAudienceMap({ features, rows }: {
  features: StateGeometry[];
  rows: Array<{ name: string; activeUsers: number }>;
}) {
  if (!features.length) return null;
  const width = 480, height = 245;
  const bounds = { west: -80.8, east: -69.0, south: 37.8, north: 45.5 };
  const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
  const y0 = mercator(bounds.south), y1 = mercator(bounds.north);
  const project = ([longitude, latitude]: Position): [number, number] => [
    (longitude - bounds.west) / (bounds.east - bounds.west) * width,
    (y1 - mercator(latitude)) / (y1 - y0) * height,
  ];
  const values = new Map(rows.map(row => [row.name, row.activeUsers]));
  const maximum = Math.max(1, ...rows.map(row => row.activeUsers));
  const path = (feature: StateGeometry): string => {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    return polygons.map(polygon => polygon.map(ring => {
      if (ring.length < 4 || ring.some(position => !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || Math.abs(position[1]) >= 85)) return '';
      return ring.map((position, i) => `${i ? 'L' : 'M'}${project(position).map(value => value.toFixed(2)).join(',')}`).join(' ') + ' Z';
    }).join(' ')).join(' ');
  };
  return <figure className="bw-regional-map">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Northeast regional audience. Darker blue indicates more reported active users; the ranked list below gives exact counts.">
      {features.map(feature => {
        const value = values.get(feature.name);
        const band = value === undefined ? 'unknown' : value === 0 ? 'zero' : Math.min(4, Math.max(1, Math.ceil(value / maximum * 4)));
        return <path key={feature.name} d={path(feature)} fillRule="evenodd" className={`bw-map-band-${band}`}>
          <title>{feature.name}: {value === undefined ? 'not reported' : `${count(value)} active users`}</title>
        </path>;
      })}
    </svg>
    <figcaption>Approximate digital location, not broadcast coverage. Unreported regions are gray.</figcaption>
  </figure>;
}
