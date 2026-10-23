const pairKey=(a,b)=>JSON.stringify([a.kind+':'+a.id,b.kind+':'+b.id].sort());
async function exclusions(client) {
 const ready=(await client.query("SELECT to_regclass('workforce_non_duplicate_pairs') AS ready")).rows[0]?.ready;
 if(!ready)return new Set();
 return new Set((await client.query('SELECT pair_key FROM workforce_non_duplicate_pairs')).rows.map(r=>r.pair_key));
}
module.exports={pairKey,exclusions};
