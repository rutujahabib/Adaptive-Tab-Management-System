// Version 1.2.0 
// 1. LRU (Least Recently Used) Tracker
class LRUTracker {
  constructor() {
    this.accessTimes = new Map();
  }

  recordAccess(tabId) { 
    this.accessTimes.set(tabId, Date.now());
    this.saveToStorage();
  }

  getRecency(tabId) {
    const lastAccess = this.accessTimes.get(tabId) || Date.now();
    const idleTime = Date.now() - lastAccess;
    const maxIdle = 1 * 60 * 60 * 1000; // P1 FIX: Reduced from 2 hours to 1 hour
    return Math.min(idleTime / maxIdle, 1.0);
  }

  async saveToStorage() {
    const data = Object.fromEntries(this.accessTimes);
    await chrome.storage.local.set({ lru_data: data });
  }

  async loadFromStorage() {
    const result = await chrome.storage.local.get('lru_data');
    if (result.lru_data) {
      this.accessTimes = new Map(Object.entries(result.lru_data).map(([k, v]) => [k, parseInt(v)]));
    }
  }

  removeTab(tabId) {
    this.accessTimes.delete(tabId);
  }

  // Clear old data on startup
  async clearStaleData() {
    const result = await chrome.storage.local.get('last_session_time');
    const lastSession = result.last_session_time || 0;
    const hoursSinceLastSession = (Date.now() - lastSession) / (60 * 60 * 1000);
    
    if (hoursSinceLastSession > 24) {
      console.log('Clearing stale LRU data (24+ hours old)');
      this.accessTimes.clear();
      await chrome.storage.local.remove('lru_data');
    }
  }
}


// 2. LFU (Least Frequently Used) Tracker with Decay

class LFUTracker {
  constructor() {
    this.frequencies = new Map();
    this.lastAccess = new Map(); // P15 FIX: Track access time for decay
  }

  recordVisit(tabId) {
    const count = this.frequencies.get(tabId) || 0;
    this.frequencies.set(tabId, count + 1);
    this.lastAccess.set(tabId, Date.now()); // P15 FIX: Track when visited
    this.saveToStorage();
  }

  getFrequency(tabId) {
    const count = this.frequencies.get(tabId) || 1;
    const maxFreq = 20;
    return 1.0 - Math.min(Math.log(count + 1) / Math.log(maxFreq + 1), 1.0);
  }

  // Frequency with exponential decay
  getFrequencyWithDecay(tabId) {
    const count = this.frequencies.get(tabId) || 1;
    const lastAccessTime = this.lastAccess.get(tabId) || Date.now();
    
    const ageInDays = (Date.now() - lastAccessTime) / (24 * 60 * 60 * 1000);
    const decayFactor = Math.pow(0.5, ageInDays / 7); // Half-life: 7 days
    const decayedCount = count * decayFactor;
    
    const maxFreq = 20;
    return 1.0 - Math.min(Math.log(decayedCount + 1) / Math.log(maxFreq + 1), 1.0);
  }

  async saveToStorage() {
    const freqData = Object.fromEntries(this.frequencies);
    const accessData = Object.fromEntries(this.lastAccess);
    await chrome.storage.local.set({ 
      lfu_data: freqData,
      lfu_access_times: accessData 
    });
  }

  async loadFromStorage() {
    const result = await chrome.storage.local.get(['lfu_data', 'lfu_access_times']);
    if (result.lfu_data) {
      this.frequencies = new Map(Object.entries(result.lfu_data).map(([k, v]) => [k, parseInt(v)]));
    }
    if (result.lfu_access_times) {
      this.lastAccess = new Map(Object.entries(result.lfu_access_times).map(([k, v]) => [k, parseInt(v)]));
    }
  }

  removeTab(tabId) {
    this.frequencies.delete(tabId);
    this.lastAccess.delete(tabId);
  }

  // Clear old data on startup
  async clearStaleData() {
    const result = await chrome.storage.local.get('last_session_time');
    const lastSession = result.last_session_time || 0;
    const hoursSinceLastSession = (Date.now() - lastSession) / (60 * 60 * 1000);
    
    if (hoursSinceLastSession > 24) {
      console.log('Clearing stale LFU data (24+ hours old)');
      this.frequencies.clear();
      this.lastAccess.clear();
      await chrome.storage.local.remove(['lfu_data', 'lfu_access_times']);
    }
  }
}


