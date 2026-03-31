module.exports = {
  apps: [{
    name: 'mothership',
    script: './dist/index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    min_uptime: 10000,
    max_restarts: 3,
    kill_timeout: 5000,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    time: true,
  }],
};
