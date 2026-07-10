const pool = require('../config/db');

async function backfill() {
  try {
    const targetDate = '2026-07-09';
    console.log(`Starting backfill for date: ${targetDate}`);

    // Fetch individual/self attendance
    const empRes = await pool.query(
      `SELECT a.attendance_id, a.punch_in_time, a.mid_shift_punch_in_time, a.punch_out_time,
              z.city_id, c.city_name
       FROM attendance a
       JOIN employee e ON e.emp_id = a.emp_id
       JOIN wards w ON w.ward_id = e.ward_id
       JOIN zones z ON z.zone_id = w.zone_id
       JOIN cities c ON c.city_id = z.city_id
       WHERE a.date = $1::date`,
      [targetDate]
    );
    console.log(`Found ${empRes.rows.length} employee attendance records for ${targetDate}`);

    // Fetch professional attendance
    const profRes = await pool.query(
      `SELECT pa.id, pa.punch_in, pa.punch_out, pa.city_id, c.city_name
       FROM professional_attendance pa
       JOIN cities c ON c.city_id = pa.city_id
       WHERE pa.date = $1::date`,
      [targetDate]
    );
    console.log(`Found ${profRes.rows.length} professional attendance records for ${targetDate}`);

    // Clear existing daily traffic cost rows for today to rebuild cleanly
    await pool.query(
      `DELETE FROM city_daily_traffic_cost WHERE metric_date = $1::date`,
      [targetDate]
    );
    console.log("Cleared existing traffic cost records for today.");

    const cityMetrics = {};

    const getOrCreateMetric = (cityId, source) => {
      const key = `${cityId}:${source}`;
      if (!cityMetrics[key]) {
        cityMetrics[key] = {
          metric_date: targetDate,
          city_id: cityId,
          source: source,
          request_count: 0,
          attendance_count: 0,
          success_count: 0,
          failure_count: 0
        };
      }
      return cityMetrics[key];
    };

    // Process employee attendance
    for (const r of empRes.rows) {
      const cityId = r.city_id;
      if (!cityId) continue;

      const metric = getOrCreateMetric(cityId, 'individual_attendance');

      if (r.punch_in_time) {
        metric.request_count += 1;
        metric.attendance_count += 1;
        metric.success_count += 1;
      }
      if (r.mid_shift_punch_in_time) {
        metric.request_count += 1;
        metric.attendance_count += 1;
        metric.success_count += 1;
      }
      if (r.punch_out_time) {
        metric.request_count += 1;
        metric.attendance_count += 1;
        metric.success_count += 1;
      }
    }

    // Process professional attendance
    for (const r of profRes.rows) {
      const cityId = r.city_id;
      if (!cityId) continue;

      if (r.punch_in) {
        const metric = getOrCreateMetric(cityId, 'professional_punch_in');
        metric.request_count += 1;
        metric.attendance_count += 1;
        metric.success_count += 1;
      }
      if (r.punch_out) {
        const metric = getOrCreateMetric(cityId, 'professional_punch_out');
        metric.request_count += 1;
        metric.attendance_count += 1;
        metric.success_count += 1;
      }
    }

    // Insert backfilled metrics
    for (const key of Object.keys(cityMetrics)) {
      const m = cityMetrics[key];
      if (m.request_count === 0 && m.attendance_count === 0) continue;

      await pool.query(
        `INSERT INTO city_daily_traffic_cost (
           metric_date, city_id, source, request_count, attendance_count, success_count, failure_count
         ) VALUES ($1::date, $2, $3, $4, $5, $6, $7)`,
        [
          m.metric_date,
          m.city_id,
          m.source,
          m.request_count,
          m.attendance_count,
          m.success_count,
          m.failure_count
        ]
      );
      console.log(`Inserted metrics for City ${m.city_id} (${m.source}): req=${m.request_count}, att=${m.attendance_count}`);
    }

    console.log("Backfill completed successfully!");

  } catch (err) {
    console.error("Backfill failed:", err);
  } finally {
    process.exit(0);
  }
}

backfill();
