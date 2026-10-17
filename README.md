# GameGIS Tiles

Static, pre-processed OpenStreetMap data published on GitHub Pages for client applications.
The build runs here in GitHub Actions every week: it downloads the extracts listed in `regions.json` from
[Geofabrik](https://download.geofabrik.de/), verifies them, and cuts the published areas into small JSON bundles.
`manifest.json` lists the regions (`regions`) and every bundle.

## Using the data

1. Read `manifest.json` — data timestamp, bundle zoom and a SHA-256 for every bundle.
2. Compute the Web Mercator tile of a position at zoom 13 and fetch `bundles/13/{x}/{y}.json.gz`
   (gzip — decompress with `DecompressionStream('gzip')`; verify the SHA-256 from the manifest first).
3. Check `tiles["15/x/y"].status` for the z15 tile you need: only `READY` tiles are complete.
   `INCOMPLETE` tiles carry a reason (for example tiles on the region border) and publish no features.
4. `data` holds GeoJSON features grouped as `walkableWays`, `buildings`, `entrances`, `water`,
   `railways`, `power`, `restrictedAreas`, `restrictedWays` (coordinates `[lon, lat]`).
   Power features keep `power`, `voltage` and `location` (e.g. `underground`) tags.

A missing bundle means the area has not been prepared yet.

### Ready-made client

`gamegis-client.js` (published at the site root) does all of the above: mirror failover,
SHA-256 check, gzip, per-tile status and optional offline cache. Copy it into the application.

```js
import {createTileClient} from './gamegis-client.js';
const tiles = createTileClient({mirrors: ['https://yashynvalerii-dev.github.io/gamegis-tiles/']});
const area = await tiles.getArea({lat: 51.0102, lon: 11.0036, radiusM: 500});
// area.status: READY | PARTIAL | UNAVAILABLE; area.tiles["15/x/y"].status; area.data.buildings ...
```

## License and attribution

Map data © OpenStreetMap contributors, Open Database License (ODbL 1.0); extracts by Geofabrik GmbH.
Applications showing this data must credit “© OpenStreetMap contributors”.
The bundles are a derived database and remain under the ODbL.

The build code in `src/` and `tools/` is generated from a private project (see `PIPELINE_SOURCE.txt`)
and is published for transparency; no open-source license is granted for it at this time.
