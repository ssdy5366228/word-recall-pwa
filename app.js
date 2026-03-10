const DB_NAME = 'word_recall_pwa_db';
const DB_VERSION = 1;
const STORE_APP = 'app';
const APP_STATE_KEY = 'state';

const defaultState = {
  settings: { dailyQuota: 10, intervals: [0, 1, 3, 7, 14, 30] },
  words: [],
  logs: []
};

let db;
let state = structuredClone(defaultState);
let currentReviewQueue = [];
let currentReviewIndex = 0;
let calendarCursor = new Date();
let editingWordId = null;
let reviewContext = { type: 'today' };

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
      if (!database.objectStoreNames.contains(STORE_APP)) database.createObjectStore(STORE_APP);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APP, 'readonly');
    const req = tx.objectStore(STORE_APP).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APP, 'readwrite');
    const req = tx.objectStore(STORE_APP).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadState() {
  const saved = await dbGet(APP_STATE_KEY);
  state = saved ? {
    settings: { ...defaultState.settings, ...saved.settings },
    words: Array.isArray(saved.words) ? saved.words.map(normalizeWord) : [],
    logs: Array.isArray(saved.logs) ? saved.logs : []
  } : structuredClone(defaultState);
}

async function saveState() {
  await dbSet(APP_STATE_KEY, state);
}

