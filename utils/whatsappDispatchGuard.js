const pool = require("../config/db");

const DISPATCH_TABLE = "whatsapp_report_dispatches";
let ensureDispatchTablePromise;

const ensureDispatchTable = async () => {
  if (!ensureDispatchTablePromise) {
    ensureDispatchTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS ${DISPATCH_TABLE} (
        report_name TEXT NOT NULL,
        report_date DATE NOT NULL,
        recipient_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (report_name, report_date, recipient_key)
      )
    `);
  }

  await ensureDispatchTablePromise;
};

const claimWhatsAppDispatch = async ({ reportName, reportDate, recipientKey }) => {
  await ensureDispatchTable();

  const { rowCount } = await pool.query(
    `
      INSERT INTO ${DISPATCH_TABLE} (report_name, report_date, recipient_key)
      VALUES ($1, $2::date, $3)
      ON CONFLICT (report_name, report_date, recipient_key) DO NOTHING
    `,
    [reportName, reportDate, recipientKey]
  );

  return rowCount === 1;
};

const releaseWhatsAppDispatch = async ({ reportName, reportDate, recipientKey }) => {
  await ensureDispatchTable();

  await pool.query(
    `
      DELETE FROM ${DISPATCH_TABLE}
      WHERE report_name = $1
        AND report_date = $2::date
        AND recipient_key = $3
    `,
    [reportName, reportDate, recipientKey]
  );
};

module.exports = {
  ensureDispatchTable,
  claimWhatsAppDispatch,
  releaseWhatsAppDispatch,
};
