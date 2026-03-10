const DB_NAME = 'word_recall_pwa_db';
const DB_VERSION = 1;
const STORE_APP = 'app';
const APP_STATE_KEY = 'state';

const defaultState = {
  settings: {
    dailyQuota: 10,
    intervals: [0, 1, 3, 7, 14, 30]
  },
  words: [],
  logs: []
};

let db;
let state = structuredClone(defaultState);
let currentReviewQueue = [];
let currentReviewIndex = 0;
let calendarCursor = new Date();

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), 1800);
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_APP)) {
        database.createObjectStore(STORE_APP);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APP, 'readonly');
    const store = tx.objectStore(STORE_APP);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APP, 'readwrite');
    const store = tx.objectStore(STORE_APP);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadState() {
  const saved = await dbGet(APP_STATE_KEY);
  state = saved ? {
    settings: { ...defaultState.settings, ...saved.settings },
    words: Array.isArray(saved.words) ? saved.words : [],
    logs: Array.isArray(saved.logs) ? saved.logs : []
  } : structuredClone(defaultState);
}

async function saveState() {
  await dbSet(APP_STATE_KEY, state);
}

function todayStr() {
  return formatDate(new Date());
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function getTodayDueWords() {
  const t = todayStr();
  return state.words.filter(w => w.nextReviewDate <= t);
}

function getTodayNewCount() {
  const t = todayStr();
  return state.words.filter(w => w.createdAt === t).length;
}

function renderDashboard() {
  const due = getTodayDueWords();
  const hardCount = state.words.filter(w => (w.wrongCount || 0) > 0).length;
  document.getElementById('todayDueCount').textContent = due.length;
  document.getElementById('todayNewQuota').textContent = state.settings.dailyQuota;
  document.getElementById('hardWordCount').textContent = hardCount;
  document.getElementById('totalWordCount').textContent = state.words.length;

  const newCount = getTodayNewCount();
  document.getElementById('todayPlan').innerHTML = `
    <p>今天建议先完成 <strong>${due.length}</strong> 个待复习单词。</p>
    <p>今天已录入新词 <strong>${newCount}</strong> / ${state.settings.dailyQuota}。</p>
    <p>${newCount < state.settings.dailyQuota ? `还可新增 <strong>${state.settings.dailyQuota - newCount}</strong> 个新词。`: '<span style="color:#059669">今日新词目标已达到。</span>'}</p>
  `;

  const batchMap = {};
  due.forEach(w => {
    batchMap[w.createdAt] = (batchMap[w.createdAt] || 0) + 1;
  });
  const html = Object.keys(batchMap).sort().map(d => `<p>${d} 批次：<strong>${batchMap[d]}</strong> 个</p>`).join('') || '<p class="muted">今天没有到期批次。</p>';
  document.getElementById('batchSummary').innerHTML = html;
}

function renderReview() {
  currentReviewQueue = getTodayDueWords().sort((a, b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
  currentReviewIndex = 0;
  updateReviewCard();
}

function updateReviewCard() {
  const empty = document.getElementById('reviewEmpty');
  const box = document.getElementById('reviewBox');
  const answerBox = document.getElementById('answerBox');
  const rateButtons = document.getElementById('rateButtons');
  document.getElementById('spellingAttempt').value = '';
  answerBox.classList.add('hidden');
  rateButtons.classList.add('hidden');

  if (currentReviewIndex >= currentReviewQueue.length) {
    empty.textContent = currentReviewQueue.length === 0 ? '今天还没有待复习内容。' : '今天的复习已完成。';
    empty.classList.remove('hidden');
    box.classList.add('hidden');
    renderDashboard();
    renderLog();
    renderLibrary();
    renderCalendar();
    return;
  }

  empty.classList.add('hidden');
  box.classList.remove('hidden');
  const item = currentReviewQueue[currentReviewIndex];
  document.getElementById('reviewPrompt').textContent = item.meaning;
  document.getElementById('reviewMeta').textContent = `标签：${(item.tags || []).join(' / ') || '无'} ｜ 进度：${currentReviewIndex + 1}/${currentReviewQueue.length}`;
}

function revealAnswer() {
  const item = currentReviewQueue[currentReviewIndex];
  const attempt = document.getElementById('spellingAttempt').value.trim();
  document.getElementById('answerWord').textContent = item.word;
  document.getElementById('answerMeaning').textContent = item.meaning;
  document.getElementById('answerExample').textContent = item.example || '—';
  document.getElementById('attemptResult').textContent = attempt || '未输入';
  document.getElementById('answerBox').classList.remove('hidden');
  document.getElementById('rateButtons').classList.remove('hidden');
}

async function applyRating(wordId, rating, attempt) {
  const item = state.words.find(w => w.id === wordId);
  if (!item) return;
  const oldStage = item.stageIndex || 0;
  const maxStage = state.settings.intervals.length - 1;
  let newStage = oldStage;
  let nextDate = todayStr();

  if (rating === 'Easy') {
    newStage = Math.min(oldStage + 2, maxStage);
    nextDate = addDays(todayStr(), state.settings.intervals[newStage]);
  } else if (rating === 'Good') {
    newStage = Math.min(oldStage + 1, maxStage);
    nextDate = addDays(todayStr(), state.settings.intervals[newStage]);
  } else if (rating === 'Hard') {
    newStage = oldStage;
    nextDate = addDays(todayStr(), 1);
    item.wrongCount = (item.wrongCount || 0) + 1;
  } else if (rating === 'Again') {
    newStage = 0;
    nextDate = todayStr();
    item.wrongCount = (item.wrongCount || 0) + 1;
  }

  item.stageIndex = newStage;
  item.nextReviewDate = nextDate;
  item.lastReviewDate = todayStr();

  state.logs.unshift({
    id: uuid(),
    ts: new Date().toLocaleString('zh-CN'),
    word: item.word,
    rating,
    oldStage,
    newStage,
    nextDate,
    attempt: attempt || ''
  });

  await saveState();
  currentReviewIndex += 1;
  renderDashboard();
  updateReviewCard();
}

async function addWord(entry) {
  state.words.push({
    id: uuid(),
    word: entry.word,
    meaning: entry.meaning,
    example: entry.example || '',
    tags: entry.tags || [],
    createdAt: todayStr(),
    nextReviewDate: todayStr(),
    stageIndex: 0,
    wrongCount: 0,
    lastReviewDate: null
  });
  await saveState();
}

function renderLibrary() {
  const container = document.getElementById('libraryList');
  if (state.words.length === 0) {
    container.innerHTML = '<div class="muted">词库为空</div>';
    return;
  }
  container.innerHTML = state.words.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(w => `
    <div class="list-item">
      <div class="word-head">
        <div>
          <strong>${escapeHtml(w.word)}</strong>
          <div>${escapeHtml(w.meaning)}</div>
        </div>
        <div class="muted small">阶段 ${w.stageIndex}</div>
      </div>
      <div class="pills">${(w.tags || []).map(t => `<span class="pill">${escapeHtml(t)}</span>`).join('') || ''}</div>
      <div class="small muted">下次复习：${w.nextReviewDate} ｜ 错题次数：${w.wrongCount || 0}</div>
      ${w.example ? `<div class="small" style="margin-top:6px;">例句：${escapeHtml(w.example)}</div>` : ''}
    </div>
  `).join('');
}

function renderLog() {
  const container = document.getElementById('logList');
  if (state.logs.length === 0) {
    container.innerHTML = '<div class="muted">暂无记录</div>';
    return;
  }
  container.innerHTML = state.logs.slice(0, 200).map(log => `
    <div class="list-item">
      <div class="word-head">
        <strong>${escapeHtml(log.word)}</strong>
        <div>${log.rating}</div>
      </div>
      <div class="small muted">${log.ts}</div>
      <div class="small">原阶段 ${log.oldStage} → 新阶段 ${log.newStage}</div>
      <div class="small">下次日期：${log.nextDate}</div>
      <div class="small">拼写：${log.attempt ? escapeHtml(log.attempt) : '—'}</div>
    </div>
  `).join('');
}

function renderCalendar() {
  const title = document.getElementById('calendarTitle');
  const grid = document.getElementById('calendarGrid');
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  title.textContent = `${year} 年 ${month + 1} 月`;

  const firstDay = new Date(year, month, 1);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];

  let html = weekdayNames.map(d => `<div class="weekday">周${d}</div>`).join('');
  for (let i = 0; i < startWeekday; i++) html += `<div class="day" style="background:#f9fafb"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = formatDate(new Date(year, month, day));
    const dueCount = state.words.filter(w => w.nextReviewDate === ds).length;
    const newCount = state.words.filter(w => w.createdAt === ds).length;
    html += `
      <div class="day">
        <div class="date">${day}</div>
        <div class="small ${dueCount > 0 ? '' : 'muted'}">复习: ${dueCount}</div>
        <div class="small ${newCount > 0 ? '' : 'muted'}">新词: ${newCount}</div>
      </div>
    `;
  }
  grid.innerHTML = html;
}

function renderSettings() {
  document.getElementById('dailyQuotaSelect').value = String(state.settings.dailyQuota);
  document.getElementById('intervalInput').value = state.settings.intervals.join(',');
}

function switchTab(tabId) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.querySelector(`.bottom-nav button[data-tab="${tabId}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (tabId === 'review') renderReview();
  if (tabId === 'calendarTab') renderCalendar();
  if (tabId === 'log') renderLog();
  if (tabId === 'library') renderLibrary();
  if (tabId === 'settings') renderSettings();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function bindEvents() {
  document.querySelectorAll('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('addWordBtn').addEventListener('click', async () => {
    const word = document.getElementById('wordInput').value.trim();
    const meaning = document.getElementById('meaningInput').value.trim();
    const example = document.getElementById('exampleInput').value.trim();
    const tags = document.getElementById('tagInput').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!word || !meaning) {
      showToast('请填写单词和释义');
      return;
    }
    await addWord({ word, meaning, example, tags });
    document.getElementById('wordInput').value = '';
    document.getElementById('meaningInput').value = '';
    document.getElementById('exampleInput').value = '';
    document.getElementById('tagInput').value = '';
    renderDashboard();
    renderLibrary();
    renderCalendar();
    showToast('已添加');
  });

  document.getElementById('addBatchDemoBtn').addEventListener('click', async () => {
    const demo = [
      ['negotiate', '谈判；协商', 'We need to negotiate a better price.', ['工作', '口语']],
      ['commute', '通勤', 'My commute takes about forty minutes.', ['口语']],
      ['itinerary', '行程安排', 'I shared the itinerary with the team.', ['旅行', '工作']],
      ['hesitate', '犹豫', 'Don’t hesitate to ask questions.', ['口语']],
      ['accurate', '准确的', 'Your pronunciation is quite accurate.', ['口语']]
    ];
    for (const [word, meaning, example, tags] of demo) {
      await addWord({ word, meaning, example, tags });
    }
    renderDashboard();
    renderLibrary();
    renderCalendar();
    showToast('已导入 5 个示例');
  });

  document.getElementById('showAnswerBtn').addEventListener('click', revealAnswer);
  document.getElementById('skipBtn').addEventListener('click', () => {
    if (currentReviewQueue.length === 0) return;
    currentReviewQueue.push(currentReviewQueue[currentReviewIndex]);
    currentReviewIndex += 1;
    updateReviewCard();
  });

  document.querySelectorAll('#rateButtons button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = currentReviewQueue[currentReviewIndex];
      const attempt = document.getElementById('spellingAttempt').value.trim();
      await applyRating(item.id, btn.dataset.rating, attempt);
    });
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const dailyQuota = Number(document.getElementById('dailyQuotaSelect').value);
    const intervals = document.getElementById('intervalInput').value.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);
    if (intervals.length === 0) {
      showToast('复习间隔不能为空');
      return;
    }
    state.settings.dailyQuota = dailyQuota;
    state.settings.intervals = intervals;
    await saveState();
    renderDashboard();
    showToast('设置已保存');
  });

  document.getElementById('prevMonthBtn').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });

  document.getElementById('nextMonthBtn').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `word_recall_backup_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('已导出 JSON');
  });

  document.getElementById('importInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      state = {
        settings: { ...defaultState.settings, ...parsed.settings },
        words: Array.isArray(parsed.words) ? parsed.words : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs : []
      };
      await saveState();
      initViews();
      showToast('导入成功');
    } catch {
      showToast('导入失败');
    } finally {
      event.target.value = '';
    }
  });

  document.getElementById('clearDemoBtn').addEventListener('click', async () => {
    if (!confirm('确定清空所有本地数据吗？')) return;
    state = structuredClone(defaultState);
    await saveState();
    initViews();
    showToast('已清空');
  });
}

function initViews() {
  renderDashboard();
  renderReview();
  renderLog();
  renderLibrary();
  renderCalendar();
  renderSettings();
  switchTab('dashboard');
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {
      // ignore
    }
  }
}

(async function init() {
  db = await openDB();
  await loadState();
  bindEvents();
  initViews();
  registerSW();
})();
