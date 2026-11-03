use rusqlite::{params, types::ValueRef, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS daily_rates (
  date TEXT PRIMARY KEY,
  gold22_per10g INTEGER NOT NULL,
  gold18_per10g INTEGER NOT NULL,
  silver_per_kg INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  mobile TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '',
  relative_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  state_code TEXT NOT NULL DEFAULT '',
  pan TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS logos (hash TEXT PRIMARY KEY, data_url TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT UNIQUE NOT NULL,
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  buyer_snapshot TEXT NOT NULL,
  shop_snapshot TEXT NOT NULL,
  taxable INTEGER NOT NULL,
  cgst INTEGER NOT NULL,
  sgst INTEGER NOT NULL,
  round_off INTEGER NOT NULL,
  grand_total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS invoices_date ON invoices(date);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  sl INTEGER NOT NULL,
  description TEXT NOT NULL,
  metal TEXT NOT NULL,
  weight_mg INTEGER NOT NULL,
  rate_input INTEGER NOT NULL,
  rate_per_g INTEGER NOT NULL,
  metal_value INTEGER NOT NULL,
  making_type TEXT NOT NULL,
  making_value INTEGER NOT NULL,
  making_amount INTEGER NOT NULL,
  hsn TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  mode TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference_no TEXT NOT NULL DEFAULT ''
);

-- Saved bills are never edited or deleted (GST). Only ACTIVE -> CANCELLED is allowed.
CREATE TRIGGER IF NOT EXISTS invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS invoices_only_cancel BEFORE UPDATE ON invoices
WHEN NOT (OLD.status = 'ACTIVE' AND NEW.status = 'CANCELLED'
  AND NEW.invoice_no IS OLD.invoice_no AND NEW.fy IS OLD.fy AND NEW.seq IS OLD.seq AND NEW.date IS OLD.date
  AND NEW.customer_id IS OLD.customer_id AND NEW.buyer_snapshot IS OLD.buyer_snapshot AND NEW.shop_snapshot IS OLD.shop_snapshot
  AND NEW.taxable IS OLD.taxable AND NEW.cgst IS OLD.cgst AND NEW.sgst IS OLD.sgst
  AND NEW.round_off IS OLD.round_off AND NEW.grand_total IS OLD.grand_total AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be edited, only cancelled'); END;
CREATE TRIGGER IF NOT EXISTS items_no_update BEFORE UPDATE ON invoice_items
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be edited'); END;
CREATE TRIGGER IF NOT EXISTS items_no_delete BEFORE DELETE ON invoice_items
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be edited'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be edited'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Saved bills cannot be edited'); END;
CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY,
  estimate_no TEXT UNIQUE NOT NULL,
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  customer_snapshot TEXT NOT NULL,
  shop_snapshot TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  round_off INTEGER NOT NULL,
  grand_total INTEGER NOT NULL,
  payment_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS estimates_date ON estimates(date);

CREATE TABLE IF NOT EXISTS estimate_items (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id),
  sl INTEGER NOT NULL,
  description TEXT NOT NULL,
  metal TEXT NOT NULL,
  weight_mg INTEGER NOT NULL,
  rate_input INTEGER NOT NULL,
  rate_per_g INTEGER NOT NULL,
  metal_value INTEGER NOT NULL,
  making_type TEXT NOT NULL,
  making_value INTEGER NOT NULL,
  making_amount INTEGER NOT NULL
);

-- Estimates follow the same rule as bills: never edited or deleted, only cancelled.
CREATE TRIGGER IF NOT EXISTS estimates_no_delete BEFORE DELETE ON estimates
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS estimates_only_cancel BEFORE UPDATE ON estimates
WHEN NOT (OLD.status = 'ACTIVE' AND NEW.status = 'CANCELLED'
  AND NEW.estimate_no IS OLD.estimate_no AND NEW.fy IS OLD.fy AND NEW.seq IS OLD.seq AND NEW.date IS OLD.date
  AND NEW.customer_id IS OLD.customer_id AND NEW.customer_snapshot IS OLD.customer_snapshot
  AND NEW.shop_snapshot IS OLD.shop_snapshot AND NEW.subtotal IS OLD.subtotal AND NEW.round_off IS OLD.round_off
  AND NEW.grand_total IS OLD.grand_total AND NEW.payment_mode IS OLD.payment_mode AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited, only cancelled'); END;
CREATE TRIGGER IF NOT EXISTS estimate_items_no_update BEFORE UPDATE ON estimate_items
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited'); END;
CREATE TRIGGER IF NOT EXISTS estimate_items_no_delete BEFORE DELETE ON estimate_items
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited'); END;
"#;

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(SCHEMA)?;
    migrate(conn)
}

/// Version 2 (app 0.2.0): customer CRM fields, old-jewellery exchange on estimates.
const MIGRATION_V2: &str = r#"
ALTER TABLE customers ADD COLUMN other_mobile TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN dob TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN anniversary TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE estimates ADD COLUMN exchange_total INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS estimate_exchanges (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id),
  sl INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS estimate_exchanges_no_update BEFORE UPDATE ON estimate_exchanges
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited'); END;
CREATE TRIGGER IF NOT EXISTS estimate_exchanges_no_delete BEFORE DELETE ON estimate_exchanges
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited'); END;

-- the edit guard must also cover the new column
DROP TRIGGER IF EXISTS estimates_only_cancel;
CREATE TRIGGER estimates_only_cancel BEFORE UPDATE ON estimates
WHEN NOT (OLD.status = 'ACTIVE' AND NEW.status = 'CANCELLED'
  AND NEW.estimate_no IS OLD.estimate_no AND NEW.fy IS OLD.fy AND NEW.seq IS OLD.seq AND NEW.date IS OLD.date
  AND NEW.customer_id IS OLD.customer_id AND NEW.customer_snapshot IS OLD.customer_snapshot
  AND NEW.shop_snapshot IS OLD.shop_snapshot AND NEW.subtotal IS OLD.subtotal AND NEW.round_off IS OLD.round_off
  AND NEW.grand_total IS OLD.grand_total AND NEW.payment_mode IS OLD.payment_mode AND NEW.created_at IS OLD.created_at
  AND NEW.exchange_total IS OLD.exchange_total)
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited, only cancelled'); END;
"#;

/// Version 3 (FIXES-PLAN step 2): an estimate's customer (name / mobiles) may be corrected, with an audit trail.
/// Everything else on an estimate stays locked, and GST invoices are not touched.
const MIGRATION_V3: &str = r#"
CREATE TABLE IF NOT EXISTS estimate_edits (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id),
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS estimate_edits_estimate ON estimate_edits(estimate_id);
-- the audit trail itself can never be changed
CREATE TRIGGER IF NOT EXISTS estimate_edits_no_update BEFORE UPDATE ON estimate_edits
BEGIN SELECT RAISE(ABORT, 'The edit history cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS estimate_edits_no_delete BEFORE DELETE ON estimate_edits
BEGIN SELECT RAISE(ABORT, 'The edit history cannot be changed'); END;

DROP TRIGGER IF EXISTS estimates_only_cancel;
CREATE TRIGGER estimates_only_cancel BEFORE UPDATE ON estimates
WHEN NOT (
  -- everything except status, customer and cancel fields is identical
  NEW.estimate_no IS OLD.estimate_no AND NEW.fy IS OLD.fy AND NEW.seq IS OLD.seq AND NEW.date IS OLD.date
  AND NEW.shop_snapshot IS OLD.shop_snapshot AND NEW.subtotal IS OLD.subtotal AND NEW.round_off IS OLD.round_off
  AND NEW.grand_total IS OLD.grand_total AND NEW.payment_mode IS OLD.payment_mode AND NEW.created_at IS OLD.created_at
  AND NEW.exchange_total IS OLD.exchange_total
  AND (
    -- cancel: ACTIVE -> CANCELLED, customer unchanged
    (OLD.status = 'ACTIVE' AND NEW.status = 'CANCELLED'
      AND NEW.customer_id IS OLD.customer_id AND NEW.customer_snapshot IS OLD.customer_snapshot)
    OR
    -- correct the customer of an active estimate; nothing else
    (OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE'
      AND NEW.cancel_reason IS OLD.cancel_reason AND NEW.cancelled_at IS OLD.cancelled_at)
  ))
BEGIN SELECT RAISE(ABORT, 'Saved estimates cannot be edited, only cancelled (the customer name and mobile can be corrected)'); END;
"#;

/// Version 4 (FIXES-PLAN step 4): fixed-price items (LUXMÉ 925 silver) and the cached SKU catalogue.
/// New item columns have defaults, so every existing line reads as a weight-priced item, exactly as before.
/// ADD COLUMN does not touch existing rows, so the no-update triggers on saved items stay in force.
const MIGRATION_V4: &str = r#"
ALTER TABLE invoice_items ADD COLUMN pricing TEXT NOT NULL DEFAULT 'WEIGHT';
ALTER TABLE invoice_items ADD COLUMN sku TEXT;
ALTER TABLE invoice_items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invoice_items ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE estimate_items ADD COLUMN pricing TEXT NOT NULL DEFAULT 'WEIGHT';
ALTER TABLE estimate_items ADD COLUMN sku TEXT;
ALTER TABLE estimate_items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE estimate_items ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS invoice_items_sku ON invoice_items(sku);
CREATE INDEX IF NOT EXISTS estimate_items_sku ON estimate_items(sku);

-- last copy of the LUXMÉ sheet (shop price only); replaced whole on each successful sync
CREATE TABLE IF NOT EXISTS catalogue (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  shop_price INTEGER NOT NULL,
  weight_mg INTEGER,
  qty INTEGER,
  synced_at TEXT NOT NULL
);
"#;

/// Brings an older database up to date, one version at a time, each step in a transaction.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {MIGRATION_V2} PRAGMA user_version = 2; COMMIT;"))?;
    }
    if version < 3 {
        conn.execute_batch(&format!("BEGIN; {MIGRATION_V3} PRAGMA user_version = 3; COMMIT;"))?;
    }
    if version < 4 {
        conn.execute_batch(&format!("BEGIN; {MIGRATION_V4} PRAGMA user_version = 4; COMMIT;"))?;
    }
    Ok(())
}

fn to_sql(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(rusqlite::types::Null),
        Value::Bool(b) => Box::new(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

pub fn select(conn: &Connection, sql: &str, args: &[Value]) -> rusqlite::Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let boxed: Vec<Box<dyn ToSql>> = args.iter().map(to_sql).collect();
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt.query(refs.as_slice())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(f) => Value::from(f),
                ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(_) => Value::Null,
            };
            m.insert(name.clone(), v);
        }
        out.push(m);
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct ExecResult {
    pub rows_affected: usize,
    pub last_insert_id: i64,
}

pub fn execute(conn: &Connection, sql: &str, args: &[Value]) -> rusqlite::Result<ExecResult> {
    let boxed: Vec<Box<dyn ToSql>> = args.iter().map(to_sql).collect();
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let n = conn.execute(sql, refs.as_slice())?;
    Ok(ExecResult { rows_affected: n, last_insert_id: conn.last_insert_rowid() })
}

#[derive(Deserialize, Debug)]
pub struct NewCustomer {
    pub mobile: String,
    pub name: String,
    pub relation: String,
    pub relative_name: String,
    pub address: String,
    pub state: String,
    pub state_code: String,
    pub pan: String,
}

fn weight_pricing() -> String {
    "WEIGHT".into()
}
fn one() -> i64 {
    1
}

#[derive(Deserialize, Debug, Default)]
pub struct NewItem {
    pub description: String,
    pub metal: String,
    pub weight_mg: i64,
    pub rate_input: i64,
    pub rate_per_g: i64,
    pub metal_value: i64,
    pub making_type: String,
    pub making_value: i64,
    pub making_amount: i64,
    #[serde(default)]
    pub hsn: String,
    /// WEIGHT or FIXED_PRICE
    #[serde(default = "weight_pricing")]
    pub pricing: String,
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default = "one")]
    pub qty: i64,
    /// FIXED_PRICE: tag price per piece in paise (GST-inclusive on bills)
    #[serde(default)]
    pub unit_price: i64,
}

