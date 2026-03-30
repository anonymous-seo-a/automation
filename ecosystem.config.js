module.exports = {
  apps: [{
    name: 'mothership',
    script: './src/index.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx/esm',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
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
