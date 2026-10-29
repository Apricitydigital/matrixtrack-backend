const pool = require('../config/db');
const { getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { importOptions, validateImport, insertImport } = require('../utils/employeeBulkImport');

const scopes = req => ({
  cityIds: getPermissionCityFilter(req,'employees','write'),
  kothiIds: req.kothiScope?.all ? null : (req.kothiScope?.ids || []).map(Number),
});
const getOptions = async (req,res) => {
  try {
    const { cityIds,kothiIds } = scopes(req);
    res.json(await importOptions(pool,cityIds,kothiIds));
  } catch (error) {
    console.error('Employee import options failed:',error.code || error.message);
    res.status(500).json({ message:'Unable to load import locations and designations.' });
  }
};
const importEmployees = async (req,res) => {
  if (typeof req.body.preview !== 'boolean') return res.status(400).json({ message:'Specify preview as true or false.' });
  let client;
  try {
    const preview = req.body.preview;
    const { cityIds,kothiIds } = scopes(req);
    client = await pool.connect();
    await client.query(preview ? 'BEGIN READ ONLY' : 'BEGIN');
    if (!preview) {
      await client.query("SET LOCAL lock_timeout='3s'");
      // Serialize against other Employee Master writers until validation and
      // the single batch insert finish, including overlapping imports.
      await client.query('LOCK TABLE employee IN SHARE ROW EXCLUSIVE MODE');
    }
    const options = await importOptions(client,cityIds,kothiIds);
    const result = await validateImport(client,req.body.rows,options,cityIds,kothiIds);
    if (preview || !result.can_import) {
      await client.query('ROLLBACK');
      return res.status(preview ? 200 : 400).json({ ...result, preview, imported:0, message:result.can_import ? 'Ready to import. Review the employees below.' : 'Correct the listed rows and upload again. No employees were saved.' });
    }
    const employees = await insertImport(client,result.rows);
    await client.query('COMMIT');
    res.status(201).json({ success:true, imported:employees.length, employees, message:`Imported ${employees.length} employees.` });
  } catch (error) {
    if (client) try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Employee bulk import failed:',error.code || error.message);
    res.status(error.status || (['23505','23503','40001','40P01','55P03'].includes(error.code) ? 409 : 500)).json({ message:error.status ? error.message : 'Import could not be saved. No employees were imported. Preview the file again and retry.' });
  } finally { client?.release(); }
};
module.exports = { getOptions, importEmployees };
