const pool = require("./config/db");
const badIds = [
  11374,11371,11373,11375,11379,11400,11389,11397,11384,11383,
  11391,11406,11404,6824,6827,3347,11372,11370,11369,11396,
  11363,6823
];
(async () => {
  const { rowCount } = await pool.query(
    "UPDATE employee SET face_embedding = NULL WHERE emp_id = ANY($1)",
    [badIds]
  );
  console.log({ cleared: rowCount });
  await pool.end();
})();
