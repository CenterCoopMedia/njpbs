#!/usr/bin/env python3
"""Resample the NJ hero edge ring to one point per New Jersey municipality.

The hero point cloud (src/data/nj-points.json) draws the state's outline from an
ordered ``edge`` ring. New Jersey has 564 municipalities; this resamples that ring
to exactly 564 points, evenly spaced by arc length, so the boundary carries one
point per town -- a quiet, verifiable allusion, not a claim
layered onto the copy. Arc-length resampling keeps every new point on the original
outline polyline, so the silhouette and bounding box are preserved; only the
high-frequency detail between samples is dropped.

The data file is Python ``json.dumps`` output (compact, 4-decimal coords). Re-dumping
here preserves that exact serialization, so the diff touches only ``edge``, the
``counts.edge`` tally, and a ``meta`` note -- the 4500-point ``fill`` array is left
byte-for-byte unchanged.

Run manually after the source geometry changes; it is NOT part of the build or CI:

    python3 scripts/resample-nj-edge.py
"""
import json
import math
from pathlib import Path

# New Jersey's municipalities. The edge ring is sampled to exactly this many points
# (kept in sync with src/lib/nj-facts.ts NJ_MUNICIPALITIES and nj-points.test.ts).
NJ_MUNICIPALITIES = 564

DATA = Path(__file__).resolve().parent.parent / "src" / "data" / "nj-points.json"


def resample_closed_ring(ring, n):
    """Return n points evenly spaced by arc length around a closed ordered ring.

    Each output point lies on the original polyline (linear interpolation between
    two consecutive source vertices), so the outline is thinned, never reshaped.
    """
    m = len(ring)
    seg = []
    total = 0.0
    for i in range(m):
        ax, ay = ring[i]
        bx, by = ring[(i + 1) % m]  # wrap: the ring is closed
        d = math.hypot(bx - ax, by - ay)
        seg.append(d)
        total += d
    step = total / n
    out = []
    seg_idx = 0
    seg_start = 0.0  # cumulative arc length at the start of seg[seg_idx]
    for k in range(n):
        target = k * step
        while seg_idx < m and seg_start + seg[seg_idx] < target:
            seg_start += seg[seg_idx]
            seg_idx += 1
        if seg_idx >= m:  # floating-point overrun past the last segment
            out.append([round(ring[-1][0], 4), round(ring[-1][1], 4)])
            continue
        ax, ay = ring[seg_idx]
        bx, by = ring[(seg_idx + 1) % m]
        length = seg[seg_idx] or 1e-12
        t = (target - seg_start) / length
        out.append([round(ax + (bx - ax) * t, 4), round(ay + (by - ay) * t, 4)])
    return out


def main():
    raw = DATA.read_text()
    data = json.loads(raw)
    # The rest assumes the file is canonical json.dumps output, so re-dumping leaves
    # fill identical. If that ever stops holding, stop rather than reformat the whole
    # file and bury the real change.
    if json.dumps(data) != raw:
        raise SystemExit(
            "nj-points.json is not canonical json.dumps output; aborting to avoid a noisy rewrite."
        )

    before = len(data["edge"])
    data["edge"] = resample_closed_ring(data["edge"], NJ_MUNICIPALITIES)
    data["counts"]["edge"] = NJ_MUNICIPALITIES
    data["meta"]["edgeNote"] = (
        "edge ring resampled by arc length to 564 points, one per NJ municipality"
    )

    DATA.write_text(json.dumps(data))
    print(f"edge ring: {before} -> {len(data['edge'])} points (one per NJ municipality)")


if __name__ == "__main__":
    main()
