module.exports = {
  apps: [{
    name: 'pds-wa-unofficial',
    script: './src/index.js',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 10000,
    env: {
      NODE_ENV: 'development',
      DB_PATH: './data/waun.db',
    },
    env_production: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      DB_PATH: './data/waun.db',
    },
  }],
}
