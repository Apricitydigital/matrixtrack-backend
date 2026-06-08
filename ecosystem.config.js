// PM2 Ecosystem Config — Production Scale
// Run with: pm2 start ecosystem.config.js
// Monitor with: pm2 monit
// Logs with: pm2 logs attendease-backend
module.exports = {
  apps: [
    {
      name: "attendease-backend",
      script: "app.js",

      // ─── CLUSTER MODE ──────────────────────────────────────────────────────
      // "max" = use ALL available CPU cores (t3.medium = 2 cores = 2 processes)
      // Each process handles requests independently → 2-4x throughput
      instances: "max",
      exec_mode: "cluster",

      // ─── ENV ───────────────────────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
      },

      // ─── MEMORY / CRASH RECOVERY ───────────────────────────────────────────
      // Auto-restart if process exceeds 512MB RAM (prevents memory leaks)
      max_memory_restart: "512M",

      // Restart delay after crash (prevents rapid crash loops)
      restart_delay: 2000,
      max_restarts: 10,

      // ─── LOGGING ───────────────────────────────────────────────────────────
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // ─── GRACEFUL RELOAD ───────────────────────────────────────────────────
      // Zero-downtime deploys: new process starts before old one stops
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 5000,

      // ─── WATCH ─────────────────────────────────────────────────────────────
      // Disabled in prod — use pm2 reload instead
      watch: false,
    },
  ],
};
