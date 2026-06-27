// popup.js — AUCTMS v1.2.0

// ── Color map ────────────────────────────────────────────────────
const COLOR_MAP = {
  blue:'#4dabf7', green:'#51cf66', red:'#ff6b6b', purple:'#cc5de8',
  orange:'#ff922b', yellow:'#ffd43b', grey:'#868e96', cyan:'#22b8cf', pink:'#f06595'
};
function hexFromColor(c) { return COLOR_MAP[c] || '#868e96'; }

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb/1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m/60)}h ago`;
}

// ── FIX 1: Robust select setter — converts stored number to matching option ──
function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (!el || val === undefined || val === null) return;
  const strVal = String(val);
  // Try exact match first
  for (const opt of el.options) {
    if (opt.value === strVal) { el.value = strVal; return; }
  }
  // Try float comparison (handles 0.6 vs "0.60" mismatch)
  const numVal = parseFloat(strVal);
  for (const opt of el.options) {
    if (Math.abs(parseFloat(opt.value) - numVal) < 0.001) { el.value = opt.value; return; }
  }
}

// ── Tab Navigation ───────────────────────────────────────────────
function initTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.panel).classList.add('active');
    });
  });
}

// ── Dashboard ────────────────────────────────────────────────────
async function loadDashboard() {
  const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
  document.getElementById('tabCount').textContent = response.tabCount;

  const pct = response.memory.usagePercent;
  const rounded = Math.round(pct / 5) * 5;
  let qualifier = 'Normal';
  if (rounded >= 90) qualifier = 'Critical';
  else if (rounded >= 80) qualifier = 'High';
  else if (rounded >= 60) qualifier = 'Moderate';
  document.getElementById('memoryUsage').textContent = `~${rounded}%`;
  document.getElementById('memoryUsage').title = qualifier;

  // FIX: sleeping count from live tabs query
  const allTabs = await chrome.tabs.query({});
  const sleepCount = allTabs.filter(t => t.discarded).length;
  document.getElementById('sleepCount').textContent = sleepCount;

  if (response.lastOptimization) {
    const opt = response.lastOptimization;
    document.getElementById('optimizationCard').style.display = 'block';
    const MAX = 16 * 1024 * 1024 * 1024; // use 16 GB as scale max for realism
    document.getElementById('memoryBefore').style.width = Math.min((opt.memoryBefore/MAX)*100, 100) + '%';
    document.getElementById('memoryAfter').style.width  = Math.min((opt.memoryAfter/MAX)*100, 100) + '%';
    document.getElementById('memoryBeforeText').textContent = '~' + formatBytes(opt.memoryBefore);
    document.getElementById('memoryAfterText').textContent  = '~' + formatBytes(opt.memoryAfter);
    document.getElementById('savedAmount').textContent = `~${opt.savedMB} MB`;
    const modeLabel = opt.mode === 'TRUE_DISCARD' ? 'Tabs closed' : 'Tabs slept';
    const reason = opt.discardedTabs?.[0]?.reason ? ` · ${opt.discardedTabs[0].reason}` : '';
    document.getElementById('savingsLabel').textContent = `${modeLabel} (${opt.discardedCount})${reason}`;
    document.getElementById('statusText').textContent =
      `${opt.mode === 'TRUE_DISCARD' ? 'Closed' : 'Slept'} ${opt.discardedCount} · ~${opt.savedMB} MB saved`;
  } else {
    document.getElementById('statusText').textContent = `~${rounded}% RAM`;
  }
}

// ── Groups ───────────────────────────────────────────────────────
async function loadGroups() {
  const container = document.getElementById('tabGroups');
  container.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_ACTUAL_GROUPS' });
    if (!response.groups || response.groups.length === 0) {
      container.innerHTML = '<div class="empty-state">No grouped tabs — open more tabs of the same category and click Re-Classify</div>';
      return;
    }
    container.innerHTML = '';
    for (const group of response.groups) {
      const sleeping = group.tabs.filter(t => t.discarded).length;
      const active   = group.tabs.length - sleeping;
      const item = document.createElement('div');
      item.className = 'group-item';
      item.innerHTML = `
        <div class="group-dot" style="background:${hexFromColor(group.color)}"></div>
        <div class="group-info">
          <div class="group-name">${group.title || 'Unnamed Group'}</div>
          <div class="group-count">
            ${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''} &nbsp;·&nbsp;
            <span style="color:#0070f3">${active} active</span>
            &nbsp;·&nbsp;
            <span style="color:#f5a623">${sleeping} sleeping</span>
          </div>
        </div>
        <span class="score-badge">${group.color}</span>
      `;
      container.appendChild(item);
    }
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Error loading groups</div>';
  }
}

// ── FIX 2: History — reads from chrome.storage.local (persisted), not in-memory array ──
async function loadHistory() {
  const container = document.getElementById('discardHistory');
  try {
    // First try the in-memory route via background
    const response = await chrome.runtime.sendMessage({ action: 'GET_DISCARD_HISTORY' });
    let history = response.history || [];

    // If background worker restarted and lost in-memory history, fall back to storage
    if (history.length === 0) {
      const stored = await chrome.storage.local.get('discard_history_log');
      history = stored.discard_history_log || [];
    }

    // Also always show currently-sleeping tabs as "sleeping" entries
    const allTabs = await chrome.tabs.query({});
    const sleepingTabs = allTabs.filter(t => t.discarded && !t.pinned && !t.active);

    if (history.length === 0 && sleepingTabs.length === 0) {
      container.innerHTML = '<div class="empty-state">No slept or discarded tabs yet</div>';
      return;
    }

    container.innerHTML = '';

    // Show currently sleeping tabs at the top (live state)
    if (sleepingTabs.length > 0) {
      const header = document.createElement('div');
      header.className = 'history-section-header';
      header.textContent = `Currently Sleeping (${sleepingTabs.length})`;
      container.appendChild(header);

      sleepingTabs.slice(0, 10).forEach(tab => {
        const div = document.createElement('div');
        div.className = 'history-item sleeping-live';
        div.innerHTML = `
          <div class="history-info">
            <div class="history-title">${(tab.title || tab.url || 'Unknown').substring(0, 40)}</div>
            <div class="history-reason">💤 Sleeping now · <span style="color:#c8ff00">Click Restore to wake</span></div>
          </div>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn-restore';
        btn.textContent = 'Wake';
        btn.onclick = () => wakeTab(tab.id);
        div.appendChild(btn);
        container.appendChild(div);
      });
    }

    // Past history below
    if (history.length > 0) {
      if (sleepingTabs.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'history-section-header';
        sep.textContent = 'Past Actions';
        container.appendChild(sep);
      }
      history.slice(0, 8).forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const modeIcon = item.mode === 'TRUE_DISCARD' ? '✕' : '💤';
        div.innerHTML = `
          <div class="history-info">
            <div class="history-title">${(item.title || 'Unknown').substring(0, 40)}</div>
            <div class="history-reason">${modeIcon} ${item.reason || 'Optimized'} · ${timeAgo(item.discardedAt)}</div>
          </div>
        `;
        if (item.mode !== 'TRUE_DISCARD') {
          const btn = document.createElement('button');
          btn.className = 'btn-restore';
          btn.textContent = 'Restore';
          btn.onclick = () => restoreTab(item.tabId);
          div.appendChild(btn);
        }
        container.appendChild(div);
      });
    }

  } catch (err) {
    container.innerHTML = '<div class="empty-state">Error loading history</div>';
    console.error(err);
  }
}

