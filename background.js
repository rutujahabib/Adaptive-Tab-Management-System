// background.js — AUCTMS v1.2.0
// Full audit pass: fixed all race conditions, memory leaks, logic bugs, and UX gaps

// ══════════════════════════════════════════════════
// 1. LRU Tracker
// ══════════════════════════════════════════════════
class LRUTracker {
  constructor() {
    this.accessTimes = new Map();
    this._saveTimer = null;
  }

  recordAccess(tabId) {
    this.accessTimes.set(String(tabId), Date.now());
    this._debouncedSave();
  }

  // AUDIT FIX: debounce saves — was writing to storage on every single tab click
  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveToStorage(), 1000);
  }

  getRecency(tabId) {
    const lastAccess = this.accessTimes.get(String(tabId)) || Date.now();
    const idleTime = Date.now() - lastAccess;
    const maxIdle = 60 * 60 * 1000; // 1 hour
    return Math.min(idleTime / maxIdle, 1.0);
  }

  async saveToStorage() {
    const data = Object.fromEntries(this.accessTimes);
    await chrome.storage.local.set({ lru_data: data });
  }

  async loadFromStorage() {
    const result = await chrome.storage.local.get('lru_data');
    if (result.lru_data) {
      this.accessTimes = new Map(
        Object.entries(result.lru_data).map(([k, v]) => [k, parseInt(v)])
      );
    }
  }

  removeTab(tabId) {
    this.accessTimes.delete(String(tabId));
  }

  async clearStaleData() {
    const result = await chrome.storage.local.get('last_session_time');
    const lastSession = result.last_session_time || 0;
    const hoursSince = (Date.now() - lastSession) / (60 * 60 * 1000);
    if (hoursSince > 24) {
      this.accessTimes.clear();
      await chrome.storage.local.remove('lru_data');
    }
  }
}

// ══════════════════════════════════════════════════
// 2. LFU Tracker with Exponential Decay
// ══════════════════════════════════════════════════
class LFUTracker {
  constructor() {
    this.frequencies = new Map();
    this.lastAccess   = new Map();
    this._saveTimer   = null;
  }

  recordVisit(tabId) {
    const id = String(tabId);
    this.frequencies.set(id, (this.frequencies.get(id) || 0) + 1);
    this.lastAccess.set(id, Date.now());
    this._debouncedSave();
  }

  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveToStorage(), 1000);
  }

  // AUDIT FIX: use decayed frequency everywhere (removed unused getFrequency)
  getFrequencyWithDecay(tabId) {
    const id = String(tabId);
    const count = this.frequencies.get(id) || 1;
    const lastAccessTime = this.lastAccess.get(id) || Date.now();
    const ageInDays = (Date.now() - lastAccessTime) / (24 * 60 * 60 * 1000);
    const decayFactor = Math.pow(0.5, ageInDays / 7); // 7-day half-life
    const decayedCount = count * decayFactor;
    const maxFreq = 20;
    return 1.0 - Math.min(Math.log(decayedCount + 1) / Math.log(maxFreq + 1), 1.0);
  }

  async saveToStorage() {
    await chrome.storage.local.set({
      lfu_data: Object.fromEntries(this.frequencies),
      lfu_access_times: Object.fromEntries(this.lastAccess)
    });
  }

  async loadFromStorage() {
    const result = await chrome.storage.local.get(['lfu_data', 'lfu_access_times']);
    if (result.lfu_data) {
      this.frequencies = new Map(
        Object.entries(result.lfu_data).map(([k, v]) => [k, parseInt(v)])
      );
    }
    if (result.lfu_access_times) {
      this.lastAccess = new Map(
        Object.entries(result.lfu_access_times).map(([k, v]) => [k, parseInt(v)])
      );
    }
  }

  removeTab(tabId) {
    const id = String(tabId);
    this.frequencies.delete(id);
    this.lastAccess.delete(id);
  }

  async clearStaleData() {
    const result = await chrome.storage.local.get('last_session_time');
    const lastSession = result.last_session_time || 0;
    const hoursSince = (Date.now() - lastSession) / (60 * 60 * 1000);
    if (hoursSince > 24) {
      this.frequencies.clear();
      this.lastAccess.clear();
      await chrome.storage.local.remove(['lfu_data', 'lfu_access_times']);
    }
  }
}

