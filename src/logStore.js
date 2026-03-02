const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const MAX_ENTRIES = 100;
let logs = [];

function loadLogs() {
  try {
    if (fs.existsSync(config.logFilePath)) {
      const data = fs.readFileSync(config.logFilePath, 'utf8');
      logs = JSON.parse(data);
      console.log(`[LOGS] Loaded ${logs.length} log entries`);
    } else {
      logs = [];
      console.log('[LOGS] No existing log file, starting fresh');
    }
  } catch (err) {
    console.error('[LOGS] Error loading logs:', err.message);
    logs = [];
  }
}

function saveLogs() {
  try {
    const dir = path.dirname(config.logFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.logFilePath, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('[LOGS] Error saving logs:', err.message);
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function formatTimestampET(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function generateSummary(entry) {
  const start = formatTimestampET(entry.first_timestamp);
  const end = formatTimestampET(entry.last_timestamp);

  if (entry.has_changes) {
    const parts = [];
    if (entry.details_json.new_shows_count > 0) parts.push(`${entry.details_json.new_shows_count} new`);
    if (entry.details_json.updated_shows_count > 0) parts.push(`${entry.details_json.updated_shows_count} updated`);
    if (entry.details_json.slack_posts_count > 0) parts.push(`${entry.details_json.slack_posts_count} Slack posts`);
    return `Checked ${entry.details_json.total_shows_seen} shows: ${parts.join(', ')}.`;
  }

  if (entry.checks_count === 1) {
    return `No changes: 1 check at ${start}, no Slack posts.`;
  }
  return `No changes: ${entry.checks_count} checks between ${start} and ${end}, no Slack posts.`;
}

function logRun(runResult) {
  try {
    const now = new Date().toISOString();
    const newShows = runResult.newShows || 0;
    const updatedShows = runResult.updatedShows || 0;
    const slackPosts = newShows + updatedShows;
    const totalSeen = runResult.totalShowsSeen || 0;
    const hasErrors = runResult.hasErrors || false;
    const errors = runResult.errors || [];
    const hasChanges = newShows > 0 || updatedShows > 0 || hasErrors;

    if (hasChanges) {
      const entry = {
        id: generateId(),
        first_timestamp: now,
        last_timestamp: now,
        run_type: 'show_check',
        has_changes: true,
        checks_count: 1,
        summary: '',
        details_json: {
          total_shows_seen: totalSeen,
          new_shows_count: newShows,
          updated_shows_count: updatedShows,
          slack_posts_count: slackPosts,
          slack_triggered: slackPosts > 0,
          changes: runResult.changes || [],
          has_errors: hasErrors,
          errors,
        },
      };
      entry.summary = hasErrors ? `Error: ${errors.join('; ')}` : generateSummary(entry);
      logs.unshift(entry);
      console.log(`[LOGS] New change entry: ${entry.summary}`);
    } else {
      const last = logs[0];
      if (last && last.run_type === 'show_check' && !last.has_changes) {
        last.checks_count += 1;
        last.last_timestamp = now;
        last.details_json.total_shows_seen = totalSeen;
        last.summary = generateSummary(last);
        console.log(`[LOGS] Rollup updated: ${last.checks_count} checks`);
      } else {
        const entry = {
          id: generateId(),
          first_timestamp: now,
          last_timestamp: now,
          run_type: 'show_check',
          has_changes: false,
          checks_count: 1,
          summary: '',
          details_json: {
            total_shows_seen: totalSeen,
            new_shows_count: 0,
            updated_shows_count: 0,
            slack_posts_count: 0,
            slack_triggered: false,
            changes: [],
          },
        };
        entry.summary = generateSummary(entry);
        logs.unshift(entry);
        console.log(`[LOGS] New no-change entry`);
      }
    }

    if (logs.length > MAX_ENTRIES) logs = logs.slice(0, MAX_ENTRIES);
    saveLogs();
  } catch (err) {
    console.error('[LOGS] Error logging run:', err.message);
  }
}

function getLogs(limit = 100) {
  return logs.slice(0, limit);
}

function clearLogs() {
  logs = [];
  saveLogs();
}

module.exports = { loadLogs, logRun, getLogs, clearLogs };