// 3. TF-IDF Engine

class TFIDFEngine {
  constructor() {
    this.stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how']);
  }

  tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !this.stopWords.has(word));
  }

  computeTF(tokens) {
    const tf = {};
    const total = tokens.length;
    tokens.forEach(token => {
      tf[token] = (tf[token] || 0) + 1;
    });
    for (let term in tf) {
      tf[term] = tf[term] / total;
    }
    return tf;
  }

  extractKeywords(text, topN = 5) {
    const tokens = this.tokenize(text);
    const tf = this.computeTF(tokens);
    
    const sorted = Object.entries(tf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([term]) => term);
    
    return sorted;
  }
}


// 4. Jaccard Similarity Calculator

class JaccardSimilarity {
  static calculate(set1, set2) {
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  static computeSimilarity(tokens1, tokens2) {
    const set1 = new Set(tokens1);
    const set2 = new Set(tokens2);
    return this.calculate(set1, set2);
  }
}


// 5. NLP-Based Tab Classifier

class TabClassifier {
  constructor() {
    this.tfidf = new TFIDFEngine();
    this.categories = {
      'Work': {
        keywords: ['github', 'docs', 'document', 'presentation', 'sheet', 'drive', 'office', 'notion', 'slack', 'meeting', 'zoom', 'teams'],
        domains: ['github.com', 'docs.google.com', 'notion.so', 'office.com', 'slack.com'],
        color: 'blue'
      },
      'Research': {
        keywords: ['wikipedia', 'research', 'article', 'paper', 'study', 'stackoverflow', 'tutorial', 'learn', 'course', 'education'],
        domains: ['wikipedia.org', 'stackoverflow.com', 'medium.com', 'arxiv.org', 'scholar.google.com'],
        color: 'green'
      },
      'Shopping': {
        keywords: ['buy', 'shop', 'cart', 'price', 'product', 'order', 'amazon', 'store', 'deal'],
        domains: ['amazon.com', 'ebay.com', 'walmart.com', 'flipkart.com', 'myntra.com'],
        color: 'orange'
      },
      'Entertainment': {
        keywords: ['video', 'watch', 'movie', 'music', 'game', 'play', 'stream', 'netflix', 'youtube', 'spotify'],
        domains: ['youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv', 'reddit.com'],
        color: 'red'
      },
      'Social': {
        keywords: ['twitter', 'facebook', 'social', 'chat', 'message', 'post', 'linkedin', 'instagram'],
        domains: ['twitter.com', 'facebook.com', 'linkedin.com', 'instagram.com', 'whatsapp.com'],
        color: 'purple'
      }
    };
  }

  classify(tab) {
    const title = (tab.title || '').toLowerCase();
    const url = (tab.url || '').toLowerCase();
    const text = title + ' ' + url;
    
    let maxScore = 0;
    let bestCategory = 'Other';
    
    for (let [category, data] of Object.entries(this.categories)) {
      let score = 0;
      
      if (data.domains.some(domain => url.includes(domain))) {
        score += 50;
      }
      
      const tokens = this.tfidf.tokenize(text);
      const keywords = this.tfidf.extractKeywords(text, 10);
      
      data.keywords.forEach(keyword => {
        if (keywords.includes(keyword)) score += 15;
        if (title.includes(keyword)) score += 10;
        if (url.includes(keyword)) score += 5;
      });
      
      if (score > maxScore) {
        maxScore = score;
        bestCategory = category;
      }
    }
    
    const confidence = Math.min(maxScore / 10, 10);
    const color = this.categories[bestCategory]?.color || 'grey';
    
    return {
      category: bestCategory,
      confidence: confidence,
      score: maxScore,
      color: color
    };
  }
}


// 6. Hybrid Scoring Algorithm (HSA)
class HybridScoringAlgorithm {
  constructor(lruTracker, lfuTracker, classifier) {
    this.lru = lruTracker;
    this.lfu = lfuTracker;
    this.classifier = classifier;
    
    this.weights = {
      wR: 0.30,
      wF: 0.25,
      wM: 0.25,
      wC: 0.20
    };
    
  
  this.whitelist = new Set();
  }

