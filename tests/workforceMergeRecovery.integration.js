const assert=require('node:assert/strict');
module.exports=async({db,pool,call})=>{
 const recovery=require('../utils/workforceMergeRecovery');
 await db.exec('CREATE TABLE professional_site_access(professional_id UUID REFERENCES professional_employees(id),kothi_id INT,PRIMARY KEY(professional_id,kothi_id))');
 const a='b1111111-1111-4111-8111-111111111111',b='b2222222-2222-4222-8222-222222222222';
 await db.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,kothi_id,is_active,selfie_url,email,password_hash)
 VALUES($1,'Undo Professional','UNDO-P1','7777777777',1,10,true,'main-face','undo-main@example.test','main-hash'),
 ($2,'Undo Professional','UNDO-P2','7777777777',1,10,true,'source-face','undo-source@example.test','source-hash')`,[a,b]);
 await db.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out,punch_approval_status,city_id) VALUES
 ($1,'2026-10-01','2026-10-01 09:00','2026-10-01 18:00','accepted',1),
 ($2,'2026-10-01','2026-10-01 09:00','2026-10-01 18:00','accepted',1),
 ($2,'2026-10-02','2026-10-02 09:00',NULL,'accepted',1)`,[a,b]);
 await db.query(`INSERT INTO professional_punch_evidence(attendance_id,label) SELECT id,'undo-evidence' FROM professional_attendance WHERE professional_id=$1 AND date='2026-10-01'`,[b]);
 await db.exec(`CREATE TABLE recovery_uuid_fixture(id UUID PRIMARY KEY,professional_id UUID REFERENCES professional_employees(id),data JSONB,tags TEXT[],quantity NUMERIC,total NUMERIC GENERATED ALWAYS AS (quantity*2) STORED)`);
 await db.query(`INSERT INTO recovery_uuid_fixture(id,professional_id,data,tags,quantity) VALUES($1,$2,'{"original":true}',ARRAY['first','second'],1.25)`,[b,b]);
 await db.exec(`CREATE TABLE professional_week_off(id UUID DEFAULT gen_random_uuid() PRIMARY KEY,professional_id UUID UNIQUE REFERENCES professional_employees(id),week_off_days INT[],effective_from DATE);
 CREATE TABLE professional_week_off_versions(id BIGSERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees(id),week_off_days INT[],effective_from DATE);
 CREATE FUNCTION capture_professional_week_off() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO professional_week_off_versions(professional_id,week_off_days,effective_from) VALUES(NEW.professional_id,NEW.week_off_days,NEW.effective_from); RETURN NEW; END $$;
 CREATE TRIGGER professional_week_off_history BEFORE INSERT OR UPDATE ON professional_week_off FOR EACH ROW EXECUTE FUNCTION capture_professional_week_off();`);
 await db.query("INSERT INTO professional_week_off(professional_id,week_off_days,effective_from) VALUES($1,'{}','2026-10-17'),($2,'{0}','2026-10-17')",[a,b]);
 const weeklyBefore=(await db.query('SELECT to_jsonb(w) AS row FROM professional_week_off w ORDER BY id')).rows;
 const versionsBefore=(await db.query('SELECT to_jsonb(v) AS row FROM professional_week_off_versions v ORDER BY id')).rows;
 await db.query('INSERT INTO professional_site_access VALUES($1,10),($2,20)',[a,b]);
 const accessBefore=(await db.query('SELECT to_jsonb(t) AS row FROM professional_site_access t ORDER BY professional_id')).rows;
 await recovery.installRecoveryTriggers(pool);
 const before=(await db.query('SELECT to_jsonb(t) AS row FROM professional_attendance t WHERE professional_id=ANY($1::uuid[]) ORDER BY id',[[a,b]])).rows;
 const evidenceBefore=(await db.query("SELECT to_jsonb(t) AS row FROM professional_punch_evidence t WHERE label='undo-evidence'")).rows;
 const params={kind:'professional',id:a};
 assert.equal((await call('post','/:kind/:id/merge-preview',{params,body:{sourceIds:[b]}})).code,200,'Main weekly-off schedule is retained automatically');
 const pv=await call('post','/:kind/:id/merge-preview',{params,body:{sourceIds:[b],weeklyOffSourceId:b}});assert.equal(pv.code,200,JSON.stringify(pv.data));
 const merged=await call('post','/:kind/:id/merge',{params,body:{sourceIds:[b],weeklyOffSourceId:b,confirmation:a,reason:'Professional recovery test',fingerprint:pv.data.fingerprint}});
 assert.equal(merged.code,200,JSON.stringify(merged.data));
 assert.deepEqual((await db.query('SELECT kothi_id FROM professional_site_access WHERE professional_id=$1',[a])).rows.map(row=>row.kothi_id),[10],'Main must not inherit duplicate site permissions');
 assert.deepEqual((await db.query('SELECT week_off_days FROM professional_week_off WHERE professional_id=$1',[a])).rows[0].week_off_days,[]);
 const rp={mergeId:String(merged.data.mergeId)};
 assert.equal((await call('post','/merges/:mergeId/revert-preview',{user:3,params:rp})).code,403);
 assert.equal((await call('post','/merges/:mergeId/revert',{user:3,params:rp})).code,403);
 const oldPreview=await call('post','/merges/:mergeId/revert-preview',{params:rp});assert.equal(oldPreview.code,200,JSON.stringify(oldPreview.data));
 await db.query("INSERT INTO professional_attendance(professional_id,date,punch_in,punch_approval_status,city_id) VALUES($1,'2026-10-03','2026-10-03 09:00','accepted',1)",[a]);
 await db.query("UPDATE professional_attendance SET punch_out='2026-10-02 18:00' WHERE professional_id=$1 AND date='2026-10-02'",[a]);
 await db.query(`UPDATE recovery_uuid_fixture SET data='{"laterEdit":true}' WHERE id=$1`,[b]);
 const stale=await call('post','/merges/:mergeId/revert',{params:rp,body:{confirmation:a,reason:'Stale preview test',fingerprint:oldPreview.data.fingerprint}});
 assert.equal(stale.code,409);
 // Expiry is enforced by PostgreSQL, independent of browser clock.
 await db.query("UPDATE workforce_merge_audit SET restore_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[rp.mergeId]);
 assert.equal((await call('post','/merges/:mergeId/revert-preview',{params:rp})).code,409);
 await db.query("UPDATE workforce_merge_audit SET restore_until=clock_timestamp()+INTERVAL '1 hour' WHERE id=$1",[rp.mergeId]);
 // A changed FK must fail the whole inverse replay, including already-restored profiles.
 await db.query("UPDATE professional_punch_evidence SET attendance_id=(SELECT id FROM professional_attendance WHERE professional_id=$1 AND date='2026-10-03') WHERE label='undo-evidence'",[a]);
 assert.equal((await call('post','/merges/:mergeId/revert-preview',{params:rp})).code,409);
 assert.equal((await db.query('SELECT 1 FROM professional_employees WHERE id=$1',[b])).rows.length,0);
 await db.query("UPDATE professional_punch_evidence SET attendance_id=(SELECT id FROM professional_attendance WHERE professional_id=$1 AND date='2026-10-01') WHERE label='undo-evidence'",[a]);
 const preview=await call('post','/merges/:mergeId/revert-preview',{params:rp});assert.equal(preview.code,200,JSON.stringify(preview.data));
 const restored=await call('post','/merges/:mergeId/revert',{params:rp,body:{confirmation:a,reason:'Restore original profiles',fingerprint:preview.data.fingerprint}});
 assert.equal(restored.code,200,JSON.stringify(restored.data));
 const after=(await db.query("SELECT to_jsonb(t) AS row FROM professional_attendance t WHERE professional_id=ANY($1::uuid[]) AND date<>'2026-10-03' ORDER BY id",[[a,b]])).rows;
 const expected=before.map(({row})=>({row:row.date==='2026-10-02'?{...row,punch_out:'2026-10-02T18:00:00'}:row}));
 assert.deepEqual(after,expected,'Overlap originals and moved row ownership restored; later punch-out retained');
 assert.equal((await db.query("SELECT 1 FROM professional_attendance WHERE professional_id=$1 AND date='2026-10-03'",[a])).rows.length,1);
 assert.deepEqual((await db.query("SELECT to_jsonb(t) AS row FROM professional_punch_evidence t WHERE label='undo-evidence'")).rows,evidenceBefore);
 assert.equal((await db.query('SELECT password_hash FROM professional_employees WHERE id=$1',[b])).rows[0].password_hash,'source-hash');
 assert.equal((await db.query('SELECT 1 FROM workforce_employee_aliases WHERE source_id=$1',[b])).rows.length,0);
 assert.equal((await db.query('SELECT 1 FROM workforce_professional_login_aliases WHERE source_id=$1',[b])).rows.length,0);
 const typed=(await db.query('SELECT * FROM recovery_uuid_fixture WHERE id=$1',[b])).rows[0];
 assert.equal(typed.professional_id,b);
 assert.deepEqual(typed.data,{laterEdit:true});
 assert.deepEqual(typed.tags,['first','second']);
 assert.equal(Number(typed.total),2.5);
 assert.deepEqual((await db.query('SELECT to_jsonb(w) AS row FROM professional_week_off w ORDER BY id')).rows,weeklyBefore,'Both original schedules restored');
 assert.deepEqual((await db.query('SELECT to_jsonb(v) AS row FROM professional_week_off_versions v ORDER BY id')).rows,versionsBefore,'Restore must not append spurious weekly-off history');
 assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM professional_site_access t ORDER BY professional_id')).rows,accessBefore,'Revert restores the original site permissions exactly');
 const history=await call('get','/merges');assert.equal(history.code,200);
 assert.ok(!JSON.stringify(history.data).includes('source-hash'),'History must not expose credentials');
 assert.equal((await call('get','/merges',{user:3})).code,403);
 console.log('PASS: professional overlap recovery, evidence FKs, passwords, new punches, later punch-out, expiry, stale preview, conflict rollback and owner-only recovery.');
};