// Wake a currently-sleeping (discarded) tab by reloading it
async function wakeTab(tabId) {
  try {
    await chrome.tabs.reload(tabId);
    setTimeout(() => loadHistory(), 800);
  } catch (e) {
    console.error('Wake tab error:', e);
  }
}

async function restoreTab(tabId) {
  await chrome.runtime.sendMessage({ action: 'RESTORE_TAB', tabId });
  setTimeout(() => loadHistory(), 800);
}

// ── FIX 3: Settings — load, apply, and wire to background thresholds ─
let whitelistDomains = [];

async function loadSettings() {
  // Use chrome.storage.local for reliability (sync can fail or be slow)
  const result = await chrome.storage.local.get(['never_discard_domains', 'user_prefs']);
  whitelistDomains = result.never_discard_domains || [];
  const prefs = result.user_prefs || {};

  // FIX: use the robust setSelectValue helper instead of direct .value assignment
  setSelectValue('sleepThreshold', prefs.sleepThreshold ?? 0.60);
  setSelectValue('emergencyThreshold', prefs.emergencyThreshold ?? 0.85);
  setSelectValue('idleTimeout', prefs.idleTimeout ?? 15);

  document.getElementById('toggleAutoGroup').checked =
    prefs.autoGroup !== undefined ? prefs.autoGroup : true;
  document.getElementById('toggleNotifications').checked =
    prefs.notifications !== undefined ? prefs.notifications : true;

  renderWhitelistTags();
}

