const fs = require('fs');
const path = require('path');
const { config } = require('./config');

let state = {};

function ensureDataDirectory() {
  const dir = path.dirname(config.stateFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState() {
  try {
    ensureDataDirectory();

    if (fs.existsSync(config.stateFilePath)) {
      const data = fs.readFileSync(config.stateFilePath, 'utf8');
      state = JSON.parse(data);

      // Migrate old format (lastSeenShowId) to new shows map
      for (const username in state) {
        if (state[username].lastSeenShowId && !state[username].shows) {
          state[username].shows = {
            [state[username].lastSeenShowId]: {
              id: state[username].lastSeenShowId,
              postedToSlack: true,
              firstSeenAt: state[username].lastCheckedAt || new Date().toISOString(),
            },
          };
        }
        if (!state[username].shows) {
          state[username].shows = {};
        }
      }

      console.log('[STATE] Loaded from', config.stateFilePath);
    } else {
      state = {};
      saveState();
      console.log('[STATE] Created new state file at', config.stateFilePath);
    }
  } catch (err) {
    console.error('[STATE] Error loading state, starting fresh:', err.message);
    state = {};
    saveState();
  }

  return state;
}

function saveState() {
  try {
    ensureDataDirectory();
    fs.writeFileSync(config.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[STATE] Error saving state:', err.message);
  }
}

function ensureUserState(username) {
  if (!state[username]) {
    state[username] = { shows: {}, lastCheckedAt: null };
  }
  if (!state[username].shows) {
    state[username].shows = {};
  }
}

function isShowKnown(username, showId) {
  ensureUserState(username);
  return !!state[username].shows[showId];
}

function isShowPosted(username, showId) {
  ensureUserState(username);
  return state[username].shows[showId]?.postedToSlack === true;
}

function addShow(username, show, postedToSlack = false) {
  ensureUserState(username);
  if (!state[username].shows[show.id]) {
    state[username].shows[show.id] = {
      id: show.id,
      title: show.title,
      startTime: show.startTime,
      url: show.url,
      postedToSlack,
      firstSeenAt: new Date().toISOString(),
    };
    saveState();
    return true;
  }
  return false;
}

function markShowAsPosted(username, showId) {
  ensureUserState(username);
  if (state[username].shows[showId]) {
    state[username].shows[showId].postedToSlack = true;
    state[username].shows[showId].postedAt = new Date().toISOString();
    saveState();
    return true;
  }
  return false;
}

function updateShowDetails(username, show) {
  ensureUserState(username);
  const existing = state[username].shows[show.id];
  if (!existing) return { updated: false, changes: [] };

  const changes = detectChanges(existing, show);
  if (changes.length === 0) return { updated: false, changes: [] };

  if (!existing.updateHistory) existing.updateHistory = [];
  existing.updateHistory.push({ timestamp: new Date().toISOString(), changes });

  existing.title = show.title;
  existing.startTime = show.startTime;
  existing.url = show.url;
  existing.lastUpdatedAt = new Date().toISOString();
  saveState();

  return { updated: true, changes };
}

function detectChanges(existing, newShow) {
  const changes = [];
  if (existing.title !== newShow.title) {
    changes.push({ field: 'title', oldValue: existing.title, newValue: newShow.title });
  }
  if (existing.startTime !== newShow.startTime) {
    changes.push({ field: 'startTime', oldValue: existing.startTime, newValue: newShow.startTime });
  }
  return changes;
}

function getAllShows(username) {
  ensureUserState(username);
  return Object.values(state[username].shows);
}

function getUnpostedShows(username) {
  ensureUserState(username);
  return Object.values(state[username].shows).filter(s => !s.postedToSlack);
}

function updateLastCheckedAt(username) {
  ensureUserState(username);
  state[username].lastCheckedAt = new Date().toISOString();
  saveState();
}

function getLastCheckedAt(username) {
  ensureUserState(username);
  return state[username].lastCheckedAt;
}

function getState() {
  return state;
}

function getShowUpdateHistory(username, showId) {
  ensureUserState(username);
  return state[username].shows[showId]?.updateHistory || [];
}

module.exports = {
  loadState,
  saveState,
  isShowKnown,
  isShowPosted,
  addShow,
  markShowAsPosted,
  updateShowDetails,
  getShowUpdateHistory,
  getAllShows,
  getUnpostedShows,
  updateLastCheckedAt,
  getLastCheckedAt,
  getState,
};
