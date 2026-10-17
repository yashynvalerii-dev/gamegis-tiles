# GameGIS Tiles

Static, pre-processed OpenStreetMap data published on GitHub Pages for client applications.
The build runs here in GitHub Actions every week: it downloads the regional extract from
[Geofabrik](https://download.geofabrik.de/), verifies it, and cuts it into small JSON bundles.

## Using the data

1. Read `manifest.json` — data timestamp, bundle zoom and a SHA-256 for every bundle.
2. Compute the Web Mercator tile of a position at zoom 13 and fetch `bundles/13/{x}/{y}.json`.
3. Check `tiles["15/x/y"].status` for the z15 tile you need: only `READY` tiles are complete.
   `INCOMPLETE` tiles carry a reason (for example tiles on the region border) and publish no features.
4. `data` holds GeoJSON features grouped as `walkableWays`, `buildings`, `entrances`, `water`,
   `railways`, `restrictedAreas`, `restrictedWays` (coordinates `[lon, lat]`).

A missing bundle means the area has not been prepared yet.

## License and attribution

Map data © OpenStreetMap contributors, Open Database License (ODbL 1.0); extracts by Geofabrik GmbH.
Applications showing this data must credit “© OpenStreetMap contributors”.
The bundles are a derived database and remain under the ODbL.

The build code in `src/` and `tools/` is generated from a private project (see `PIPELINE_SOURCE.txt`)
and is published for transparency; no open-source license is granted for it at this time.