  async loadWhitelist() {
    const result = await chrome.storage.sync.get('never_discard_domains');
    if (result.never_discard_domains) {
      this.whitelist = new Set(result.never_discard_domains);
    }
  }

  isWhitelisted(tab) {
    try {
      const url = new URL(tab.url);
      return this.whitelist.has(url.hostname);
    } catch (e) {
      return false;
    }
  }

  estimateMemory(tab) {
    const url = (tab.url || '').toLowerCase();
    let baseMemory = 50;
    
    if (url.includes('youtube') || url.includes('video')) baseMemory *= 3;
    if (url.includes('netflix') || url.includes('stream')) baseMemory *= 3;
    if (url.includes('facebook') || url.includes('twitter')) baseMemory *= 2;
    if (url.includes('amazon') || url.includes('shopping')) baseMemory *= 1.5;
    
    const maxMemory = 200;
    return Math.min(baseMemory / maxMemory, 1.0);
  }

  calculateContentPriority(tab, classification) {
    const basePriorities = {
      'Work': 0.95,
      'Research': 0.80,
      'Social': 0.50,
      'Shopping': 0.40,
      'Entertainment': 0.30,
      'Other': 0.20
    };
    
    let priority = basePriorities[classification.category] || 0.20;
    
    if (tab.pinned) priority += 0.20;
    if (tab.active) priority += 0.25;
    if (classification.confidence > 7) priority += 0.05;
    
    const url = (tab.url || '').toLowerCase();
    if (url.includes('docs.google') || url.includes('form')) priority += 0.15;
    if (url.includes('checkout') || url.includes('payment')) priority += 0.20;
    
    return Math.min(priority, 1.0);
  }

  async calculateUtilityScore(tab) {
    const tabId = tab.id.toString();
    
    const Ri = this.lru.getRecency(tabId);
    const Fi = this.lfu.getFrequencyWithDecay(tabId); // P15 FIX: Use decayed frequency
    const Mi = this.estimateMemory(tab);
    
    const classification = this.classifier.classify(tab);
    const Ci = this.calculateContentPriority(tab, classification);
    
    
    const utility = 
      this.weights.wR * Ri +
      this.weights.wF * Fi +
      this.weights.wM * Mi -
      this.weights.wC * Ci;
    
    
    let reason = '';
    if (Ri > 0.7) reason = 'Idle 1+ hours';
    else if (Fi > 0.8) reason = 'Rarely used';
    else if (Mi > 0.7) reason = 'High memory';
    else reason = 'Low priority';
    
    return {
      utility: utility,
      components: { Ri, Fi, Mi, Ci },
      classification: classification,
      reason: reason, // P17 FIX
      shouldDiscard: utility > 0.25 && !tab.active && !tab.pinned // P1 FIX: 0.5 → 0.25
    };
  }

  async getDiscardCandidates(tabs) {
    const scores = [];
    
    for (let tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        continue;
      }
      
      
      if (this.isWhitelisted(tab)) continue;
      
      if (tab.active || tab.pinned) continue;
      if (tab.audible) continue;
      
      const score = await this.calculateUtilityScore(tab);
      
      if (score.shouldDiscard) {
        scores.push({ tab, score });
      }
    }
    
    scores.sort((a, b) => b.score.utility - a.score.utility);
    
    return scores;
  }
}


// 7. Tab Grouping Engine
class TabGroupingEngine {
  constructor(classifier) {
    this.classifier = classifier;
    this.tfidf = new TFIDFEngine();
    this.groupCache = new Map();
  }

  async groupTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    
    // Store original positions
    const originalPositions = new Map();
    tabs.forEach((tab, index) => {
      originalPositions.set(tab.id, index);
    });
    
    const grouped = {};
    
