module.exports = {
  apps: [
    {
      name: 'proxyurl-server',
      cwd: __dirname + '/server',
      script: 'dist/index.js', // lean: build/migrate happen in pm2-boot.bat, not here
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' },
      out_file: '../logs/server-out.log',
      error_file: '../logs/server-err.log',
      time: true,
    },
    {
      name: 'proxyurl-backup',
      cwd: __dirname + '/server',
      script: 'scripts/backup-db.js',
      autorestart: false, // one-shot; re-triggered by cron_restart
      cron_restart: '0 2 * * *', // 02:00 daily — adjust as needed
      out_file: '../logs/backup-out.log',
      error_file: '../logs/backup-err.log',
      time: true,
    },
  ],
};
