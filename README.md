# Boozt Frontpage Archive

Takes screenshots of Boozt department frontpages (women, men, kids, home, sport, beauty) for 15 markets, on desktop and mobile, at 08:00 and 16:00 Copenhagen time. Runs on GitHub Actions, so no computer needs to be on. The viewer in `docs/` lets you filter by department, country, device and date.

## Set up

1. Create a private GitHub repo and push this folder to it.
2. Settings > Actions > General > Workflow permissions: choose "Read and write".
3. Settings > Pages: deploy from branch `main`, folder `/docs`. For a private repo this needs GitHub Enterprise Cloud with private Pages, otherwise anyone with the link can view the screenshots. Ask web dev where internal tools are hosted.
4. Actions > "Capture frontpages" > Run workflow with `only` = `se` to test Sweden first.
5. Open the Pages URL and check the screenshots.
6. Run it again with `only` empty to test all markets. Read the "Problems" lines in the log.

## Check and fix markets

- Sweden is pinned in `markets.json`. Other markets are discovered from the navigation on the market start page and cached in `urls.json`.
- The language codes in `markets.json` for other markets are guesses (for example `no/no`, `ee/et`, `fo/da`). Fix any that fail.
- If discovery picks the wrong link for a department, add the URL under `depts` for that market.
- `node capture.mjs --discover` prints what it finds without taking screenshots.
- Sport is split into `sport-women`, `sport-men` and `sport-kids`. Sweden is pinned. Other markets are discovered by looking for links containing `/sport` in the navigation, so check them after the first run.

## Size

One run is up to 240 screenshots. At about 100 to 150 KB each that is roughly 20 to 30 MB per run, or 40 to 60 MB per day. A repo grows past GitHub's recommended size within a few months. Set `RETENTION_DAYS` in `.github/workflows/capture.yml` (for example 90), or move `docs/shots` to a storage bucket.