// ══════════════════════════════════════════════════
// 3. TF-IDF Engine
// ══════════════════════════════════════════════════
class TFIDFEngine {
  constructor() {
    this.stopWords = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with',
      'by','from','as','is','was','are','been','be','have','has','had','do',
      'does','did','will','would','should','could','may','might','must','can',
      'this','that','these','those','it','its','i','you','he','she','we','they',
      'what','which','who','when','where','why','how','new','tab'
    ]);
  }

  tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !this.stopWords.has(w));
  }

  computeTF(tokens) {
    const tf = {};
    tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    const total = tokens.length || 1;
    for (let t in tf) tf[t] /= total;
    return tf;
  }

  extractKeywords(text, topN = 5) {
    const tokens = this.tokenize(text);
    const tf = this.computeTF(tokens);
    return Object.entries(tf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([term]) => term);
  }
}

// ══════════════════════════════════════════════════
// 4. Jaccard Similarity
// ══════════════════════════════════════════════════
class JaccardSimilarity {
  static computeSimilarity(tokens1, tokens2) {
    const s1 = new Set(tokens1);
    const s2 = new Set(tokens2);
    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }
}

// ══════════════════════════════════════════════════
// 5. NLP Tab Classifier
// ══════════════════════════════════════════════════
class TabClassifier {
  constructor() {
    this.tfidf = new TFIDFEngine();
    this.categories = {
      'Work': {
        keywords: ['github','gitlab','jira','docs','document','presentation','sheet',
                   'drive','office','notion','slack','meeting','zoom','teams','figma',
                   'linear','confluence','trello','asana'],
        domains:  ['github.com','gitlab.com','docs.google.com','notion.so','office.com',
                   'slack.com','figma.com','linear.app','atlassian.com','trello.com'],
        color: 'blue'
      },
      'Research': {
        keywords: ['wikipedia','research','article','paper','study','stackoverflow',
                   'tutorial','learn','course','education','lecture','documentation',
                   'reference','guide','howto'],
        domains:  ['wikipedia.org','stackoverflow.com','medium.com','arxiv.org',
                   'scholar.google.com','mdn.web.docs','developer.mozilla.org',
                   'w3schools.com','coursera.org','udemy.com'],
        color: 'green'
      },
      'Shopping': {
        keywords: ['buy','shop','cart','price','product','order','store','deal',
                   'discount','checkout','purchase','wishlist'],
        domains:  ['amazon.com','amazon.in','ebay.com','walmart.com','flipkart.com',
                   'myntra.com','meesho.com','ajio.com','snapdeal.com'],
        color: 'orange'
      },
      'Entertainment': {
        keywords: ['video','watch','movie','music','game','play','stream','episode',
                   'series','anime','podcast','sports'],
        domains:  ['youtube.com','netflix.com','spotify.com','twitch.tv','hotstar.com',
                   'primevideo.com','reddit.com','9gag.com','discord.com'],
        color: 'red'
      },
      'Social': {
        keywords: ['twitter','facebook','social','chat','message','post','linkedin',
                   'instagram','profile','feed','follow'],
        domains:  ['twitter.com','x.com','facebook.com','linkedin.com','instagram.com',
                   'whatsapp.com','telegram.org','threads.net'],
        color: 'purple'
      }
    };
  }

  classify(tab) {
    const title  = (tab.title || '').toLowerCase();
    const url    = (tab.url   || '').toLowerCase();
    const text   = title + ' ' + url;

    let maxScore  = 0;
    let bestCat   = 'Other';

    for (const [category, data] of Object.entries(this.categories)) {
      let score = 0;
      // Domain match is strongest signal
      if (data.domains.some(d => url.includes(d))) score += 50;

      const keywords = this.tfidf.extractKeywords(text, 10);
      data.keywords.forEach(kw => {
        if (keywords.includes(kw)) score += 15;
        if (title.includes(kw))   score += 10;
        if (url.includes(kw))     score += 5;
      });

      if (score > maxScore) { maxScore = score; bestCat = category; }
    }

    return {
      category:   bestCat,
      confidence: Math.min(maxScore / 10, 10),
      score:      maxScore,
      color:      this.categories[bestCat]?.color || 'grey'
    };
  }
}

