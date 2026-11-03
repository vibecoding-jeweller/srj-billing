/**
 * LUXMÉ 925 catalogue for SRJ Billing.
 *
 * Paste this into the LUXMÉ Inventory sheet (Extensions → Apps Script) and deploy it as a web app.
 * The app then reads ONLY: SKU, Name, ShopSP (shop price, GST-inclusive), Weight, Qty and the tab name.
 * Purchase cost (CP), OnlineSP, margins and everything else never leave the sheet, so the sheet itself
 * can stay private.
 *
 * Columns are found by their header name, never by position: tabs differ, some repeat a header
 * (the first one is used) and some have blank headers. Tabs without both "SKU" and "ShopSP"
 * (e.g. *_Results, Meta) are skipped.
 *
 * Read-only. (Marking a piece sold, Qty − 1, would be a doPost here later; not built yet.)
 */

/** Header text → the field it fills. Matching ignores case, spaces, dots and underscores. */
var LUXME_FIELDS = {
  sku: ['sku'],
  name: ['name', 'productname', 'itemname'],
  shopPrice: ['shopsp'],
  weight: ['weight', 'weightg', 'weightgm', 'wt'],
  qty: ['qty', 'quantity', 'stock'],
};

function luxmeKey_(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[\s._()\-]/g, '');
}

/** Column index of each field, taking the first column with a matching header. */
function luxmeColumns_(header) {
  var cols = {};
  for (var c = 0; c < header.length; c++) {
    var k = luxmeKey_(header[c]);
    if (!k) continue;
    for (var f in LUXME_FIELDS) {
      if (cols[f] === undefined && LUXME_FIELDS[f].indexOf(k) !== -1) cols[f] = c;
    }
  }
  return cols;
}

/** "₹1,499.00" / 1499 / "1499/-" → 1499 (rupees). Blank or junk → null. */
function luxmeNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = String(v == null ? '' : v).replace(/[₹,\s]|rs\.?|\/-|g(ms?|rams?)?$/gi, '');
  if (!s || !/^\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * One tab's values (as from getDataRange().getValues()) → catalogue rows.
 * The header row is the first of the top 10 rows that has both SKU and ShopSP.
 */
function parseLuxmeTab(tabName, values) {
  var out = [];
  var headerAt = -1;
  var cols = null;
  for (var r = 0; r < Math.min(values.length, 10); r++) {
    var c = luxmeColumns_(values[r] || []);
    if (c.sku !== undefined && c.shopPrice !== undefined) {
      headerAt = r;
      cols = c;
      break;
    }
  }
  if (!cols) return out; // *_Results, Meta and other non-stock tabs
  for (var i = headerAt + 1; i < values.length; i++) {
    var row = values[i] || [];
    var sku = String(row[cols.sku] == null ? '' : row[cols.sku]).trim().toUpperCase();
    var price = luxmeNumber_(row[cols.shopPrice]);
    if (!sku || !price || price <= 0) continue;
    out.push({
      sku: sku,
      name: cols.name === undefined ? '' : String(row[cols.name] == null ? '' : row[cols.name]).trim(),
      category: String(tabName).trim(),
      shopPrice: price,
      weight: cols.weight === undefined ? null : luxmeNumber_(row[cols.weight]),
      qty: cols.qty === undefined ? null : luxmeNumber_(row[cols.qty]),
    });
  }
  return out;
}

/** All tabs → one list. A SKU on two tabs is taken from the first. */
function buildLuxmeCatalogue(tabs) {
  var seen = {};
  var items = [];
  for (var t = 0; t < tabs.length; t++) {
    var rows = parseLuxmeTab(tabs[t].name, tabs[t].values);
    for (var i = 0; i < rows.length; i++) {
      if (seen[rows[i].sku]) continue;
      seen[rows[i].sku] = true;
      items.push(rows[i]);
    }
  }
  return items;
}

/** The web app: GET → {"ok":true,"generatedAt":"…","items":[{sku,name,category,shopPrice,weight,qty}]} */
function doGet() {
  var out;
  try {
    var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    var tabs = sheets.map(function (s) {
      return { name: s.getName(), values: s.getDataRange().getValues() };
    });
    out = { ok: true, generatedAt: new Date().toISOString(), items: buildLuxmeCatalogue(tabs) };
  } catch (e) {
    out = { ok: false, error: String(e) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