#[derive(Deserialize, Debug)]
pub struct NewPayment {
    pub mode: String,
    pub amount: i64,
    pub reference_no: String,
}

#[derive(Deserialize, Debug)]
pub struct NewLogo {
    pub hash: String,
    pub data_url: String,
}

#[derive(Deserialize, Debug)]
pub struct NewInvoice {
    pub date: String,
    pub fy: String,
    pub prefix: String,
    /// First number to use when this FY has no bills yet.
    pub start_seq: Option<i64>,
    pub customer: Option<NewCustomer>,
    pub buyer_snapshot: Value,
    pub shop_snapshot: Value,
    pub logo: Option<NewLogo>,
    pub taxable: i64,
    pub cgst: i64,
    pub sgst: i64,
    pub round_off: i64,
    pub grand_total: i64,
    pub items: Vec<NewItem>,
    pub payments: Vec<NewPayment>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SavedInvoice {
    pub id: i64,
    pub invoice_no: String,
    pub seq: i64,
}

pub fn format_invoice_no(prefix: &str, fy: &str, seq: i64) -> String {
    format!("{prefix}/{fy}/{seq:03}")
}

/// Assigns the invoice number and writes the bill in one transaction: no gaps, no duplicates.
pub fn save_invoice(conn: &mut Connection, inv: &NewInvoice) -> rusqlite::Result<SavedInvoice> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let last: Option<i64> = tx
        .query_row("SELECT MAX(seq) FROM invoices WHERE fy = ?1", params![inv.fy], |r| r.get(0))
        .optional()?
        .flatten();
    let seq = match last {
        Some(s) => s + 1,
        None => inv.start_seq.unwrap_or(1).max(1),
    };
    let invoice_no = format_invoice_no(&inv.prefix, &inv.fy, seq);

