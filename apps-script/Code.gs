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

// Your secret code. Best: save it as a script property named SECRET_CODE (Project Settings >
// Script properties), so it never sits in the code. Otherwise paste it between the quotes below.
const SECRET_CODE = 'PASTE-YOUR-SECRET-CODE-HERE';

function secretCode() {
  return PropertiesService.getScriptProperties().getProperty('SECRET_CODE') || SECRET_CODE;
}

const TABLES = ['sets', 'bins', 'inventory', 'settings', 'log'];
const HEADER = ['key', 'updated', 'deleted', 'seq', 'summary', 'json'];
const COLS = HEADER.length;

function doGet() {
  return ContentService.createTextOutput('Brick Sorter sync is running.');
}

function doPost(e) {
  let out;
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = secretCode();
    if (secret === 'PASTE-YOUR-SECRET-CODE-HERE') throw new Error('The script has no secret code yet. Add a script property named SECRET_CODE (or edit SECRET_CODE in the script).');
    if (!body.token || body.token !== secret) throw new Error('Wrong secret code.');
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
  if (body.action === 'recognise') return recognise(body);

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
  return { ok: true, v: 2, seq: seq, changes: pulled };
}

// Camera fallback: forwards a photo to Brickognize from Google's servers, in case the browser
// is not allowed to call Brickognize directly. The photo is not stored in the sheet.
function recognise(body) {
  const blob = Utilities.newBlob(Utilities.base64Decode(String(body.image || '')), 'image/jpeg', 'photo.jpg');
  const res = UrlFetchApp.fetch('https://api.brickognize.com/predict/parts/', {
    method: 'post',
    headers: { 'User-Agent': 'BrickSorter/1.0 (personal LEGO sorting app; github.com/alexpett/brick-sorter)' },
    payload: { query_image: blob },
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  let result = null;
  try { result = JSON.parse(res.getContentText()); } catch (err) { /* not JSON */ }
  return { ok: status === 200 && !!result, status: status, result: result, error: status === 200 ? '' : 'Brickognize answered with status ' + status };
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
  if (table === 'log') return r.qty + ' pieces at ' + r.t;
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
