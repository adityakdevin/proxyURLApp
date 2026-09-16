module.exports = {
  apps: [
    {
      name: 'proxyurl-server',
      cwd: __dirname + '/server',
      script: 'dist/index.js', // lean: build/migrate happen in pm2-boot.bat, not here
      autorestart: true,
      max_restarts: 10,
      // max_restarts alone does NOT stop a crash loop. PM2 only counts a restart against it
      // when the process died inside min_uptime, which defaults to 1000ms — and this one
      // takes longer than that to reach app.listen and fail on EADDRINUSE, so every restart
      // was scored as healthy, the counter reset each time, and the box logged 303,917
      // restarts over seven days while pm2 status still said "online". 30s is comfortably
      // longer than a clean boot, so a start that dies on bind is now counted, and PM2 gives
      // up after ten and marks the app `errored` where somebody can see it.
      min_uptime: '30s',
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