// ══════════════════════════════════════════════════
// 6. Hybrid Scoring Algorithm (HSA)
//    U(Ti) = wR·Ri + wF·Fi + wM·Mi − wC·Ci
// ══════════════════════════════════════════════════
class HybridScoringAlgorithm {
  constructor(lru, lfu, classifier) {
    this.lru        = lru;
    this.lfu        = lfu;
    this.classifier = classifier;
    this.weights    = { wR: 0.30, wF: 0.25, wM: 0.25, wC: 0.20 };
    this.whitelist  = new Set();
  }

  async loadWhitelist() {
    // AUDIT FIX: load from local (not sync) to match where we save
    const r = await chrome.storage.local.get('never_discard_domains');
    if (r.never_discard_domains) {
      this.whitelist = new Set(r.never_discard_domains);
    }
  }

  isWhitelisted(tab) {
    try {
      const hostname = new URL(tab.url).hostname.replace(/^www\./, '');
      return this.whitelist.has(hostname) || this.whitelist.has('www.' + hostname);
    } catch { return false; }
  }

  estimateMemory(tab) {
    const url = (tab.url || '').toLowerCase();
    let base = 50;
    if (url.includes('youtube') || url.includes('video'))   base *= 3;
    if (url.includes('netflix') || url.includes('stream'))  base *= 3;
    if (url.includes('facebook') || url.includes('twitter') || url.includes('reddit')) base *= 2;
    if (url.includes('amazon') || url.includes('shopping')) base *= 1.5;
    return Math.min(base / 200, 1.0);
  }

  calculateContentPriority(tab, cls) {
    const basePriorities = {
      Work: 0.95, Research: 0.80, Social: 0.50,
      Shopping: 0.40, Entertainment: 0.30, Other: 0.20
    };
    let p = basePriorities[cls.category] ?? 0.20;
    if (tab.pinned) p += 0.20;
    if (tab.active) p += 0.25;
    if (cls.confidence > 7) p += 0.05;
    const url = (tab.url || '').toLowerCase();
    if (url.includes('docs.google') || url.includes('form'))   p += 0.15;
    if (url.includes('checkout')    || url.includes('payment')) p += 0.20;
    return Math.min(p, 1.0);
  }

  async calculateUtilityScore(tab) {
    const id  = String(tab.id);
    const Ri  = this.lru.getRecency(id);
    const Fi  = this.lfu.getFrequencyWithDecay(id);
    const Mi  = this.estimateMemory(tab);
    const cls = this.classifier.classify(tab);
    const Ci  = this.calculateContentPriority(tab, cls);

    const utility = this.weights.wR * Ri
                  + this.weights.wF * Fi
                  + this.weights.wM * Mi
                  - this.weights.wC * Ci;

    let reason;
    if (Ri > 0.7)   reason = 'Idle 1+ hours';
    else if (Fi > 0.8) reason = 'Rarely visited';
    else if (Mi > 0.7) reason = 'High memory';
    else               reason = 'Low priority';

    return {
      utility,
      components: { Ri, Fi, Mi, Ci },
      classification: cls,
      reason,
      shouldDiscard: utility > 0.25 && !tab.active && !tab.pinned
    };
  }

  async getDiscardCandidates(tabs) {
    const scores = [];
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) continue;
      if (tab.active || tab.pinned || tab.audible) continue;
      if (this.isWhitelisted(tab)) continue;
      if (tab.discarded) continue; // AUDIT FIX: skip already-sleeping tabs

      const score = await this.calculateUtilityScore(tab);
      if (score.shouldDiscard) scores.push({ tab, score });
    }
    scores.sort((a, b) => b.score.utility - a.score.utility);
    return scores;
  }
}

// ══════════════════════════════════════════════════
// 7. Tab Grouping Engine
// ══════════════════════════════════════════════════
class TabGroupingEngine {
  constructor(classifier) {
    this.classifier = classifier;
    this.groupCache = new Map(); // category → groupId
  }

