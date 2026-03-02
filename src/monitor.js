const { config } = require('./config');
const {
  loadState,
  isShowKnown,
  addShow,
  markShowAsPosted,
  updateShowDetails,
  getAllShows,
  updateLastCheckedAt,
  getState,
} = require('./stateStore');
const { fetchShows } = require('./fetchShows');
const { sendSlackNotification, sendShowUpdateNotification } = require('./notifySlack');
const { logRun } = require('./logStore');

// Track which usernames are on their first run this process lifetime
let isFirstRun = {};

async function checkUserShows(username) {
  console.log(`\n[CHECK] Checking shows for ${username}...`);

  try {
    const shows = await fetchShows(username);

    if (shows.length === 0) {
      console.log(`[CHECK] No shows found for ${username}`);
      updateLastCheckedAt(username);
      return { newShows: [], updatedShows: [], existingShows: [] };
    }

    const newShows = [];
    const updatedShows = [];
    const existingShows = [];

    for (const show of shows) {
      const known = isShowKnown(username, show.id);

      if (!known) {
        console.log(`[CHECK] New show: ${show.id} — "${show.title}"`);

        if (isFirstRun[username]) {
          // First run: ingest all shows without alerting (avoid flood)
          addShow(username, show, true);
          console.log(`[CHECK] First run — stored without alerting`);
        } else {
          addShow(username, show, false);
          newShows.push(show);

          console.log(`[CHECK] Sending Slack notification...`);
          const ok = await sendSlackNotification(show, username);
          if (ok) {
            markShowAsPosted(username, show.id);
            console.log(`[CHECK] Notification sent`);
          } else {
            console.log(`[CHECK] Notification failed`);
          }
        }
      } else {
        const result = updateShowDetails(username, show);

        if (result.updated) {
          console.log(`[CHECK] Show updated: ${show.id} — changes: ${JSON.stringify(result.changes)}`);
          updatedShows.push({ show, changes: result.changes });

          const ok = await sendShowUpdateNotification(show, username, result.changes);
          if (ok) {
            console.log(`[CHECK] Update notification sent`);
          } else {
            console.log(`[CHECK] Update notification failed`);
          }
        } else {
          existingShows.push(show);
        }
      }
    }

    if (isFirstRun[username]) {
      console.log(`[CHECK] First run complete — stored ${shows.length} shows without alerting`);
      isFirstRun[username] = false;
    }

    updateLastCheckedAt(username);

    const newCount = newShows.length;
    const updCount = updatedShows.length;
    if (newCount === 0 && updCount === 0) {
      console.log(`[CHECK] No new or updated shows for ${username}`);
    } else {
      if (newCount > 0) console.log(`[CHECK] ${newCount} new show(s) for ${username}`);
      if (updCount > 0) console.log(`[CHECK] ${updCount} updated show(s) for ${username}`);
    }

    return { newShows, updatedShows, existingShows };

  } catch (err) {
    console.error(`[CHECK] Error for ${username}:`, err.message);
    return { newShows: [], updatedShows: [], existingShows: [], error: err.message };
  }
}

async function checkAllUsers() {
  console.log('\n========================================');
  console.log(`[MONITOR] Check at ${new Date().toISOString()}`);
  console.log('========================================');

  const results = {};

  for (let i = 0; i < config.usernames.length; i++) {
    const username = config.usernames[i];
    try {
      results[username] = await checkUserShows(username);
      // Small delay between users to be polite to the API
      if (i < config.usernames.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`[MONITOR] Error processing ${username}:`, err.message);
      results[username] = { error: err.message };
    }
  }

  console.log('[MONITOR] Check cycle complete');
  return results;
}

async function runOnce() {
  console.log('\n========================================');
  console.log('   Whatnot Show Monitor v2 — Run Once  ');
  console.log('========================================');
  console.log(`Triggered at: ${new Date().toISOString()}`);

  loadState();

  // Determine first-run status per username
  for (const username of config.usernames) {
    const s = getState();
    isFirstRun[username] = !s[username] || Object.keys(s[username].shows || {}).length === 0;
  }

  if (config.usernames.length === 0) {
    return {
      success: false,
      message: 'No usernames configured. Set WHATNOT_USERNAMES environment variable.',
      timestamp: new Date().toISOString(),
    };
  }

  const results = await checkAllUsers();

  let totalNew = 0;
  let totalUpdated = 0;
  let totalSeen = 0;
  let lastShowId = null;
  const errors = [];
  const allChanges = [];

  for (const [username, result] of Object.entries(results)) {
    if (result.error) {
      errors.push(`${username}: ${result.error}`);
    } else {
      totalNew += (result.newShows || []).length;
      totalUpdated += (result.updatedShows || []).length;
      totalSeen += (result.newShows?.length || 0) + (result.updatedShows?.length || 0) + (result.existingShows?.length || 0);
      if (result.newShows?.length > 0) lastShowId = result.newShows[0].id;

      for (const show of result.newShows || []) {
        allChanges.push({ type: 'new_show', username, show_id: show.id, title: show.title });
      }
      for (const { show, changes } of result.updatedShows || []) {
        allChanges.push({ type: 'updated_show', username, show_id: show.id, title: show.title, changes });
      }
    }
  }

  let message;
  if (errors.length > 0) {
    message = `Check completed with errors: ${errors.join('; ')}`;
  } else if (totalNew > 0 || totalUpdated > 0) {
    const parts = [];
    if (totalNew > 0) parts.push(`${totalNew} new show(s) detected and notified`);
    if (totalUpdated > 0) parts.push(`${totalUpdated} show(s) updated`);
    message = parts.join(', ');
  } else {
    message = 'No new shows found';
  }

  console.log(`[RUN] Complete: ${message}`);

  try {
    logRun({
      newShows: totalNew,
      updatedShows: totalUpdated,
      totalShowsSeen: totalSeen,
      changes: allChanges,
      hasErrors: errors.length > 0,
      errors,
    });
  } catch (logErr) {
    console.error('[RUN] Error logging run:', logErr.message);
  }

  return {
    success: errors.length === 0,
    message,
    newShows: totalNew,
    updatedShows: totalUpdated,
    lastShowId,
    timestamp: new Date().toISOString(),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

process.on('uncaughtException', err => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

module.exports = { checkUserShows, checkAllUsers, runOnce };
