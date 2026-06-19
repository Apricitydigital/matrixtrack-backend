module.exports = {
  apps: [
    {
      name: "matrixtrack-api",
      script: "./app.js",
      instances: 2,
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "900M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
