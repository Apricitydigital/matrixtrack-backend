const { Client } = require('pg');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function run() {
  const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  });

  await client.connect();

  const names = ['Ishika', 'Jaspreet rathore', 'sunpreet sir', 'Neeraj verma'];
  for (const name of names) {
    const res = await client.query(`SELECT emp_id, emp_code, name, face_embedding FROM employee WHERE name ILIKE $1`, [`%${name}%`]);
    console.log(`Results for ${name}:`);
    res.rows.forEach(r => console.log(r));
    console.log('---');
  }

  await client.end();
}

run().catch(console.error);