  async groupTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const grouped = {};

    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) continue;
      const cls      = this.classifier.classify(tab);
      const category = cls.category;
      if (!grouped[category]) {
        grouped[category] = { tabs: [], color: cls.color };
      }
      grouped[category].tabs.push(tab);
    }

    // AUDIT FIX: validate cached group IDs still exist before reusing
    const existingGroups = await chrome.tabGroups.query({});
    const existingIds    = new Set(existingGroups.map(g => g.id));
    for (const [cat, gid] of this.groupCache.entries()) {
      if (!existingIds.has(gid)) this.groupCache.delete(cat);
    }

    for (const [category, data] of Object.entries(grouped)) {
      if (data.tabs.length < 2) continue; // only group if 2+ tabs in category

      const tabIds = data.tabs.map(t => t.id);
      try {
        let groupId = this.groupCache.get(category);

        if (!groupId) {
          groupId = await chrome.tabs.group({ tabIds: [tabIds[0]] });
          await chrome.tabGroups.update(groupId, {
            title: `${category} (${data.tabs.length})`,
            color: data.color,
            collapsed: false
          });
          this.groupCache.set(category, groupId);
        }

        // Add remaining tabs
        for (let i = 1; i < tabIds.length; i++) {
          try {
            await chrome.tabs.group({ tabIds: [tabIds[i]], groupId });
          } catch { /* tab already grouped or closed */ }
        }

        // Update title count
        await chrome.tabGroups.update(groupId, {
          title: `${category} (${data.tabs.length})`
        });

      } catch (err) {
        console.error('Grouping error for', category, err);
        this.groupCache.delete(category); // clear bad cache entry
      }
    }

    return grouped;
  }

  clearCache() { this.groupCache.clear(); }
}

// ══════════════════════════════════════════════════
// 8. Memory Monitor
// ══════════════════════════════════════════════════
class MemoryMonitor {
  constructor(hsa) {
    this.hsa               = hsa;
    this.memoryThreshold   = 0.60;  // SLEEP mode
    this.emergencyThreshold= 0.85;  // TRUE DISCARD mode
    this.userSleepThreshold= null;  // user override (null = use auto-adjust)
    this.lastOptimization  = 0;
    this.discardHistory    = [];
    this.ourSavedBytes     = 0;
  }

  // AUDIT FIX: only auto-adjust if user hasn't set a manual threshold
  async adjustThresholds() {
    if (this.userSleepThreshold !== null) return; // respect user setting
    const tabs = await chrome.tabs.query({});
    const n = tabs.length;
    if (n < 20)      this.memoryThreshold = 0.65;
    else if (n < 50) this.memoryThreshold = 0.60;
    else             this.memoryThreshold = 0.55;
  }

  async getMemoryInfo() {
    try {
      const info = await chrome.system.memory.getInfo();
      const usageRatio = 1 - (info.availableCapacity / info.capacity);
      return {
        total:        info.capacity,
        available:    info.availableCapacity,
        used:         info.capacity - info.availableCapacity,
        usageRatio,
        usagePercent: Math.round(usageRatio * 100)
      };
    } catch {
      // Fallback if permission fails
      return { total: 8e9, available: 2e9, used: 6e9, usageRatio: 0.75, usagePercent: 75 };
    }
  }

