const DB_NAME = 'word_recall_pwa_db';
const DB_VERSION = 2;
const STORE_APP = 'app';
const APP_STATE_KEY = 'state';
const APP_VERSION = 'v5.4.2';

const defaultState = {
  settings: {
    dailyQuota: 10,
    intervals: [0, 1, 3, 7, 14, 30],
  },
  words: [],
  wrongBook: [],
  logs: [],
};

let db;
let state = structuredClone(defaultState);
let editingWordId = null;
let calendarCursor = new Date();
let reviewContext = { type: 'today', sourceDate: null };
let reviewSession = null;
let wrongBookSession = null;
let settingsMessage = '';
let dataMessage = '';
let exportPreviewText = '';
let exportDownloadUrl = '';
let pendingImportState = null;
let pendingImportPreview = null;
let librarySearch = '';
let showWrongList = false;
let activeSwipeCard = null;

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

function getDaysInMonth(dateObj) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0).getDate();
}

function getBatchDatesForTargetDate(targetDate, intervals) {
  return [...new Set((intervals || []).map(interval => addDays(targetDate, -interval)))];
}

function chunk(arr, size) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function ratingRank(rating) {
  return { Easy: 0, Good: 1, Hard: 2, Again: 3 }[rating] ?? 99;
}

function worseRating(a, b) {
  if (!a) return b;
  if (!b) return a;
  return ratingRank(a) >= ratingRank(b) ? a : b;
}

function normalizeEnglish(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()\[\]{}'"“”‘’\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function canonicalWord(text) {
  return String(text || '').trim().toLowerCase();
}

function findDuplicateWord(wordText, excludeId = null) {
  const key = canonicalWord(wordText);
  if (!key) return null;
  return state.words.find(word => canonicalWord(word.word) === key && word.id !== excludeId) || null;
}

function getEnglishCheckResult(input, answer) {
  const normalizedInput = normalizeEnglish(input);
  const normalizedAnswer = normalizeEnglish(answer);
  if (!normalizedInput) return { checked: false, isCorrect: false, text: '尚未输入英文' };
  if (normalizedInput === normalizedAnswer) return { checked: true, isCorrect: true, text: '程序判断：拼写正确' };
  return { checked: true, isCorrect: false, text: `程序判断：不匹配（应为 ${answer}）` };
}


function normalizeIntervalsFromText(text) {
  const vals = String(text || '').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);
  return [...new Set(vals)].sort((a, b) => a - b);
}

