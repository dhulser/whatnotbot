document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadStatus();

  document.getElementById('refreshAll').addEventListener('click', async () => {
    const btn = document.getElementById('refreshAll');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    await loadStatus();
    btn.disabled = false;
    btn.textContent = 'Refresh All';
    showNotification('Status refreshed', 'success');
  });
});

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    document.getElementById('configDetails').innerHTML = `
      <div class="config-details">
        <div class="config-item">
          <div class="config-label">Monitored Users</div>
          <div class="config-value">${cfg.usernames.join(', ') || 'None configured'}</div>
        </div>
        <div class="config-item">
          <div class="config-label">Check Schedule</div>
          <div class="config-value">Every 5 min (GitHub Actions)</div>
        </div>
        <div class="config-item">
          <div class="config-label">Slack Notifications</div>
          <div class="config-value">${cfg.slackConfigured ? 'Enabled' : 'Not configured'}</div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Error loading config:', err);
    showNotification('Error loading configuration', 'error');
  }
}

async function loadStatus() {
  const loadingEl = document.getElementById('loading');
  const userCardsEl = document.getElementById('userCards');

  loadingEl.classList.remove('hidden');

  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    loadingEl.classList.add('hidden');

    if (Object.keys(status).length === 0) {
      userCardsEl.innerHTML = `
        <div class="empty-state">
          <p>No users configured. Set WHATNOT_USERNAMES environment variable.</p>
        </div>
      `;
      return;
    }

    userCardsEl.innerHTML = '';
    userCardsEl.className = 'user-cards';

    for (const [username, data] of Object.entries(status)) {
      userCardsEl.appendChild(createUserCard(username, data));
    }
  } catch (err) {
    loadingEl.classList.add('hidden');
    console.error('Error loading status:', err);
    showNotification('Error loading status', 'error');
  }
}

function createUserCard(username, data) {
  const card = document.createElement('div');
  card.className = 'user-card';
  card.id = `user-${username}`;

  card.innerHTML = `
    <div class="user-header">
      <div class="user-info">
        <h3>@${username}</h3>
        <a href="https://www.whatnot.com/user/${username}/shows" target="_blank">View on Whatnot</a>
      </div>
      <div class="user-actions">
        <button class="btn btn-secondary btn-small" onclick="refreshUser('${username}')">Refresh</button>
      </div>
    </div>

    <div class="user-stats">
      <div class="stat">
        <div class="stat-value">${data.totalShows}</div>
        <div class="stat-label">Total Shows</div>
      </div>
      <div class="stat posted">
        <div class="stat-value">${data.postedShows}</div>
        <div class="stat-label">Posted</div>
      </div>
      <div class="stat pending">
        <div class="stat-value">${data.unpostedShows}</div>
        <div class="stat-label">Pending</div>
      </div>
      <div class="stat updated">
        <div class="stat-value">${data.updatedShows || 0}</div>
        <div class="stat-label">Updated</div>
      </div>
    </div>

    <div class="shows-list">
      <h4>Shows</h4>
      ${data.shows.length === 0
        ? '<div class="empty-state">No shows found yet</div>'
        : data.shows.map(show => createShowItem(username, show)).join('')
      }
    </div>

    <div class="last-checked">Last checked: ${data.lastCheckedAt || 'Never'}</div>
  `;

  return card;
}

function createShowItem(username, show) {
  const isPosted = show.postedToSlack;
  const firstSeen = show.firstSeenAt ? formatTimeET(show.firstSeenAt) : 'Unknown';
  const hasUpdates = show.hasUpdates || (show.updateHistory && show.updateHistory.length > 0);
  const updateHistory = show.updateHistory || [];

  let updateHistoryHtml = '';
  if (hasUpdates && updateHistory.length > 0) {
    const historyEntries = updateHistory.slice(-3).reverse().map(entry => {
      const ts = formatTimeET(entry.timestamp);
      const changes = entry.changes.map(c => {
        const fieldName = c.field === 'startTime' ? 'Time' : 'Title';
        return `<div class="change-detail">
          <span class="change-field">${fieldName}:</span>
          <span class="change-old">${escapeHtml(c.oldValue || 'Not set')}</span>
          &rarr;
          <span class="change-new">${escapeHtml(c.newValue || 'Not set')}</span>
        </div>`;
      }).join('');
      return `<div class="update-entry">
        <div class="update-timestamp">${ts}</div>
        ${changes}
      </div>`;
    }).join('');

    updateHistoryHtml = `
      <div class="update-history">
        <div class="update-history-title">Update History (${updateHistory.length} update${updateHistory.length > 1 ? 's' : ''})</div>
        ${historyEntries}
      </div>
    `;
  }

  const scheduledDisplay = show.startTime
    ? formatStartTime(show.startTime)
    : '';

  return `
    <div class="show-item" data-show-id="${show.id}">
      <div class="show-details">
        <div class="show-title">${escapeHtml(show.title)}</div>
        <div class="show-meta">
          ${scheduledDisplay ? `<span>Scheduled: ${escapeHtml(scheduledDisplay)}</span>` : ''}
          <span>First seen: ${firstSeen}</span>
          <a href="${show.url}" target="_blank">View Show</a>
        </div>
        ${updateHistoryHtml}
      </div>
      <div class="show-status">
        ${hasUpdates ? '<span class="status-badge updated">Updated</span>' : ''}
        <span class="status-badge ${isPosted ? 'posted' : 'pending'}">
          ${isPosted ? 'Posted' : 'Not Posted'}
        </span>
        ${!isPosted
          ? `<button class="btn btn-success btn-small" onclick="postShow('${username}', '${show.id}')">Post to Slack</button>`
          : ''
        }
      </div>
    </div>
  `;
}

/**
 * Format a time value for display.
 * If it's a valid ISO date, render it in US Eastern time.
 * Otherwise return the string as-is (relative label from scraping).
 */
function formatStartTime(timeStr) {
  if (!timeStr) return '';
  const d = new Date(timeStr);
  if (!isNaN(d.getTime())) {
    return d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/New_York', timeZoneName: 'short',
    });
  }
  return timeStr; // relative string e.g. "Tomorrow 2:30 AM"
}

function formatTimeET(dateString) {
  if (!dateString) return 'Never';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET';
  } catch {
    return dateString || 'Unknown';
  }
}

async function refreshUser(username) {
  const card = document.getElementById(`user-${username}`);
  const btn = card.querySelector('.user-actions button');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  await loadStatus();
  btn.disabled = false;
  btn.textContent = 'Refresh';
  showNotification(`@${username} refreshed`, 'success');
}

async function postShow(username, showId) {
  const showItem = document.querySelector(`[data-show-id="${showId}"]`);
  const btn = showItem.querySelector('.btn-success');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  try {
    const res = await fetch(`/api/shows/${username}/${showId}/post`, { method: 'POST' });
    const result = await res.json();

    if (result.success) {
      showNotification('Show posted to Slack', 'success');
      await loadStatus();
    } else {
      showNotification('Error: ' + (result.error || 'Unknown error'), 'error');
      btn.disabled = false;
      btn.textContent = 'Post to Slack';
    }
  } catch (err) {
    console.error('Error posting show:', err);
    showNotification('Error posting show', 'error');
    btn.disabled = false;
    btn.textContent = 'Post to Slack';
  }
}

function showNotification(message, type) {
  const el = document.getElementById('notification');
  el.textContent = message;
  el.className = `notification ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Auto-refresh status every 60 seconds
setInterval(loadStatus, 60000);