  async checkAndOptimize() {
    await this.adjustThresholds();

    const memory = await this.getMemoryInfo();
    const now    = Date.now();

    if (now - this.lastOptimization < 5 * 60 * 1000) {
      return { optimized: false, reason: 'throttled' };
    }
    if (memory.usageRatio < this.memoryThreshold) {
      return { optimized: false, reason: 'below_threshold', memory };
    }

    const tabs             = await chrome.tabs.query({});
    const isEmergency      = memory.usageRatio >= this.emergencyThreshold;
    const discardedTabs    = [];
    this.ourSavedBytes     = 0; // AUDIT FIX: reset per-run counter, not cumulative

    if (isEmergency) {
      // TRUE DISCARD: close tabs permanently
      const targets = tabs
        .filter(t => !t.active && !t.pinned && !t.audible
                  && t.url && !t.url.startsWith('chrome://')
                  && !this.hsa.isWhitelisted(t))
        .map(t => ({ tab: t, lastAccess: this.hsa.lru.accessTimes.get(String(t.id)) || 0 }))
        .sort((a, b) => a.lastAccess - b.lastAccess)
        .slice(0, 10);

      for (const { tab } of targets) {
        try {
          const before = (await this.getMemoryInfo()).used;
          await chrome.tabs.remove(tab.id);
          await new Promise(r => setTimeout(r, 300));
          const after = (await this.getMemoryInfo()).used;
          this.ourSavedBytes += Math.max(before - after, 0);

          discardedTabs.push({
            tabId: tab.id, title: tab.title, url: tab.url,
            reason: 'Emergency: RAM ≥ 85%',
            discardedAt: Date.now(), mode: 'TRUE_DISCARD'
          });
        } catch (e) { console.error('Close tab error:', e); }
      }

    } else {
      // SLEEP: discard() keeps tab visible, frees RAM
      const candidates = await this.hsa.getDiscardCandidates(tabs);
      const count      = memory.usageRatio > 0.75 ? 8 : 5;
      const toSleep    = candidates.slice(0, count);

      for (const { tab, score } of toSleep) {
        try {
          const before = (await this.getMemoryInfo()).used;
          await chrome.tabs.discard(tab.id);
          await new Promise(r => setTimeout(r, 300));
          const after = (await this.getMemoryInfo()).used;
          this.ourSavedBytes += Math.max(before - after, 0);

          discardedTabs.push({
            tabId: tab.id, title: tab.title, url: tab.url,
            utility: score.utility.toFixed(3),
            reason: score.reason,
            discardedAt: Date.now(), mode: 'SLEEP'
          });
        } catch (e) { console.error('Sleep tab error:', e); }
      }
    }

    // Persist history
    this.discardHistory = [...discardedTabs, ...this.discardHistory].slice(0, 20);
    await chrome.storage.local.set({ discard_history_log: this.discardHistory });

    await new Promise(r => setTimeout(r, 1000));
    const memoryAfter = await this.getMemoryInfo();
    this.lastOptimization = now;

    const savedMB = Math.round(this.ourSavedBytes / (1024 * 1024));
    const result  = {
      optimized: true, timestamp: now,
      memoryBefore: memory.used, memoryAfter: memoryAfter.used,
      savedMB, discardedCount: discardedTabs.length,
      discardedTabs, mode: isEmergency ? 'TRUE_DISCARD' : 'SLEEP'
    };

    await chrome.storage.local.set({ last_optimization: result });

    if (discardedTabs.length > 0) {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icon48.png',
        title: isEmergency ? '⚠️ Emergency: Tabs Closed' : '✅ Memory Optimized',
        message: `${isEmergency ? 'Closed' : 'Slept'} ${discardedTabs.length} tabs · ~${savedMB} MB freed`
      });
    }

    return result;
  }

  // AUDIT FIX: idle threshold now reads from user pref not hardcoded 15 min
  async checkIdleTabs(idleMinutes = 15) {
    const tabs           = await chrome.tabs.query({});
    const idleThreshold  = idleMinutes * 60 * 1000;
    const now            = Date.now();
    const discardedTabs  = [];

    for (const tab of tabs) {
      if (tab.active || tab.pinned || tab.audible || tab.discarded) continue;
      if (this.hsa.isWhitelisted(tab)) continue;
      if (!tab.url || tab.url.startsWith('chrome://')) continue;

      const lastAccess = this.hsa.lru.accessTimes.get(String(tab.id));
      if (!lastAccess || (now - lastAccess) < idleThreshold) continue;

      try {
        await chrome.tabs.discard(tab.id);
        discardedTabs.push({
          tabId: tab.id, title: tab.title, url: tab.url,
          reason: `Idle ${idleMinutes}+ minutes`,
          discardedAt: now, mode: 'SLEEP'
        });
      } catch (e) { console.error('Idle sleep error:', e); }
    }

    if (discardedTabs.length > 0) {
      this.discardHistory = [...discardedTabs, ...this.discardHistory].slice(0, 20);
      await chrome.storage.local.set({ discard_history_log: this.discardHistory });
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icon48.png',
        title: '💤 Idle Tabs Slept',
        message: `Slept ${discardedTabs.length} tabs idle for ${idleMinutes}+ min`
      });
    }
  }

  formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb/1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  }
}

