const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { config, validateConfig, logConfig } = require('./src/config');
const {
  loadState,
  getAllShows,
  markShowAsPosted,
  getState,
  getLastCheckedAt,
  getUnpostedShows,
} = require('./src/stateStore');
const { sendSlackNotification } = require('./src/notifySlack');
const { runOnce } = require('./src/monitor');
const { loadLogs, getLogs } = require('./src/logStore');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth middleware for the /run endpoint
// ---------------------------------------------------------------------------
function requireTriggerToken(req, res, next) {
  if (!config.triggerSecret) {
    // No secret configured — warn but allow (useful during local dev)
    console.warn('[AUTH] TRIGGER_SECRET not set — /run endpoint is unsecured');
    return next();
  }

  const provided = req.query.token || req.headers['x-trigger-token'];
  if (!provided) {
    return res.status(403).json({ success: false, error: 'Forbidden: no token provided' });
  }
  if (provided !== config.triggerSecret) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid token' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'whatnot-monitor', version: '2.0.0' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Trigger a monitoring run (supports both GET and POST for GitHub Actions flexibility)
async function handleRun(req, res) {
  console.log(`\n[RUN] Received trigger (${req.method})`);
  try {
    const result = await runOnce();
    res.json(result);
  } catch (err) {
    console.error('[RUN] Error:', err.message);
    res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
  }
}

app.post('/run', requireTriggerToken, handleRun);
app.get('/run', requireTriggerToken, handleRun);

// Config info (non-sensitive)
app.get('/api/config', (_req, res) => {
  res.json({
    usernames: config.usernames,
    slackConfigured: !!config.slackWebhookUrl,
  });
});

// Per-user status summary
app.get('/api/status', (_req, res) => {
  const status = {};

  for (const username of config.usernames) {
    const shows = getAllShows(username);
    const unposted = getUnpostedShows(username);

    const showsWithMeta = shows.map(s => ({
      ...s,
      status: s.postedToSlack ? 'posted' : 'pending',
      hasUpdates: (s.updateHistory?.length || 0) > 0,
      updateCount: s.updateHistory?.length || 0,
    }));

    status[username] = {
      totalShows: shows.length,
      postedShows: shows.filter(s => s.postedToSlack).length,
      unpostedShows: unposted.length,
      updatedShows: shows.filter(s => s.updateHistory?.length > 0).length,
      lastCheckedAt: formatTimeET(getLastCheckedAt(username)),
      shows: showsWithMeta.sort((a, b) => {
        // Unposted first, then newest first
        if (a.postedToSlack !== b.postedToSlack) return a.postedToSlack ? 1 : -1;
        return new Date(b.firstSeenAt) - new Date(a.firstSeenAt);
      }),
    };
  }

  res.json(status);
});

// All shows for a username
app.get('/api/shows/:username', (req, res) => {
  const { username } = req.params;
  if (!config.usernames.includes(username)) {
    return res.status(404).json({ error: 'Username not configured' });
  }

  const shows = getAllShows(username).map(s => ({
    ...s,
    status: s.postedToSlack ? 'posted' : 'pending',
  }));

  res.json({ username, shows });
});

// Manually post a show to Slack
app.post('/api/shows/:username/:showId/post', async (req, res) => {
  const { username, showId } = req.params;

  if (!config.usernames.includes(username)) {
    return res.status(404).json({ error: 'Username not configured' });
  }

  const show = getAllShows(username).find(s => s.id === showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  if (show.postedToSlack) return res.status(400).json({ error: 'Show already posted to Slack' });

  try {
    const ok = await sendSlackNotification(show, username);
    if (ok) {
      markShowAsPosted(username, showId);
      res.json({ success: true, message: 'Notification sent' });
    } else {
      res.status(500).json({ error: 'Failed to send Slack notification' });
    }
  } catch (err) {
    console.error('[API] Error posting to Slack:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug logs
app.get('/api/logs', (_req, res) => {
  try {
    res.json(getLogs(100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Web dashboard pages
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/debug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTimeET(dateString) {
  if (!dateString) return 'Never';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Never';
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET';
  } catch {
    return 'Never';
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function startServer() {
  validateConfig();
  logConfig();
  loadState();
  loadLogs();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('   Whatnot Monitor v2 — Self-Scheduled  ');
    console.log('========================================');
    console.log(`Listening on http://0.0.0.0:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /            Health check');
    console.log('  GET  /health      Health check');
    console.log('  POST /run         Manual trigger (token required)');
    console.log('  GET  /dashboard   Web dashboard');
    console.log('  GET  /debug       Debug logs');
    console.log('========================================\n');

    // Run once immediately on startup so we don't wait up to 5 min for first check
    console.log('[STARTUP] Running initial check...');
    runOnce().catch(err => console.error('[STARTUP] Initial run error:', err.message));

    // Internal cron — fires on clock-aligned 5-min marks (or CRON_SCHEDULE override)
    cron.schedule(config.cronSchedule, () => {
      console.log('\n[CRON] Scheduled trigger firing...');
      runOnce().catch(err => console.error('[CRON] Error during scheduled run:', err.message));
    });
    console.log(`[CRON] Scheduler started: ${config.cronSchedule}`);
  });
}

startServer().catch(err => {
  console.error('[FATAL] Failed to start server:', err.message);
  process.exit(1);
});