    let customer_id: Option<i64> = match &inv.customer {
        Some(c) if !c.mobile.is_empty() => {
            tx.execute(
                "INSERT INTO customers (mobile, name, relation, relative_name, address, state, state_code, pan)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(mobile) DO UPDATE SET name=excluded.name, relation=excluded.relation,
                   relative_name=excluded.relative_name, address=excluded.address, state=excluded.state,
                   state_code=excluded.state_code,
                   pan=CASE WHEN excluded.pan <> '' THEN excluded.pan ELSE customers.pan END,
                   updated_at=datetime('now','localtime')",
                params![c.mobile, c.name, c.relation, c.relative_name, c.address, c.state, c.state_code, c.pan],
            )?;
            Some(tx.query_row("SELECT id FROM customers WHERE mobile = ?1", params![c.mobile], |r| r.get(0))?)
        }
        _ => None,
    };

    if let Some(l) = &inv.logo {
        tx.execute("INSERT OR IGNORE INTO logos (hash, data_url) VALUES (?1, ?2)", params![l.hash, l.data_url])?;
    }

    tx.execute(
        "INSERT INTO invoices (invoice_no, fy, seq, date, customer_id, buyer_snapshot, shop_snapshot,
           taxable, cgst, sgst, round_off, grand_total, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ACTIVE')",
        params![
            invoice_no,
            inv.fy,
            seq,
            inv.date,
            customer_id,
            inv.buyer_snapshot.to_string(),
            inv.shop_snapshot.to_string(),
            inv.taxable,
            inv.cgst,
            inv.sgst,
            inv.round_off,
            inv.grand_total
        ],
    )?;
    let id = tx.last_insert_rowid();
    for (i, it) in inv.items.iter().enumerate() {
        tx.execute(
            "INSERT INTO invoice_items (invoice_id, sl, description, metal, weight_mg, rate_input, rate_per_g,
               metal_value, making_type, making_value, making_amount, hsn, pricing, sku, qty, unit_price)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                id,
                (i + 1) as i64,
                it.description,
                it.metal,
                it.weight_mg,
                it.rate_input,
                it.rate_per_g,
                it.metal_value,
                it.making_type,
                it.making_value,
                it.making_amount,
                it.hsn,
                it.pricing,
                it.sku,
                it.qty,
                it.unit_price
            ],
        )?;
    }
    for p in &inv.payments {
        tx.execute(
            "INSERT INTO payments (invoice_id, mode, amount, reference_no) VALUES (?1, ?2, ?3, ?4)",
            params![id, p.mode, p.amount, p.reference_no],
        )?;
    }
    tx.commit()?;
    Ok(SavedInvoice { id, invoice_no, seq })
}

#[derive(Deserialize, Debug)]
pub struct EstimateCustomer {
    pub mobile: String,
    pub name: String,
    #[serde(default)]
    pub other_mobile: String,
}

#[derive(Deserialize, Debug)]
pub struct NewExchange {
    pub description: String,
    pub amount: i64,
}

#[derive(Deserialize, Debug)]
pub struct NewEstimate {
    pub date: String,
    pub fy: String,
    pub prefix: String,
    pub customer: Option<EstimateCustomer>,
    pub customer_snapshot: Value,
    pub shop_snapshot: Value,
    pub logo: Option<NewLogo>,
    pub subtotal: i64,
    pub round_off: i64,
    pub grand_total: i64,
    pub payment_mode: String,
    pub items: Vec<NewItem>,
    /// Old jewellery taken in exchange: money only, deducted from the total
    #[serde(default)]
    pub exchanges: Vec<NewExchange>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SavedEstimate {
    pub id: i64,
    pub estimate_no: String,
    pub seq: i64,
}

/// Same rules as bills: number assigned inside the transaction, own series per FY.
pub fn save_estimate(conn: &mut Connection, est: &NewEstimate) -> rusqlite::Result<SavedEstimate> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let last: Option<i64> = tx.query_row("SELECT MAX(seq) FROM estimates WHERE fy = ?1", params![est.fy], |r| r.get(0))?;
    let seq = last.map(|s| s + 1).unwrap_or(1);
    let estimate_no = format_invoice_no(&est.prefix, &est.fy, seq);

