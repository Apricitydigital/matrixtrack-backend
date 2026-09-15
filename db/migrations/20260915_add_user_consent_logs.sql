-- Migration: Create user_consent_logs table for DPDP Act 2023 Compliance
CREATE TABLE IF NOT EXISTS user_consent_logs (
    id SERIAL PRIMARY KEY,
    user_id INT,                         -- Employee/User ID (if registered user)
    mobile VARCHAR(15),                  -- Worker mobile number
    emp_code VARCHAR(50),                -- Employee Code (e.g. PUSG07)
    consent_type VARCHAR(50) NOT NULL,   -- 'BIOMETRIC_FACE_AND_AADHAR'
    actor_type VARCHAR(20) NOT NULL,     -- 'SELF' or 'SUPERVISOR_PROXY'
    supervisor_id INT DEFAULT 0,         -- ID of Supervisor if added by Supervisor
    consent_given BOOLEAN NOT NULL DEFAULT TRUE,
    consent_version VARCHAR(10) DEFAULT 'v1.0',
    language_used VARCHAR(10) DEFAULT 'en', -- 'en', 'hi', 'mr'
    ip_address VARCHAR(45),
    device_info TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ucl_mobile ON user_consent_logs(mobile);
CREATE INDEX IF NOT EXISTS idx_ucl_emp_code ON user_consent_logs(emp_code);
CREATE INDEX IF NOT EXISTS idx_ucl_user_id ON user_consent_logs(user_id);
