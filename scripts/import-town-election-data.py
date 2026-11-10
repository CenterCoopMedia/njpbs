#!/usr/bin/env python3
"""Normalize reviewed downloads. No runtime fetches."""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('downloads', type=Path)
parser.add_argument('--downloaded-at', required=True, help='UTC ISO timestamp of the downloads')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
sources = {}

def csv_source(key, chart, label):
    path = args.downloads / (chart.replace('/', '-') + '.csv')
    rows = [{k.strip(): v.strip() for k, v in row.items() if k and k.strip()}
            for row in csv.DictReader(path.open(encoding='utf-8-sig'))
            if row.get('County', '').strip() and row.get('Municipality', '').strip()]
    assert len(rows) == 564, (chart, len(rows))
    indexed = {(row['County'], row['Municipality']): row for row in rows}
    assert len(indexed) == 564, 'Duplicate municipality/county'
    sources[key] = dict(label=label, url=f'https://datawrapper.dwcdn.net/{chart}/dataset.csv',
                        rows=len(rows), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    return indexed

federal = csv_source('federal', 'Jbmar/2', 'NJ Spotlight News, 2024 federal results')
history = csv_source('president', 'AShWs/2', 'NJ Spotlight News, presidential comparisons')
turnout = csv_source('turnout', 'xdQKT/2', 'NJ Spotlight News, 2024 general-election turnout')
assert federal.keys() == history.keys() == turnout.keys(), 'Municipality join mismatch'
geometry_path = args.downloads / 'municipalities.geojson'
geometry = json.loads(geometry_path.read_text())['features']
assert len(geometry) == 564
shapes = {str(f['properties']['MUN_CODE']).zfill(4): f for f in geometry}
assert len(shapes) == 564
sources['geometry'] = dict(label='NJ Office of GIS, municipal boundaries', rows=564,
    url='https://maps.nj.gov/arcgis/rest/services/Framework/Government_Boundaries/MapServer/2',
    sha256=hashlib.sha256(geometry_path.read_bytes()).hexdigest(), toleranceDegrees=0.002)
# Use the same projection and reviewed county outlines as official-nj-boundaries.ts.
projection = (260.0052908342445, 19884.395680708545, -334.9915465032699, 13972.398279645975)
county_source = (root / 'site/src/data/official-nj-boundaries.ts').read_text()
counties = json.loads(county_source[county_source.index('['):county_source.rindex(']') + 1])
assert len(counties) == 21

def share(row, key):
    value = float(row[key])
    assert 0 <= value <= 100, (row['Municipality'], key, value)
    return value

def pair(row, dem, rep):
    values = [share(row, dem), share(row, rep)]
    assert sum(values) <= 100.1
    return values

towns = []
map_points = []
for key, row in turnout.items():
    code = row['municode'].zfill(4)
    shape = shapes[code]
    assert shape['properties']['COUNTY'].casefold() == row['County'].casefold()
    polygons = shape['geometry']['coordinates']
    if shape['geometry']['type'] == 'Polygon': polygons = [polygons]
    assert shape['geometry']['type'] in ('Polygon', 'MultiPolygon')
    rings = [[[round(x * projection[0] + projection[1], 1),
               round(y * projection[2] + projection[3], 1)] for x, y, *_ in ring]
             for polygon in polygons for ring in polygon]
    points = [p for ring in rings for p in ring]
    map_points.extend(points)
    x1, y1 = map(min, zip(*points)); x2, y2 = map(max, zip(*points))
    path = ' '.join('M' + ' L'.join(f'{x:g} {y:g}' for x, y in ring) + ' Z' for ring in rings)
    f, h = federal[key], history[key]
    president2024 = pair(f, 'President Democrat Harris %', 'President Republican Trump %')
    assert president2024 == pair(h, '2024 President Democrat Harris', '2024 President Republican Trump')
    registered, ballots = int(row['Registered voters']), int(row['Ballots cast'])
    assert 0 < ballots <= registered
    pct = share(row, 'Turnout pct')
    assert abs(pct - 100 * ballots / registered) <= 0.11
    towns.append(dict(id=code, name=shape['properties']['MUN_LABEL'], county=row['County'],
        president2016=pair(h, '2016 President Democrat Clinton', '2016 President Republican Trump'),
        president2020=pair(h, '2020 President Democrat Biden', '2020 President Republican Trump'),
        president2024=president2024,
        senate2024=pair(f, 'Senate Democrat Kim %', 'Senate Republican Bashaw %'),
        house2024=dict(district=f['District'], democrat=f['House Dem'], republican=f['House Rep'],
                       shares=pair(f, 'House Democrat %', 'House Republican %')),
        turnout2024=dict(percent=pct, registered=registered, ballots=ballots),
        path=path, marker=[round((x1+x2)/2, 1), round((y1+y2)/2, 1)]))
assert {t['id'] for t in towns} == shapes.keys()
towns.sort(key=lambda t: (t['name'], t['county']))
for county in counties:
    coordinates = [float(value) for value in re.findall(r'-?\d+(?:\.\d+)?', county['path'])]
    map_points.extend(zip(coordinates[::2], coordinates[1::2]))
left, top = map(min, zip(*map_points))
right, bottom = map(max, zip(*map_points))
# The 9-unit location marker plus its stroke needs 10 units; 16 leaves room.
padding = 16
view_box = [round(left - padding, 1), round(top - padding, 1),
            round(right - left + 2 * padding, 1), round(bottom - top + 2 * padding, 1)]
boundaries = dict(version=1, downloadedAt=args.downloaded_at, rows=564, source=sources.pop('geometry'),
    countySource='site/src/data/official-nj-boundaries.ts', viewBox=view_box, counties=counties,
    towns=[dict(id=t['id'], path=t.pop('path'), marker=t.pop('marker')) for t in towns])
output = dict(version=1, downloadedAt=args.downloaded_at, rows=564, sources=sources,
    analysisUrl='https://www.njspotlightnews.org/special-report/how-nj-towns-voted-trump-harris-plus-senate-house-2024-election-breakdown/',
    towns=towns)
header = {k: v for k, v in output.items() if k != 'towns'}
serialized = json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  \"towns\": [\n'
serialized += ',\n'.join('    ' + json.dumps(t, ensure_ascii=False, separators=(',', ':')) for t in towns) + '\n  ]\n}\n'
(root / 'packages/content-core/data/nj-town-elections-v1.json').write_text(serialized)
(root / 'packages/content-core/data/nj-town-boundaries-v1.json').write_text(json.dumps(boundaries, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'Wrote {len(towns)} towns, {len(counties)} counties; joined by reviewed county/name and NJ municipality code.')
