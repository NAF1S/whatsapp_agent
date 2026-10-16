module.exports = {
  apps: [
    {
      name: 'hh-agent',
      cwd: '/projects/HH-agent/agent',
      script: 'dist/index.js',
      watch: false,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'whatsapp-bridge',
      cwd: '/projects/HH-agent/whatsapp_bridge',
      script: 'whatsapp-bridge.js',
      watch: false,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
