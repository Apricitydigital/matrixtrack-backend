const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// Database configuration
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'attendease',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false },
});

async function createSupervisorUser() {
  try {
    console.log('🔍 Creating supervisor user for mobile app testing...');
    
    // Supervisor user data
    const supervisorData = {
      name: "Test Supervisor",
      emp_code: "SUP001",
      email: "supervisor@test.com",
      phone: "9876543210",
      role: "supervisor",
      password: "supervisor123"
    };

    // Hash password
    console.log('🔐 Hashing password...');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(supervisorData.password, salt);

    // Check if supervisor already exists
    const existingSupervisor = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [supervisorData.email]
    );

    if (existingSupervisor.rows.length > 0) {
      console.log('⚠️  Supervisor user already exists:');
      console.log('   Email:', supervisorData.email);
      console.log('   Password: supervisor123');
      return;
    }

    // Insert supervisor user
    console.log('💾 Inserting supervisor user into database...');
    const result = await pool.query(
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING user_id, name, email, emp_code, role, created_at`,
      [supervisorData.name, supervisorData.emp_code, supervisorData.email, supervisorData.phone, supervisorData.role, hashedPassword]
    );

    console.log('✅ Supervisor user created successfully!');
    console.log('\n👤 Supervisor User Details:');
    console.log('   ID:', result.rows[0].user_id);
    console.log('   Name:', result.rows[0].name);
    console.log('   Email:', result.rows[0].email);
    console.log('   Employee Code:', result.rows[0].emp_code);
    console.log('   Role:', result.rows[0].role);

    console.log('\n🔑 Login Credentials for Mobile App:');
    console.log('   Email: supervisor@test.com');
    console.log('   Password: supervisor123');

    console.log('\n📱 Next Steps:');
    console.log('1. Start the mobile app: cd attendeaseApp && npx expo start');
    console.log('2. Login with the supervisor credentials above');
    console.log('3. App will show supervisor interface');

  } catch (error) {
    console.error('❌ Error creating supervisor user:', error);
    
    if (error.code === '23505') {
      console.log('⚠️  Email or Employee Code already exists in database');
    } else if (error.code === 'ECONNREFUSED') {
      console.log('⚠️  Database connection failed');
      console.log('   Make sure PostgreSQL is running and database exists');
    } else {
      console.log('   Error details:', error.message);
    }
  } finally {
    // Close database connection
    await pool.end();
    console.log('\n🔌 Database connection closed');
  }
}

// Run the script
console.log('🚀 Starting Supervisor User Creation Script...\n');
createSupervisorUser();
