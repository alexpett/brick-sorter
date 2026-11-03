# Brick Sorter

A phone web app for sorting a loose LEGO collection back into sets.

- Catalogue sets by set number (data from Rebrickable)
- Choose sets to rebuild; each gets a numbered active bin
- Add pieces with a LEGO colour picker; the app says which bin each piece belongs in
- Everything stays on your phone, with a Google Sheet as backup

Status: stages 1 (set catalogue), 2 (manual inventory and bins) 3 (Google Sheet backup), 4 (pick list) and 5 (camera) are built. See the build stages below.

## Build stages

1. Set catalogue
2. Manual inventory and bins
3. Sync and backup
4. Progress and missing parts
5. Camera identification

## Keys and privacy

This repository is public. API keys are never stored in the code: they are pasted into the app's Settings screen and kept on your own device.

Not affiliated with the LEGO Group, Rebrickable or Brickognize. LEGO is a trademark of the LEGO Group.

## Backup

See [apps-script/SETUP.md](apps-script/SETUP.md) to link a Google Sheet.

## Data and credits

Part, colour and category names in `data/` are derived from the [Rebrickable downloads](https://rebrickable.com/downloads/). To refresh them, download the CSVs and run `python3 tools/build-data.py <csv folder>`.

## Brickognize

Camera recognition uses the free [Brickognize](https://brickognize.com) API. Its author confirmed that personal use is welcome, with no daily quota and a limit of five requests per second per IP.