function remapStageIndex(oldIntervals, newIntervals, oldStageIndex) {
  if (!newIntervals.length) return 0;
  const safeOldIndex = Math.max(0, Math.min(oldStageIndex || 0, oldIntervals.length - 1));
  const oldValue = oldIntervals[safeOldIndex] ?? newIntervals[0];
  const exactIndex = newIntervals.indexOf(oldValue);
  if (exactIndex >= 0) return exactIndex;
  let bestIndex = 0;
  let bestDiff = Infinity;
  newIntervals.forEach((value, index) => {
    const diff = Math.abs(value - oldValue);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function looksLikeMojibake(text) {
  const s = String(text || '');
  if (!s) return false;
  return /�/.test(s) || /(?:Ã.|Â.|å.|ä.|ç.|æ.|é.|è.|ö.|ü)/.test(s);
}

function sanitizeImportedState(parsed) {
  const raw = parsed || {};
  const rawSettings = raw.settings || {};
  const intervals = Array.isArray(rawSettings.intervals) && rawSettings.intervals.length
    ? rawSettings.intervals.map(Number).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
    : [0, 1, 3, 7, 14, 30];
  const dailyQuota = [5, 10].includes(Number(rawSettings.dailyQuota)) ? Number(rawSettings.dailyQuota) : 10;
  const words = Array.isArray(raw.words) ? raw.words.map(word => normalizeWord({
    ...word,
    example: String(word?.example || ''),
    tags: Array.isArray(word?.tags) ? word.tags.map(String) : [],
    stageIndex: remapStageIndex([0, 1, 3, 7, 14, 30], intervals, Number(word?.stageIndex || 0)),
  })) : [];
  const ids = new Set(words.map(word => word.id));
  const wrongBook = Array.isArray(raw.wrongBook)
    ? raw.wrongBook.filter(item => item && ids.has(String(item.wordId))).map(item => ({ wordId: String(item.wordId), errorCount: Math.max(1, Number(item.errorCount || 1)) }))
    : [];
  const logs = Array.isArray(raw.logs)
    ? raw.logs.map((log, i) => ({
        id: String(log?.id || `log_${i}_${Date.now()}`),
        ts: String(log?.ts || ''),
        word: String(log?.word || ''),
        source: String(log?.source || ''),
        pass: String(log?.pass || ''),
        rating: String(log?.rating || ''),
        addedToWrongBook: Boolean(log?.addedToWrongBook),
        inputValue: String(log?.inputValue || ''),
      }))
    : [];
  return { settings: { dailyQuota, intervals, batchSize: dailyQuota }, words, wrongBook, logs };
}

function getBatchSize() {
  return Number(state.settings?.dailyQuota) || 10;
}

function normalizeWord(word) {
  return {
    id: uuid(),
    word: '',
    meaning: '',
    example: '',
    tags: [],
    createdAt: todayStr(),
    stageIndex: 0,
    reviewedOnDates: [],
    lastReviewDate: null,
    lastFinalRating: null,
    ...word,
    tags: Array.isArray(word.tags) ? word.tags : [],
    reviewedOnDates: Array.isArray(word.reviewedOnDates) ? word.reviewedOnDates : [],
  };
}

function getYearOptions() {
  const years = new Set([new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]);
  state.words.forEach(word => {
    if (word.createdAt) years.add(Number(word.createdAt.slice(0, 4)));
  });
  return [...years].filter(Number.isFinite).sort((a, b) => a - b);
}

function getWrongBookMap() {
  return new Map((state.wrongBook || []).map(item => [item.wordId, item.errorCount]));
}

function getWrongBookIds() {
  return new Set((state.wrongBook || []).map(item => item.wordId));
}

function getWrongBookItems() {
  return (state.wrongBook || [])
    .map(item => {
      const word = state.words.find(w => w.id === item.wordId);
      return word ? { ...word, errorCount: item.errorCount } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.errorCount - a.errorCount) || a.word.localeCompare(b.word));
}

function getTodayDueWords(targetDate = todayStr()) {
  const batchDates = getBatchDatesForTargetDate(targetDate, state.settings.intervals);
  return state.words
    .filter(word => batchDates.includes(word.createdAt) && !(word.reviewedOnDates || []).includes(targetDate))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.word.localeCompare(b.word));
}

function getBatchSummary(targetDate = todayStr()) {
  return state.settings.intervals.map(interval => {
    const batchDate = addDays(targetDate, -interval);
    const count = state.words.filter(word => word.createdAt === batchDate && !(word.reviewedOnDates || []).includes(targetDate)).length;
    return { interval, batchDate, count };
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function loadState() {
  const saved = await dbGet(APP_STATE_KEY);
  state = saved ? sanitizeImportedState(saved) : structuredClone(defaultState);
}

async function saveState(nextState = state) {
  await dbSet(APP_STATE_KEY, nextState);
  state = nextState;
}

function resetNormalReviewSession() {
  reviewSession = null;
}

function resetWrongBookSession() {
  wrongBookSession = null;
}

function buildNormalQueue() {
  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    return state.words.filter(word => word.createdAt === reviewContext.sourceDate).sort((a, b) => a.word.localeCompare(b.word));
  }
  return getTodayDueWords(todayStr());
}

function getReviewContextKey() {
  return reviewContext.type === 'batch' && reviewContext.sourceDate ? `batch:${reviewContext.sourceDate}` : 'today';
}

function startNormalReviewSession() {
  const queue = buildNormalQueue();
  const baseBatches = chunk(queue.map(w => w.id), getBatchSize());
  reviewSession = {
    type: 'normal',
    contextKey: getReviewContextKey(),
    queueIds: queue.map(w => w.id),
    batchSize: getBatchSize(),
    batchIndex: 0,
    phase: 1,
    wordIndex: 0,
    showAnswer: false,
    inputValue: '',
    selectedRating: '',
    completed: false,
    roundRatings: {},
    batchOrders: {},
    autoAgainReady: false,
    currentPoolIds: baseBatches[0] || [],
    remedialRound: 0,
  };
}

function startWrongBookSession() {
  const queue = getWrongBookItems();
  wrongBookSession = {
    type: 'wrongbook',
    queueIds: queue.map(w => w.id),
    batchSize: getBatchSize(),
    phase: 1,
    batchIndex: 0,
    wordIndex: 0,
    showAnswer: false,
    inputValue: '',
    selectedRating: '',
    completed: false,
    roundCompleted: false,
    batchOrders: {},
    autoAgainReady: false,
  };
}

function ensureNormalReviewSession() {
  const contextKey = getReviewContextKey();
  if (!reviewSession || reviewSession.contextKey !== contextKey || reviewSession.batchSize !== getBatchSize()) {
    startNormalReviewSession();
    return;
  }
  if (reviewSession.completed && buildNormalQueue().length > 0) {
    startNormalReviewSession();
  }
}

function ensureWrongBookSession() {
  if (!wrongBookSession || wrongBookSession.batchSize !== getBatchSize()) {
    startWrongBookSession();
    return;
  }
  if ((wrongBookSession.completed || wrongBookSession.roundCompleted) && getWrongBookItems().length === 0) {
    startWrongBookSession();
  }
}

function getSessionBatch(session) {
  if (session.type === 'wrongbook') {
    const queue = session.queueIds.map(id => getWrongBookItems().find(word => word.id === id)).filter(Boolean);
    const batches = chunk(queue, session.batchSize);
    const baseBatch = batches[session.batchIndex] || [];
    const orderKey = `${session.phase}_${session.batchIndex}`;
    session.batchOrders = session.batchOrders || {};
    if (!session.batchOrders[orderKey]) {
      session.batchOrders[orderKey] = shuffleArray(baseBatch.map(word => word.id));
    }
    const batch = session.batchOrders[orderKey].map(id => baseBatch.find(word => word.id === id)).filter(Boolean);
    return { queue, batches, batch, item: batch[session.wordIndex] || null };
  }

  const queue = session.queueIds.map(id => state.words.find(word => word.id === id)).filter(Boolean);
  const baseBatches = chunk(queue.map(word => word.id), session.batchSize);
  if (!Array.isArray(session.currentPoolIds)) session.currentPoolIds = baseBatches[session.batchIndex] || [];
  const poolWords = session.currentPoolIds.map(id => state.words.find(word => word.id === id)).filter(Boolean);
  const orderKey = `${session.batchIndex}_${session.phase}_${session.remedialRound || 0}_${session.currentPoolIds.join('|')}`;
  session.batchOrders = session.batchOrders || {};
  if (!session.batchOrders[orderKey]) {
    session.batchOrders[orderKey] = shuffleArray(poolWords.map(word => word.id));
  }
  const batch = session.batchOrders[orderKey].map(id => poolWords.find(word => word.id === id)).filter(Boolean);
  return { queue, batches: baseBatches, batch, item: batch[session.wordIndex] || null, baseBatches };
}

function renderDashboard() {
  const today = todayStr();
  const dueWords = getTodayDueWords(today);
  const newCount = state.words.filter(word => word.createdAt === today).length;
  const batchSummary = getBatchSummary(today);
  document.getElementById('todayDueCount').textContent = dueWords.length;
  document.getElementById('todayNewQuota').textContent = state.settings.dailyQuota;
  document.getElementById('wrongWordCount').textContent = state.wrongBook.length;
  document.getElementById('totalWordCount').textContent = state.words.length;
  document.getElementById('todayPlan').innerHTML = `
    <p>今天建议先完成 <strong>${dueWords.length}</strong> 个命中间隔日期的待复习单词。</p>
    <p>今天已录入新词 <strong>${newCount}</strong> / ${state.settings.dailyQuota}。</p>
    <p>${newCount < state.settings.dailyQuota ? `还可新增 <strong>${state.settings.dailyQuota - newCount}</strong> 个新词。` : '<span style="color:#059669">今日新词目标已达到。</span>'}</p>
  `;
  document.getElementById('batchSummary').innerHTML = batchSummary.map(item => `<p>${item.interval} 天前（${item.batchDate}）批次：<strong>${item.count}</strong> 个</p>`).join('') || '<p class="muted">暂无批次</p>';
  document.getElementById('appVersionLine').textContent = `Version: ${APP_VERSION}`;
}


function renderReview() {
  ensureNormalReviewSession();
  const title = document.getElementById('reviewSectionTitle');
  const banner = document.getElementById('reviewBanner');
  const summary = document.getElementById('reviewSummary');
  const done = document.getElementById('reviewDone');
  const box = document.getElementById('reviewBox');

  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    title.textContent = `${reviewContext.sourceDate} 批次复习`;
    banner.textContent = `当前来自日历：${reviewContext.sourceDate} 批次。`;
    banner.classList.remove('hidden');
  } else {
    title.textContent = '普通复习';
    banner.classList.add('hidden');
    banner.textContent = '';
  }

  const session = reviewSession;
  const { queue, batches, batch, item } = getSessionBatch(session);

  if (session.completed) {
    done.textContent = '今日所有单词已复习完成。';
    done.classList.remove('hidden');
    box.classList.add('hidden');
    summary.classList.add('hidden');
    return;
  }

  done.classList.add('hidden');

  if (queue.length === 0 || !item) {
    box.classList.add('hidden');
    summary.classList.remove('hidden');
    summary.textContent = '当前没有可复习内容。';
    return;
  }

  box.classList.remove('hidden');
  summary.classList.remove('hidden');
  summary.textContent = `${session.remedialRound ? `补救复习第 ${session.remedialRound} 轮 · ` : ''}复习小批次 ${Math.min(session.batchIndex + 1, batches.length)}/${batches.length} · 第 ${session.phase} 轮 · ${Math.min(session.wordIndex + 1, batch.length)}/${batch.length}`;

  const modeText = document.getElementById('reviewModeText');
  const prompt = document.getElementById('reviewPrompt');
  const meta = document.getElementById('reviewMeta');
  const inputWrap = document.getElementById('reviewInputWrap');
  const input = document.getElementById('reviewInputEnglish');
  const answerBox = document.getElementById('answerBox');
  const ratingWrap = document.getElementById('ratingWrap');
  const answerWord = document.getElementById('answerWord');
  const answerMeaning = document.getElementById('answerMeaning');
  const answerExample = document.getElementById('answerExample');
  const echoRow = document.getElementById('reviewInputEchoRow');
  const attemptResult = document.getElementById('attemptResult');
  const autoJudge = document.getElementById('reviewAutoJudge');

  modeText.textContent = session.phase === 1 ? '第一轮：先看英文，心里回忆中文意思' : '第二轮：先看中文，输入英文拼写';
  prompt.textContent = session.phase === 1 ? item.word : item.meaning;
  meta.textContent = `标签：${(item.tags || []).join(' / ') || '无'} ｜ 词条ID：${item.id}`;
  inputWrap.classList.toggle('hidden', session.phase !== 2);
  if (session.phase === 2) input.value = session.inputValue;

  answerBox.classList.toggle('hidden', !session.showAnswer);
  ratingWrap.classList.toggle('hidden', !session.showAnswer);
  answerWord.textContent = item.word;
  answerMeaning.textContent = item.meaning;
  answerExample.textContent = item.example || '—';
  echoRow.classList.toggle('hidden', session.phase !== 2);
  attemptResult.textContent = session.inputValue || '未输入';
  autoJudge.textContent = '';
  autoJudge.className = 'judge-text';
  let check = null;
  if (session.phase === 2) {
    check = getEnglishCheckResult(session.inputValue, item.word);
    autoJudge.textContent = check.text;
    autoJudge.classList.add(check.checked ? (check.isCorrect ? 'judge-ok' : 'judge-bad') : '');
    if (session.showAnswer) session.autoAgainReady = !check.isCorrect;
  }

  const applyAgain = async () => {
    await finishNormalReviewStep('Again', true);
    await saveState();
    resetWrongBookSession();
    renderAll();
  };
  const applyPositive = async (rating) => {
    await finishNormalReviewStep(rating, false);
    await saveState();
    renderAll();
  };

  if (!session.showAnswer) {
    document.getElementById('showAnswerBtn').onclick = () => {
      session.showAnswer = true;
      session.inputValue = document.getElementById('reviewInputEnglish').value.trim();
      session.autoAgainReady = session.phase === 2 && !getEnglishCheckResult(session.inputValue, item.word).isCorrect;
      renderReview();
    };
    return;
  }

  if (session.phase === 1) {
    ratingWrap.innerHTML = `
      <div class="small muted">选择标签后会自动记录并进入下一题；Again 会自动加入错词本。</div>
      <div class="button-row wrap">
        <button class="btn easy" data-action="easy">Easy</button>
        <button class="btn good" data-action="good">Good</button>
        <button class="btn hard" data-action="hard">Hard</button>
        <button class="btn again" data-action="again">Again（自动加错词本）</button>
      </div>
    `;
    ratingWrap.querySelector('[data-action="easy"]').onclick = () => applyPositive('Easy');
    ratingWrap.querySelector('[data-action="good"]').onclick = () => applyPositive('Good');
    ratingWrap.querySelector('[data-action="hard"]').onclick = () => applyPositive('Hard');
    ratingWrap.querySelector('[data-action="again"]').onclick = () => applyAgain();
  } else if (session.autoAgainReady) {
    ratingWrap.innerHTML = `
      <div class="small" style="color:#be123c">已自动判定为 Again，并会自动加入错词本。</div>
      <div class="button-row wrap"><button class="btn again" data-action="autoAgain">已判 Again，下一题</button></div>
    `;
    ratingWrap.querySelector('[data-action="autoAgain"]').onclick = () => applyAgain();
  } else {
    ratingWrap.innerHTML = `
      <div class="small muted">输入正确后，选择一个正确标签，会自动记录并进入下一题。</div>
      <div class="button-row wrap">
        <button class="btn easy" data-action="easy">Easy</button>
        <button class="btn good" data-action="good">Good</button>
        <button class="btn hard" data-action="hard">Hard</button>
      </div>
    `;
    ratingWrap.querySelector('[data-action="easy"]').onclick = () => applyPositive('Easy');
    ratingWrap.querySelector('[data-action="good"]').onclick = () => applyPositive('Good');
    ratingWrap.querySelector('[data-action="hard"]').onclick = () => applyPositive('Hard');
  }
}

async function finishNormalReviewStep(rating, addToWrongBook) {
  const session = reviewSession;
  const { batches, batch, item, baseBatches } = getSessionBatch(session);
  if (!item || !rating) return;
  const key = item.id;
  const prev = session.roundRatings[key] || {};
  if (session.phase === 1) prev.phase1 = rating;
  if (session.phase === 2) prev.phase2 = rating;
  session.roundRatings[key] = prev;

  state.logs.unshift({
    id: uuid(),
    ts: new Date().toLocaleString('zh-CN'),
    word: item.word,
    source: reviewContext.type === 'batch' ? '日历批次复习' : '普通复习',
    pass: session.phase === 1 ? '英→中' : '中→英',
    rating,
    addedToWrongBook: addToWrongBook,
    inputValue: session.inputValue,
  });

  if (addToWrongBook) adjustWrongBookCount(item.id, 1);

  const isLastWordInBatch = session.wordIndex >= batch.length - 1;
  session.showAnswer = false;
  session.autoAgainReady = false;
  session.inputValue = '';

  if (!isLastWordInBatch) {
    session.wordIndex += 1;
    return;
  }

  if (session.phase === 1) {
    session.phase = 2;
    session.wordIndex = 0;
    return;
  }

  const shouldMark = reviewContext.type === 'today' || (reviewContext.type === 'batch' && getBatchDatesForTargetDate(todayStr(), state.settings.intervals).includes(reviewContext.sourceDate));
  const failedIds = [];

  (session.currentPoolIds || []).forEach((id) => {
    const result = session.roundRatings[id] || {};
    const word = state.words.find((w) => w.id === id);
    if (!word) return;
    const hadAgain = result.phase1 === 'Again' || result.phase2 === 'Again';
    const finalRating = worseRating(result.phase1, result.phase2);
    word.lastReviewDate = todayStr();
    word.lastFinalRating = finalRating || word.lastFinalRating;
    if (hadAgain) {
      failedIds.push(id);
    } else if (shouldMark) {
      const reviewedOn = new Set(word.reviewedOnDates || []);
      reviewedOn.add(todayStr());
      word.reviewedOnDates = [...reviewedOn];
    }
  });

  session.batchOrders = {};
  session.roundRatings = {};
  session.wordIndex = 0;

  if (failedIds.length) {
    session.currentPoolIds = failedIds;
    session.remedialRound = (session.remedialRound || 0) + 1;
    session.phase = 1;
    return;
  }

  const isLastBatch = session.batchIndex >= baseBatches.length - 1;
  if (!isLastBatch) {
    session.batchIndex += 1;
    session.currentPoolIds = baseBatches[session.batchIndex] || [];
    session.remedialRound = 0;
    session.phase = 1;
  } else {
    session.completed = true;
  }
}

function renderWrongBook() {
  const list = getWrongBookItems();
  renderWrongBookList(list);
  ensureWrongBookSession();
  const done = document.getElementById('wrongbookDone');
  const roundDone = document.getElementById('wrongbookRoundDone');
  const box = document.getElementById('wrongbookReviewBox');
  const session = wrongBookSession;

  if (list.length === 0) {
    done.textContent = '错词本已清空，当前没有需要复习的错词。';
    done.classList.remove('hidden');
    roundDone.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  done.classList.add('hidden');

  if (session.roundCompleted) {
    roundDone.classList.remove('hidden');
    roundDone.innerHTML = `本轮错词复习已完成，错词本仍剩 <strong>${list.length}</strong> 个词。<div class="button-row"><button class="btn" id="restartWrongbookRoundBtn">继续下一轮错词复习</button></div>`;
    box.innerHTML = '';
    document.getElementById('restartWrongbookRoundBtn').onclick = () => {
      startWrongBookSession();
      renderWrongBook();
    };
    return;
  }

  roundDone.classList.add('hidden');

  const { queue, batches, batch, item } = getSessionBatch(session);
  if (queue.length === 0 || !item) {
    box.innerHTML = '<div class="muted">当前没有需要复习的错词。</div>';
    return;
  }

  const check = session.phase === 2 ? getEnglishCheckResult(session.inputValue, item.word) : null;
  if (session.phase === 2 && session.showAnswer) session.autoAgainReady = !check.isCorrect;
  const errorCount = Number(item.errorCount ?? 1) || 1;
  box.innerHTML = `
    <div class="summary-pill">复习小批次 ${Math.min(session.batchIndex + 1, batches.length)}/${batches.length} · 第 ${session.phase} 轮 · ${Math.min(session.wordIndex + 1, batch.length)}/${batch.length}</div>
    <p class="muted">${session.phase === 1 ? '第一轮：英文 → 中文' : '第二轮：中文 → 英文'}</p>
    <div class="prompt">${escapeHtml(session.phase === 1 ? item.word : item.meaning)}</div>
    ${session.phase === 2 ? `<label for="wrongbookInputEnglish">输入你回忆出的英文</label><input id="wrongbookInputEnglish" value="${escapeHtml(session.inputValue)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" data-gramm="false" />` : ''}
    ${!session.showAnswer ? `<div class="button-row"><button class="btn primary" id="wrongbookShowAnswerBtn">显示答案</button></div>` : `
      <div class="answer-box">
        <p><strong>答案：</strong>${escapeHtml(item.word)}</p>
        <p><strong>释义：</strong>${escapeHtml(item.meaning)}</p>
        <p><strong>当前错词次数：</strong>${errorCount}</p>
        ${session.phase === 2 ? `<p><strong>你的拼写：</strong>${escapeHtml(session.inputValue || '未输入')}</p><p class="judge-text ${check.checked ? (check.isCorrect ? 'judge-ok' : 'judge-bad') : ''}">${escapeHtml(check.text)}</p>` : ''}
      </div>
      <div class="small muted">Easy / Good / Hard 视为答对，错误次数 -1；Again 视为答错，错误次数 +1。</div>
      <div id="wrongbookActions"></div>
    `}
  `;

  if (session.phase === 2) {
    document.getElementById('wrongbookInputEnglish').oninput = (e) => {
      session.inputValue = e.target.value;
      if (session.showAnswer) renderWrongBook();
    };
  }

  if (!session.showAnswer) {
    document.getElementById('wrongbookShowAnswerBtn').onclick = () => {
      session.showAnswer = true;
      session.autoAgainReady = session.phase === 2 && !getEnglishCheckResult(session.inputValue, item.word).isCorrect;
      renderWrongBook();
    };
    return;
  }

  const actions = document.getElementById('wrongbookActions');
  const submit = async (delta, rating) => {
    await finishWrongBookReviewStep(delta, rating);
    await saveState();
    renderAll();
  };

  if (session.phase === 1) {
    actions.innerHTML = `
      <div class="button-row wrap">
        <button class="btn easy" data-action="easy">Easy</button>
        <button class="btn good" data-action="good">Good</button>
        <button class="btn hard" data-action="hard">Hard</button>
        <button class="btn again" data-action="again">Again</button>
      </div>
    `;
    actions.querySelector('[data-action="easy"]').onclick = () => submit(-1, 'Easy');
    actions.querySelector('[data-action="good"]').onclick = () => submit(-1, 'Good');
    actions.querySelector('[data-action="hard"]').onclick = () => submit(-1, 'Hard');
    actions.querySelector('[data-action="again"]').onclick = () => submit(1, 'Again');
  } else if (session.autoAgainReady) {
    actions.innerHTML = `
      <div class="small" style="color:#be123c">已自动判定为 Again。</div>
      <div class="button-row wrap"><button class="btn again" data-action="autoAgain">已判 Again，下一题</button></div>
    `;
    actions.querySelector('[data-action="autoAgain"]').onclick = () => submit(1, 'Again');
  } else {
    actions.innerHTML = `
      <div class="small muted">输入正确后，选择一个正确标签，会自动记录并进入下一题。</div>
      <div class="button-row wrap">
        <button class="btn easy" data-action="easy">Easy</button>
        <button class="btn good" data-action="good">Good</button>
        <button class="btn hard" data-action="hard">Hard</button>
      </div>
    `;
    actions.querySelector('[data-action="easy"]').onclick = () => submit(-1, 'Easy');
    actions.querySelector('[data-action="good"]').onclick = () => submit(-1, 'Good');
    actions.querySelector('[data-action="hard"]').onclick = () => submit(-1, 'Hard');
  }
}

async function finishWrongBookReviewStep(delta, rating) {
  const session = wrongBookSession;
  const { batches, batch, item } = getSessionBatch(session);
  if (!item || !rating) return;
  adjustWrongBookCount(item.id, delta);
  state.logs.unshift({
    id: uuid(),
    ts: new Date().toLocaleString('zh-CN'),
    word: item.word,
    source: '错词本复习',
    pass: session.phase === 1 ? '英→中' : '中→英',
    rating,
    addedToWrongBook: false,
    inputValue: session.inputValue,
  });
  const isLastWordInBatch = session.wordIndex >= batch.length - 1;
  const isLastBatch = session.batchIndex >= batches.length - 1;
  session.showAnswer = false;
  session.autoAgainReady = false;
  session.inputValue = '';
  if (!isLastWordInBatch) {
    session.wordIndex += 1;
  } else if (session.phase === 1) {
    session.phase = 2;
    session.wordIndex = 0;
  } else if (!isLastBatch) {
    session.batchIndex += 1;
    session.phase = 1;
    session.wordIndex = 0;
  } else {
    session.roundCompleted = true;
  }
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  document.getElementById('calendarTitle').textContent = `${year} 年 ${month + 1} 月`;
  document.getElementById('selectedDateLabel').textContent = selectedDate;
  document.getElementById('selectedDateTitle').textContent = `${selectedDate} 录入的单词`;

  const yearSelect = document.getElementById('calendarYearSelect');
  const monthSelect = document.getElementById('calendarMonthSelect');
  yearSelect.innerHTML = getYearOptions().map(y => `<option value="${y}">${y} 年</option>`).join('');
  yearSelect.value = String(year);
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1} 月</option>`).join('');
  monthSelect.value = String(month + 1);

  const daysInMonth = getDaysInMonth(calendarCursor);
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map(label => `<div class="weekday">周${label}</div>`).join('');

  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7;
  for (let i = 0; i < startWeekday; i++) {
    grid.insertAdjacentHTML('beforeend', '<div class="day" style="background:#f9fafb"></div>');
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = formatDate(new Date(year, month, day));
    const created = state.words.filter(word => word.createdAt === ds).length;
    const due = state.words.filter(word => getBatchDatesForTargetDate(ds, state.settings.intervals).includes(word.createdAt)).length;
    grid.insertAdjacentHTML('beforeend', `
      <button class="day ${selectedDate === ds ? 'selected' : ''}" data-date="${ds}">
        <div class="date">${day}</div>
        <div class="small">新词: ${created}</div>
        <div class="small">复习: ${due}</div>
      </button>
    `);
  }

  grid.querySelectorAll('.day[data-date]').forEach(btn => {
    btn.onclick = () => {
      selectedDate = btn.dataset.date;
      renderCalendar();
      renderSelectedDateWords();
    };
  });

  renderSelectedDateWords();
}

function renderSelectedDateWords() {
  const container = document.getElementById('selectedDateWords');
  const words = state.words.filter(word => word.createdAt === selectedDate).sort((a, b) => a.word.localeCompare(b.word));
  if (words.length === 0) {
    container.innerHTML = '<div class="list-item muted">这一天当前没有录入单词，但你现在可以直接补录到这一天。</div>';
    return;
  }
  container.innerHTML = words.map(word => renderWordCardHtml(word, '', { swipeable: true })).join('');
  attachWordCardEvents(container);
}

function renderWordCardHtml(word, extraHtml = '', options = {}) {
  const wrongCount = getWrongBookMap().get(word.id) ?? word.errorCount;
  const editable = options.editable !== false;
  const deletable = options.deletable !== false;
  const swipeable = Boolean(options.swipeable && (editable || deletable));
  const bodyHtml = `
      <div class="word-head">
        <div>
          <strong>${escapeHtml(word.word)}</strong>
          <div>${escapeHtml(word.meaning)}</div>
        </div>
        <div class="small muted">阶段 ${word.stageIndex || 0}（${state.settings.intervals[word.stageIndex || 0] ?? state.settings.intervals[0]} 天）</div>
      </div>
      <div style="margin-top:8px;">${escapeHtml(word.example || '—')}</div>
      <div class="pills">${(word.tags || []).map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="small muted" style="margin-top:8px;">录入：${word.createdAt}${wrongCount ? ` · 错词次数：${wrongCount}` : ''}${extraHtml}</div>
      ${(!swipeable && (editable || deletable)) ? `<div class="word-actions">${editable ? '<button class="btn" data-action="edit">编辑</button>' : ''}${deletable ? '<button class="btn danger-outline" data-action="delete">删除</button>' : ''}</div>` : ''}
    `;

  if (swipeable) {
    return `
      <div class="swipe-card" data-word-id="${word.id}">
        <div class="swipe-actions">
          ${editable ? '<button class="swipe-btn swipe-edit" data-action="edit">编辑</button>' : ''}
          ${deletable ? '<button class="swipe-btn swipe-delete" data-action="delete">删除</button>' : ''}
        </div>
        <div class="list-item swipe-content">${bodyHtml}</div>
      </div>
    `;
  }

  return `<div class="list-item" data-word-id="${word.id}">${bodyHtml}</div>`;
}

function attachSwipeWordCards(container) {
  const cards = container.querySelectorAll('.swipe-card');
  cards.forEach((card) => {
    const content = card.querySelector('.swipe-content');
    if (!content) return;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const closeOther = () => {
      if (activeSwipeCard && activeSwipeCard !== card) activeSwipeCard.classList.remove('swiped');
    };

    content.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      dragging = true;
      closeOther();
    }, { passive: true });

    content.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (dx < -36) {
        card.classList.add('swiped');
        activeSwipeCard = card;
      } else if (dx > 24) {
        card.classList.remove('swiped');
        if (activeSwipeCard === card) activeSwipeCard = null;
      }
    }, { passive: true });

    content.addEventListener('click', (e) => {
      if (card.classList.contains('swiped')) {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('swiped');
        if (activeSwipeCard === card) activeSwipeCard = null;
      }
    });
  });
}

function attachWordCardEvents(container) {
  container.querySelectorAll('[data-word-id]').forEach(card => {
    const id = card.dataset.wordId;
    const word = state.words.find(w => w.id === id);
    if (!word) return;
    const editBtn = card.querySelector('[data-action="edit"]');
    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); activeSwipeCard = null; openEditModal(word.id); };
    if (deleteBtn) deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除这个单词吗？')) return;
      state.words = state.words.filter(w => w.id !== id);
      state.wrongBook = state.wrongBook.filter(item => item.wordId !== id);
      await saveState();
      resetNormalReviewSession();
      resetWrongBookSession();
      renderAll();
    };
  });
  attachSwipeWordCards(container);
}

function renderLibrary() {
  const container = document.getElementById('libraryList');
  const countEl = document.getElementById('librarySearchCount');
  const inputEl = document.getElementById('librarySearchInput');
  if (inputEl) inputEl.value = librarySearch;
  const q = librarySearch.trim().toLowerCase();
  let words = [...state.words].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.word.localeCompare(b.word));
  if (q) {
    words = words.filter(word => [word.word, word.meaning, word.example, ...(word.tags || [])].some(value => String(value || '').toLowerCase().includes(q)));
    countEl.textContent = `当前匹配词条：${words.length}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.textContent = '';
    countEl.classList.add('hidden');
  }
  container.innerHTML = words.length ? words.map(word => renderWordCardHtml(word, '', { swipeable: true })).join('') : '<div class="muted">未找到匹配词条。</div>';
  attachWordCardEvents(container);
}

function renderWrongBookList(items = getWrongBookItems()) {
  const card = document.getElementById('wrongbookListCard');
  const container = document.getElementById('wrongbookList');
  const toggleBtn = document.getElementById('wrongbookListToggleBtn');
  if (!items.length) {
    if (card) card.classList.add('hidden');
    return;
  }
  if (card) card.classList.remove('hidden');
  toggleBtn.textContent = showWrongList ? '收起错词列表' : '展开错词列表';
  if (!showWrongList) {
    container.innerHTML = '<div class="muted">错词列表已隐藏。你可以先完成上方错词复习，再按需要展开查看。</div>';
    return;
  }
  container.innerHTML = items.map(word => renderWordCardHtml(word, '', { editable: false, deletable: false })).join('');
}


function renderLog() {
  const container = document.getElementById('logList');
  container.innerHTML = state.logs.length ? state.logs.slice(0, 200).map(log => `
    <div class="list-item">
      <div class="word-head"><strong>${escapeHtml(log.word)}</strong><div>${escapeHtml(log.rating || '')}</div></div>
      <div class="small muted">${escapeHtml(log.ts || '')}</div>
      <div class="small">来源：${escapeHtml(log.source || '')} ｜ 回忆方向：${escapeHtml(log.pass || '')}</div>
      <div class="small">加入错词本：${log.addedToWrongBook ? '是' : '否'}</div>
      ${log.inputValue ? `<div class="small">输入：${escapeHtml(log.inputValue)}</div>` : ''}
    </div>
  `).join('') : '<div class="muted">暂无记录。</div>';
}

function renderSettings() {
  document.getElementById('dailyQuotaSelect').value = String(state.settings.dailyQuota);
  document.getElementById('intervalInput').value = state.settings.intervals.join(',');

  const settingsMsgEl = document.getElementById('settingsMsg');
  if (settingsMessage) {
    settingsMsgEl.textContent = settingsMessage;
    settingsMsgEl.classList.remove('hidden');
  } else {
    settingsMsgEl.classList.add('hidden');
    settingsMsgEl.textContent = '';
  }

  const dataMsgEl = document.getElementById('dataMsg');
  if (dataMessage) {
    dataMsgEl.textContent = dataMessage;
    dataMsgEl.classList.remove('hidden');
  } else {
    dataMsgEl.classList.add('hidden');
    dataMsgEl.textContent = '';
  }

  const againBtn = document.getElementById('downloadAgainBtn');
  if (exportDownloadUrl) {
    againBtn.href = exportDownloadUrl;
    againBtn.download = `word_recall_backup_${todayStr()}.json`;
    againBtn.classList.remove('hidden');
  } else {
    againBtn.classList.add('hidden');
    againBtn.removeAttribute('href');
  }

  const importBox = document.getElementById('importPreviewBox');
  if (pendingImportPreview) {
    importBox.classList.remove('hidden');
    importBox.innerHTML = `
      <div class="card" style="margin-top:12px;border-color:#f59e0b;background:#fffbeb;">
        <div class="section-subtitle" style="color:#92400e;">导入前预检结果</div>
        <div class="small" style="color:#78350f;line-height:1.8;">
          <div>文件名：${escapeHtml(pendingImportPreview.fileName)}</div>
          <div>单词数：${pendingImportPreview.wordCount}</div>
          <div>错词本数：${pendingImportPreview.wrongBookCount}</div>
          <div>记录数：${pendingImportPreview.logCount}</div>
          <div>设置存在：${pendingImportPreview.hasSettings ? '是' : '否'}</div>
          <div>复习间隔：${escapeHtml(pendingImportPreview.intervals)}</div>
          <div>每日新学词数：${escapeHtml(String(pendingImportPreview.dailyQuota))}</div>
          <div>疑似乱码词条数：${pendingImportPreview.suspiciousCount}</div>
        </div>
        <div class="answer-box" style="margin-top:12px;">
          <div class="section-subtitle">词条抽样预览</div>
          <div class="small" style="margin-top:8px;line-height:1.8;">${pendingImportPreview.sampleWords.length ? pendingImportPreview.sampleWords.map(item => `<div><strong>${escapeHtml(item.word || '（空）')}</strong> — ${escapeHtml(item.meaning || '（空）')}</div>`).join('') : '<div>没有检测到词条样本。</div>'}</div>
        </div>
        <div class="button-row wrap">
          <button class="btn primary" id="confirmImportBtn">确认导入并覆盖</button>
          <button class="btn" id="cancelImportBtn">取消导入</button>
        </div>
      </div>`;
    document.getElementById('confirmImportBtn').onclick = async () => {
      if (!pendingImportState) return;
      state = sanitizeImportedState(pendingImportState);
      pendingImportState = null;
      pendingImportPreview = null;
      exportPreviewText = '';
      await saveState();
      resetNormalReviewSession();
      resetWrongBookSession();
      calendarCursor = new Date();
      selectedDate = todayStr();
      reviewContext = { type: 'today', sourceDate: null };
      dataMessage = 'JSON 已导入，当前本地数据已覆盖。';
      renderAll();
      showToast('导入成功');
    };
    document.getElementById('cancelImportBtn').onclick = () => {
      pendingImportState = null;
      pendingImportPreview = null;
      dataMessage = '已取消导入，当前本地数据未被覆盖。';
      renderSettings();
    };
  } else {
    importBox.classList.add('hidden');
    importBox.innerHTML = '';
  }

  const exportBox = document.getElementById('exportPreviewBox');
  if (exportPreviewText) {
    exportBox.classList.remove('hidden');
    exportBox.innerHTML = `<div class="card" style="margin-top:12px;"><div class="section-subtitle">导出 JSON 内容预览</div><pre style="max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;">${escapeHtml(exportPreviewText)}</pre></div>`;
  } else {
    exportBox.classList.add('hidden');
    exportBox.innerHTML = '';
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  if (tabId === 'review') renderReview();
  if (tabId === 'calendarTab') renderCalendar();
  if (tabId === 'library') renderLibrary();
  if (tabId === 'wrongbook') renderWrongBook();
  if (tabId === 'log') renderLog();
  if (tabId === 'settings') renderSettings();
}

function renderAll() {
  renderDashboard();
  renderReview();
  renderCalendar();
  renderLibrary();
  renderWrongBook();
  renderLog();
  renderSettings();
}

function openEditModal(wordId) {
  editingWordId = wordId;
  const word = state.words.find(w => w.id === wordId);
  if (!word) return;
  document.getElementById('editWordInput').value = word.word || '';
  document.getElementById('editMeaningInput').value = word.meaning || '';
  document.getElementById('editExampleInput').value = word.example || '';
  document.getElementById('editTagInput').value = (word.tags || []).join(', ');
  document.getElementById('editCreatedAtInput').value = word.createdAt || todayStr();
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  editingWordId = null;
  document.getElementById('editModal').classList.add('hidden');
}

async function saveEditModal() {
  const word = state.words.find(w => w.id === editingWordId);
  if (!word) return;
  const nextWord = document.getElementById('editWordInput').value.trim();
  const duplicate = findDuplicateWord(nextWord, word.id);
  if (duplicate) {
    showToast(`该单词已在词库中，未保存重复词条（${duplicate.word}）`);
    return;
  }
  const nextState = structuredClone(state);
  const target = nextState.words.find(w => w.id === editingWordId);
  if (!target) return;
  target.word = nextWord;
  target.meaning = document.getElementById('editMeaningInput').value.trim();
  target.example = document.getElementById('editExampleInput').value.trim();
  target.tags = document.getElementById('editTagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  target.createdAt = document.getElementById('editCreatedAtInput').value || todayStr();
  try {
    await saveState(nextState);
  } catch (error) {
    console.error(error);
    showToast('保存失败，请重试');
    return;
  }
  closeEditModal();
  resetNormalReviewSession();
  resetWrongBookSession();
  renderAll();
  showToast('已保存修改');
}

function adjustWrongBookCount(wordId, delta) {
  const existing = state.wrongBook.find(item => item.wordId === wordId);
  if (!existing) {
    if (delta > 0) state.wrongBook.push({ wordId, errorCount: delta });
    return;
  }
  existing.errorCount += delta;
  if (existing.errorCount <= 0) {
    state.wrongBook = state.wrongBook.filter(item => item.wordId !== wordId);
  }
}

async function addWord(entry) {
  const duplicate = findDuplicateWord(entry.word);
  if (duplicate) return { ok: false, duplicate };
  const nextState = structuredClone(state);
  nextState.words.push(normalizeWord({ id: uuid(), ...entry }));
  try {
    await saveState(nextState);
  } catch (error) {
    console.error(error);
    return { ok: false, saveFailed: true };
  }
  resetNormalReviewSession();
  resetWrongBookSession();
  renderAll();
  return { ok: true };
}

async function handleAddTodayWord() {
  const word = document.getElementById('wordInput').value.trim();
  const meaning = document.getElementById('meaningInput').value.trim();
  const example = document.getElementById('exampleInput').value.trim();
  const tags = document.getElementById('tagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!word || !meaning) return showToast('请填写单词和释义');
  const result = await addWord({ word, meaning, example, tags, createdAt: todayStr(), stageIndex: 0 });
  if (!result?.ok) return showToast(result.saveFailed ? '保存失败，请重试' : `该单词已在词库中，未重复录入（${result.duplicate.word}）`);
  document.getElementById('wordInput').value = '';
  document.getElementById('meaningInput').value = '';
  document.getElementById('exampleInput').value = '';
  document.getElementById('tagInput').value = '';
  showToast('已添加到今天');
}

async function handleAddWordToSelectedDate() {
  const word = document.getElementById('calendarWordInput').value.trim();
  const meaning = document.getElementById('calendarMeaningInput').value.trim();
  const example = document.getElementById('calendarExampleInput').value.trim();
  const tags = document.getElementById('calendarTagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!word || !meaning) return showToast('请填写单词和释义');
  const result = await addWord({ word, meaning, example, tags, createdAt: selectedDate, stageIndex: 0 });
  if (!result?.ok) return showToast(result.saveFailed ? '保存失败，请重试' : `该单词已在词库中，未重复录入（${result.duplicate.word}）`);
  document.getElementById('calendarWordInput').value = '';
  document.getElementById('calendarMeaningInput').value = '';
  document.getElementById('calendarExampleInput').value = '';
  document.getElementById('calendarTagInput').value = '';
  showToast(`已添加到 ${selectedDate}`);
}

function bindEvents() {
  document.querySelectorAll('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('addWordBtn').addEventListener('click', handleAddTodayWord);
  document.getElementById('addBatchDemoBtn').addEventListener('click', async () => {
    const demo = [
      ['negotiate', '谈判；协商', 'We need to negotiate a better price.', ['工作', '口语']],
      ['commute', '通勤', 'My commute takes about forty minutes.', ['口语']],
      ['itinerary', '行程安排', 'I shared the itinerary with the team.', ['旅行', '工作']],
      ['hesitate', '犹豫', 'Don’t hesitate to ask questions.', ['口语']],
      ['accurate', '准确的', 'Your pronunciation is quite accurate.', ['口语']],
    ];
    let added = 0;
    let skipped = 0;
    for (const [word, meaning, example, tags] of demo) {
      if (findDuplicateWord(word)) {
        skipped += 1;
        continue;
      }
      state.words.push(normalizeWord({ id: uuid(), word, meaning, example, tags, createdAt: todayStr(), stageIndex: 0 }));
      added += 1;
    }
    await saveState();
    resetNormalReviewSession();
    resetWrongBookSession();
    renderAll();
    showToast(skipped ? `已导入 ${added} 个示例，跳过 ${skipped} 个重复单词` : `已导入 ${added} 个示例`);
  });
  document.getElementById('addWordToSelectedDateBtn').addEventListener('click', handleAddWordToSelectedDate);

  document.getElementById('librarySearchInput').addEventListener('input', (e) => {
    librarySearch = e.target.value || '';
    renderLibrary();
  });
  document.getElementById('librarySearchClearBtn').addEventListener('click', () => {
    librarySearch = '';
    document.getElementById('librarySearchInput').value = '';
    renderLibrary();
  });

  document.getElementById('wrongbookListToggleBtn').addEventListener('click', () => {
    showWrongList = !showWrongList;
    renderWrongBookList();
  });

  document.getElementById('reviewSelectedBatchBtn').addEventListener('click', () => {
    reviewContext = { type: 'batch', sourceDate: selectedDate };
    resetNormalReviewSession();
    switchTab('review');
  });

  document.getElementById('showAnswerBtn').addEventListener('click', () => {
    ensureNormalReviewSession();
    reviewSession.showAnswer = true;
    reviewSession.inputValue = document.getElementById('reviewInputEnglish').value.trim();
    reviewSession.autoAgainReady = reviewSession.phase === 2 && !getEnglishCheckResult(reviewSession.inputValue, getSessionBatch(reviewSession).item.word).isCorrect;
    renderReview();
  });
  document.getElementById('skipBtn').addEventListener('click', () => {
    ensureNormalReviewSession();
    const session = reviewSession;
    const { batches, batch } = getSessionBatch(session);
    const isLastWordInBatch = session.wordIndex >= batch.length - 1;
    const isLastBatch = session.batchIndex >= batches.length - 1;
    session.showAnswer = false;
    session.inputValue = '';
    session.autoAgainReady = false;
    if (!isLastWordInBatch) session.wordIndex += 1;
    else if (session.phase === 1) { session.phase = 2; session.wordIndex = 0; }
    else if (!isLastBatch) { session.batchIndex += 1; session.phase = 1; session.wordIndex = 0; }
    else session.completed = true;
    renderReview();
  });
  document.getElementById('reviewInputEnglish').addEventListener('input', (e) => {
    ensureNormalReviewSession();
    reviewSession.inputValue = e.target.value;
    if (reviewSession.showAnswer) renderReview();
  });

  document.getElementById('calendarYearSelect').addEventListener('change', (e) => {
    calendarCursor = new Date(Number(e.target.value), calendarCursor.getMonth(), 1);
    renderCalendar();
  });
  document.getElementById('calendarMonthSelect').addEventListener('change', (e) => {
    calendarCursor = new Date(calendarCursor.getFullYear(), Number(e.target.value) - 1, 1);
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

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const dailyQuota = Number(document.getElementById('dailyQuotaSelect').value);
    const nextIntervals = normalizeIntervalsFromText(document.getElementById('intervalInput').value);
    if (!nextIntervals.length) {
      settingsMessage = '复习间隔不能为空。';
      renderSettings();
      return showToast('复习间隔不能为空');
    }
    const oldIntervals = state.settings.intervals;
    state.settings.dailyQuota = dailyQuota;
    state.settings.batchSize = dailyQuota;
    state.settings.intervals = nextIntervals;
    state.words = state.words.map(word => ({ ...word, stageIndex: remapStageIndex(oldIntervals, nextIntervals, word.stageIndex || 0) }));
    settingsMessage = `已保存复习间隔：${nextIntervals.join(', ')}`;
    await saveState();
    resetNormalReviewSession();
    resetWrongBookSession();
    renderAll();
    showToast('设置已保存');
  });
  document.getElementById('exportBtn').addEventListener('click', () => {
    const jsonText = JSON.stringify(state, null, 2);
    exportPreviewText = jsonText;
    const blob = new Blob(['﻿' + jsonText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    if (exportDownloadUrl) URL.revokeObjectURL(exportDownloadUrl);
    exportDownloadUrl = url;
    const a = document.createElement('a');
    a.href = url;
    a.download = `word_recall_backup_${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    dataMessage = '已生成 JSON 下载。若没有自动下载，请点击下方“再次下载 JSON”，或先用“显示导出 JSON 内容”检查数据。';
    renderSettings();
    showToast('已生成导出数据');
  });
  document.getElementById('showExportBtn').addEventListener('click', () => {
    exportPreviewText = JSON.stringify(state, null, 2);
    dataMessage = '已在下方显示导出 JSON 内容，可先检查中文与数据结构。';
    renderSettings();
  });
  document.getElementById('copyExportBtn').addEventListener('click', async () => {
    try {
      const text = exportPreviewText || JSON.stringify(state, null, 2);
      await navigator.clipboard.writeText(text);
      exportPreviewText = text;
      dataMessage = 'JSON 内容已复制到剪贴板。';
    } catch {
      dataMessage = '复制失败，请先点击“显示导出 JSON 内容”，再手动复制。';
    }
    renderSettings();
  });
  document.getElementById('importInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const normalized = sanitizeImportedState(parsed);
      const words = normalized.words || [];
      const suspiciousCount = words.reduce((acc, word) => {
        const fields = [word.word, word.meaning, word.example, ...(Array.isArray(word.tags) ? word.tags : [])];
        return acc + (fields.some(v => looksLikeMojibake(v)) ? 1 : 0);
      }, 0);
      pendingImportState = normalized;
      pendingImportPreview = {
        fileName: file.name,
        wordCount: words.length,
        wrongBookCount: (normalized.wrongBook || []).length,
        logCount: (normalized.logs || []).length,
        hasSettings: Boolean(normalized.settings),
        intervals: Array.isArray(normalized.settings?.intervals) ? normalized.settings.intervals.join(', ') : '无',
        dailyQuota: normalized.settings?.dailyQuota ?? '无',
        suspiciousCount,
        sampleWords: words.slice(0, 5).map(word => ({ word: word.word || '', meaning: word.meaning || '' })),
      };
      dataMessage = '已读取 JSON，请先查看导入前预检结果，再决定是否覆盖当前本地数据。';
      renderSettings();
    } catch {
      pendingImportState = null;
      pendingImportPreview = null;
      dataMessage = '导入失败，请检查 JSON 文件。';
      renderSettings();
      showToast('导入失败');
    } finally {
      event.target.value = '';
    }
  });
  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('确定清空所有本地数据吗？')) return;
    state = structuredClone(defaultState);
    await saveState();
    resetNormalReviewSession();
    resetWrongBookSession();
    reviewContext = { type: 'today', sourceDate: null };
    selectedDate = todayStr();
    calendarCursor = new Date();
    renderAll();
    showToast('已清空');
  });

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    await saveEditModal();
  });
  document.getElementById('cancelEditBtn').addEventListener('click', closeEditModal);
  document.getElementById('editBackdrop').addEventListener('click', closeEditModal);
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js?v=5.3.1');
    } catch {
      // ignore
    }
  }
}

(async function init() {
  db = await openDB();
  await loadState();
  selectedDate = todayStr();
  calendarCursor = new Date();
  bindEvents();
  renderAll();
  switchTab('dashboard');
  registerSW();
})();