function normalizeWord(word) {
  return {
    stageIndex: 0,
    wrongCount: 0,
    example: '',
    tags: [],
    lastReviewDate: null,
    nextReviewDate: word.createdAt || todayStr(),
    reviewedOnDates: [],
    ...word,
    reviewedOnDates: Array.isArray(word.reviewedOnDates) ? word.reviewedOnDates : []
  };
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayStr() {
  return formatDate(new Date());
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function getBatchDatesForTargetDate(targetDate, intervals) {
  return [...new Set(intervals.map(interval => addDays(targetDate, -interval)))];
}

function getRemainingDueWordsForDate(targetDate) {
  const batchDates = getBatchDatesForTargetDate(targetDate, state.settings.intervals);
  return state.words.filter(word => batchDates.includes(word.createdAt) && !(word.reviewedOnDates || []).includes(targetDate));
}

function getBatchSummaryForDate(targetDate) {
  return state.settings.intervals.map(interval => {
    const batchDate = addDays(targetDate, -interval);
    const count = state.words.filter(word => word.createdAt === batchDate && !(word.reviewedOnDates || []).includes(targetDate)).length;
    return { interval, batchDate, count };
  });
}

function getYearOptions() {
  const years = new Set([new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]);
  state.words.forEach(word => {
    if (word.createdAt) years.add(Number(word.createdAt.slice(0, 4)));
    if (word.nextReviewDate) years.add(Number(word.nextReviewDate.slice(0, 4)));
  });
  return [...years].filter(Number.isFinite).sort((a, b) => a - b);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderDashboard() {
  const today = todayStr();
  const dueWords = getRemainingDueWordsForDate(today);
  const batchSummary = getBatchSummaryForDate(today);
  const newCount = state.words.filter(word => word.createdAt === today).length;
  const hardCount = state.words.filter(word => (word.wrongCount || 0) > 0).length;
  document.getElementById('todayDueCount').textContent = dueWords.length;
  document.getElementById('todayNewQuota').textContent = state.settings.dailyQuota;
  document.getElementById('hardWordCount').textContent = hardCount;
  document.getElementById('totalWordCount').textContent = state.words.length;

  document.getElementById('todayPlan').innerHTML = `
    <p>今天建议先完成 <strong>${dueWords.length}</strong> 个命中间隔日期的待复习单词。</p>
    <p>今天已录入新词 <strong>${newCount}</strong> / ${state.settings.dailyQuota}。</p>
    <p>${newCount < state.settings.dailyQuota ? `还可新增 <strong>${state.settings.dailyQuota - newCount}</strong> 个新词。` : '<span style="color:#059669">今日新词目标已达到。</span>'}</p>
  `;

  document.getElementById('batchSummary').innerHTML = batchSummary.map(item => `
    <p>${item.interval} 天前（${item.batchDate}）批次：<strong>${item.count}</strong> 个</p>
  `).join('') || '<p class="muted">暂无批次</p>';
}

function buildReviewQueue() {
  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    return state.words.filter(word => word.createdAt === reviewContext.sourceDate);
  }
  return getRemainingDueWordsForDate(todayStr());
}

function renderReview() {
  currentReviewQueue = buildReviewQueue();
  currentReviewIndex = 0;
  const banner = document.getElementById('reviewBanner');
  const title = document.getElementById('reviewSectionTitle');
  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    title.textContent = '该日批次复习';
    banner.textContent = `当前来自日历：${reviewContext.sourceDate} 批次。`;
    banner.classList.remove('hidden');
  } else {
    title.textContent = '口语友好复习模式';
    banner.classList.add('hidden');
    banner.textContent = '';
  }
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
    empty.textContent = currentReviewQueue.length === 0 ? '当前没有可复习内容。' : '本轮复习已完成。';
    empty.classList.remove('hidden');
    box.classList.add('hidden');
    renderDashboard();
    renderCalendar();
    renderLibrary();
    renderLog();
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
  const item = state.words.find(word => word.id === wordId);
  if (!item) return;
  const today = todayStr();
  const oldStage = item.stageIndex || 0;
  const maxStage = state.settings.intervals.length - 1;
  let newStage = oldStage;
  let nextDate = today;
  let wrongCount = item.wrongCount || 0;

  if (rating === 'Easy') {
    newStage = Math.min(oldStage + 2, maxStage);
    nextDate = addDays(today, state.settings.intervals[newStage]);
  } else if (rating === 'Good') {
    newStage = Math.min(oldStage + 1, maxStage);
    nextDate = addDays(today, state.settings.intervals[newStage]);
  } else if (rating === 'Hard') {
    newStage = oldStage;
    nextDate = addDays(today, 1);
    wrongCount += 1;
  } else {
    newStage = 0;
    nextDate = today;
    wrongCount += 1;
  }

  const shouldMarkReviewedToday = reviewContext.type === 'today' || (reviewContext.type === 'batch' && getBatchDatesForTargetDate(today, state.settings.intervals).includes(reviewContext.sourceDate));
  const reviewedOnDates = new Set(item.reviewedOnDates || []);
  if (shouldMarkReviewedToday) reviewedOnDates.add(today);

  Object.assign(item, {
    stageIndex: newStage,
    nextReviewDate: nextDate,
    wrongCount,
    lastReviewDate: today,
    reviewedOnDates: [...reviewedOnDates]
  });

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
  state.words.push(normalizeWord({
    id: uuid(),
    word: entry.word,
    meaning: entry.meaning,
    example: entry.example || '',
    tags: entry.tags || [],
    createdAt: entry.createdAt,
    nextReviewDate: entry.nextReviewDate || entry.createdAt,
    stageIndex: 0,
    wrongCount: 0,
    lastReviewDate: null,
    reviewedOnDates: []
  }));
  await saveState();
}

async function deleteWord(wordId) {
  state.words = state.words.filter(word => word.id !== wordId);
  await saveState();
  renderDashboard();
  renderLibrary();
  renderCalendar();
  showToast('已删除');
}

function renderWordList(container, words, emptyText) {
  if (words.length === 0) {
    container.innerHTML = `<div class="muted">${emptyText}</div>`;
    return;
  }
  container.innerHTML = words.map(word => `
    <div class="list-item">
      <div class="word-head">
        <div>
          <strong>${escapeHtml(word.word)}</strong>
          <div>${escapeHtml(word.meaning)}</div>
        </div>
        <div class="small muted">阶段 ${word.stageIndex || 0}<br>错词 ${word.wrongCount || 0}</div>
      </div>
      <div class="pills">${(word.tags || []).map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="small" style="margin-top:6px;">例句：${word.example ? escapeHtml(word.example) : '—'}</div>
      <div class="small muted" style="margin-top:6px;">录入：${word.createdAt} ｜ 下次复习：${word.nextReviewDate || '—'}</div>
      <div class="word-actions">
        <button class="btn small-btn" data-action="edit-word" data-id="${word.id}">编辑</button>
        <button class="btn small-btn danger-outline" data-action="delete-word" data-id="${word.id}">删除</button>
      </div>
    </div>
  `).join('');
}

function renderLibrary() {
  const container = document.getElementById('libraryList');
  const sorted = state.words.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderWordList(container, sorted, '词库为空');
}

function renderSelectedDatePanel() {
  const selectedDate = document.getElementById('selectedDateLabel').textContent;
  document.getElementById('selectedDateTitle').textContent = `${selectedDate} 录入的单词`;
  const words = state.words.filter(word => word.createdAt === selectedDate).sort((a, b) => a.word.localeCompare(b.word));
  renderWordList(document.getElementById('selectedDateWords'), words, '这一天当前没有录入单词，但你现在可以直接补录到这一天。');
}

function renderCalendar() {
  const title = document.getElementById('calendarTitle');
  const grid = document.getElementById('calendarGrid');
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  title.textContent = `${year} 年 ${month + 1} 月`;
  document.getElementById('selectedDateLabel').textContent = document.getElementById('selectedDateLabel').textContent || todayStr();

  const yearSelect = document.getElementById('calendarYearSelect');
  const monthSelect = document.getElementById('calendarMonthSelect');
  yearSelect.innerHTML = getYearOptions().map(y => `<option value="${y}">${y} 年</option>`).join('');
  yearSelect.value = String(year);
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1} 月</option>`).join('');
  monthSelect.value = String(month + 1);

  const firstDay = new Date(year, month, 1);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const selectedDate = document.getElementById('selectedDateLabel').textContent;

  let html = weekdayNames.map(name => `<div class="weekday">周${name}</div>`).join('');
  for (let i = 0; i < startWeekday; i++) html += `<div class="day" style="background:#f9fafb"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = formatDate(new Date(year, month, day));
    const created = state.words.filter(word => word.createdAt === ds).length;
    const due = getRemainingDueWordsForDate(ds).length;
    html += `
      <button class="day ${selectedDate === ds ? 'selected' : ''}" data-date="${ds}">
        <div class="date">${day}</div>
        <div class="small ${created > 0 ? '' : 'muted'}">新词: ${created}</div>
        <div class="small ${due > 0 ? '' : 'muted'}">复习: ${due}</div>
      </button>
    `;
  }
  grid.innerHTML = html;
  renderSelectedDatePanel();
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

