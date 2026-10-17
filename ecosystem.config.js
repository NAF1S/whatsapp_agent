const path = require('path');

// Resolve paths relative to THIS file, not a hardcoded absolute host path. The repo can
// therefore be checked out anywhere (e.g. /projects/HH-agent on the home server or
// /home/ubuntu/projects/HH-agent/whatsapp_agent on EC2) without PM2 failing with
// "Script not found".
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'hh-agent',
      cwd: path.join(ROOT, 'agent'),
      script: 'dist/index.js',
      watch: false,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'whatsapp-bridge',
      cwd: path.join(ROOT, 'whatsapp_bridge'),
      script: 'whatsapp-bridge.js',
      watch: false,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
