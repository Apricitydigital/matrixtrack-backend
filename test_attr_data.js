const axios = require('axios');

const test = async () => {
  const pool = require('./config/db');
  const date = '2026-03-23'; // As in screenshot
  
  try {
    // Check employees count
    const empRes = await pool.query('SELECT count(*) FROM employee');
    console.log('Total Employees in DB:', empRes.rows[0].count);
    
    // Check attendance records for the date
    const attRes = await pool.query('SELECT count(*) FROM attendance WHERE date = $1', [date]);
    console.log('Total Attendance Records for', date, ':', attRes.rows[0].count);
    
    // Peek at one employee
    const oneEmp = await pool.query('SELECT emp_id, name, emp_code FROM employee LIMIT 1');
    console.log('Sample Employee:', oneEmp.rows[0]);
    
    // Peek at one attendance record
    const oneAtt = await pool.query('SELECT emp_id, punch_in_time FROM attendance WHERE date = $1 LIMIT 1', [date]);
    console.log('Sample Attendance Record:', oneAtt.rows[0]);
    
  } catch (err) {
    console.error('Test Failed:', err);
  } finally {
    process.exit(0);
  }
};

test();
