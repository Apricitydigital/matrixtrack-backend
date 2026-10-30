const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { resolveProfessionalLocation } = require('../utils/professionalLocation');

test('resolveProfessionalLocation resolves canonical hierarchy', async (t) => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE cities (city_id INT PRIMARY KEY, city_name TEXT);
    CREATE TABLE zones (zone_id INT PRIMARY KEY, city_id INT, zone_name TEXT);
    CREATE TABLE sectors (sector_id INT PRIMARY KEY, zone_id INT, sector_name TEXT);
    CREATE TABLE wards (ward_id INT PRIMARY KEY, sector_id INT, zone_id INT, ward_name TEXT);

    INSERT INTO cities VALUES (1, 'Indore');
    INSERT INTO zones VALUES (114, 1, 'Indore Municipal Corporation');
    INSERT INTO sectors VALUES (145, 114, 'IMC ZONE 08');
    INSERT INTO wards VALUES (1590, 145, 114, '37');
  `);

  await t.test('resolves legacy request where ward_id was stored as wards.ward_id (1590/1590)', async () => {
    const loc = await resolveProfessionalLocation(db, {
      city_id: 1,
      zone_id: 114,
      ward_id: 1590,
      kothi_id: 1590
    });

    assert.equal(loc.ward_id, 145, 'Sector ID must resolve to 145');
    assert.equal(loc.kothi_id, 1590, 'Kothi ID must resolve to 1590');
    assert.equal(loc.employee_ward_id, 1590, 'Employee Master ward must be 1590');
    assert.equal(loc.zone_id, 114);
    assert.equal(loc.city_id, 1);
  });

  await t.test('resolves modern canonical request where ward_id is sector_id (145/1590)', async () => {
    const loc = await resolveProfessionalLocation(db, {
      city_id: 1,
      zone_id: 114,
      ward_id: 145,
      kothi_id: 1590
    });

    assert.equal(loc.ward_id, 145);
    assert.equal(loc.kothi_id, 1590);
    assert.equal(loc.employee_ward_id, 1590);
  });

  await t.test('resolves request with only sector_id and no kothi', async () => {
    const loc = await resolveProfessionalLocation(db, {
      city_id: 1,
      zone_id: 114,
      ward_id: 145,
      kothi_id: null
    });

    assert.equal(loc.ward_id, 145);
    assert.equal(loc.kothi_id, null);
    assert.equal(loc.employee_ward_id, 1590, 'Employee master should fallback to ward in sector');
  });

  await t.test('resolves city from zone when city_id is missing', async () => {
    const loc = await resolveProfessionalLocation(db, {
      city_id: null,
      zone_id: 114,
      ward_id: 145,
      kothi_id: 1590
    });

    assert.equal(loc.city_id, 1);
    assert.equal(loc.zone_id, 114);
    assert.equal(loc.ward_id, 145);
    assert.equal(loc.kothi_id, 1590);
  });
});