// ══════════════════════════════════════════════════
// 9. Main System
// ══════════════════════════════════════════════════
class TabManagementSystem {
  constructor() {
    this.lru         = new LRUTracker();
    this.lfu         = new LFUTracker();
    this.classifier  = new TabClassifier();
    this.hsa         = new HybridScoringAlgorithm(this.lru, this.lfu, this.classifier);
    this.grouper     = new TabGroupingEngine(this.classifier);
    this.memoryMonitor = new MemoryMonitor(this.hsa);
    this.initialized = false;
    this.userIdleMinutes = 15; // default, overridden by settings
  }

  async initialize() {
    if (this.initialized) return;
    console.log('AUCTMS v1.2.0 initializing…');

    await chrome.storage.local.set({ last_session_time: Date.now() });

    await this.lru.loadFromStorage();
    await this.lfu.loadFromStorage();
    await this.lru.clearStaleData();
    await this.lfu.clearStaleData();

    await this.hsa.loadWhitelist();
    await this.loadUserPreferences();

    // Restore persisted discard history (survives SW restarts)
    const stored = await chrome.storage.local.get('discard_history_log');
    if (stored.discard_history_log) {
      this.memoryMonitor.discardHistory = stored.discard_history_log;
    }

    this.setupEventListeners();

    // Alarms
    chrome.alarms.create('memory_check', { periodInMinutes: 1 });
    chrome.alarms.create('idle_check',   { periodInMinutes: 5 });

    // Initial grouping after tabs settle
    setTimeout(() => this.grouper.groupTabs(), 3000);

    this.initialized = true;
    console.log('AUCTMS initialized');
  }

  async loadUserPreferences() {
    const result = await chrome.storage.local.get(['user_prefs', 'never_discard_domains']);
    if (result.user_prefs) {
      const p = result.user_prefs;
      if (p.sleepThreshold) {
        this.memoryMonitor.memoryThreshold    = p.sleepThreshold;
        this.memoryMonitor.userSleepThreshold = p.sleepThreshold; // lock auto-adjust off
      }
      if (p.emergencyThreshold) {
        this.memoryMonitor.emergencyThreshold = p.emergencyThreshold;
      }
      if (p.idleTimeout) {
        this.userIdleMinutes = p.idleTimeout;
      }
      console.log('Loaded prefs:', p);
    }
    if (result.never_discard_domains) {
      this.hsa.whitelist = new Set(result.never_discard_domains);
    }
  }

  setupEventListeners() {
    // Tab activated
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      this.lru.recordAccess(tabId);
      this.lfu.recordVisit(tabId);
    });

    // New tab created
    chrome.tabs.onCreated.addListener(tab => {
      if (tab.id) {
        this.lru.recordAccess(tab.id);
        this.lfu.recordVisit(tab.id);
      }
      setTimeout(() => this.grouper.groupTabs(), 2500);
    });

    // Tab URL changed / finished loading
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'complete' || changeInfo.url) {
        this.lru.recordAccess(tabId);
        setTimeout(() => this.grouper.groupTabs(), 2500);
      }
    });

    // Tab closed — clean up trackers
    chrome.tabs.onRemoved.addListener(tabId => {
      this.lru.removeTab(tabId);
      this.lfu.removeTab(tabId);
    });

    // Alarms
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === 'memory_check') {
        this.memoryMonitor.checkAndOptimize();
      }
      if (alarm.name === 'idle_check') {
        this.memoryMonitor.checkIdleTabs(this.userIdleMinutes);
      }
    });
  }

  async getSystemStatus() {
    const tabs   = await chrome.tabs.query({});
    const memory = await this.memoryMonitor.getMemoryInfo();
    const lastOpt = await chrome.storage.local.get('last_optimization');

    return {
      tabCount:         tabs.length,
      memory,
      lastOptimization: lastOpt.last_optimization || null,
      // Live threshold values so popup can show what's currently active
      currentThresholds: {
        sleep:     this.memoryMonitor.memoryThreshold,
        emergency: this.memoryMonitor.emergencyThreshold,
        idleMin:   this.userIdleMinutes
      }
    };
  }
}