    for (let tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://')) continue;
      
      const classification = this.classifier.classify(tab);
      const category = classification.category;
      
      if (!grouped[category]) {
        grouped[category] = {
          tabs: [],
          color: classification.color,
          confidence: []
        };
      }
      
      grouped[category].tabs.push(tab);
      grouped[category].confidence.push(classification.confidence);
    }
    
    
    for (let [category, data] of Object.entries(grouped)) {
      if (data.tabs.length < 2) continue;
      
      // Sort by original position to maintain order
      data.tabs.sort((a, b) => {
        return originalPositions.get(a.id) - originalPositions.get(b.id);
      });
      
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
        
        for (let i = 1; i < tabIds.length; i++) {
          try {
            await chrome.tabs.group({ tabIds: [tabIds[i]], groupId });
          } catch (e) {
            // Tab might already be grouped
          }
        }
        
        await chrome.tabGroups.update(groupId, {
          title: `${category} (${data.tabs.length})`
        });
        
      } catch (error) {
        console.error('Error grouping tabs:', error);
      }
    }
    
    return grouped;
  }

  clearCache() {
    this.groupCache.clear();
  }
}

// 8. Memory Monitor & RAM Optimizer


class MemoryMonitor {
  constructor(hsa) {
    this.hsa = hsa;
    this.memoryThreshold = 0.60;       // SLEEP mode triggers at 60%
    this.emergencyThreshold = 0.85;    // TRUE DISCARD mode triggers at 85%
    this.lastOptimization = 0;
    this.memoryHistory = [];
    this.discardHistory = [];          
    this.ourSavedBytes = 0;            // RAM counter: only track OUR savings
  }

  // Adjust sleep threshold based on tab count (keeps emergency fixed at 85%)
  async adjustThresholds() {
    const tabs = await chrome.tabs.query({});
    const tabCount = tabs.length;

    if (tabCount < 20) {
      this.memoryThreshold = 0.65;     // fewer tabs → slightly higher sleep trigger
    } else if (tabCount < 50) {
      this.memoryThreshold = 0.60;
    } else {
      this.memoryThreshold = 0.55;     // many tabs → earlier sleep trigger
    }
    // Emergency (true discard) always stays at 85%
  }

  async getMemoryInfo() {
    try {
      const info = await chrome.system.memory.getInfo();
      const usageRatio = 1 - (info.availableCapacity / info.capacity);
      
      return {
        total: info.capacity,
        available: info.availableCapacity,
        used: info.capacity - info.availableCapacity,
        usageRatio: usageRatio,
        usagePercent: Math.round(usageRatio * 100)
      };
    } catch (error) {
      return {
        total: 8 * 1024 * 1024 * 1024,
        available: 2 * 1024 * 1024 * 1024,
        used: 6 * 1024 * 1024 * 1024,
        usageRatio: 0.75,
        usagePercent: 75
      };
    }
  }

