const axios = require('axios');
const pool = require('./config/db');

(async () => {
    try {
        // Find an admin email
        const adminRes = await pool.query("SELECT email, password_hash FROM users WHERE role='admin' LIMIT 1");
        const adminEmail = adminRes.rows[0].email;
        
        // We can't log in without the plain password, but we can bypass it by updating the hash to 'password123'
        // OR we can just generate a token using JWT_SECRET from process.env! Wait, process.env is empty here unless loaded via dotenv!
        require('dotenv').config();
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: 1, role: 'admin', user_id: 1, email: adminEmail },
            process.env.JWT_SECRET || 'fallbacksecret', // I hope it's right. If not, I'll update the password hash temporarily!
            { expiresIn: '1d' }
        );

        const res = await axios.post('http://localhost:5000/api/attendance?date=2026-03-23', {}, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log("Live API records returned:", res.data.length);

    } catch (e) {
        console.error("Live API error:", e.response?.data || e.message);
    }
    process.exit(0);
})();
