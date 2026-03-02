const axios = require('axios');
const { config } = require('./config');

async function sendSlackNotification(show, username) {
  if (!config.slackWebhookUrl) {
    console.log('[SLACK] Webhook not configured, skipping');
    return false;
  }

  const startTimeText = show.startTime ? formatStartTime(show.startTime) : 'Time not specified';

  const payload = {
    text: `New Whatnot show posted by ${username}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'New Whatnot Show Alert', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New show posted by ${username}*\n\n*Title:* ${show.title}\n*Start time:* ${startTimeText}\n*Link:* ${show.url || 'Not available'}`,
        },
      },
      ...(show.url ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View Show', emoji: true },
          url: show.url,
          action_id: 'view_show',
        }],
      }] : []),
    ],
  };

  return postToSlack(payload, `new show "${show.title}" by ${username}`);
}

async function sendShowUpdateNotification(show, username, changes) {
  if (!config.slackWebhookUrl) {
    console.log('[SLACK] Webhook not configured, skipping update notification');
    return false;
  }

  // Filter out noise: changes where only the relative time label shifted
  // (e.g. "Tomorrow 2:30 AM" → "Thu 2:30 AM") but the actual time is the same.
  const meaningfulChanges = changes.filter(change => {
    if (change.field !== 'startTime') return true; // title changes are always meaningful
    return !isSameEffectiveTime(change.oldValue, change.newValue);
  });

  if (meaningfulChanges.length === 0) {
    console.log(`[SLACK] Suppressing update notification — only relative-label time drift, no real change`);
    return true; // treat as success (nothing to do)
  }

  const changeDetails = meaningfulChanges.map(c => {
    if (c.field === 'title') {
      return `*Title changed:*\n  _Was:_ ${c.oldValue}\n  _Now:_ ${c.newValue}`;
    } else if (c.field === 'startTime') {
      return `*Time changed:*\n  _Was:_ ${c.oldValue || 'Not specified'}\n  _Now:_ ${c.newValue || 'Not specified'}`;
    }
    return `*${c.field}:* ${c.oldValue} → ${c.newValue}`;
  }).join('\n\n');

  const payload = {
    text: `Show updated by ${username}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Whatnot Show Updated', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Show updated by ${username}*\n\n*Current Title:* ${show.title}\n*Scheduled:* ${show.startTime ? formatStartTime(show.startTime) : 'Not specified'}`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Changes detected:*\n\n${changeDetails}` },
      },
      ...(show.url ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View Show', emoji: true },
          url: show.url,
          action_id: 'view_show',
        }],
      }] : []),
    ],
  };

  return postToSlack(payload, `show update for "${show.title}" by ${username}`);
}

async function sendTestNotification() {
  if (!config.slackWebhookUrl) {
    console.log('[SLACK] Cannot send test notification — webhook not configured');
    return false;
  }

  const payload = {
    text: 'Whatnot Show Monitor v2 is active',
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Whatnot Show Monitor v2* is now active and monitoring for new shows.',
      },
    }],
  };

  return postToSlack(payload, 'test notification');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postToSlack(payload, description) {
  try {
    await axios.post(config.slackWebhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log(`[SLACK] Sent: ${description}`);
    return true;
  } catch (err) {
    console.error(`[SLACK] Failed to send ${description}:`, err.message);
    if (err.response) {
      console.error(`[SLACK] Status: ${err.response.status}`, err.response.data);
    }
    return false;
  }
}

/**
 * Format a start time (ISO string or relative string) for display in Slack.
 * If it's a valid ISO date, format it in US Eastern time.
 * If it's a relative string ("Tomorrow 2:30 AM"), return it as-is.
 */
function formatStartTime(startTime) {
  if (!startTime) return 'Not specified';

  const date = new Date(startTime);
  if (!isNaN(date.getTime())) {
    return date.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
  }

  // Not a parseable ISO date — return the string as-is (relative label)
  return startTime;
}

/**
 * Returns true if two time strings represent the same effective time,
 * even if one uses a relative label ("Tomorrow 2:30 AM") and the other
 * uses a day-of-week label ("Thu 2:30 AM").
 *
 * Both strings must have the same clock time (HH:MM AM/PM) to match.
 * This prevents noisy update alerts caused by relative-label rotation.
 */
function isSameEffectiveTime(oldTime, newTime) {
  if (oldTime === newTime) return true;
  if (!oldTime || !newTime) return false;

  // If both are ISO timestamps, compare them directly
  const oldDate = new Date(oldTime);
  const newDate = new Date(newTime);
  if (!isNaN(oldDate.getTime()) && !isNaN(newDate.getTime())) {
    return oldDate.getTime() === newDate.getTime();
  }

  // For relative strings, extract the HH:MM AM/PM portion and compare
  const timeRe = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i;
  const oldClock = (oldTime.match(timeRe) || [])[1];
  const newClock = (newTime.match(timeRe) || [])[1];

  if (!oldClock || !newClock) return false;

  return oldClock.trim().toUpperCase() === newClock.trim().toUpperCase();
}

module.exports = { sendSlackNotification, sendShowUpdateNotification, sendTestNotification };
