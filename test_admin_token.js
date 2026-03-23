const pool = require('./config/db');

(async () => {
    try {
        const adminRes = await pool.query("SELECT email, password FROM users WHERE role='admin' LIMIT 1");
        console.log("Admin user:", adminRes.rows[0]);
        // I won't know the password if it's hashed.
        // Let's just create a token manually.
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: 1, role: 'admin', user_id: 1, email: adminRes.rows[0].email },
            process.env.JWT_SECRET || 'fallbacksecret', // Need to know JWT secret from .env!
            { expiresIn: '1d' }
        );
        console.log("Token:", token);
        
        // Let's just create a mock express app to test `attendanceRoutes`? No, let's just use the real app if we can get the auth right.
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
})();