    // Remember the customer by mobile, but never overwrite bill details (address, PAN…) from an estimate.
    let customer_id: Option<i64> = match &est.customer {
        Some(c) if !c.mobile.is_empty() => {
            tx.execute(
                "INSERT INTO customers (mobile, name, other_mobile) VALUES (?1, ?2, ?3)
                 ON CONFLICT(mobile) DO UPDATE SET
                   name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
                   other_mobile = CASE WHEN excluded.other_mobile <> '' THEN excluded.other_mobile ELSE customers.other_mobile END,
                   updated_at = datetime('now','localtime')",
                params![c.mobile, c.name, c.other_mobile],
            )?;
            Some(tx.query_row("SELECT id FROM customers WHERE mobile = ?1", params![c.mobile], |r| r.get(0))?)
        }
        _ => None,
    };
    if let Some(l) = &est.logo {
        tx.execute("INSERT OR IGNORE INTO logos (hash, data_url) VALUES (?1, ?2)", params![l.hash, l.data_url])?;
    }
    tx.execute(
        "INSERT INTO estimates (estimate_no, fy, seq, date, customer_id, customer_snapshot, shop_snapshot,
           subtotal, round_off, grand_total, payment_mode, exchange_total, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ACTIVE')",
        params![
            estimate_no,
            est.fy,
            seq,
            est.date,
            customer_id,
            est.customer_snapshot.to_string(),
            est.shop_snapshot.to_string(),
            est.subtotal,
            est.round_off,
            est.grand_total,
            est.payment_mode,
            est.exchanges.iter().map(|x| x.amount).sum::<i64>()
        ],
    )?;
    let id = tx.last_insert_rowid();
    for (i, it) in est.items.iter().enumerate() {
        tx.execute(
            "INSERT INTO estimate_items (estimate_id, sl, description, metal, weight_mg, rate_input, rate_per_g,
               metal_value, making_type, making_value, making_amount, pricing, sku, qty, unit_price)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                (i + 1) as i64,
                it.description,
                it.metal,
                it.weight_mg,
                it.rate_input,
                it.rate_per_g,
                it.metal_value,
                it.making_type,
                it.making_value,
                it.making_amount,
                it.pricing,
                it.sku,
                it.qty,
                it.unit_price
            ],
        )?;
    }
    for (i, x) in est.exchanges.iter().enumerate() {
        tx.execute(
            "INSERT INTO estimate_exchanges (estimate_id, sl, description, amount) VALUES (?1, ?2, ?3, ?4)",
            params![id, (i + 1) as i64, x.description, x.amount],
        )?;
    }
    tx.commit()?;
    Ok(SavedEstimate { id, estimate_no, seq })
}

pub fn cancel_estimate(conn: &Connection, id: i64, reason: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE estimates SET status='CANCELLED', cancel_reason=?2, cancelled_at=datetime('now','localtime')
         WHERE id=?1 AND status='ACTIVE'",
        params![id, reason],
    )
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FieldEdit {
    pub field: String,
    pub old_value: String,
    pub new_value: String,
}

fn valid_mobile(m: &str) -> bool {
    m.is_empty() || (m.len() == 10 && m.chars().all(|c| c.is_ascii_digit()))
}