function renderWhitelistTags() {
  const container = document.getElementById('whitelistTags');
  container.innerHTML = '';
  if (whitelistDomains.length === 0) {
    container.innerHTML = '<div style="font-size:10px;color:var(--muted);padding:4px 0">No domains added yet</div>';
    return;
  }
  whitelistDomains.forEach((domain, i) => {
    const tag = document.createElement('div');
    tag.className = 'whitelist-tag';
    tag.innerHTML = `<span>${domain}</span><button title="Remove">×</button>`;
    tag.querySelector('button').onclick = () => {
      whitelistDomains.splice(i, 1);
      renderWhitelistTags();
    };
    container.appendChild(tag);
  });
}

async function saveSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  const prefs = {
    sleepThreshold:     parseFloat(document.getElementById('sleepThreshold').value),
    emergencyThreshold: parseFloat(document.getElementById('emergencyThreshold').value),
    idleTimeout:        parseInt(document.getElementById('idleTimeout').value),
    autoGroup:          document.getElementById('toggleAutoGroup').checked,
    notifications:      document.getElementById('toggleNotifications').checked
  };

  // FIX: save to local (reliable) AND sync (for cross-device)
  await chrome.storage.local.set({ user_prefs: prefs, never_discard_domains: whitelistDomains });
  await chrome.storage.sync.set({ user_prefs: prefs, never_discard_domains: whitelistDomains });

  // FIX: tell background to apply the new thresholds immediately
  try {
    await chrome.runtime.sendMessage({ action: 'APPLY_SETTINGS', prefs, whitelist: whitelistDomains });
  } catch(e) { /* background will read from storage on next check */ }

  btn.textContent = '✓ Saved';
  setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false; }, 1500);
}

function setupWhitelistAdd() {
  document.getElementById('addWhitelistBtn').addEventListener('click', () => {
    const input  = document.getElementById('whitelistInput');
    const raw    = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (raw && !whitelistDomains.includes(raw)) {
      whitelistDomains.push(raw);
      renderWhitelistTags();
      input.value = '';
    }
  });
  document.getElementById('whitelistInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addWhitelistBtn').click();
  });
}

function setupOptimizeBtn() {
  document.getElementById('optimizeBtn').addEventListener('click', async () => {
    const btn = document.getElementById('optimizeBtn');
    btn.textContent = '⏳ Optimizing…';
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: 'forceOptimize' });
      await new Promise(r => setTimeout(r, 2500));
      await loadDashboard();
      await loadHistory();
    } catch (e) { console.error(e); }
    btn.textContent = '⚡ Optimize Now';
    btn.disabled = false;
  });
}

function setupDiscardBtn() {
  document.getElementById('discardOldestBtn').addEventListener('click', async () => {
    const btn = document.getElementById('discardOldestBtn');
    btn.textContent = '⏳ Working…';
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'DISCARD_OLDEST_TAB' });
      btn.textContent = res.success ? `✓ Done` : `✗ ${res.reason}`;
      await new Promise(r => setTimeout(r, 2000));
      await loadDashboard();
      await loadHistory();
    } catch (e) { console.error(e); }
    btn.textContent = '✕ Discard Oldest';
    btn.disabled = false;
  });
}

function setupRegroupBtn() {
  document.getElementById('regroupBtn').addEventListener('click', async () => {
    const btn = document.getElementById('regroupBtn');
    btn.textContent = '↺ Regrouping…';
    btn.disabled = true;
    await chrome.runtime.sendMessage({ action: 'regroup' });
    await new Promise(r => setTimeout(r, 1500));
    await loadGroups();
    btn.textContent = '↺ Re-Classify Now';
    btn.disabled = false;
  });
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabNav();
  try {
    await Promise.all([loadDashboard(), loadGroups(), loadHistory(), loadSettings()]);
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('mainContent').style.display   = 'block';
  } catch (err) {
    console.error('Init error:', err);
    document.getElementById('loadingScreen').innerHTML =
      '<p style="color:#ff4d4d;font-size:11px;text-align:center;padding:20px">Error loading. Close and reopen.</p>';
  }
  setupOptimizeBtn();
  setupDiscardBtn();
  setupRegroupBtn();
  setupWhitelistAdd();
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
});
