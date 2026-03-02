require('dotenv').config();

const config = {
  usernames: process.env.WHATNOT_USERNAMES
    ? process.env.WHATNOT_USERNAMES.split(',').map(u => u.trim()).filter(Boolean)
    : [],

  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,

  triggerSecret: process.env.TRIGGER_SECRET || null,

  // State and log files — override with /data/state.json on Render (persistent disk)
  stateFilePath: process.env.STATE_FILE_PATH || './data/state.json',
  logFilePath: process.env.LOG_FILE_PATH || './data/debug_logs.json',

  whatnotBaseUrl: 'https://www.whatnot.com',
  whatnotApiUrl: 'https://api.whatnot.com/graphql',
};

function validateConfig() {
  const warnings = [];

  if (config.usernames.length === 0) {
    warnings.push('No WHATNOT_USERNAMES configured. Set to a comma-separated list of usernames.');
  }
  if (!config.slackWebhookUrl) {
    warnings.push('SLACK_WEBHOOK_URL not configured. Slack notifications will be disabled.');
  }
  if (!config.triggerSecret) {
    warnings.push('TRIGGER_SECRET not configured. The /run endpoint will be unsecured.');
  }

  for (const w of warnings) {
    console.warn(`[CONFIG] Warning: ${w}`);
  }

  return true;
}

function logConfig() {
  console.log('========================================');
  console.log('   Whatnot Monitor v2 — Configuration  ');
  console.log('========================================');
  console.log(`Usernames: ${config.usernames.length > 0 ? config.usernames.join(', ') : '(none)'}`);
  console.log(`Slack:     ${config.slackWebhookUrl ? 'enabled' : 'disabled'}`);
  console.log(`Auth:      ${config.triggerSecret ? 'TRIGGER_SECRET set' : 'UNSECURED'}`);
  console.log(`State:     ${config.stateFilePath}`);
  console.log('========================================');
}

module.exports = { config, validateConfig, logConfig };