/// Corrects the customer on an ACTIVE estimate: snapshot, linked customer and an audit row per changed field,
/// all in one transaction. Returns the fields that changed (empty if nothing did).
pub fn update_estimate_customer(
    conn: &mut Connection,
    id: i64,
    name: &str,
    mobile: &str,
    other_mobile: &str,
) -> Result<Vec<FieldEdit>, String> {
    let name = name.trim();
    let mobile = mobile.trim();
    let other_mobile = other_mobile.trim();
    if !valid_mobile(mobile) {
        return Err("Mobile number must be 10 digits.".into());
    }
    if !valid_mobile(other_mobile) {
        return Err("Other mobile number must be 10 digits.".into());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let (status, snapshot): (String, String) = tx
        .query_row("SELECT status, customer_snapshot FROM estimates WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Estimate not found.")?;
    if status != "ACTIVE" {
        return Err("Only active estimates can be edited.".into());
    }
    let mut snap: Value = serde_json::from_str(&snapshot).unwrap_or_else(|_| Value::Object(Map::new()));
    let printed_name = if name.is_empty() { "Cash" } else { name };
    let mut edits = Vec::new();
    for (key, new) in [("name", printed_name), ("mobile", mobile), ("otherMobile", other_mobile)] {
        let old = snap.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if old != new {
            edits.push(FieldEdit { field: key.into(), old_value: old, new_value: new.into() });
            snap[key] = Value::from(new);
        }
    }
    if edits.is_empty() {
        return Ok(edits);
    }
    // Link to the customer with this mobile (created if new); no mobile means no linked customer.
    let customer_id: Option<i64> = if mobile.is_empty() {
        None
    } else {
        let real_name = if printed_name == "Cash" { "" } else { printed_name };
        tx.execute(
            "INSERT INTO customers (mobile, name, other_mobile) VALUES (?1, ?2, ?3)
             ON CONFLICT(mobile) DO UPDATE SET
               name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
               other_mobile = CASE WHEN excluded.other_mobile <> '' THEN excluded.other_mobile ELSE customers.other_mobile END,
               updated_at = datetime('now','localtime')",
            params![mobile, real_name, other_mobile],
        )
        .map_err(|e| e.to_string())?;
        Some(tx.query_row("SELECT id FROM customers WHERE mobile = ?1", params![mobile], |r| r.get(0)).map_err(|e| e.to_string())?)
    };
    tx.execute(
        "UPDATE estimates SET customer_snapshot = ?2, customer_id = ?3 WHERE id = ?1",
        params![id, snap.to_string(), customer_id],
    )
    .map_err(|e| e.to_string())?;
    for e in &edits {
        tx.execute(
            "INSERT INTO estimate_edits (estimate_id, field, old_value, new_value) VALUES (?1, ?2, ?3, ?4)",
            params![id, e.field, e.old_value, e.new_value],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(edits)
}

pub fn cancel_invoice(conn: &Connection, id: i64, reason: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE invoices SET status='CANCELLED', cancel_reason=?2, cancelled_at=datetime('now','localtime')
         WHERE id=?1 AND status='ACTIVE'",
        params![id, reason],
    )
}

/// Consistent copy of the live database (safe while it is open).
pub fn snapshot_to(conn: &Connection, dest: &std::path::Path) -> rusqlite::Result<()> {
    let _ = std::fs::remove_file(dest);
    conn.execute("VACUUM INTO ?1", params![dest.to_string_lossy()])?;
    Ok(())
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct CatalogueItem {
    pub sku: String,
    pub name: String,
    pub category: String,
    /// paise, GST-inclusive
    pub shop_price: i64,
    pub weight_mg: Option<i64>,
    pub qty: Option<i64>,
}

/// Swap in a freshly synced catalogue, all or nothing: a failed sync never leaves a half-empty cache.
pub fn replace_catalogue(conn: &mut Connection, items: &[CatalogueItem], synced_at: &str) -> Result<usize, String> {
    if items.is_empty() {
        return Err("The catalogue came back empty, so the last copy was kept.".into());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM catalogue", []).map_err(|e| e.to_string())?;
    let mut n = 0;
    for it in items {
        let sku = it.sku.trim().to_uppercase();
        if sku.is_empty() || it.shop_price <= 0 {
            continue;
        }
        // the first row wins when a SKU appears twice
        n += tx
            .execute(
                "INSERT OR IGNORE INTO catalogue (sku, name, category, shop_price, weight_mg, qty, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![sku, it.name.trim(), it.category.trim(), it.shop_price, it.weight_mg, it.qty, synced_at],
            )
            .map_err(|e| e.to_string())?;
    }
    if n == 0 {
        return Err("No usable rows in the catalogue (each needs a SKU and a ShopSP), so the last copy was kept.".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn invoice(date: &str, fy: &str) -> NewInvoice {
        NewInvoice {
            date: date.into(),
            fy: fy.into(),
            prefix: "SR".into(),
            start_seq: None,
            customer: Some(NewCustomer {
                mobile: "7060329291".into(),
                name: "Shruti".into(),
                relation: "D/o".into(),
                relative_name: "Sanjay".into(),
                address: "".into(),
                state: "Uttarakhand".into(),
                state_code: "05".into(),
                pan: "".into(),
            }),
            buyer_snapshot: json!({"name": "Shruti"}),
            shop_snapshot: json!({"name": "S.R. Jewellers"}),
            logo: None,
            taxable: 840950,
            cgst: 12614,
            sgst: 12614,
            round_off: 22,
            grand_total: 866200,
            items: vec![NewItem {
                description: "Gold Ring 22kt".into(),
                metal: "GOLD22".into(),
                weight_mg: 550,
                rate_input: 13900000,
                rate_per_g: 1390000,
                metal_value: 764500,
                making_type: "PCT".into(),
                making_value: 1000,
                making_amount: 76450,
                hsn: "7113".into(),
                ..weight_item()
            }],
            payments: vec![NewPayment { mode: "UPI".into(), amount: 866200, reference_no: "".into() }],
        }
    }

    fn weight_item() -> NewItem {
        NewItem { pricing: "WEIGHT".into(), qty: 1, ..Default::default() }
    }

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn numbers_are_sequential_and_reset_on_new_fy() {
        let mut c = mem();
        assert_eq!(save_invoice(&mut c, &invoice("2027-03-30", "26-27")).unwrap().invoice_no, "SR/26-27/001");
        assert_eq!(save_invoice(&mut c, &invoice("2027-03-31", "26-27")).unwrap().invoice_no, "SR/26-27/002");
        // 1 April: new financial year starts at 001
        assert_eq!(save_invoice(&mut c, &invoice("2027-04-01", "27-28")).unwrap().invoice_no, "SR/27-28/001");
        assert_eq!(save_invoice(&mut c, &invoice("2027-04-01", "27-28")).unwrap().invoice_no, "SR/27-28/002");
    }

    #[test]
    fn start_seq_only_applies_to_empty_fy_and_grows_past_999() {
        let mut c = mem();
        let mut inv = invoice("2026-10-10", "26-27");
        inv.start_seq = Some(999);
        assert_eq!(save_invoice(&mut c, &inv).unwrap().invoice_no, "SR/26-27/999");
        assert_eq!(save_invoice(&mut c, &inv).unwrap().invoice_no, "SR/26-27/1000");
    }

    #[test]
    fn cancelled_numbers_are_never_reused() {
        let mut c = mem();
        let a = save_invoice(&mut c, &invoice("2026-10-10", "26-27")).unwrap();
        assert_eq!(cancel_invoice(&c, a.id, "wrong weight").unwrap(), 1);
        assert_eq!(save_invoice(&mut c, &invoice("2026-10-10", "26-27")).unwrap().invoice_no, "SR/26-27/002");
        // cannot cancel twice, cannot edit, cannot delete
        assert_eq!(cancel_invoice(&c, a.id, "again").unwrap(), 0);
        assert!(c.execute("UPDATE invoices SET grand_total = 1 WHERE id = ?1", [a.id]).is_err());
        assert!(c.execute("DELETE FROM invoices WHERE id = ?1", [a.id]).is_err());
        assert!(c.execute("DELETE FROM invoice_items", []).is_err());
    }

    #[test]
    fn failed_save_leaves_no_gap() {
        let mut c = mem();
        let mut bad = invoice("2026-10-10", "26-27");
        bad.payments[0].mode = "x".into();
        // force a failure after the invoice row is inserted
        c.execute_batch("CREATE TRIGGER fail BEFORE INSERT ON payments WHEN NEW.mode = 'x' BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
        assert!(save_invoice(&mut c, &bad).is_err());
        assert_eq!(save_invoice(&mut c, &invoice("2026-10-10", "26-27")).unwrap().invoice_no, "SR/26-27/001");
    }

    #[test]
    fn repeat_customer_is_updated_not_duplicated() {
        let mut c = mem();
        save_invoice(&mut c, &invoice("2026-10-10", "26-27")).unwrap();
        let mut inv = invoice("2026-10-11", "26-27");
        inv.customer.as_mut().unwrap().address = "New address".into();
        save_invoice(&mut c, &inv).unwrap();
        let rows = select(&c, "SELECT address FROM customers", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["address"], "New address");
    }

    fn estimate(date: &str, fy: &str, mobile: &str, name: &str) -> NewEstimate {
        NewEstimate {
            date: date.into(),
            fy: fy.into(),
            prefix: "EST".into(),
            customer: Some(EstimateCustomer { mobile: mobile.into(), name: name.into(), other_mobile: "".into() }),
            customer_snapshot: json!({"name": name, "mobile": mobile, "otherMobile": ""}),
            shop_snapshot: json!({"name": "S.R. Jewellers"}),
            logo: None,
            subtotal: 8635704,
            round_off: -4,
            grand_total: 8635700,
            payment_mode: "Cash".into(),
            items: invoice(date, fy).items,
            exchanges: vec![],
        }
    }

    #[test]
    fn estimates_have_their_own_series_and_reset_each_fy() {
        let mut c = mem();
        save_invoice(&mut c, &invoice("2026-10-08", "26-27")).unwrap();
        assert_eq!(save_estimate(&mut c, &estimate("2026-10-08", "26-27", "", "Cash")).unwrap().estimate_no, "EST/26-27/001");
        assert_eq!(save_estimate(&mut c, &estimate("2027-03-31", "26-27", "", "Cash")).unwrap().estimate_no, "EST/26-27/002");
        assert_eq!(save_estimate(&mut c, &estimate("2027-04-01", "27-28", "", "Cash")).unwrap().estimate_no, "EST/27-28/001");
        // bill numbering is not affected by estimates
        assert_eq!(save_invoice(&mut c, &invoice("2026-10-09", "26-27")).unwrap().invoice_no, "SR/26-27/002");
    }

    #[test]
    fn estimates_can_only_be_cancelled() {
        let mut c = mem();
        let e = save_estimate(&mut c, &estimate("2026-10-08", "26-27", "", "Cash")).unwrap();
        assert!(c.execute("UPDATE estimates SET grand_total = 1 WHERE id = ?1", [e.id]).is_err());
        assert!(c.execute("DELETE FROM estimates WHERE id = ?1", [e.id]).is_err());
        assert!(c.execute("DELETE FROM estimate_items", []).is_err());
        assert_eq!(cancel_estimate(&c, e.id, "customer changed mind").unwrap(), 1);
        assert_eq!(cancel_estimate(&c, e.id, "again").unwrap(), 0);
        assert_eq!(save_estimate(&mut c, &estimate("2026-10-08", "26-27", "", "Cash")).unwrap().estimate_no, "EST/26-27/002");
    }

    #[test]
    fn estimate_keeps_customer_bill_details() {
        let mut c = mem();
        save_invoice(&mut c, &invoice("2026-10-08", "26-27")).unwrap(); // stores Uttarakhand address details
        save_estimate(&mut c, &estimate("2026-10-09", "26-27", "7060329291", "")).unwrap();
        let rows = select(&c, "SELECT name, state FROM customers", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "Shruti");
        assert_eq!(rows[0]["state"], "Uttarakhand");
        save_estimate(&mut c, &estimate("2026-10-09", "26-27", "9027515504", "Lakhmichand Sharma")).unwrap();
        assert_eq!(select(&c, "SELECT COUNT(*) AS n FROM customers", &[]).unwrap()[0]["n"], 2);
    }

    #[test]
    fn exchange_is_stored_and_cannot_be_edited() {
        let mut c = mem();
        let mut e = estimate("2026-10-15", "26-27", "", "Cash");
        e.exchanges = vec![
            NewExchange { description: "Old payal".into(), amount: 500000 },
            NewExchange { description: "".into(), amount: 120000 },
        ];
        let saved = save_estimate(&mut c, &e).unwrap();
        let rows = select(&c, "SELECT exchange_total FROM estimates WHERE id = ?1", &[saved.id.into()]).unwrap();
        assert_eq!(rows[0]["exchange_total"], 620000);
        assert!(c.execute("UPDATE estimates SET exchange_total = 0 WHERE id = ?1", [saved.id]).is_err());
        assert!(c.execute("DELETE FROM estimate_exchanges", []).is_err());
        assert!(c.execute("UPDATE estimate_exchanges SET amount = 1", []).is_err());
        // cancelling still works with the new column
        assert_eq!(cancel_estimate(&c, saved.id, "test").unwrap(), 1);
    }

    #[test]
    fn upgrades_a_version_1_database_without_losing_data() {
        // a 0.1.0 database: base schema only, user_version 0
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute("INSERT INTO customers (mobile, name) VALUES ('7060329291', 'Shruti')", []).unwrap();
        c.execute(
            "INSERT INTO estimates (estimate_no, fy, seq, date, customer_snapshot, shop_snapshot, subtotal, round_off, grand_total, payment_mode)
             VALUES ('EST/26-27/001', '26-27', 1, '2026-10-08', '{}', '{}', 100, 0, 100, 'Cash')",
            [],
        )
        .unwrap();
        init(&c).unwrap();
        init(&c).unwrap(); // running again is harmless
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4);
        let rows = select(&c, "SELECT name, other_mobile, notes FROM customers", &[]).unwrap();
        assert_eq!(rows[0]["name"], "Shruti");
        assert_eq!(rows[0]["other_mobile"], "");
        assert_eq!(select(&c, "SELECT exchange_total FROM estimates", &[]).unwrap()[0]["exchange_total"], 0);
        assert_eq!(save_estimate(&mut c, &estimate("2026-10-09", "26-27", "", "Cash")).unwrap().estimate_no, "EST/26-27/002");
    }

    #[test]
    fn estimate_saves_other_mobile_on_customer() {
        let mut c = mem();
        let mut e = estimate("2026-10-09", "26-27", "9027515504", "Lakhmichand Sharma");
        e.customer.as_mut().unwrap().other_mobile = "9720275804".into();
        save_estimate(&mut c, &e).unwrap();
        let rows = select(&c, "SELECT other_mobile FROM customers", &[]).unwrap();
        assert_eq!(rows[0]["other_mobile"], "9720275804");
    }

    #[test]
    fn estimate_customer_can_be_corrected_with_audit_trail() {
        let mut c = mem();
        let e = save_estimate(&mut c, &estimate("2026-10-08", "26-27", "9027515504", "Lakhmichand")).unwrap();
        let edits = update_estimate_customer(&mut c, e.id, "Lakhmichand Sharma", "9027515504", "9720275804").unwrap();
        assert_eq!(
            edits.iter().map(|x| x.field.as_str()).collect::<Vec<_>>(),
            vec!["name", "otherMobile"]
        );
        let row = select(&c, "SELECT customer_snapshot, customer_id FROM estimates WHERE id = ?1", &[e.id.into()]).unwrap();
        let snap: Value = serde_json::from_str(row[0]["customer_snapshot"].as_str().unwrap()).unwrap();
        assert_eq!(snap["name"], "Lakhmichand Sharma");
        assert_eq!(snap["otherMobile"], "9720275804");
        let audit = select(&c, "SELECT field, old_value, new_value FROM estimate_edits ORDER BY id", &[]).unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0]["old_value"], "Lakhmichand");
        assert_eq!(audit[0]["new_value"], "Lakhmichand Sharma");
        // the linked customer follows a changed mobile
        update_estimate_customer(&mut c, e.id, "Lakhmichand Sharma", "9000000001", "").unwrap();
        let cust = select(&c, "SELECT c.mobile FROM estimates e JOIN customers c ON c.id = e.customer_id WHERE e.id = ?1", &[e.id.into()]).unwrap();
        assert_eq!(cust[0]["mobile"], "9000000001");
        assert_eq!(select(&c, "SELECT COUNT(*) AS n FROM estimate_edits", &[]).unwrap()[0]["n"], 4); // + mobile, otherMobile
        // no change, no audit row
        assert!(update_estimate_customer(&mut c, e.id, "Lakhmichand Sharma", "9000000001", "").unwrap().is_empty());
        // the audit trail cannot be changed
        assert!(c.execute("DELETE FROM estimate_edits", []).is_err());
        assert!(c.execute("UPDATE estimate_edits SET new_value = 'x'", []).is_err());
    }

    #[test]
    fn everything_else_on_an_estimate_stays_locked() {
        let mut c = mem();
        let e = save_estimate(&mut c, &estimate("2026-10-08", "26-27", "", "Cash")).unwrap();
        for sql in [
            "UPDATE estimates SET grand_total = 1 WHERE id = ?1",
            "UPDATE estimates SET date = '2026-01-01' WHERE id = ?1",
            "UPDATE estimates SET payment_mode = 'UPI' WHERE id = ?1",
            "UPDATE estimates SET exchange_total = 5 WHERE id = ?1",
            "UPDATE estimates SET cancel_reason = 'x' WHERE id = ?1",
            // customer change smuggled in with another column
            "UPDATE estimates SET customer_snapshot = '{}', subtotal = 1 WHERE id = ?1",
            // customer change while cancelling
            "UPDATE estimates SET status = 'CANCELLED', customer_snapshot = '{}' WHERE id = ?1",
        ] {
            assert!(c.execute(sql, [e.id]).is_err(), "should be blocked: {sql}");
        }
        assert!(c.execute("DELETE FROM estimates WHERE id = ?1", [e.id]).is_err());
        // cancelled estimates cannot be edited at all
        cancel_estimate(&c, e.id, "test").unwrap();
        assert!(c.execute("UPDATE estimates SET customer_snapshot = '{\"name\":\"X\"}' WHERE id = ?1", [e.id]).is_err());
        assert_eq!(
            update_estimate_customer(&mut c, e.id, "X", "", "").unwrap_err(),
            "Only active estimates can be edited."
        );
    }

    #[test]
    fn estimate_customer_edit_validates_mobiles() {
        let mut c = mem();
        let e = save_estimate(&mut c, &estimate("2026-10-08", "26-27", "", "Cash")).unwrap();
        assert!(update_estimate_customer(&mut c, e.id, "A", "12345", "").is_err());
        assert!(update_estimate_customer(&mut c, e.id, "A", "", "98x7001122").is_err());
        assert_eq!(select(&c, "SELECT COUNT(*) AS n FROM estimate_edits", &[]).unwrap()[0]["n"], 0);
    }

    #[test]
    fn gst_invoices_stay_fully_locked() {
        let mut c = mem();
        let i = save_invoice(&mut c, &invoice("2026-10-08", "26-27")).unwrap();
        assert!(c.execute("UPDATE invoices SET buyer_snapshot = '{}' WHERE id = ?1", [i.id]).is_err());
        assert!(c.execute("UPDATE invoices SET customer_id = NULL WHERE id = ?1", [i.id]).is_err());
        assert!(c.execute("DELETE FROM invoices WHERE id = ?1", [i.id]).is_err());
    }

    #[test]
    fn upgrades_a_version_2_database_without_losing_data() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch(&format!("{MIGRATION_V2} PRAGMA user_version = 2;")).unwrap();
        // an estimate as version 2 saved it (items without the version 4 columns)
        c.execute_batch(
            "INSERT INTO estimates (estimate_no, fy, seq, date, customer_snapshot, shop_snapshot, subtotal, round_off, grand_total, payment_mode)
             VALUES ('EST/26-27/001', '26-27', 1, '2026-10-08', '{\"name\":\"Lakhmichand\",\"mobile\":\"9027515504\",\"otherMobile\":\"\"}', '{}', 100, 0, 100, 'Cash');",
        )
        .unwrap();
        let e = SavedEstimate { id: c.last_insert_rowid(), estimate_no: "EST/26-27/001".into(), seq: 1 };
        // version 2 does not allow a customer correction
        assert!(c.execute("UPDATE estimates SET customer_snapshot = '{}' WHERE id = ?1", [e.id]).is_err());
        init(&c).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4);
        assert_eq!(select(&c, "SELECT estimate_no FROM estimates", &[]).unwrap()[0]["estimate_no"], "EST/26-27/001");
        update_estimate_customer(&mut c, e.id, "Lakhmichand Sharma", "9027515504", "").unwrap();
        assert!(c.execute("UPDATE estimates SET grand_total = 1 WHERE id = ?1", [e.id]).is_err());
    }

    #[test]
    fn upgrades_a_version_3_database_keeping_old_items_as_weight_priced() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch(&format!("{MIGRATION_V2} {MIGRATION_V3} PRAGMA user_version = 3;")).unwrap();
        c.execute_batch(
            "INSERT INTO invoices (invoice_no, fy, seq, date, buyer_snapshot, shop_snapshot, taxable, cgst, sgst, round_off, grand_total)
               VALUES ('SR/26-27/001', '26-27', 1, '2026-10-08', '{}', '{}', 840950, 12614, 12614, 22, 866200);
             INSERT INTO invoice_items (invoice_id, sl, description, metal, weight_mg, rate_input, rate_per_g, metal_value, making_type, making_value, making_amount, hsn)
               VALUES (1, 1, 'Gold Ring 22kt', 'GOLD22', 550, 13900000, 1390000, 764500, 'PCT', 1000, 76450, '7113');",
        )
        .unwrap();
        init(&c).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4);
        let r = &select(&c, "SELECT description, metal_value, pricing, sku, qty, unit_price FROM invoice_items", &[]).unwrap()[0];
        assert_eq!(r["description"], "Gold Ring 22kt");
        assert_eq!(r["metal_value"], 764500);
        assert_eq!(r["pricing"], "WEIGHT");
        assert_eq!(r["sku"], Value::Null);
        assert_eq!(r["qty"], 1);
        assert_eq!(r["unit_price"], 0);
        // saved bills are still locked after the new columns
        assert!(c.execute("UPDATE invoice_items SET sku = 'RNG0005'", []).is_err());
        assert!(c.execute("DELETE FROM invoice_items", []).is_err());
        assert_eq!(select(&c, "SELECT COUNT(*) AS n FROM catalogue", &[]).unwrap()[0]["n"], 0);
    }

    #[test]
    fn fixed_price_items_are_saved_with_sku_qty_and_price() {
        let mut c = mem();
        let mut inv = invoice("2026-11-02", "26-27");
        inv.items.push(NewItem {
            description: "Silver 925 Ring (RNG0005)".into(),
            metal: "SILVER925".into(),
            rate_per_g: 145534,
            metal_value: 145534,
            making_type: "FIXED".into(),
            hsn: "7113".into(),
            pricing: "FIXED_PRICE".into(),
            sku: Some("RNG0005".into()),
            qty: 1,
            unit_price: 149900,
            ..Default::default()
        });
        let saved = save_invoice(&mut c, &inv).unwrap();
        let rows = select(&c, "SELECT pricing, sku, qty, unit_price FROM invoice_items WHERE invoice_id = ?1 ORDER BY sl", &[json!(saved.id)]).unwrap();
        assert_eq!(rows[0]["pricing"], "WEIGHT");
        assert_eq!(rows[0]["sku"], Value::Null);
        assert_eq!(rows[1]["pricing"], "FIXED_PRICE");
        assert_eq!(rows[1]["sku"], "RNG0005");
        assert_eq!(rows[1]["unit_price"], 149900);
        let mut est = estimate("2026-11-02", "26-27", "", "Cash");
        est.items = inv.items;
        let e = save_estimate(&mut c, &est).unwrap();
        let rows = select(&c, "SELECT sku FROM estimate_items WHERE estimate_id = ?1 ORDER BY sl", &[json!(e.id)]).unwrap();
        assert_eq!(rows[1]["sku"], "RNG0005");
    }

    #[test]
    fn catalogue_is_replaced_whole_or_kept() {
        let mut c = mem();
        let item = |sku: &str, price: i64| CatalogueItem {
            sku: sku.into(),
            name: "Ring".into(),
            category: "Rings".into(),
            shop_price: price,
            weight_mg: Some(3500),
            qty: Some(2),
        };
        assert_eq!(replace_catalogue(&mut c, &[item("rng0005", 149900), item("RNG0005", 1), item("PYL0001", 249900)], "2026-10-30 18:10").unwrap(), 2);
        let rows = select(&c, "SELECT sku, shop_price FROM catalogue ORDER BY sku", &[]).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["sku"], "RNG0005");
        assert_eq!(rows[1]["shop_price"], 149900); // first row wins
        // an empty or useless sync keeps the cached copy
        assert!(replace_catalogue(&mut c, &[], "2026-11-02 10:00").is_err());
        assert!(replace_catalogue(&mut c, &[item("", 100), item("X1", 0)], "2026-11-02 10:00").is_err());
        let rows = select(&c, "SELECT synced_at FROM catalogue", &[]).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["synced_at"], "2026-10-30 18:10");
        // a good sync replaces it whole
        assert_eq!(replace_catalogue(&mut c, &[item("BRC0001", 99900)], "2026-11-02 10:00").unwrap(), 1);
        assert_eq!(select(&c, "SELECT sku FROM catalogue", &[]).unwrap()[0]["sku"], "BRC0001");
    }
}