// ══════════════════════════════════════════════════
// Bootstrap
// ══════════════════════════════════════════════════
const system = new TabManagementSystem();
system.initialize();

// ══════════════════════════════════════════════════
// Message Handlers
// ══════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'getStatus') {
    system.getSystemStatus().then(sendResponse);
    return true;
  }

  if (request.action === 'forceOptimize') {
    // AUDIT FIX: bypass throttle on manual force
    system.memoryMonitor.lastOptimization = 0;
    system.memoryMonitor.checkAndOptimize().then(sendResponse);
    return true;
  }

  if (request.action === 'regroup') {
    system.grouper.clearCache();
    system.grouper.groupTabs().then(sendResponse);
    return true;
  }

  if (request.action === 'GET_ACTUAL_GROUPS') {
    chrome.tabGroups.query({}).then(async groups => {
      const result = [];
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id });
        result.push({
          id: g.id, title: g.title, color: g.color, collapsed: g.collapsed,
          tabs: tabs.map(t => ({
            id: t.id, title: t.title, url: t.url,
            active: t.active, discarded: t.discarded
          }))
        });
      }
      sendResponse({ groups: result });
    });
    return true;
  }

  if (request.action === 'GET_DISCARD_HISTORY') {
    sendResponse({ history: system.memoryMonitor.discardHistory || [] });
    return true;
  }

  // Apply settings immediately from popup (no restart needed)
  if (request.action === 'APPLY_SETTINGS') {
    const p  = request.prefs    || {};
    const wl = request.whitelist || [];
    if (p.sleepThreshold) {
      system.memoryMonitor.memoryThreshold    = p.sleepThreshold;
      system.memoryMonitor.userSleepThreshold = p.sleepThreshold;
    }
    if (p.emergencyThreshold) {
      system.memoryMonitor.emergencyThreshold = p.emergencyThreshold;
    }
    if (p.idleTimeout) {
      system.userIdleMinutes = p.idleTimeout;
    }
    system.hsa.whitelist = new Set(wl);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'RESTORE_TAB') {
    chrome.tabs.reload(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch(e  => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === 'ADD_TO_WHITELIST') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async tabs => {
      if (!tabs[0]) { sendResponse({ success: false }); return; }
      try {
        const hostname = new URL(tabs[0].url).hostname.replace(/^www\./, '');
        const stored   = await chrome.storage.local.get('never_discard_domains');
        const list     = stored.never_discard_domains || [];
        if (!list.includes(hostname)) {
          list.push(hostname);
          await chrome.storage.local.set({ never_discard_domains: list });
          system.hsa.whitelist = new Set(list);
        }
        sendResponse({ success: true, domain: hostname });
      } catch (e) {
        sendResponse({ success: false, error: 'Invalid URL' });
      }
    });
    return true;
  }

  if (request.action === 'DISCARD_OLDEST_TAB') {
    chrome.tabs.query({}).then(async tabs => {
      const candidates = tabs
        .filter(t => !t.active && !t.pinned && !t.audible
                  && t.url && !t.url.startsWith('chrome://')
                  && !system.hsa.isWhitelisted(t))
        .map(t => ({ tab: t, lastAccess: system.hsa.lru.accessTimes.get(String(t.id)) || 0 }))
        .sort((a, b) => a.lastAccess - b.lastAccess);

      if (candidates.length === 0) {
        sendResponse({ success: false, reason: 'No eligible tabs' });
        return;
      }

      const oldest = candidates[0].tab;
      try {
        await chrome.tabs.remove(oldest.id);
        const entry = {
          tabId: oldest.id, title: oldest.title, url: oldest.url,
          reason: 'Manually discarded', discardedAt: Date.now(),
          mode: 'TRUE_DISCARD'
        };
        system.memoryMonitor.discardHistory.unshift(entry);
        system.memoryMonitor.discardHistory = system.memoryMonitor.discardHistory.slice(0, 20);
        // AUDIT FIX: persist manual discard too
        await chrome.storage.local.set({ discard_history_log: system.memoryMonitor.discardHistory });
        sendResponse({ success: true, title: oldest.title });
      } catch (e) {
        sendResponse({ success: false, reason: e.message });
      }
    });
    return true;
  }

});