function renderSettings() {
  document.getElementById('dailyQuotaSelect').value = String(state.settings.dailyQuota);
  document.getElementById('intervalInput').value = state.settings.intervals.join(',');
}

function switchTab(tabId) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(btn => btn.classList.remove('active'));
  const btn = document.querySelector(`.bottom-nav button[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  if (tabId === 'review') renderReview();
  if (tabId === 'calendarTab') renderCalendar();
  if (tabId === 'library') renderLibrary();
  if (tabId === 'log') renderLog();
  if (tabId === 'settings') renderSettings();
  if (tabId === 'dashboard') renderDashboard();
}

function openEditModal(wordId) {
  const word = state.words.find(item => item.id === wordId);
  if (!word) return;
  editingWordId = wordId;
  document.getElementById('editWordInput').value = word.word || '';
  document.getElementById('editMeaningInput').value = word.meaning || '';
  document.getElementById('editExampleInput').value = word.example || '';
  document.getElementById('editTagInput').value = (word.tags || []).join(', ');
  document.getElementById('editCreatedAtInput').value = word.createdAt || '';
  document.getElementById('editNextReviewDateInput').value = word.nextReviewDate || word.createdAt || '';
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  editingWordId = null;
  document.getElementById('editModal').classList.add('hidden');
}

async function saveEditWord() {
  const word = state.words.find(item => item.id === editingWordId);
  if (!word) return;
  word.word = document.getElementById('editWordInput').value.trim();
  word.meaning = document.getElementById('editMeaningInput').value.trim();
  word.example = document.getElementById('editExampleInput').value.trim();
  word.tags = document.getElementById('editTagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  word.createdAt = document.getElementById('editCreatedAtInput').value || word.createdAt;
  word.nextReviewDate = document.getElementById('editNextReviewDateInput').value || word.nextReviewDate;
  await saveState();
  closeEditModal();
  renderDashboard();
  renderLibrary();
  renderCalendar();
  showToast('已保存修改');
}

function setSelectedDate(dateStr) {
  document.getElementById('selectedDateLabel').textContent = dateStr;
  renderCalendar();
}

function resetReviewContextToToday() {
  reviewContext = { type: 'today' };
}

function initViews() {
  calendarCursor = new Date();
  document.getElementById('selectedDateLabel').textContent = todayStr();
  renderDashboard();
  renderReview();
  renderLibrary();
  renderLog();
  renderCalendar();
  renderSettings();
  switchTab('dashboard');
}

function bindEvents() {
  document.querySelectorAll('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'review') resetReviewContextToToday();
      switchTab(btn.dataset.tab);
    });
  });

  document.getElementById('addWordBtn').addEventListener('click', async () => {
    const word = document.getElementById('wordInput').value.trim();
    const meaning = document.getElementById('meaningInput').value.trim();
    const example = document.getElementById('exampleInput').value.trim();
    const tags = document.getElementById('tagInput').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!word || !meaning) return showToast('请填写单词和释义');
    await addWord({ word, meaning, example, tags, createdAt: todayStr(), nextReviewDate: todayStr() });
    document.getElementById('wordInput').value = '';
    document.getElementById('meaningInput').value = '';
    document.getElementById('exampleInput').value = '';
    document.getElementById('tagInput').value = '';
    renderDashboard();
    renderLibrary();
    renderCalendar();
    showToast('已添加到今天');
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
      await addWord({ word, meaning, example, tags, createdAt: todayStr(), nextReviewDate: todayStr() });
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

  document.getElementById('reviewSelectedBatchBtn').addEventListener('click', () => {
    const selectedDate = document.getElementById('selectedDateLabel').textContent;
    reviewContext = { type: 'batch', sourceDate: selectedDate };
    switchTab('review');
  });

  document.getElementById('addWordToSelectedDateBtn').addEventListener('click', async () => {
    const selectedDate = document.getElementById('selectedDateLabel').textContent;
    const word = document.getElementById('calendarWordInput').value.trim();
    const meaning = document.getElementById('calendarMeaningInput').value.trim();
    const example = document.getElementById('calendarExampleInput').value.trim();
    const tags = document.getElementById('calendarTagInput').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!word || !meaning) return showToast('请填写单词和释义');
    await addWord({ word, meaning, example, tags, createdAt: selectedDate, nextReviewDate: selectedDate });
    document.getElementById('calendarWordInput').value = '';
    document.getElementById('calendarMeaningInput').value = '';
    document.getElementById('calendarExampleInput').value = '';
    document.getElementById('calendarTagInput').value = '';
    renderDashboard();
    renderCalendar();
    renderLibrary();
    showToast('已添加到所选日期');
  });

  document.getElementById('calendarGrid').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-date]');
    if (!btn) return;
    setSelectedDate(btn.dataset.date);
  });

  document.getElementById('calendarYearSelect').addEventListener('change', (event) => {
    calendarCursor = new Date(Number(event.target.value), calendarCursor.getMonth(), 1);
    renderCalendar();
  });
  document.getElementById('calendarMonthSelect').addEventListener('change', (event) => {
    calendarCursor = new Date(calendarCursor.getFullYear(), Number(event.target.value) - 1, 1);
    renderCalendar();
  });
  document.getElementById('prevMonthBtn').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('nextMonthBtn').addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });

  document.getElementById('libraryList').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit-word') openEditModal(btn.dataset.id);
    if (btn.dataset.action === 'delete-word') await deleteWord(btn.dataset.id);
  });
  document.getElementById('selectedDateWords').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit-word') openEditModal(btn.dataset.id);
    if (btn.dataset.action === 'delete-word') await deleteWord(btn.dataset.id);
  });
  document.getElementById('saveEditBtn').addEventListener('click', saveEditWord);
  document.getElementById('cancelEditBtn').addEventListener('click', closeEditModal);
  document.getElementById('editBackdrop').addEventListener('click', closeEditModal);

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const dailyQuota = Number(document.getElementById('dailyQuotaSelect').value);
    const intervals = document.getElementById('intervalInput').value.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);
    if (intervals.length === 0) return showToast('复习间隔不能为空');
    state.settings.dailyQuota = dailyQuota;
    state.settings.intervals = intervals;
    await saveState();
    renderDashboard();
    renderCalendar();
    showToast('设置已保存');
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
        words: Array.isArray(parsed.words) ? parsed.words.map(normalizeWord) : [],
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

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }
}

(async function init() {
  db = await openDB();
  await loadState();
  bindEvents();
  initViews();
  registerSW();
})();
