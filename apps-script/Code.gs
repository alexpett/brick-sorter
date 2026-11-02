/**
 * Brick Sorter sync - Google Apps Script
 *
 * Paste this into the Apps Script editor of the Google Sheet you want to use as the backup
 * (Extensions > Apps Script), set SECRET_CODE below, then Deploy > New deployment > Web app.
 * See SETUP.md for the step-by-step version.
 *
 * The sheet gets one tab per kind of data (sets, bins, inventory, settings). Each row is one
 * record: key, updated, deleted, seq, summary (readable), json (the full record).
 * The newest "updated" time wins when the same record is changed in two places.
 */

// Make up a long random code (the app can generate one for you) and paste it between the quotes.
const SECRET_CODE = 'PASTE-YOUR-SECRET-CODE-HERE';

const TABLES = ['sets', 'bins', 'inventory', 'settings'];
const HEADER = ['key', 'updated', 'deleted', 'seq', 'summary', 'json'];
const COLS = HEADER.length;

function doGet() {
  return ContentService.createTextOutput('Brick Sorter sync is running.');
}

function doPost(e) {
  let out;
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET_CODE === 'PASTE-YOUR-SECRET-CODE-HERE') throw new Error('The script has no secret code yet. Edit SECRET_CODE in the script.');
    if (!body.token || body.token !== SECRET_CODE) throw new Error('Wrong secret code.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      out = handle(body);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (body.action === 'ping') return { ok: true, name: ss.getName() };

  const props = PropertiesService.getScriptProperties();
  let seq = Number(props.getProperty('seq') || 0);
  const since = Number(body.since || 0);
  const pulled = {};

  for (const table of TABLES) {
    const sh = sheetFor(ss, table);
    const last = sh.getLastRow();
    const data = last > 1 ? sh.getRange(2, 1, last - 1, COLS).getValues() : [];
    const index = {};
    data.forEach((r, i) => { index[String(r[0])] = i; });

    // Everything newer than the caller's cursor, read before this request's own changes are applied.
    pulled[table] = data.filter((r) => Number(r[3]) > since).map((r) => JSON.parse(r[5]));

    const incoming = (body.changes && body.changes[table]) || [];
    const appends = [];
    for (const rec of incoming) {
      const key = keyOf(table, rec);
      if (!key) continue;
      const updated = String(rec.updated || '');
      const i = index[key];
      if (i !== undefined && i < data.length) {
        if (updated <= String(data[i][1])) continue; // the sheet already has a newer (or same) version
        seq++;
        const row = makeRow(table, key, rec, seq);
        sh.getRange(i + 2, 1, 1, COLS).setValues([row]);
        data[i] = row;
      } else {
        seq++;
        appends.push(makeRow(table, key, rec, seq));
      }
    }
    if (appends.length) {
      const needed = last + appends.length;
      if (needed > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows() + 100);
      sh.getRange(Math.max(last, 1) + 1, 1, appends.length, COLS).setValues(appends);
    }
  }

  props.setProperty('seq', String(seq));
  return { ok: true, seq: seq, changes: pulled };
}

function keyOf(table, rec) {
  const k = table === 'settings' ? rec.key : table === 'sets' ? rec.set_num : rec.id;
  return k === undefined || k === null || k === '' ? '' : String(k);
}

function makeRow(table, key, rec, seq) {
  return [key, String(rec.updated || ''), rec.deleted ? 1 : 0, seq, summary(table, rec), JSON.stringify(rec)];
}

function summary(table, r) {
  if (table === 'inventory') return r.qty + ' x ' + r.name + ' (' + r.color_name + ')' + (r.part_num ? ' ' + r.part_num : '');
  if (table === 'sets') return r.set_num + ' ' + r.name + ' [' + (r.status || '') + (r.active_bin ? ' bin ' + r.active_bin : '') + ']';
  if (table === 'bins') return r.type === 'active' ? 'Bin ' + r.number + ' (' + r.set_num + ')' : r.label;
  if (table === 'settings') return r.key;
  return '';
}

function sheetFor(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, COLS).setValues([HEADER]);
    sh.getRange(1, 1, sh.getMaxRows(), COLS).setNumberFormat('@'); // keep ISO times and ids as plain text
    sh.setFrozenRows(1);
  }
  return sh;
}