  async checkAndOptimize() {
    await this.adjustThresholds();

    const memory = await this.getMemoryInfo();
    const now = Date.now();

    // Throttle: max once per 5 minutes
    if (now - this.lastOptimization < 5 * 60 * 1000) {
      return { optimized: false, reason: 'throttled' };
    }

    if (memory.usageRatio < this.memoryThreshold) {
      return { optimized: false, reason: 'below_threshold', memory };
    }

    console.log(`Memory usage: ${memory.usagePercent}% - Mode: ${memory.usageRatio >= this.emergencyThreshold ? 'TRUE DISCARD' : 'SLEEP'}`);

    const tabs = await chrome.tabs.query({});
    const isEmergencyMode = memory.usageRatio >= this.emergencyThreshold; // 85%+
    const discardedTabs = [];

    if (isEmergencyMode) {
      // EMERGENCY MODE (85%+): TRUE DISCARD  permanently close tabs 
      console.log('EMERGENCY MODE (85%+): True discarding oldest tabs');

      const emergencyTargets = tabs
        .filter(t => !t.active && !t.pinned && !t.audible && t.url && !t.url.startsWith('chrome://'))
        .map(t => ({
          tab: t,
          lastAccess: this.hsa.lru.accessTimes.get(t.id.toString()) || 0
        }))
        .sort((a, b) => a.lastAccess - b.lastAccess); // oldest first

      const toClose = emergencyTargets.slice(0, 10).map(item => item.tab);

      for (let tab of toClose) {
        try {
          const memBefore = (await this.getMemoryInfo()).used;
          await chrome.tabs.remove(tab.id); // TRUE DISCARD: close the tab
          await new Promise(resolve => setTimeout(resolve, 300));
          const memAfter = (await this.getMemoryInfo()).used;
          const tabSaved = Math.max(memBefore - memAfter, 0);
          this.ourSavedBytes += tabSaved;

          discardedTabs.push({
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            utility: 'EMERGENCY',
            reason: 'Emergency: Tab closed (85%+ RAM)',
            discardedAt: Date.now(),
            mode: 'TRUE_DISCARD'
          });
          console.log(`True discarded: ${tab.title}`);
        } catch (error) {
          console.error('Error closing tab:', error);
        }
      }

    } else {
      // NORMAL MODE (60–85%): SLEEP tab.discard() keeps tab, frees RAM 
      console.log('NORMAL MODE (60-85%): Sleeping tabs via HSA');

      const candidates = await this.hsa.getDiscardCandidates(tabs);
      const sleepCount = memory.usageRatio > 0.75 ? 8 : 5;
      const toSleep = candidates.slice(0, sleepCount);

      for (let candidate of toSleep) {
        try {
          const memBefore = (await this.getMemoryInfo()).used;
          await chrome.tabs.discard(candidate.tab.id); // SLEEP: tab stays, RAM freed
          await new Promise(resolve => setTimeout(resolve, 300));
          const memAfter = (await this.getMemoryInfo()).used;
          const tabSaved = Math.max(memBefore - memAfter, 0);
          this.ourSavedBytes += tabSaved;

          discardedTabs.push({
            tabId: candidate.tab.id,
            title: candidate.tab.title,
            url: candidate.tab.url,
            utility: candidate.score.utility.toFixed(3),
            reason: candidate.score.reason,
            discardedAt: Date.now(),
            mode: 'SLEEP'
          });
          console.log(`Slept tab: ${candidate.tab.title}`);
        } catch (error) {
          console.error('Error sleeping tab:', error);
        }
      }
    }

    // Add to discard history for undo (P18) — persist so popup survives SW restart
    this.discardHistory = [...discardedTabs, ...this.discardHistory].slice(0, 20);
    await chrome.storage.local.set({ discard_history_log: this.discardHistory });

    await new Promise(resolve => setTimeout(resolve, 1000));
    const memoryAfter = await this.getMemoryInfo();

    this.lastOptimization = now;

    // Use ourSavedBytes for accurate display (not system-wide RAM delta)
    const savedMB = Math.round(this.ourSavedBytes / (1024 * 1024));

    const result = {
      optimized: true,
      timestamp: now,
      memoryBefore: memory.used,
      memoryAfter: memoryAfter.used,
      saved: this.ourSavedBytes,
      savedMB: savedMB,
      discardedCount: discardedTabs.length,
      discardedTabs: discardedTabs,
      isEmergency: isEmergencyMode,
      mode: isEmergencyMode ? 'TRUE_DISCARD' : 'SLEEP'
    };

    await chrome.storage.local.set({ last_optimization: result });

    if (discardedTabs.length > 0) {
      const modeLabel = isEmergencyMode ? '⚠️ Closed' : '💤 Slept';
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon48.png',
        title: isEmergencyMode ? '⚠️ Emergency Optimization' : '✅ Memory Optimized',
        message: `${modeLabel} ${discardedTabs.length} tabs • Saved ~${savedMB} MB`
      });
    }

    return result;
  }

  // Independent idle check: sleep tabs idle for 15+ minutes
  async checkIdleTabs() {
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    const idleThreshold = 15 * 60 * 1000; // 15 minutes

    const discardedTabs = [];
    
    for (let tab of tabs) {
      if (tab.active || tab.pinned || tab.audible) continue;
      if (this.hsa.isWhitelisted(tab)) continue;
      
      const lastAccess = this.hsa.lru.accessTimes.get(tab.id.toString());
      if (!lastAccess) continue;
      
      const idleTime = now - lastAccess;
      
      if (idleTime > idleThreshold) {
        try {
          await chrome.tabs.discard(tab.id);
          discardedTabs.push({
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            reason: 'Idle 15+ minutes',
            discardedAt: now
          });
          console.log(`Discarded idle tab: ${tab.title}`);
        } catch (error) {
          console.error('Error discarding idle tab:', error);
        }
      }
    }
    
    if (discardedTabs.length > 0) {
      this.discardHistory = [...discardedTabs, ...this.discardHistory].slice(0, 20);
      await chrome.storage.local.set({ discard_history_log: this.discardHistory });
      
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon48.png',
        title: 'Idle Tabs Cleaned',
        message: `Slept ${discardedTabs.length} tabs idle for 15+ minutes`
      });
    }
  }

  formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb.toFixed(0)} MB`;
  }
}


// 9. Main Tab Management System

class TabManagementSystem {
  constructor() {
    this.lru = new LRUTracker();
    this.lfu = new LFUTracker();
    this.classifier = new TabClassifier();
    this.hsa = new HybridScoringAlgorithm(this.lru, this.lfu, this.classifier);
    this.grouper = new TabGroupingEngine(this.classifier);
    this.memoryMonitor = new MemoryMonitor(this.hsa);
    
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    console.log('Initializing Adaptive Tab Management System v1.2.0...');
    
    
    await chrome.storage.local.set({ last_session_time: Date.now() });
    
    // Load saved data
    await this.lru.loadFromStorage();
    await this.lfu.loadFromStorage();
    
    
    await this.lru.clearStaleData();
    await this.lfu.clearStaleData();
    
    
    await this.hsa.loadWhitelist();
    
    
    await this.loadUserPreferences();
    
    // Load persisted discard history so popup shows history after SW restart
    const storedHistory = await chrome.storage.local.get('discard_history_log');
    if (storedHistory.discard_history_log) {
      this.memoryMonitor.discardHistory = storedHistory.discard_history_log;
    }
    
    this.setupEventListeners();
    
    // Alarms
    chrome.alarms.create('memory_check', { periodInMinutes: 1 });
    chrome.alarms.create('idle_check', { periodInMinutes: 30 }); // P7 FIX
    
    // Initial grouping
    setTimeout(() => this.grouper.groupTabs(), 3000);
    
    this.initialized = true;
    console.log('System initialized successfully');
  }

  
  async loadUserPreferences() {
    const result = await chrome.storage.local.get(['user_prefs', 'never_discard_domains']);
    if (result.user_prefs) {
      const prefs = result.user_prefs;
      // Apply thresholds to live memory monitor
      if (prefs.sleepThreshold)     this.memoryMonitor.memoryThreshold    = prefs.sleepThreshold;
      if (prefs.emergencyThreshold) this.memoryMonitor.emergencyThreshold = prefs.emergencyThreshold;
      console.log('Applied user preferences:', prefs);
    }
    if (result.never_discard_domains) {
      this.hsa.whitelist = new Set(result.never_discard_domains);
    }
  }

  setupEventListeners() {
    // Track tab activation
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      this.lru.recordAccess(activeInfo.tabId.toString());
      this.lfu.recordVisit(activeInfo.tabId.toString());
    });
    
    // Track new tabs - instant regroup
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id) {
        this.lru.recordAccess(tab.id.toString());
        this.lfu.recordVisit(tab.id.toString());
      }
      // Instant regroup when new tab created
      setTimeout(() => this.grouper.groupTabs(), 2000);
    });
    
    // Track tab updates (URL changes) - instant regroup
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' || changeInfo.url) {
        this.lru.recordAccess(tabId.toString());
        // Instant regroup when URL changes
        setTimeout(() => this.grouper.groupTabs(), 2000);
      }
    });
    
    // Clean up closed tabs
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.lru.removeTab(tabId.toString());
      this.lfu.removeTab(tabId.toString());
    });
    
    // Alarms
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'memory_check') {
        this.memoryMonitor.checkAndOptimize();
      }
      if (alarm.name === 'idle_check') {
        this.memoryMonitor.checkIdleTabs(); // P7 FIX
      }
    });
  }

  async getSystemStatus() {
    const tabs = await chrome.tabs.query({});
    const memory = await this.memoryMonitor.getMemoryInfo();
    const lastOpt = await chrome.storage.local.get('last_optimization');
    
    return {
      tabCount: tabs.length,
      memory: memory,
      lastOptimization: lastOpt.last_optimization || null,
      tabs: tabs // P4 FIX: Include actual tabs for popup
    };
  }
}

// Initialize System

const system = new TabManagementSystem();
system.initialize();


// Message Handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  if (request.action === 'getStatus') {
    system.getSystemStatus().then(sendResponse);
    return true;
  }
  
  if (request.action === 'forceOptimize') {
    system.memoryMonitor.checkAndOptimize().then(sendResponse);
    return true;
  }
  
  if (request.action === 'regroup') {
    system.grouper.clearCache();
    system.grouper.groupTabs().then(sendResponse);
    return true;
  }
  
 
  if (request.action === 'GET_ACTUAL_GROUPS') {
    chrome.tabGroups.query({}).then(async (groups) => {
      const groupsWithTabs = [];
      
      for (let group of groups) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        groupsWithTabs.push({
          id: group.id,
          title: group.title,
          color: group.color,
          collapsed: group.collapsed,
          tabs: tabs.map(t => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            discarded: t.discarded // P1: Show sleep status
          }))
        });
      }
      
      sendResponse({ groups: groupsWithTabs });
    });
    return true;
  }
  
 
  if (request.action === 'GET_DISCARD_HISTORY') {
    sendResponse({ history: system.memoryMonitor.discardHistory || [] });
    return true;
  }

  // Apply settings from popup immediately to live system
  if (request.action === 'APPLY_SETTINGS') {
    const prefs    = request.prefs    || {};
    const whitelist = request.whitelist || [];
    if (prefs.sleepThreshold)     system.memoryMonitor.memoryThreshold    = prefs.sleepThreshold;
    if (prefs.emergencyThreshold) system.memoryMonitor.emergencyThreshold = prefs.emergencyThreshold;
    system.hsa.whitelist = new Set(whitelist);
    sendResponse({ success: true });
    return true;
  }
  
 // Rutuja -we need to remove this section to fix run time  
  if (request.action === 'RESTORE_TAB') {
    chrome.tabs.reload(request.tabId).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  
  if (request.action === 'ADD_TO_WHITELIST') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      if (tabs[0]) {
        try {
          const url = new URL(tabs[0].url);
          const result = await chrome.storage.sync.get('never_discard_domains');
          const list = result.never_discard_domains || [];
          if (!list.includes(url.hostname)) {
            list.push(url.hostname);
            await chrome.storage.sync.set({ never_discard_domains: list });
            await system.hsa.loadWhitelist();
          }
          sendResponse({ success: true, domain: url.hostname });
        } catch (e) {
          sendResponse({ success: false, error: 'Invalid URL' });
        }
      }
    });
    return true;
  }

  // Manual: Discard oldest tab (for demo / manual control)
  if (request.action === 'DISCARD_OLDEST_TAB') {
    chrome.tabs.query({}).then(async (tabs) => {
      const candidates = tabs
        .filter(t => !t.active && !t.pinned && !t.audible && t.url && !t.url.startsWith('chrome://'))
        .map(t => ({
          tab: t,
          lastAccess: system.memoryMonitor.hsa.lru.accessTimes.get(t.id.toString()) || 0
        }))
        .sort((a, b) => a.lastAccess - b.lastAccess); // oldest first

      if (candidates.length === 0) {
        sendResponse({ success: false, reason: 'No eligible tabs to discard' });
        return;
      }

      const oldest = candidates[0].tab;
      try {
        await chrome.tabs.remove(oldest.id); // True discard: close the tab
        system.memoryMonitor.discardHistory.unshift({
          tabId: oldest.id,
          title: oldest.title,
          url: oldest.url,
          reason: 'Manually discarded (oldest tab)',
          discardedAt: Date.now(),
          mode: 'MANUAL_DISCARD'
        });
        system.memoryMonitor.discardHistory = system.memoryMonitor.discardHistory.slice(0, 20);
        sendResponse({ success: true, title: oldest.title });
      } catch (error) {
        sendResponse({ success: false, reason: error.message });
      }
    });
    return true;
  }

});