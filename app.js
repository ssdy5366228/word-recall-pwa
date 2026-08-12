const APP_VERSION = 'v6.0 Beta 4.4';
const APP_VERSION_NUMBER = '6.0.0-beta.4.4';
const SCHEMA_VERSION = 7;
const DB_NAME = 'word_recall_pwa_db';
const DB_VERSION = 7;
const STORE_APP = 'app';
const STORE_CURRENT = 'currentState';
const STORE_SNAPSHOTS = 'snapshots';
const STORE_META = 'metadata';
const APP_STATE_KEY = 'state';
const CURRENT_STATE_KEY = 'current';
const META_KEY = 'meta';
const LS_STATE_KEY = 'word_recall_pwa_state_v5_7';
const LS_META_KEY = 'word_recall_pwa_meta_v5_7';
const APP_INITIALIZED_KEY = 'word_recall_app_initialized';
const LEGACY_LS_STATE_KEYS = ['word_recall_pwa_state_v5_6_1', 'word_recall_pwa_state_v5_6', 'word_recall_pwa_state_v5_5_beta'];
const LS_TODAY_DRAFT_KEY = 'word_recall_pwa_today_draft_v5_7';
const LS_CALENDAR_DRAFT_KEY = 'word_recall_pwa_calendar_draft_v5_7';
const LS_REVIEW_SESSIONS_KEY = 'word_recall_pwa_review_sessions_v6_0_beta_4_2';
const LEGACY_TODAY_DRAFT_KEYS = ['word_recall_pwa_today_draft_v5_6_1', 'word_recall_pwa_today_draft_v5_6', 'word_recall_pwa_today_draft_v5_5_beta'];
const LEGACY_CALENDAR_DRAFT_KEYS = ['word_recall_pwa_calendar_draft_v5_6_1', 'word_recall_pwa_calendar_draft_v5_6', 'word_recall_pwa_calendar_draft_v5_5_beta'];
const MAX_SNAPSHOTS = 10;
const MAX_LOCAL_FALLBACK_SNAPSHOTS = 3;
const LS_SNAPSHOTS_KEY = 'word_recall_pwa_snapshots_v5_7';
const DEFAULT_INTERVALS = [0, 1, 3, 7, 14, 21, 30, 60, 90, 180];
const RECOVERY_DAYS = { Easy: 30, Good: 14, Hard: 3, Again: 1 };
const AUDIO_CACHE_NAME = 'word-recall-pronunciation-v2';
const LEGACY_AUDIO_CACHE_NAMES = ['word-recall-pronunciation-v1'];
const PRONUNCIATION_SETTINGS_VERSION = 1;
const DICTIONARY_API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

const defaultState = {
  settings: {
    dailyQuota: 5,
    intervals: DEFAULT_INTERVALS,
    backlogDailyLimit: 8,
    longTermDailyLimit: 10,
    weakDailyLimit: 10,
    pronunciationLocale: 'en-US',
    autoPronounce: true,
    cachePronunciationOnAdd: true,
    pronunciationSettingsVersion: PRONUNCIATION_SETTINGS_VERSION,
  },
  words: [],
  wrongBook: [],
  logs: [],
};

let db = null;
let dbOpenError = null;
let state = structuredClone(defaultState);
let editingWordId = null;
let calendarCursor = new Date();
let selectedDate = todayStr();
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
let lastAutoSpokenKey = '';
let activePronunciationAudio = null;
let pronunciationAudioUnlocked = false;
let pronunciationUnlockPromise = null;
let activePronunciationObjectUrl = '';
let pronunciationRequestSerial = 0;
let autoPlaybackBlockedToastShown = false;
let autoSpeakScheduleSerial = 0;
let reviewAudioEnabled = false;
let normalReviewMode = 'due'; // due | backlog | longterm | weak
const dictionaryEntryPromises = new Map();
let saveQueue = Promise.resolve();
let currentRevision = 0;
let lastKnownMeta = null;
let storageHealth = { indexedDB: 'unknown', localStorage: 'unknown', warning: '' };
let snapshotSummaries = [];
let reviewSubmitting = false;
let appLocked = false;
let fatalDataDetails = null;
let logDisplayLimit = 200;

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
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
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_APP)) database.createObjectStore(STORE_APP);
      if (!database.objectStoreNames.contains(STORE_CURRENT)) database.createObjectStore(STORE_CURRENT);
      if (!database.objectStoreNames.contains(STORE_SNAPSHOTS)) database.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 升级被其他页面阻塞'));
  });
}

function dbGetFrom(storeName, key) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB 未打开'));
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || tx.error || new Error('IndexedDB 读取失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 读取事务中止'));
  });
}

function dbGetAllFrom(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB 未打开'));
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || tx.error || new Error('IndexedDB 批量读取失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 批量读取事务中止'));
  });
}

function dbPutTo(storeName, value, key = undefined) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB 未打开'));
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (key === undefined) store.put(value); else store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入事务中止'));
  });
}

function dbDeleteFrom(storeName, key) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB 未打开'));
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 删除失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 删除事务中止'));
  });
}

function dbWriteCurrentAndMeta(envelope, meta) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB 未打开'));
    const tx = db.transaction([STORE_CURRENT, STORE_META], 'readwrite');
    tx.objectStore(STORE_CURRENT).put(envelope, CURRENT_STATE_KEY);
    tx.objectStore(STORE_META).put(meta, META_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 双写失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 双写事务中止'));
  });
}

function safeParse(raw) {
  if (raw == null) return { status: 'missing', raw: null };
  try {
    return { status: 'ok', value: JSON.parse(raw), raw };
  } catch (error) {
    return { status: 'corrupt', error, raw };
  }
}

function readLocalJSON(key) {
  try {
    return safeParse(localStorage.getItem(key));
  } catch (error) {
    return { status: 'read_error', error, raw: null };
  }
}

function localGetJSON(key, fallback = null) {
  const result = readLocalJSON(key);
  return result.status === 'ok' ? result.value : fallback;
}

function localSetJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function localRemove(key) {
  localStorage.removeItem(key);
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function getInitializedFlag() {
  try {
    return localStorage.getItem(APP_INITIALIZED_KEY) === 'true';
  } catch {
    return false;
  }
}

function setInitializedFlag() {
  try {
    localStorage.setItem(APP_INITIALIZED_KEY, 'true');
  } catch {
    // IndexedDB metadata still records initialization when localStorage is unavailable.
  }
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function checksumState(prepared) {
  return fnv1a(JSON.stringify(prepared));
}

function validateRawStateShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '数据根节点不是对象' };
  if (!Array.isArray(raw.words)) return { ok: false, error: '缺少 words 数组' };
  if (raw.wrongBook != null && !Array.isArray(raw.wrongBook)) return { ok: false, error: 'wrongBook 不是数组' };
  if (raw.logs != null && !Array.isArray(raw.logs)) return { ok: false, error: 'logs 不是数组' };
  if (raw.settings != null && (typeof raw.settings !== 'object' || Array.isArray(raw.settings))) return { ok: false, error: 'settings 不是对象' };
  return { ok: true };
}

function normalizeStoredCandidate(value, source, fallbackMeta = null) {
  try {
    const envelope = value && value.state && typeof value.state === 'object' ? value : null;
    const rawState = envelope ? envelope.state : value;
    const shape = validateRawStateShape(rawState);
    if (!shape.ok) return { ok: false, source, error: shape.error };
    const rawChecksum = fnv1a(JSON.stringify(rawState));
    const prepared = sanitizeImportedState(rawState);
    const checksum = checksumState(prepared);
    const metadata = { ...(fallbackMeta || {}), ...(envelope?.metadata || {}) };
    if (metadata.checksum && metadata.checksum !== checksum && metadata.checksum !== rawChecksum) {
      return { ok: false, source, error: '校验值不一致', metadata };
    }
    return {
      ok: true,
      source,
      state: prepared,
      metadata: {
        revision: Math.max(0, Number(metadata.revision || 0)),
        savedAt: String(metadata.savedAt || ''),
        lastKnownWordCount: Number(metadata.lastKnownWordCount ?? prepared.words.length),
        lastKnownLogCount: Number(metadata.lastKnownLogCount ?? prepared.logs.length),
        checksum,
        schemaVersion: Number(metadata.schemaVersion || 0),
        appVersion: String(metadata.appVersion || ''),
        lastDailySnapshotDate: String(metadata.lastDailySnapshotDate || ''),
      },
    };
  } catch (error) {
    return { ok: false, source, error: error?.message || String(error) };
  }
}

function makeMetadata(prepared, revision, options = {}) {
  return {
    initialized: true,
    revision,
    savedAt: options.savedAt || new Date().toISOString(),
    lastKnownWordCount: prepared.words.length,
    lastKnownLogCount: prepared.logs.length,
    checksum: checksumState(prepared),
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION_NUMBER,
    migratedFrom: options.migratedFrom || lastKnownMeta?.migratedFrom || '',
    migrationTime: options.migrationTime || lastKnownMeta?.migrationTime || '',
    lastDailySnapshotDate: options.lastDailySnapshotDate ?? lastKnownMeta?.lastDailySnapshotDate ?? '',
  };
}

function makeEnvelope(prepared, metadata) {
  return { state: cloneValue(prepared), metadata: cloneValue(metadata) };
}

function compareCandidates(a, b) {
  const rev = Number(b.metadata?.revision || 0) - Number(a.metadata?.revision || 0);
  if (rev) return rev;
  const time = String(b.metadata?.savedAt || '').localeCompare(String(a.metadata?.savedAt || ''));
  if (time) return time;
  const sourcePriority = source => source.includes('indexeddb-current') ? 3 : source.includes('local-current') ? 2 : 1;
  return sourcePriority(b.source) - sourcePriority(a.source);
}

function assertStateNotSuspicious(prepared, options = {}) {
  if (options.allowLargeDecrease || !lastKnownMeta) return;
  const previousWords = Math.max(0, Number(lastKnownMeta.lastKnownWordCount || 0));
  const currentWords = prepared.words.length;
  const previousLogs = Math.max(0, Number(lastKnownMeta.lastKnownLogCount || 0));
  const currentLogs = prepared.logs.length;
  if (previousWords > 0 && currentWords === 0) {
    throw new Error(`异常空库保护：上次已知有 ${previousWords} 个词，本次准备保存 0 个词`);
  }
  if (previousWords >= 50 && previousWords - currentWords >= 20 && currentWords < previousWords * 0.5) {
    throw new Error(`异常缩减保护：词数从 ${previousWords} 降至 ${currentWords}`);
  }
  if (previousLogs >= 200 && previousLogs - currentLogs >= 100 && currentLogs < previousLogs * 0.5) {
    throw new Error(`异常缩减保护：记录数从 ${previousLogs} 降至 ${currentLogs}`);
  }
}

async function persistPreparedState(prepared, options = {}) {
  assertStateNotSuspicious(prepared, options);
  const revision = options.revision != null ? Number(options.revision) : currentRevision + 1;
  const metadata = makeMetadata(prepared, revision, options);
  const envelope = makeEnvelope(prepared, metadata);
  const results = { indexedDB: false, localStorage: false, errors: [] };

  if (db) {
    try {
      await dbWriteCurrentAndMeta(envelope, metadata);
      results.indexedDB = true;
      storageHealth.indexedDB = 'ok';
    } catch (error) {
      results.errors.push(`IndexedDB：${error?.message || error}`);
      storageHealth.indexedDB = 'error';
    }
  } else {
    results.errors.push(`IndexedDB：${dbOpenError?.message || '不可用'}`);
    storageHealth.indexedDB = 'error';
  }

  try {
    localSetJSON(LS_STATE_KEY, envelope);
    localSetJSON(LS_META_KEY, metadata);
    results.localStorage = true;
    storageHealth.localStorage = 'ok';
  } catch (error) {
    results.errors.push(`localStorage：${error?.message || error}`);
    storageHealth.localStorage = 'error';
  }

  if (!results.indexedDB && !results.localStorage) {
    appLocked = true;
    throw new Error(`所有本地存储均保存失败。${results.errors.join('；')}`);
  }

  state = prepared;
  currentRevision = revision;
  lastKnownMeta = metadata;
  setInitializedFlag();
  storageHealth.warning = results.indexedDB && results.localStorage ? '' : `当前只有一份存储写入成功：${results.errors.join('；')}`;
  return results;
}

function readLocalSnapshotList() {
  const result = readLocalJSON(LS_SNAPSHOTS_KEY);
  return result.status === 'ok' && Array.isArray(result.value) ? result.value : [];
}

function writeLocalSnapshotList(items) {
  localSetJSON(LS_SNAPSHOTS_KEY, items.slice(0, MAX_LOCAL_FALLBACK_SNAPSHOTS));
}

async function trimSnapshots() {
  if (db) {
    try {
      const items = (await dbGetAllFrom(STORE_SNAPSHOTS)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      await Promise.all(items.slice(MAX_SNAPSHOTS).map(item => dbDeleteFrom(STORE_SNAPSHOTS, item.id)));
    } catch {
      // Snapshot trimming is best effort and never changes current state.
    }
  }
}

async function createSnapshot(reason, sourceState = state) {
  const prepared = sanitizeImportedState(cloneValue(sourceState));
  const createdAt = new Date().toISOString();
  const snapshot = {
    id: `snapshot_${createdAt}_${uuid()}`,
    reason: String(reason || 'manual'),
    createdAt,
    wordCount: prepared.words.length,
    logCount: prepared.logs.length,
    checksum: checksumState(prepared),
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION_NUMBER,
    state: cloneValue(prepared),
  };
  let stored = false;
  if (db) {
    try {
      await dbPutTo(STORE_SNAPSHOTS, snapshot);
      stored = true;
      await trimSnapshots();
    } catch {
      // Fall through to local snapshot mirror.
    }
  }
  try {
    const localItems = readLocalSnapshotList().filter(item => item.id !== snapshot.id);
    writeLocalSnapshotList([snapshot, ...localItems]);
    stored = true;
  } catch {
    // At least the IDB copy may still exist.
  }
  await loadSnapshotSummaries();
  return stored ? snapshot : null;
}

async function getAllSnapshots() {
  const merged = new Map();
  if (db) {
    try {
      (await dbGetAllFrom(STORE_SNAPSHOTS)).forEach(item => merged.set(item.id, item));
    } catch {
      // Use local snapshots if IndexedDB is unavailable.
    }
  }
  try {
    readLocalSnapshotList().forEach(item => merged.set(item.id, item));
  } catch {
    // No local fallback.
  }
  return [...merged.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function loadSnapshotSummaries() {
  const items = await getAllSnapshots();
  snapshotSummaries = items.map(item => ({
    id: item.id,
    reason: item.reason,
    createdAt: item.createdAt,
    wordCount: item.wordCount,
    logCount: item.logCount,
  }));
  return snapshotSummaries;
}

async function getSnapshotById(id) {
  if (db) {
    try {
      const item = await dbGetFrom(STORE_SNAPSHOTS, id);
      if (item) return item;
    } catch {
      // Try local fallback.
    }
  }
  return readLocalSnapshotList().find(item => item.id === id) || null;
}

function downloadJSONFile(payload, filename) {
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob(['\ufeff' + text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function restoreSnapshot(id) {
  const snapshot = await getSnapshotById(id);
  if (!snapshot) throw new Error('未找到该快照');
  const shape = validateRawStateShape(snapshot.state);
  if (!shape.ok) throw new Error(`快照无效：${shape.error}`);
  const prepared = sanitizeImportedState(snapshot.state);
  if (snapshot.checksum && snapshot.checksum !== checksumState(prepared)) throw new Error('快照校验失败');
  await createSnapshot('restore-before', state);
  await saveState(prepared, { allowLargeDecrease: true, skipDailySnapshot: true });
  resetNormalReviewSession();
  resetWrongBookSession();
  reviewContext = { type: 'today', sourceDate: null };
  renderAll();
}

function setFatalDataError(message, details = {}) {
  appLocked = true;
  fatalDataDetails = { message, ...details, occurredAt: new Date().toISOString() };
}

function renderFatalDataError() {
  const overlay = document.getElementById('fatalDataOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.getElementById('fatalDataMessage').textContent = fatalDataDetails?.message || '检测到数据异常。';
  const snapshotBox = document.getElementById('fatalSnapshotList');
  snapshotBox.innerHTML = snapshotSummaries.length
    ? snapshotSummaries.map(item => `<button class="btn snapshot-restore-btn" data-id="${escapeHtml(item.id)}">恢复 ${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))} · ${item.wordCount} 词</button>`).join('')
    : '<div class="small muted">未找到可用自动快照。</div>';
}

function bindFatalRecoveryEvents() {
  document.getElementById('fatalExportDiagnosticBtn')?.addEventListener('click', () => {
    downloadJSONFile({
      appVersion: APP_VERSION_NUMBER,
      schemaVersion: SCHEMA_VERSION,
      fatal: fatalDataDetails,
      storageHealth,
      lastKnownMeta,
      snapshots: snapshotSummaries,
    }, `word_recall_diagnostic_${todayStr()}.json`);
  });
  document.getElementById('fatalImportInput')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const raw = parsed?.state && parsed?.metadata ? parsed.state : parsed;
      const shape = validateRawStateShape(raw);
      if (!shape.ok) throw new Error(shape.error);
      const prepared = sanitizeImportedState(raw);
      await createSnapshot('fatal-import-before', state);
      await persistPreparedState(prepared, { allowLargeDecrease: true, migratedFrom: 'fatal-backup-import', migrationTime: new Date().toISOString() });
      location.reload();
    } catch (error) {
      document.getElementById('fatalRecoveryStatus').textContent = `恢复失败：${error?.message || error}`;
    } finally {
      event.target.value = '';
    }
  });
  document.getElementById('fatalSnapshotList')?.addEventListener('click', async event => {
    const button = event.target.closest('.snapshot-restore-btn');
    if (!button) return;
    try {
      await restoreSnapshot(button.dataset.id);
      location.reload();
    } catch (error) {
      document.getElementById('fatalRecoveryStatus').textContent = `快照恢复失败：${error?.message || error}`;
    }
  });
}

function getDraftKey(kind) {
  return kind === 'calendar' ? LS_CALENDAR_DRAFT_KEY : LS_TODAY_DRAFT_KEY;
}

function getDraft(kind) {
  const empty = { word: '', meaning: '', example: '', exampleMeaning: '', tags: '' };
  const current = localGetJSON(getDraftKey(kind), null);
  if (current) return { ...empty, ...current };
  const legacyKeys = kind === 'calendar' ? LEGACY_CALENDAR_DRAFT_KEYS : LEGACY_TODAY_DRAFT_KEYS;
  for (const key of legacyKeys) {
    const legacy = localGetJSON(key, null);
    if (legacy) return { ...empty, ...legacy };
  }
  return empty;
}

function saveDraft(kind, draft) {
  localSetJSON(getDraftKey(kind), {
    word: String(draft?.word || ''),
    meaning: String(draft?.meaning || ''),
    example: String(draft?.example || ''),
    exampleMeaning: String(draft?.exampleMeaning || ''),
    tags: String(draft?.tags || ''),
  });
}

function clearDraft(kind) {
  localRemove(getDraftKey(kind));
}

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  const maxHeight = 180;
  const next = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${Math.max(next, 72)}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}


function applyDraftToInputs(kind) {
  const draft = getDraft(kind);
  if (kind === 'calendar') {
    const wordEl = document.getElementById('calendarWordInput');
    const meaningEl = document.getElementById('calendarMeaningInput');
    const exampleEl = document.getElementById('calendarExampleInput');
    const exampleMeaningEl = document.getElementById('calendarExampleMeaningInput');
    const tagEl = document.getElementById('calendarTagInput');
    if (wordEl) wordEl.value = draft.word || '';
    if (meaningEl) { meaningEl.value = draft.meaning || ''; autoResizeTextarea(meaningEl); }
    if (exampleEl) exampleEl.value = draft.example || '';
    if (exampleMeaningEl) exampleMeaningEl.value = draft.exampleMeaning || '';
    if (tagEl) tagEl.value = draft.tags || '';
    return;
  }
  const wordEl = document.getElementById('wordInput');
  const meaningEl = document.getElementById('meaningInput');
  const exampleEl = document.getElementById('exampleInput');
  const exampleMeaningEl = document.getElementById('exampleMeaningInput');
  const tagEl = document.getElementById('tagInput');
  if (wordEl) wordEl.value = draft.word || '';
  if (meaningEl) { meaningEl.value = draft.meaning || ''; autoResizeTextarea(meaningEl); }
  if (exampleEl) exampleEl.value = draft.example || '';
  if (exampleMeaningEl) exampleMeaningEl.value = draft.exampleMeaning || '';
  if (tagEl) tagEl.value = draft.tags || '';
}

function captureDraftFromInputs(kind) {
  if (kind === 'calendar') {
    saveDraft('calendar', {
      word: document.getElementById('calendarWordInput')?.value || '',
      meaning: document.getElementById('calendarMeaningInput')?.value || '',
      example: document.getElementById('calendarExampleInput')?.value || '',
      exampleMeaning: document.getElementById('calendarExampleMeaningInput')?.value || '',
      tags: document.getElementById('calendarTagInput')?.value || '',
    });
    return;
  }
  saveDraft('today', {
    word: document.getElementById('wordInput')?.value || '',
    meaning: document.getElementById('meaningInput')?.value || '',
    example: document.getElementById('exampleInput')?.value || '',
    exampleMeaning: document.getElementById('exampleMeaningInput')?.value || '',
    tags: document.getElementById('tagInput')?.value || '',
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

function capRatingForHint(rating, usedHint) {
  if (!usedHint) return rating;
  return ratingRank(rating) < ratingRank('Hard') ? 'Hard' : rating;
}

function splitMeanings(text) {
  return String(text || '').split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
}

function makeMeaningHint(meaning) {
  const parts = splitMeanings(meaning);
  if (!parts.length) return '这个词有中文目标义项，但当前无法生成轻提示。';
  const cues = parts.map(part => `${part.slice(0, 1)}${part.length > 1 ? '…' : ''}`);
  return `共 ${parts.length} 个目标义项：${cues.join('；')}`;
}

function makeEnglishHint(word) {
  const raw = String(word || '').trim();
  const letters = [...raw].filter(ch => /[A-Za-z]/.test(ch)).length;
  let firstShown = false;
  const masked = [...raw].map(ch => {
    if (/[A-Za-z]/.test(ch)) {
      if (!firstShown) {
        firstShown = true;
        return ch;
      }
      return '＿';
    }
    return ch;
  }).join('');
  return `${masked}${letters ? `（${letters} 个字母）` : ''}`;
}

function normalizePronunciationWord(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSharedPronunciationAudio() {
  if (!activePronunciationAudio) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    activePronunciationAudio = audio;
  }
  return activePronunciationAudio;
}

function unlockPronunciationAudio() {
  if (pronunciationAudioUnlocked) return Promise.resolve(true);
  if (pronunciationUnlockPromise) return pronunciationUnlockPromise;
  const audio = getSharedPronunciationAudio();
  const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  try {
    audio.src = silentWav;
    audio.muted = true;
    pronunciationUnlockPromise = audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
      pronunciationAudioUnlocked = true;
      return true;
    }).catch(() => false).finally(() => {
      pronunciationUnlockPromise = null;
    });
    return pronunciationUnlockPromise;
  } catch {
    pronunciationUnlockPromise = null;
    return Promise.resolve(false);
  }
}

function stopPronunciationPlayback() {
  try {
    window.speechSynthesis?.cancel?.();
  } catch {
    // Ignore browser speech cancellation errors.
  }
  if (activePronunciationAudio) {
    try {
      activePronunciationAudio.pause();
      activePronunciationAudio.currentTime = 0;
    } catch {
      // Best effort only.
    }
  }
  if (activePronunciationObjectUrl) {
    try { URL.revokeObjectURL(activePronunciationObjectUrl); } catch { /* ignore */ }
    activePronunciationObjectUrl = '';
  }
}

function pronunciationCacheRequest(word, locale) {
  const normalized = normalizePronunciationWord(word);
  const safeLocale = ['en-US', 'en-GB'].includes(locale) ? locale : 'en-US';
  return new Request(new URL(`./__pronunciation_cache__/${safeLocale}/${encodeURIComponent(normalized)}`, location.href).href);
}

function detectAudioLocale(url) {
  const value = String(url || '').toLowerCase();
  if (/(?:^|[-_/])(us|usa)(?:[-_.?/]|$)/.test(value) || value.includes('en-us')) return 'en-US';
  if (/(?:^|[-_/])(uk|gb)(?:[-_.?/]|$)/.test(value) || value.includes('en-gb')) return 'en-GB';
  if (/(?:^|[-_/])au(?:[-_.?/]|$)/.test(value) || value.includes('en-au')) return 'en-AU';
  return '';
}

function normalizeAudioUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  try {
    const parsed = new URL(raw, 'https://api.dictionaryapi.dev/');
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}

async function fetchDictionaryEntries(word) {
  const value = normalizePronunciationWord(word);
  if (!value) throw new Error('empty-word');
  if (dictionaryEntryPromises.has(value)) return dictionaryEntryPromises.get(value);
  const task = (async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const response = await fetch(`${DICTIONARY_API_BASE}${encodeURIComponent(value)}`, {
        method: 'GET',
        signal: controller?.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`dictionary-${response.status}`);
      const entries = await response.json();
      return Array.isArray(entries) ? entries : [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  dictionaryEntryPromises.set(value, task);
  try {
    const result = await task;
    setTimeout(() => {
      if (dictionaryEntryPromises.get(value) === task) dictionaryEntryPromises.delete(value);
    }, 60000);
    return result;
  } catch (error) {
    dictionaryEntryPromises.delete(value);
    throw error;
  }
}

function selectDictionaryPronunciations(entries, preferredLocale) {
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const item of Array.isArray(entry.phonetics) ? entry.phonetics : []) {
      const audioUrl = normalizeAudioUrl(item?.audio);
      if (!audioUrl) continue;
      candidates.push({
        audioUrl,
        locale: detectAudioLocale(audioUrl),
        phonetic: String(item?.text || entry?.phonetic || ''),
      });
    }
  }
  if (!candidates.length) return [];
  const alternateLocale = preferredLocale === 'en-GB' ? 'en-US' : 'en-GB';
  const score = item => item.locale === preferredLocale ? 0 : item.locale === alternateLocale ? 1 : !item.locale ? 2 : 3;
  return candidates
    .map((item, index) => ({ ...item, _index: index }))
    .sort((a, b) => score(a) - score(b) || a._index - b._index)
    .map(({ _index, ...item }) => item);
}

async function getCachedPronunciationBlob(word, locale) {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const response = await cache.match(pronunciationCacheRequest(word, locale));
    if (!response) return null;
    const blob = await response.blob();
    return blob?.size ? blob : null;
  } catch {
    return null;
  }
}

async function deleteCachedPronunciation(word, locale) {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    return await cache.delete(pronunciationCacheRequest(word, locale));
  } catch {
    return false;
  }
}

async function fetchAndCachePronunciationBlob(word, locale, audioUrl) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const response = await fetch(audioUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (!response.ok || response.type === 'opaque') throw new Error(`audio-${response.status || response.type}`);
    const cacheCopy = response.clone();
    const blob = await response.blob();
    if (!blob?.size) throw new Error('empty-audio');
    if ('caches' in window) {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        await cache.put(pronunciationCacheRequest(word, locale), cacheCopy);
      } catch {
        // Cache write failure must never block playback.
      }
    }
    return blob;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepareDictionaryPronunciation(word, locale = state.settings.pronunciationLocale || 'en-US', options = {}) {
  const value = normalizePronunciationWord(word);
  if (!value) throw new Error('empty-word');
  if (!options.skipCache) {
    const cachedBlob = await getCachedPronunciationBlob(value, locale);
    if (cachedBlob) return { source: 'cache', blob: cachedBlob, locale, word: value };
  }
  const entries = await fetchDictionaryEntries(value);
  const candidates = selectDictionaryPronunciations(entries, locale);
  if (!candidates.length) throw new Error('no-dictionary-audio');

  // Try every dictionary audio candidate for a cacheable CORS response.
  for (const selected of candidates) {
    try {
      const blob = await fetchAndCachePronunciationBlob(value, locale, selected.audioUrl);
      if (blob) return { source: 'dictionary-cache', blob, locale: selected.locale || locale, phonetic: selected.phonetic, audioUrl: selected.audioUrl, candidates, word: value };
    } catch {
      // Keep going: another pronunciation host may still work.
    }
  }

  // CORS may forbid fetch() while direct <audio> playback still works.
  return { source: 'dictionary-direct', audioUrl: candidates[0].audioUrl, locale: candidates[0].locale || locale, phonetic: candidates[0].phonetic, candidates, word: value };
}

async function playHtmlAudio({ blob = null, audioUrl = '', requestId, auto = false }) {
  if (requestId !== pronunciationRequestSerial) return { played: false, stale: true };
  const audio = getSharedPronunciationAudio();
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    if (activePronunciationObjectUrl) {
      try { URL.revokeObjectURL(activePronunciationObjectUrl); } catch { /* ignore */ }
      activePronunciationObjectUrl = '';
    }
    if (blob) {
      activePronunciationObjectUrl = URL.createObjectURL(blob);
      audio.src = activePronunciationObjectUrl;
    } else {
      audio.src = audioUrl;
    }
    await audio.play();
    pronunciationAudioUnlocked = true;
    return { played: true, blocked: false };
  } catch (error) {
    const blocked = error?.name === 'NotAllowedError';
    if (auto && blocked && !autoPlaybackBlockedToastShown) {
      autoPlaybackBlockedToastShown = true;
      showToast('请先点一次任意喇叭，之后复习可自动发音');
    }
    return { played: false, blocked, error };
  }
}

function speakWithSystemVoiceOnce(text, { auto = false } = {}) {
  const value = String(text || '').trim();
  return new Promise(resolve => {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      if (!auto) showToast('当前浏览器不支持系统发音');
      resolve(false);
      return;
    }
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume?.();
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.lang = state.settings.pronunciationLocale || 'en-US';
      utterance.rate = 0.88;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const exact = voices.find(voice => voice.lang === utterance.lang);
      const languageMatch = voices.find(voice => voice.lang?.toLowerCase().startsWith(utterance.lang.slice(0, 2).toLowerCase()));
      if (exact || languageMatch) utterance.voice = exact || languageMatch;
      let settled = false;
      const finish = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      utterance.onstart = () => finish(true);
      utterance.onerror = () => finish(false);
      const timer = setTimeout(() => finish(false), 2200);
      setTimeout(() => {
        try {
          window.speechSynthesis.resume?.();
          window.speechSynthesis.speak(utterance);
        } catch {
          finish(false);
        }
      }, 60);
    } catch {
      resolve(false);
    }
  });
}

async function speakWithSystemVoice(text, { auto = false } = {}) {
  if (await speakWithSystemVoiceOnce(text, { auto })) return true;
  // iOS Safari can silently drop the first utterance after page/tab transitions.
  await new Promise(resolve => setTimeout(resolve, 180));
  try {
    window.speechSynthesis?.cancel?.();
    window.speechSynthesis?.resume?.();
  } catch {
    // best effort
  }
  return speakWithSystemVoiceOnce(text, { auto });
}

async function playPreparedPronunciation(prepared, requestId, auto) {
  if (!prepared) return { played: false };
  if (prepared.blob) return playHtmlAudio({ ...prepared, requestId, auto });
  const candidates = Array.isArray(prepared.candidates) && prepared.candidates.length
    ? prepared.candidates
    : prepared.audioUrl ? [{ audioUrl: prepared.audioUrl }] : [];
  let lastResult = { played: false };
  for (const candidate of candidates) {
    if (requestId !== pronunciationRequestSerial) return { played: false, stale: true };
    lastResult = await playHtmlAudio({ audioUrl: candidate.audioUrl, requestId, auto });
    if (lastResult.played || lastResult.blocked || lastResult.stale) return lastResult;
  }
  return lastResult;
}

async function speakWord(text, options = {}) {
  const value = String(text || '').trim();
  const auto = Boolean(options.auto);
  if (!value) {
    if (!auto) showToast('请先填写英文单词');
    return false;
  }
  const requestId = ++pronunciationRequestSerial;
  stopPronunciationPlayback();
  const locale = state.settings.pronunciationLocale || 'en-US';
  try {
    let prepared = await prepareDictionaryPronunciation(value, locale);
    if (requestId !== pronunciationRequestSerial) return false;
    let playback = await playPreparedPronunciation(prepared, requestId, auto);
    if (playback.played) return true;
    if (playback.blocked || playback.stale) return false;

    // A corrupted/unsupported cached blob should not poison future attempts.
    if (prepared.source === 'cache') {
      await deleteCachedPronunciation(value, locale);
      if (requestId !== pronunciationRequestSerial) return false;
      prepared = await prepareDictionaryPronunciation(value, locale, { skipCache: true });
      if (requestId !== pronunciationRequestSerial) return false;
      playback = await playPreparedPronunciation(prepared, requestId, auto);
      if (playback.played) return true;
      if (playback.blocked || playback.stale) return false;
    }
  } catch {
    // Dictionary/network failure falls through to system speech.
  }
  if (requestId !== pronunciationRequestSerial) return false;
  const usedSystem = await speakWithSystemVoice(value, { auto });
  if (!auto) showToast(usedSystem ? '未取得词典音频，已使用系统备用发音' : '发音失败，请检查网络、手机音量或稍后重试');
  return usedSystem;
}

async function prefetchPronunciation(word, { notify = false } = {}) {
  try {
    const prepared = await prepareDictionaryPronunciation(word, state.settings.pronunciationLocale || 'en-US');
    if (notify) {
      showToast(prepared.source === 'cache' ? '该词发音已在本机缓存' : prepared.blob ? '词典发音已缓存' : '已找到词典发音，使用时在线播放');
    }
    return true;
  } catch {
    if (notify) showToast('暂未找到词典发音，使用时将尝试系统发音');
    return false;
  }
}

function maybeAutoSpeak(word, key) {
  const reviewActive = document.getElementById('review')?.classList.contains('active');
  const wrongActive = document.getElementById('wrongbook')?.classList.contains('active');
  if ((!reviewActive && !wrongActive) || !state.settings.autoPronounce || !word || lastAutoSpokenKey === key) return;
  if (reviewActive && !reviewAudioEnabled) return;
  lastAutoSpokenKey = key;
  const scheduleId = ++autoSpeakScheduleSerial;
  setTimeout(() => {
    if (scheduleId !== autoSpeakScheduleSerial || lastAutoSpokenKey !== key) return;
    const stillReviewActive = document.getElementById('review')?.classList.contains('active');
    const stillWrongActive = document.getElementById('wrongbook')?.classList.contains('active');
    if (!stillReviewActive && !stillWrongActive) return;
    speakWord(word, { auto: true });
  }, 80);
}

function firstMeaningGloss(meaning) {
  return splitMeanings(meaning)[0] || String(meaning || '').trim();
}

function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function generateFallbackExample(word, partOfSpeech = '', meaning = '') {
  const w = String(word || '').trim();
  const pos = String(partOfSpeech || '').toLowerCase();
  const gloss = firstMeaningGloss(meaning);
  if (pos.includes('verb')) return { example: `We need to ${w} this carefully.`, translation: gloss ? `我们需要认真地${gloss}。` : '' };
  if (pos.includes('adjective')) return { example: `The result was ${w}.`, translation: gloss ? `结果是${gloss}的。` : '' };
  if (pos.includes('adverb')) return { example: `She spoke ${w}.`, translation: gloss ? `她${gloss}地说。` : '' };
  if (pos.includes('interjection')) return { example: `${capitalize(w)}!`, translation: gloss ? `${gloss}！` : '' };
  return { example: `This ${w} is important.`, translation: gloss ? `这个${gloss}很重要。` : '' };
}

async function fetchDictionaryData(word) {
  const entries = await fetchDictionaryEntries(word);
  let example = '';
  let partOfSpeech = '';
  let phonetic = '';
  for (const entry of entries) {
    phonetic = phonetic || String(entry.phonetic || '') || String((entry.phonetics || []).find(item => item.text)?.text || '');
    for (const meaning of entry.meanings || []) {
      partOfSpeech = partOfSpeech || String(meaning.partOfSpeech || '');
      for (const definition of meaning.definitions || []) {
        if (definition.example) {
          example = String(definition.example);
          return { example, partOfSpeech, phonetic };
        }
      }
    }
  }
  return { example, partOfSpeech, phonetic };
}

async function autoFillExample({ wordInputId, meaningInputId, exampleInputId, exampleMeaningInputId, statusId }) {
  const wordEl = document.getElementById(wordInputId);
  const meaningEl = document.getElementById(meaningInputId);
  const exampleEl = document.getElementById(exampleInputId);
  const translationEl = document.getElementById(exampleMeaningInputId);
  const statusEl = document.getElementById(statusId);
  const word = wordEl?.value.trim() || '';
  if (!word) return showToast('请先填写英文单词');
  if (exampleEl?.value.trim() && !confirm('当前已有例句，确定覆盖吗？')) return;
  if (statusEl) statusEl.textContent = '正在查询…';
  try {
    const data = await fetchDictionaryData(word);
    if (data.example) {
      exampleEl.value = data.example;
      if (statusEl) statusEl.textContent = '已写入词典例句；中文请自行确认。';
      if (wordInputId === 'wordInput') captureDraftFromInputs('today');
      if (wordInputId === 'calendarWordInput') captureDraftFromInputs('calendar');
      return;
    }
    const fallback = generateFallbackExample(word, data.partOfSpeech, meaningEl?.value || '');
    exampleEl.value = fallback.example;
    if (translationEl && !translationEl.value.trim()) translationEl.value = fallback.translation;
    if (statusEl) statusEl.textContent = '词典未返回例句，已写入本地简单例句。';
  } catch {
    const fallback = generateFallbackExample(word, '', meaningEl?.value || '');
    exampleEl.value = fallback.example;
    if (translationEl && !translationEl.value.trim()) translationEl.value = fallback.translation;
    if (statusEl) statusEl.textContent = '在线查询失败，已写入可编辑的本地简单例句。';
  }
  if (wordInputId === 'wordInput') captureDraftFromInputs('today');
  if (wordInputId === 'calendarWordInput') captureDraftFromInputs('calendar');
}

function getWrongEntry(wordId) {
  return state.wrongBook.find(item => item.wordId === wordId && item.active !== false) || null;
}

function ensureWrongEntry(wordId, source = 'recent') {
  let entry = getWrongEntry(wordId);
  if (!entry) {
    entry = {
      wordId,
      errorCount: Math.max(0, Number(state.words.find(word => word.id === wordId)?.totalErrorCount || 0)),
      weakCount: 0,
      active: true,
      source,
      nextReviewDate: todayStr(),
      lastReviewDate: '',
      lastResult: '',
      recoveryStage: 0,
      masteryStreak: 0,
      lastErrorDate: '',
      lastWeakDate: '',
      firstScheduledAt: todayStr(),
    };
    state.wrongBook.push(entry);
  }
  entry.active = true;
  if (source === 'recent') entry.source = 'recent';
  return entry;
}

function recordWeakOrError(wordId, rating, usedHint = false) {
  const finalRating = capRatingForHint(rating, usedHint);
  if (!['Hard', 'Again'].includes(finalRating)) return;
  const word = state.words.find(item => item.id === wordId);
  if (!word) return;
  const entry = ensureWrongEntry(wordId, 'recent');
  entry.lastResult = finalRating;
  entry.masteryStreak = 0;
  entry.recoveryStage = 0;
  if (finalRating === 'Again') {
    if (entry.lastErrorDate !== todayStr()) {
      entry.errorCount = Math.max(1, Number(entry.errorCount || 0) + 1);
      word.totalErrorCount = Math.max(0, Number(word.totalErrorCount || 0)) + 1;
      entry.lastErrorDate = todayStr();
    }
    entry.nextReviewDate = addDays(todayStr(), 1);
  } else {
    if (entry.lastWeakDate !== todayStr()) {
      entry.weakCount = Math.max(0, Number(entry.weakCount || 0)) + 1;
      word.weakCount = Math.max(0, Number(word.weakCount || 0)) + 1;
      if (usedHint) word.hintUseCount = Math.max(0, Number(word.hintUseCount || 0)) + 1;
      entry.lastWeakDate = todayStr();
    }
    entry.nextReviewDate = addDays(todayStr(), usedHint ? 1 : RECOVERY_DAYS.Hard);
  }
}

function settleRecoveryReview(wordId, rating, usedHint = false) {
  const finalRating = capRatingForHint(rating, usedHint);
  const entry = ensureWrongEntry(wordId, 'recent');
  const word = state.words.find(item => item.id === wordId);
  entry.lastReviewDate = todayStr();
  entry.lastResult = finalRating;
  if (['Hard', 'Again'].includes(finalRating)) {
    recordWeakOrError(wordId, finalRating, usedHint);
    return finalRating;
  }
  if (entry.lastErrorDate === todayStr()) {
    entry.nextReviewDate = addDays(todayStr(), 1);
    return finalRating;
  }
  entry.masteryStreak = Math.max(0, Number(entry.masteryStreak || 0)) + 1;
  entry.recoveryStage = Math.max(0, Number(entry.recoveryStage || 0)) + (finalRating === 'Easy' ? 2 : 1);
  if (entry.masteryStreak >= 3) {
    state.wrongBook = state.wrongBook.filter(item => item.wordId !== wordId);
    if (word) {
      const resumeDays = finalRating === 'Easy' ? RECOVERY_DAYS.Easy : RECOVERY_DAYS.Good;
      if (!word.nextReviewDate || word.nextReviewDate <= todayStr()) word.nextReviewDate = addDays(todayStr(), resumeDays);
      word.lastReviewDate = todayStr();
      word.lastFinalRating = finalRating;
      word.catchupPending = false;
    }
  } else {
    const nextDays = entry.masteryStreak >= 2 ? RECOVERY_DAYS.Easy : RECOVERY_DAYS[finalRating];
    entry.nextReviewDate = addDays(todayStr(), nextDays);
  }
  if (word && usedHint) word.hintUseCount = Math.max(0, Number(word.hintUseCount || 0)) + 1;
  return finalRating;
}

function advanceNormalSchedule(word, rating, usedHint = false) {
  const finalRating = capRatingForHint(rating, usedHint);
  const intervals = state.settings.intervals;
  const lastIndex = Math.max(0, intervals.length - 1);
  const current = Math.min(Math.max(0, Number(word.scheduleStage || 0)), lastIndex);
  const step = finalRating === 'Easy' ? 2 : 1;
  const next = Math.min(current + step, lastIndex);
  const gap = next > current ? Math.max(1, intervals[next] - intervals[current]) : Math.max(1, intervals[lastIndex] || 180);
  word.scheduleStage = next;
  word.stageIndex = next;
  word.nextReviewDate = addDays(todayStr(), gap);
  word.lastReviewDate = todayStr();
  word.lastFinalRating = finalRating;
  word.catchupPending = false;
  const reviewed = new Set(word.reviewedOnDates || []);
  reviewed.add(todayStr());
  word.reviewedOnDates = [...reviewed];
  if (usedHint) word.hintUseCount = Math.max(0, Number(word.hintUseCount || 0)) + 1;
}

function reschedulePendingLegacyBacklog() {
  const wordMap = new Map(state.words.map(word => [word.id, word]));
  const pending = state.wrongBook.filter(item => item.active !== false && item.source === 'legacyBacklog' && !item.lastReviewDate);
  pending.sort((a, b) => {
    const countDiff = (Number(b.errorCount) || 0) - (Number(a.errorCount) || 0);
    if (countDiff !== 0) return countDiff;
    const wa = wordMap.get(a.wordId) || {};
    const wb = wordMap.get(b.wordId) || {};
    return String(wa.createdAt || '').localeCompare(String(wb.createdAt || '')) || String(wa.word || '').localeCompare(String(wb.word || ''));
  });
  pending.forEach((item, index) => {
    item.nextReviewDate = addDays(todayStr(), Math.floor(index / state.settings.backlogDailyLimit));
  });
}

function reschedulePendingNormalCatchup() {
  const pending = state.words.filter(word => word.catchupPending && word.nextReviewDate >= todayStr());
  pending.sort((a, b) => String(a.nextReviewDate || '').localeCompare(String(b.nextReviewDate || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.word || '').localeCompare(String(b.word || '')));
  pending.forEach((word, index) => {
    word.nextReviewDate = addDays(todayStr(), Math.floor(index / state.settings.longTermDailyLimit));
  });
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

function ensureLongIntervals(values) {
  const cleaned = [...new Set((values || []).map(Number).filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
  if (!cleaned.includes(0)) cleaned.unshift(0);
  if ((cleaned.at(-1) ?? 0) <= 30) {
    [60, 90, 180].forEach(day => {
      if (!cleaned.includes(day)) cleaned.push(day);
    });
  }
  return [...new Set(cleaned)].sort((a, b) => a - b);
}

function normalizeSettings(rawSettings = {}) {
  const intervals = ensureLongIntervals(Array.isArray(rawSettings.intervals) && rawSettings.intervals.length ? rawSettings.intervals : DEFAULT_INTERVALS);
  const dailyQuota = [5, 10].includes(Number(rawSettings.dailyQuota)) ? Number(rawSettings.dailyQuota) : 5;
  const backlogDailyLimit = [5, 8, 10].includes(Number(rawSettings.backlogDailyLimit)) ? Number(rawSettings.backlogDailyLimit) : 8;
  const parsedNormalBacklogLimit = Number(rawSettings.longTermDailyLimit);
  const longTermDailyLimit = Number.isFinite(parsedNormalBacklogLimit) ? Math.min(999, Math.max(0, Math.floor(parsedNormalBacklogLimit))) : 10;
  const parsedWeakLimit = Number(rawSettings.weakDailyLimit);
  const weakDailyLimit = Number.isFinite(parsedWeakLimit) ? Math.min(999, Math.max(0, Math.floor(parsedWeakLimit))) : 10;
  const pronunciationLocale = ['en-US', 'en-GB'].includes(rawSettings.pronunciationLocale) ? rawSettings.pronunciationLocale : 'en-US';
  const pronunciationSettingsVersion = Math.max(0, Number(rawSettings.pronunciationSettingsVersion || 0));
  const autoPronounce = pronunciationSettingsVersion >= PRONUNCIATION_SETTINGS_VERSION
    ? Boolean(rawSettings.autoPronounce)
    : true;
  const cachePronunciationOnAdd = Object.prototype.hasOwnProperty.call(rawSettings, 'cachePronunciationOnAdd')
    ? Boolean(rawSettings.cachePronunciationOnAdd)
    : true;
  return {
    dailyQuota,
    intervals,
    batchSize: dailyQuota,
    backlogDailyLimit,
    longTermDailyLimit,
    weakDailyLimit,
    pronunciationLocale,
    autoPronounce,
    cachePronunciationOnAdd,
    pronunciationSettingsVersion: PRONUNCIATION_SETTINGS_VERSION,
  };
}

function computeLegacyNextSchedule(word, intervals) {
  const reviewed = new Set(Array.isArray(word.reviewedOnDates) ? word.reviewedOnDates : []);
  let nextIndex = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    const dueDate = addDays(word.createdAt || todayStr(), intervals[i]);
    if (reviewed.has(dueDate)) nextIndex = Math.min(i + 1, intervals.length - 1);
    else break;
  }
  const dueDate = addDays(word.createdAt || todayStr(), intervals[nextIndex] || 0);
  return { nextIndex, dueDate };
}

function initializeMissingNormalSchedules(words, settings) {
  const overdue = [];
  words.forEach(word => {
    if (word.nextReviewDate) return;
    const legacy = computeLegacyNextSchedule(word, settings.intervals);
    word.scheduleStage = legacy.nextIndex;
    word.stageIndex = legacy.nextIndex;
    if (legacy.dueDate >= todayStr()) {
      word.nextReviewDate = legacy.dueDate;
    } else {
      overdue.push({ word, dueDate: legacy.dueDate });
    }
  });
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.word.createdAt || '').localeCompare(String(b.word.createdAt || '')) || String(a.word.word || '').localeCompare(String(b.word.word || '')));
  overdue.forEach((item, index) => {
    item.word.nextReviewDate = addDays(todayStr(), Math.floor(index / settings.longTermDailyLimit));
    item.word.scheduleMigratedAt = todayStr();
    item.word.catchupPending = true;
  });
}

function initializeMissingBacklogSchedules(wrongBook, words, settings) {
  const wordMap = new Map(words.map(word => [word.id, word]));
  const missing = wrongBook.filter(item => item.active !== false && !item.nextReviewDate);
  missing.sort((a, b) => {
    const countDiff = (Number(b.errorCount) || 0) - (Number(a.errorCount) || 0);
    if (countDiff !== 0) return countDiff;
    const wa = wordMap.get(a.wordId) || {};
    const wb = wordMap.get(b.wordId) || {};
    const dateDiff = String(wa.createdAt || '').localeCompare(String(wb.createdAt || ''));
    if (dateDiff !== 0) return dateDiff;
    return String(wa.word || '').localeCompare(String(wb.word || ''));
  });
  missing.forEach((item, index) => {
    item.source = item.source || 'legacyBacklog';
    item.nextReviewDate = addDays(todayStr(), Math.floor(index / settings.backlogDailyLimit));
    item.firstScheduledAt = todayStr();
  });
}

function sanitizeImportedState(parsed) {
  const raw = parsed || {};
  const settings = normalizeSettings(raw.settings || {});
  const words = Array.isArray(raw.words) ? raw.words.map(word => normalizeWord(word)) : [];
  const ids = new Set(words.map(word => word.id));
  const seen = new Map();
  if (Array.isArray(raw.wrongBook)) {
    raw.wrongBook.forEach(item => {
      if (!item || !ids.has(String(item.wordId))) return;
      const wordId = String(item.wordId);
      const existing = seen.get(wordId);
      const normalized = {
        wordId,
        errorCount: item.errorCount != null || item.totalErrorCount != null ? Math.max(0, Number(item.errorCount ?? item.totalErrorCount ?? 0)) : 1,
        weakCount: Math.max(0, Number(item.weakCount || 0)),
        active: item.active !== false,
        source: String(item.source || ''),
        nextReviewDate: item.nextReviewDate ? String(item.nextReviewDate) : '',
        lastReviewDate: item.lastReviewDate ? String(item.lastReviewDate) : '',
        lastResult: item.lastResult ? String(item.lastResult) : '',
        recoveryStage: Math.max(0, Number(item.recoveryStage || 0)),
        masteryStreak: Math.max(0, Number(item.masteryStreak || 0)),
        lastErrorDate: item.lastErrorDate ? String(item.lastErrorDate) : '',
        lastWeakDate: item.lastWeakDate ? String(item.lastWeakDate) : '',
        firstScheduledAt: item.firstScheduledAt ? String(item.firstScheduledAt) : '',
      };
      if (!existing || normalized.errorCount > existing.errorCount) seen.set(wordId, normalized);
    });
  }
  const wrongBook = [...seen.values()];
  const wordMapForCounts = new Map(words.map(word => [word.id, word]));
  wrongBook.forEach(item => {
    const word = wordMapForCounts.get(item.wordId);
    if (word) word.totalErrorCount = Math.max(Number(word.totalErrorCount || 0), Number(item.errorCount || 0));
  });
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
        usedHint: Boolean(log?.usedHint),
        forcedAgain: Boolean(log?.forcedAgain),
      }))
    : [];
  initializeMissingNormalSchedules(words, settings);
  initializeMissingBacklogSchedules(wrongBook, words, settings);
  return { settings, words, wrongBook, logs };
}

function getBatchSize() {
  return Number(state.settings?.dailyQuota) || 10;
}

function normalizeWord(word = {}) {
  const normalized = {
    id: String(word.id || uuid()),
    word: String(word.word || ''),
    meaning: String(word.meaning || ''),
    example: String(word.example || ''),
    exampleMeaning: String(word.exampleMeaning || word.exampleTranslation || ''),
    phonetic: String(word.phonetic || ''),
    tags: Array.isArray(word.tags) ? word.tags.map(String) : [],
    createdAt: String(word.createdAt || todayStr()),
    stageIndex: Math.max(0, Number(word.stageIndex || word.scheduleStage || 0)),
    scheduleStage: Math.max(0, Number(word.scheduleStage ?? word.stageIndex ?? 0)),
    nextReviewDate: word.nextReviewDate ? String(word.nextReviewDate) : '',
    reviewedOnDates: Array.isArray(word.reviewedOnDates) ? word.reviewedOnDates.map(String) : [],
    lastReviewDate: word.lastReviewDate ? String(word.lastReviewDate) : null,
    lastFinalRating: word.lastFinalRating ? String(word.lastFinalRating) : null,
    totalErrorCount: Math.max(0, Number(word.totalErrorCount || 0)),
    weakCount: Math.max(0, Number(word.weakCount || 0)),
    hintUseCount: Math.max(0, Number(word.hintUseCount || 0)),
    scheduleMigratedAt: word.scheduleMigratedAt ? String(word.scheduleMigratedAt) : '',
    catchupPending: Boolean(word.catchupPending),
  };
  return normalized;
}

function getYearOptions() {
  const years = new Set([new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]);
  state.words.forEach(word => {
    if (word.createdAt) years.add(Number(word.createdAt.slice(0, 4)));
  });
  return [...years].filter(Number.isFinite).sort((a, b) => a - b);
}

function getWrongBookMap() {
  return new Map((state.wrongBook || []).filter(item => item.active !== false).map(item => [item.wordId, item.errorCount]));
}

function getWrongBookIds() {
  return new Set((state.wrongBook || []).filter(item => item.active !== false).map(item => item.wordId));
}

function getWrongBookItems(options = {}) {
  const dueOnly = Boolean(options.dueOnly);
  const wordMap = new Map(state.words.map(word => [word.id, word]));
  return (state.wrongBook || [])
    .filter(item => item.active !== false)
    .filter(item => !dueOnly || !item.nextReviewDate || item.nextReviewDate <= todayStr())
    .map(item => {
      const word = wordMap.get(item.wordId);
      return word ? { ...word, ...item, id: word.id, errorCount: item.errorCount } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const sourceDiff = (a.source === 'recent' ? 0 : 1) - (b.source === 'recent' ? 0 : 1);
      if (dueOnly && sourceDiff !== 0) return sourceDiff;
      const dateDiff = String(a.nextReviewDate || '').localeCompare(String(b.nextReviewDate || ''));
      if (dateDiff !== 0) return dateDiff;
      if (sourceDiff !== 0) return sourceDiff;
      const countDiff = (Number(b.errorCount) || 0) - (Number(a.errorCount) || 0);
      if (countDiff !== 0) return countDiff;
      const createdDiff = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      if (createdDiff !== 0) return createdDiff;
      return String(a.word || '').localeCompare(String(b.word || ''));
    });
}

function dateDiffDays(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

function getCoreIntervals() {
  return state.settings.intervals.filter(day => day <= 30);
}

function getLongTermIntervals() {
  return state.settings.intervals.filter(day => day > 30);
}

function getCoreDueInfo(word, targetDate = todayStr()) {
  const age = dateDiffDays(word.createdAt || targetDate, targetDate);
  const interval = getCoreIntervals().find(day => day === age);
  if (interval == null) return null;
  if ((word.reviewedOnDates || []).includes(targetDate)) return null;
  return { interval, stageIndex: state.settings.intervals.indexOf(interval) };
}

function getNormalQueueGroups(targetDate = todayStr()) {
  const sorter = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.word || '').localeCompare(String(b.word || ''));
  const coreDue = [];
  const longTermDue = [];

  state.words.forEach(word => {
    const coreInfo = getCoreDueInfo(word, targetDate);
    if (coreInfo) {
      coreDue.push(word);
      return;
    }
    const stage = Math.min(Number(word.scheduleStage || 0), state.settings.intervals.length - 1);
    const interval = state.settings.intervals[stage] ?? 0;
    if (interval > 30 && word.nextReviewDate && word.nextReviewDate <= targetDate && !(word.reviewedOnDates || []).includes(targetDate)) {
      longTermDue.push(word);
    }
  });

  return { coreDue: coreDue.sort(sorter), longTermDue: longTermDue.sort((a, b) => String(a.nextReviewDate || '').localeCompare(String(b.nextReviewDate || '')) || sorter(a, b)) };
}

function getTodayDueWords(targetDate = todayStr()) {
  return getNormalQueueGroups(targetDate).coreDue;
}


function getLogDateStr(log) {
  const raw = String(log?.ts || '');
  const m = raw.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : formatDate(parsed);
}

function getTodayCompletedTaskKeys(mode, targetDate = todayStr()) {
  const source = getReviewModeLabel(mode);
  const keys = new Set();
  (state.logs || []).forEach(log => {
    if (log?.source !== source || log?.pass !== '中→英' || getLogDateStr(log) !== targetDate) return;
    const key = log.wordId || log.word;
    if (key) keys.add(String(key));
  });
  return keys;
}

function getSavedTodayTaskSession(mode) {
  const key = `today:${mode}`;
  if (reviewSession && reviewSession.contextKey === key && !reviewSession.completed) return reviewSession;
  const saved = readReviewSessions()[key];
  return saved && !saved.completed ? saved : null;
}

function getTodayTaskProgress(mode, dueAvailableCount, dailyLimit = null) {
  const completed = getTodayCompletedTaskKeys(mode).size;
  const saved = getSavedTodayTaskSession(mode);
  let total;
  if (saved?.queueIds?.length) {
    total = saved.queueIds.length;
  } else if (dailyLimit == null) {
    total = completed + Math.max(0, Number(dueAvailableCount || 0));
  } else {
    total = Math.min(Math.max(0, Number(dailyLimit || 0)), completed + Math.max(0, Number(dueAvailableCount || 0)));
  }
  return { completed: Math.min(completed, total), total, done: total > 0 && completed >= total };
}

function formatTaskProgressMeta(progress) {
  if (!progress.total) return '今日无任务';
  return `今日 ${progress.completed}/${progress.total}${progress.done ? ' · 已完成' : ''}`;
}

function getTodayLongTermWords(targetDate = todayStr()) {
  const limit = Math.max(0, Number(state.settings.longTermDailyLimit || 0));
  const completed = getTodayCompletedTaskKeys('longterm', targetDate).size;
  const remainingLimit = Math.max(0, limit - completed);
  const words = getNormalQueueGroups(targetDate).longTermDue;
  return remainingLimit === 0 ? [] : words.slice(0, remainingLimit);
}

function getBatchSummary(targetDate = todayStr()) {
  const dueWords = getTodayDueWords(targetDate);
  const sessionIsCurrent = reviewSession
    && reviewSession.contextKey === 'today:due'
    && !reviewSession.completed;
  return getCoreIntervals().map(interval => {
    const sourceDate = addDays(targetDate, -interval);
    const words = dueWords.filter(word => {
      const info = getCoreDueInfo(word, targetDate);
      return info && info.interval === interval;
    });
    let phase1Done = 0;
    let phase2Done = 0;
    if (sessionIsCurrent) {
      words.forEach(word => {
        const result = reviewSession.roundRatings?.[word.id] || {};
        if (result.phase1) phase1Done += 1;
        if (result.phase2) phase2Done += 1;
      });
    }
    return {
      interval,
      sourceDate,
      count: words.length,
      phase1Done,
      phase2Done,
      phase1Remaining: Math.max(0, words.length - phase1Done),
      phase2Remaining: Math.max(0, words.length - phase2Done),
    };
  });
}

function getPlannedCoreReviewCount(targetDate) {
  return getCoreIntervals().reduce((total, interval) => {
    const sourceDate = addDays(targetDate, -interval);
    return total + state.words.filter(word => word.createdAt === sourceDate).length;
  }, 0);
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
  const diagnostics = { local: {}, indexedDB: {}, legacy: [] };
  const candidates = [];
  let idbMeta = null;

  const localMetaResult = readLocalJSON(LS_META_KEY);
  diagnostics.local.metaStatus = localMetaResult.status;
  const localMeta = localMetaResult.status === 'ok' ? localMetaResult.value : null;

  const currentLocalResult = readLocalJSON(LS_STATE_KEY);
  diagnostics.local.currentStatus = currentLocalResult.status;
  if (currentLocalResult.status === 'ok') {
    const candidate = normalizeStoredCandidate(currentLocalResult.value, 'local-current', localMeta);
    diagnostics.local.currentValidation = candidate.ok ? 'ok' : candidate.error;
    if (candidate.ok) candidates.push(candidate);
  } else if (currentLocalResult.status === 'corrupt') {
    diagnostics.local.corruptRawLength = currentLocalResult.raw?.length || 0;
  }

  if (db) {
    try {
      idbMeta = await dbGetFrom(STORE_META, META_KEY) || null;
      diagnostics.indexedDB.metaStatus = idbMeta ? 'ok' : 'missing';
    } catch (error) {
      diagnostics.indexedDB.metaStatus = 'read_error';
      diagnostics.indexedDB.metaError = error?.message || String(error);
    }
    try {
      const idbCurrent = await dbGetFrom(STORE_CURRENT, CURRENT_STATE_KEY);
      diagnostics.indexedDB.currentStatus = idbCurrent ? 'ok' : 'missing';
      if (idbCurrent) {
        const candidate = normalizeStoredCandidate(idbCurrent, 'indexeddb-current', idbMeta);
        diagnostics.indexedDB.currentValidation = candidate.ok ? 'ok' : candidate.error;
        if (candidate.ok) candidates.push(candidate);
      }
    } catch (error) {
      diagnostics.indexedDB.currentStatus = 'read_error';
      diagnostics.indexedDB.currentError = error?.message || String(error);
    }
  } else {
    diagnostics.indexedDB.openStatus = 'error';
    diagnostics.indexedDB.openError = dbOpenError?.message || 'IndexedDB 不可用';
  }

  for (const legacyKey of LEGACY_LS_STATE_KEYS) {
    const result = readLocalJSON(legacyKey);
    diagnostics.legacy.push({ key: legacyKey, status: result.status });
    if (result.status === 'ok') {
      const candidate = normalizeStoredCandidate(result.value, `legacy-local:${legacyKey}`);
      if (candidate.ok) candidates.push(candidate);
    }
  }

  if (db) {
    try {
      const legacyIdb = await dbGetFrom(STORE_APP, APP_STATE_KEY);
      diagnostics.indexedDB.legacyStatus = legacyIdb ? 'ok' : 'missing';
      if (legacyIdb) {
        const candidate = normalizeStoredCandidate(legacyIdb, 'legacy-indexeddb');
        if (candidate.ok) candidates.push(candidate);
      }
    } catch (error) {
      diagnostics.indexedDB.legacyStatus = 'read_error';
      diagnostics.indexedDB.legacyError = error?.message || String(error);
    }
  }

  const initializedBefore = getInitializedFlag() || Boolean(localMeta?.initialized) || Boolean(idbMeta?.initialized);
  const currentHasError = ['corrupt', 'read_error'].includes(currentLocalResult.status)
    || diagnostics.indexedDB.currentStatus === 'read_error'
    || diagnostics.local.currentValidation && diagnostics.local.currentValidation !== 'ok'
    || diagnostics.indexedDB.currentValidation && diagnostics.indexedDB.currentValidation !== 'ok';

  if (!candidates.length) {
    if (!initializedBefore && !currentHasError) {
      const fresh = sanitizeImportedState(cloneValue(defaultState));
      await persistPreparedState(fresh, { allowLargeDecrease: true, revision: 1, skipDailySnapshot: true });
      await createSnapshot('first-use', fresh);
      return true;
    }
    setFatalDataError('没有找到可验证的词库状态。程序已停止初始化，未写入空数据库。', { diagnostics });
    await loadSnapshotSummaries();
    return false;
  }

  candidates.sort(compareCandidates);
  const selected = candidates[0];
  const knownMetas = [localMeta, idbMeta, ...candidates.map(item => item.metadata)].filter(Boolean).sort((a, b) => Number(b.revision || 0) - Number(a.revision || 0));
  const strongestMeta = knownMetas[0] || selected.metadata;
  const selectedWordCount = selected.state.words.length;
  const knownWordCount = Math.max(0, Number(strongestMeta.lastKnownWordCount || 0));
  const selectedLogCount = selected.state.logs.length;
  const knownLogCount = Math.max(0, Number(strongestMeta.lastKnownLogCount || 0));
  const suspiciousEmpty = knownWordCount > 0 && selectedWordCount === 0;
  const suspiciousShrink = knownWordCount >= 50 && knownWordCount - selectedWordCount >= 20 && selectedWordCount < knownWordCount * 0.5;
  const suspiciousLogShrink = knownLogCount >= 200 && knownLogCount - selectedLogCount >= 100 && selectedLogCount < knownLogCount * 0.5;
  if (suspiciousEmpty || suspiciousShrink || suspiciousLogShrink) {
    setFatalDataError(`检测到异常数据缩减：上次已知 ${knownWordCount} 个词、${knownLogCount} 条记录；当前候选只有 ${selectedWordCount} 个词、${selectedLogCount} 条记录。未覆盖任何存储。`, { diagnostics, selectedSource: selected.source });
    await loadSnapshotSummaries();
    return false;
  }

  state = selected.state;
  currentRevision = Number(selected.metadata.revision || 0);
  lastKnownMeta = { ...selected.metadata, ...strongestMeta };
  setInitializedFlag();

  const isMigration = selected.source.startsWith('legacy-');
  const isVersionUpgrade = Boolean(selected.metadata.appVersion) && selected.metadata.appVersion !== APP_VERSION_NUMBER;
  if (isMigration || isVersionUpgrade) {
    const migrationSource = isVersionUpgrade ? `${selected.source}:${selected.metadata.appVersion}->${APP_VERSION_NUMBER}` : selected.source;
    await createSnapshot(`migration-before:${migrationSource}`, state);
    await persistPreparedState(state, {
      allowLargeDecrease: true,
      migratedFrom: migrationSource,
      migrationTime: new Date().toISOString(),
    });
  } else {
    storageHealth.localStorage = currentLocalResult.status === 'ok' ? 'ok' : 'error';
    storageHealth.indexedDB = diagnostics.indexedDB.currentStatus === 'ok' ? 'ok' : 'error';
    storageHealth.warning = storageHealth.localStorage === 'ok' && storageHealth.indexedDB === 'ok'
      ? ''
      : '当前仅从一份有效存储加载。下次成功保存会尝试修复镜像。';
  }
  await loadSnapshotSummaries();
  return true;
}

async function saveState(nextState = state, options = {}) {
  const immutableInput = cloneValue(nextState);
  const task = async () => {
    const prepared = sanitizeImportedState(immutableInput);
    if (!options.skipDailySnapshot && lastKnownMeta?.lastDailySnapshotDate !== todayStr()) {
      await createSnapshot('daily-first-save', state);
      options = { ...options, lastDailySnapshotDate: todayStr() };
    }
    if (options.snapshotReason) await createSnapshot(options.snapshotReason, state);
    return persistPreparedState(prepared, options);
  };
  saveQueue = saveQueue.catch(() => undefined).then(task);
  return saveQueue;
}


function setReviewControlsDisabled(disabled) {
  const selectors = [
    '#hintBtn', '#showAnswerBtn', '#giveUpBtn', '#skipBtn', '#reviewSpeakBtn',
    '#ratingWrap button', '#wrongbookReviewBox button', '#wrongbookReviewBox input',
  ];
  document.querySelectorAll(selectors.join(',')).forEach(element => {
    element.disabled = Boolean(disabled);
  });
}

async function runReviewSubmission(kind, operation) {
  if (reviewSubmitting || appLocked) return;
  reviewSubmitting = true;
  const beforeState = cloneValue(state);
  const beforeNormal = reviewSession ? cloneValue(reviewSession) : null;
  const beforeWrong = wrongBookSession ? cloneValue(wrongBookSession) : null;
  setReviewControlsDisabled(true);
  showToast('处理中…');
  try {
    await operation();
    persistNormalReviewSession();
    await saveState();
    if (kind === 'normal') {
      resetWrongBookSession();
      renderReview();
    } else {
      renderWrongBook();
    }
    renderDashboard();
  } catch (error) {
    state = beforeState;
    reviewSession = beforeNormal;
    wrongBookSession = beforeWrong;
    showToast(`保存失败：${error?.message || error}`);
    if (appLocked) {
      setFatalDataError('评分保存失败，且两份本地存储均不可用。程序已锁定，避免继续产生未保存操作。', { error: error?.message || String(error) });
      await loadSnapshotSummaries();
      renderFatalDataError();
    } else if (kind === 'normal') {
      renderReview();
    } else {
      renderWrongBook();
    }
  } finally {
    reviewSubmitting = false;
    setReviewControlsDisabled(false);
  }
}


function readReviewSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_REVIEW_SESSIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeReviewSessions(sessions) {
  try {
    localStorage.setItem(LS_REVIEW_SESSIONS_KEY, JSON.stringify(sessions || {}));
  } catch (error) {
    console.warn('复习会话保存失败', error);
  }
}

function persistNormalReviewSession() {
  if (!reviewSession || !reviewSession.contextKey) return;
  const sessions = readReviewSessions();
  if (reviewSession.completed) delete sessions[reviewSession.contextKey];
  else sessions[reviewSession.contextKey] = cloneValue(reviewSession);
  writeReviewSessions(sessions);
}

function restoreNormalReviewSession(contextKey = getReviewContextKey()) {
  const sessions = readReviewSessions();
  const saved = sessions[contextKey];
  if (!saved || saved.completed || saved.contextKey !== contextKey) return null;
  const validIds = new Set(state.words.map(word => word.id));
  const queueIds = Array.isArray(saved.queueIds) ? saved.queueIds.filter(id => validIds.has(id)) : [];
  const currentPoolIds = Array.isArray(saved.currentPoolIds) ? saved.currentPoolIds.filter(id => validIds.has(id)) : [];
  if (!queueIds.length || !currentPoolIds.length) {
    delete sessions[contextKey];
    writeReviewSessions(sessions);
    return null;
  }
  return { ...saved, queueIds, currentPoolIds, orderedIds: Array.isArray(saved.orderedIds) ? saved.orderedIds.filter(id => validIds.has(id)) : queueIds.slice() };
}

function clearStoredNormalReviewSession(contextKey = null) {
  if (!contextKey) {
    try { localStorage.removeItem(LS_REVIEW_SESSIONS_KEY); } catch {}
    return;
  }
  const sessions = readReviewSessions();
  delete sessions[contextKey];
  writeReviewSessions(sessions);
}

function activateNormalReviewTask(mode, context = { type: 'today', sourceDate: null }) {
  persistNormalReviewSession();
  reviewContext = context;
  normalReviewMode = mode;
  reviewSession = restoreNormalReviewSession(getReviewContextKey());
  lastAutoSpokenKey = '';
}

function resetNormalReviewSession(options = {}) {
  const { clearAllStored = true } = options;
  reviewSession = null;
  if (clearAllStored) clearStoredNormalReviewSession();
}

function resetWrongBookSession() {
  wrongBookSession = null;
}

function getTodayBacklogWords() {
  const limit = Math.max(0, Number(state.settings.backlogDailyLimit || 0));
  const completed = getTodayCompletedTaskKeys('backlog').size;
  const remainingLimit = Math.max(0, limit - completed);
  const items = getWrongBookItems({ dueOnly: true }).filter(item => item.source !== 'recent');
  return remainingLimit === 0 ? [] : items.slice(0, remainingLimit);
}

function getTodayWeakWords() {
  const limit = Math.max(0, Number(state.settings.weakDailyLimit || 0));
  const completed = getTodayCompletedTaskKeys('weak').size;
  const remainingLimit = Math.max(0, limit - completed);
  const items = getWrongBookItems({ dueOnly: true }).filter(item => item.source === 'recent');
  return remainingLimit === 0 ? [] : items.slice(0, remainingLimit);
}

function getReviewModeLabel(mode = normalReviewMode) {
  return ({ due: '今日到期', backlog: '历史积压', longterm: '长期巩固', weak: '薄弱词恢复' })[mode] || '复习';
}

function buildNormalQueue() {
  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    return state.words.filter(word => word.createdAt === reviewContext.sourceDate).sort((a, b) => a.word.localeCompare(b.word));
  }
  if (normalReviewMode === 'backlog') return getTodayBacklogWords();
  if (normalReviewMode === 'longterm') return getTodayLongTermWords(todayStr());
  if (normalReviewMode === 'weak') return getTodayWeakWords();
  return getTodayDueWords(todayStr());
}

function getReviewContextKey() {
  return reviewContext.type === 'batch' && reviewContext.sourceDate ? `batch:${reviewContext.sourceDate}` : `today:${normalReviewMode}`;
}

function buildStableNormalOrder(queue) {
  if (reviewContext.type === 'today' && normalReviewMode === 'due') {
    const targetDate = todayStr();
    const ordered = [];
    [...getCoreIntervals()].sort((a, b) => b - a).forEach(interval => {
      const stageIds = queue
        .filter(word => getCoreDueInfo(word, targetDate)?.interval === interval)
        .map(word => word.id);
      ordered.push(...shuffleArray(stageIds));
    });
    return ordered;
  }
  return shuffleArray(queue.map(word => word.id));
}

function startNormalReviewSession() {
  const queue = buildNormalQueue();
  const orderedIds = buildStableNormalOrder(queue);
  reviewSession = {
    type: 'normal',
    contextKey: getReviewContextKey(),
    queueIds: queue.map(w => w.id),
    orderedIds,
    batchSize: getBatchSize(),
    batchIndex: 0,
    phase: 1,
    wordIndex: 0,
    showAnswer: false,
    inputValue: '',
    selectedRating: '',
    completed: false,
    roundRatings: {},
    autoAgainReady: false,
    currentPoolIds: orderedIds.slice(),
    remedialRound: 0,
    usedHint: false,
    forcedAgain: false,
  };
  persistNormalReviewSession();
}

function startWrongBookSession(queueOverride = null, remedialRound = 0) {
  const queue = queueOverride || getWrongBookItems({ dueOnly: true });
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
    roundRatings: {},
    autoAgainReady: false,
    usedHint: false,
    forcedAgain: false,
    remedialIds: [],
    remedialRound,
  };
}

function ensureNormalReviewSession() {
  const contextKey = getReviewContextKey();
  if (!reviewSession || reviewSession.contextKey !== contextKey) {
    reviewSession = restoreNormalReviewSession(contextKey);
  }
  if (!reviewSession || reviewSession.contextKey !== contextKey || reviewSession.batchSize !== getBatchSize()) {
    startNormalReviewSession();
    return;
  }
  if (reviewSession.completed && reviewContext.type === 'today' && buildNormalQueue().length > 0) {
    startNormalReviewSession();
  }
}

function ensureWrongBookSession() {
  if (!wrongBookSession || wrongBookSession.batchSize !== getBatchSize()) {
    startWrongBookSession();
    return;
  }
  if ((wrongBookSession.completed || wrongBookSession.roundCompleted) && getWrongBookItems({ dueOnly: true }).length === 0) {
    startWrongBookSession();
  }
}

function getSessionBatch(session) {
  if (session.type === 'wrongbook') {
    const queue = session.queueIds.map(id => {
      const word = state.words.find(w => w.id === id);
      const entry = state.wrongBook.find(item => item.wordId === id);
      return word ? { ...word, ...(entry || {}), id: word.id, errorCount: entry?.errorCount ?? word.totalErrorCount ?? 1 } : null;
    }).filter(Boolean);
    const batches = chunk(queue, session.batchSize);
    const baseBatch = batches[session.batchIndex] || [];
    const orderKey = `${session.remedialRound || 0}_${session.batchIndex}`;
    session.batchOrders = session.batchOrders || {};
    if (!session.batchOrders[orderKey]) {
      session.batchOrders[orderKey] = shuffleArray(baseBatch.map(word => word.id));
    }
    const batch = session.batchOrders[orderKey].map(id => baseBatch.find(word => word.id === id)).filter(Boolean);
    return { queue, batches, batch, item: batch[session.wordIndex] || null };
  }

  const queue = session.queueIds.map(id => state.words.find(word => word.id === id)).filter(Boolean);
  const poolIds = Array.isArray(session.currentPoolIds) ? session.currentPoolIds : (session.orderedIds || session.queueIds);
  const poolWords = poolIds.map(id => state.words.find(word => word.id === id)).filter(Boolean);
  const batches = chunk(poolWords, session.batchSize);
  const batch = batches[session.batchIndex] || [];
  return { queue, batches, batch, item: batch[session.wordIndex] || null, baseBatches: batches };
}

function renderDashboard() {
  const today = todayStr();
  const groups = getNormalQueueGroups(today);
  const dueWords = groups.coreDue;
  const longTermAll = groups.longTermDue;
  const longTermReleased = getTodayLongTermWords(today);
  const dueRecovery = getWrongBookItems({ dueOnly: true });
  const activeWrong = getWrongBookItems();
  const backlogAll = activeWrong.filter(item => item.source !== 'recent');
  const weakAll = activeWrong.filter(item => item.source === 'recent');
  const backlogReleased = getTodayBacklogWords();
  const weakReleased = getTodayWeakWords();
  const recentDue = dueRecovery.filter(item => item.source === 'recent').length;
  const legacyDue = dueRecovery.filter(item => item.source !== 'recent').length;
  const newCount = state.words.filter(word => word.createdAt === today).length;
  const batchSummary = getBatchSummary(today);

  const dueProgress = getTodayTaskProgress('due', dueWords.length);
  const backlogProgress = getTodayTaskProgress('backlog', legacyDue, state.settings.backlogDailyLimit);
  const longTermProgress = getTodayTaskProgress('longterm', longTermAll.length, state.settings.longTermDailyLimit);
  const weakProgress = getTodayTaskProgress('weak', recentDue, state.settings.weakDailyLimit);
  const coreIntervalsText = getCoreIntervals().join('/') || '未设置';
  const longTermIntervalsText = getLongTermIntervals().join('/') || '未设置';

  document.getElementById('todayDueCount').textContent = dueProgress.total || dueWords.length;
  document.getElementById('todayBacklogCount').textContent = backlogAll.length;
  document.getElementById('todayLongTermCount').textContent = longTermAll.length;
  document.getElementById('todayWeakCount').textContent = weakAll.length;
  document.getElementById('dueTaskMeta').textContent = formatTaskProgressMeta(dueProgress);
  document.getElementById('backlogTaskMeta').textContent = formatTaskProgressMeta(backlogProgress);
  document.getElementById('longTermTaskMeta').textContent = formatTaskProgressMeta(longTermProgress);
  document.getElementById('weakTaskMeta').textContent = formatTaskProgressMeta(weakProgress);
  document.getElementById('todayNewQuota').textContent = state.settings.dailyQuota;
  document.getElementById('totalWordCount').textContent = state.words.length;
  document.getElementById('todayPlan').innerHTML = `
    <p>① 今日到期（${coreIntervalsText} 天）：<strong>${dueProgress.completed}/${dueProgress.total}</strong>${dueProgress.done ? '，已完成。' : '。'}</p>
    <p>② 历史积压：当前待处理 <strong>${legacyDue}</strong> 个；今日 <strong>${backlogProgress.completed}/${backlogProgress.total}</strong>${backlogProgress.done ? '，已完成。' : '。'}</p>
    <p>③ 长期巩固（${longTermIntervalsText} 天）：当前待处理 <strong>${longTermAll.length}</strong> 个；今日 <strong>${longTermProgress.completed}/${longTermProgress.total}</strong>${longTermProgress.done ? '，已完成。' : '。'}</p>
    <p>④ 当日 Again：在当前任务两轮结束后自动循环，直到当日记住。</p>
    <p>⑤ Hard / Again 薄弱词恢复：当前待处理 <strong>${recentDue}</strong> 个；今日 <strong>${weakProgress.completed}/${weakProgress.total}</strong>${weakProgress.done ? '，已完成。' : '。'}</p>
    <p>今天已录入新词 <strong>${newCount}</strong> / ${state.settings.dailyQuota}。${newCount < state.settings.dailyQuota ? `还可新增 <strong>${state.settings.dailyQuota - newCount}</strong> 个。` : '<span style="color:#059669">今日新词目标已达到。</span>'}</p>
  `;
  const descendingCore = [...getCoreIntervals()].sort((a, b) => b - a).join('→') || '未设置';
  document.getElementById('usageNotes').innerHTML = `
    <p>1. 今日到期按 ${descendingCore} 天批次排列，批次内随机；全部先完成英文→中文，再按相同顺序完成中文→英文。</p>
    <p>2. 首页四个任务共用同一复习界面；完成一个任务后返回今日页，再自行选择下一项。</p>
    <p>3. 历史积压、长期巩固和薄弱词恢复分别按各自每日上限释放，互不合并；今日进度按完成两轮的单词计数。</p>
    <p>4. Again 会在当前任务两轮结束后进入当日循环；Hard / Again 同时记录到后续薄弱词恢复。</p>
    <p>5. 轻提示后本题最高只能判 Hard；“不会，显示答案”自动判 Again。</p>
  `;
  const duePhase1Done = batchSummary.reduce((sum, item) => sum + item.phase1Done, 0);
  const duePhase2Done = batchSummary.reduce((sum, item) => sum + item.phase2Done, 0);
  document.getElementById('batchSummary').innerHTML = batchSummary.length
    ? `<p><strong>整体进度：</strong>英→中 ${duePhase1Done}/${dueWords.length}；中→英 ${duePhase2Done}/${dueWords.length}</p>`
      + batchSummary.map(item => `
        <p>${item.interval} 天前批次｜${item.sourceDate} 新增：共 <strong>${item.count}</strong> 个；
        英→中剩余 <strong>${item.phase1Remaining}</strong>；中→英剩余 <strong>${item.phase2Remaining}</strong></p>
      `).join('')
    : '<p class="muted">今天没有 0–30 天阶段真正到期的单词。</p>';
  document.getElementById('appVersionLine').textContent = `Version: ${APP_VERSION}`;
  const openTask = mode => {
    activateNormalReviewTask(mode, { type: 'today', sourceDate: null });
    switchTab('review');
  };
  document.getElementById('openDueTaskBtn').onclick = () => openTask('due');
  document.getElementById('openBacklogTaskBtn').onclick = () => openTask('backlog');
  document.getElementById('openLongTermTaskBtn').onclick = () => openTask('longterm');
  document.getElementById('openWeakTaskBtn').onclick = () => openTask('weak');
}


function renderReview() {
  ensureNormalReviewSession();
  persistNormalReviewSession();
  const title = document.getElementById('reviewSectionTitle');
  const banner = document.getElementById('reviewBanner');
  const summary = document.getElementById('reviewSummary');
  const done = document.getElementById('reviewDone');
  const box = document.getElementById('reviewBox');
  const audioStartBox = document.getElementById('reviewAudioStartBox');

  if (reviewContext.type === 'batch' && reviewContext.sourceDate) {
    title.textContent = `${reviewContext.sourceDate} 批次复习`;
    banner.textContent = `当前来自日历：${reviewContext.sourceDate} 批次。`;
    banner.classList.remove('hidden');
  } else {
    title.textContent = `${getReviewModeLabel()}复习`;
    banner.classList.add('hidden');
    banner.textContent = '';
  }

  const session = reviewSession;
  const { queue, batches, batch, item } = getSessionBatch(session);
  if (session.completed) {
    box.classList.add('hidden');
    summary.classList.add('hidden');
    audioStartBox.classList.add('hidden');
    done.innerHTML = `${getReviewModeLabel()}两轮已完成。<div class="button-row wrap" style="margin-top:12px;"><button class="btn primary" id="returnDashboardBtn">返回今日页</button></div>`;
    done.classList.remove('hidden');
    document.getElementById('returnDashboardBtn').onclick = () => { clearStoredNormalReviewSession(session.contextKey); reviewSession = null; switchTab('dashboard'); };
    return;
  }

  done.classList.add('hidden');
  if (queue.length === 0 || !item) {
    box.classList.add('hidden');
    audioStartBox.classList.add('hidden');
    summary.classList.remove('hidden');
    summary.innerHTML = `当前没有需要处理的${getReviewModeLabel()}词。<div class="button-row wrap" style="margin-top:12px;"><button class="btn" id="emptyReturnDashboardBtn">返回今日页</button></div>`;
    document.getElementById('emptyReturnDashboardBtn').onclick = () => switchTab('dashboard');
    return;
  }

  box.classList.remove('hidden');
  summary.classList.remove('hidden');
  const overallIndex = Math.min(session.batchIndex * session.batchSize + session.wordIndex + 1, session.currentPoolIds.length);
  summary.textContent = `${getReviewModeLabel()} · ${session.remedialRound ? `当日 Again 补救第 ${session.remedialRound} 轮 · ` : ''}第 ${session.phase} 轮 ${session.phase === 1 ? '英→中' : '中→英'} · 总进度 ${overallIndex}/${session.currentPoolIds.length} · 小批次 ${Math.min(session.batchIndex + 1, batches.length)}/${batches.length} · 批内 ${Math.min(session.wordIndex + 1, batch.length)}/${batch.length}`;
  const needsAudioStart = reviewContext.type === 'today' && state.settings.autoPronounce && !reviewAudioEnabled;
  audioStartBox.classList.toggle('hidden', !needsAudioStart);
  if (needsAudioStart) {
    box.classList.add('hidden');
    audioStartBox.innerHTML = '<button class="btn primary" id="enableReviewAudioBtn">开始复习并启用发音</button><div class="small muted" style="margin-top:8px;">iPhone 只需点击一次，之后英文→中文会自动发音。</div>';
    document.getElementById('enableReviewAudioBtn').onclick = async () => {
      if (reviewAudioEnabled) return;
      const unlockPromise = unlockPronunciationAudio();
      reviewAudioEnabled = true;
      autoPlaybackBlockedToastShown = false;
      lastAutoSpokenKey = '';
      renderReview();
      const unlocked = await unlockPromise;
      if (!unlocked) showToast('已显示单词；若仍无声，请检查静音键和媒体音量');
      await speakWord(item.word, { auto: false });
    };
    return;
  }
  box.classList.remove('hidden');

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
  const answerExampleMeaning = document.getElementById('answerExampleMeaning');
  const answerExampleMeaningRow = document.getElementById('answerExampleMeaningRow');
  const echoRow = document.getElementById('reviewInputEchoRow');
  const attemptResult = document.getElementById('attemptResult');
  const autoJudge = document.getElementById('reviewAutoJudge');
  const hintBox = document.getElementById('reviewHintBox');
  const speakBtn = document.getElementById('reviewSpeakBtn');
  const preActions = document.getElementById('reviewPreAnswerActions');

  modeText.textContent = session.phase === 1 ? '第一轮：英文 → 中文，先主动回忆目标义项' : '第二轮：中文 → 英文，输入英文拼写';
  prompt.textContent = session.phase === 1 ? item.word : item.meaning;
  const dueInfo = reviewContext.type === 'today' && normalReviewMode === 'due' ? getCoreDueInfo(item, todayStr()) : null;
  const sourceLabel = dueInfo ? `${dueInfo.interval} 天阶段｜${item.createdAt} 新增批次｜今日到期` : ((normalReviewMode === 'longterm') ? `长期巩固｜${item.nextReviewDate || '到期日未设置'}` : `${getReviewModeLabel()}｜${item.nextReviewDate || item.createdAt || '日期未知'}`);
  meta.textContent = `${sourceLabel} ｜ 标签：${(item.tags || []).join(' / ') || '无'}`;
  inputWrap.classList.toggle('hidden', session.phase !== 2);
  if (session.phase === 2) input.value = session.inputValue;

  speakBtn.classList.toggle('hidden', session.phase !== 1 && !session.showAnswer);
  speakBtn.onclick = () => { unlockPronunciationAudio(); speakWord(item.word); };
  if (session.phase === 1) {
    maybeAutoSpeak(item.word, `normal:${item.id}:${session.batchIndex}:${session.remedialRound}:${session.phase}:${session.wordIndex}`);
  } else if (!session.showAnswer) {
    stopPronunciationPlayback();
  }

  if (session.usedHint) {
    hintBox.textContent = session.phase === 1 ? makeMeaningHint(item.meaning) : makeEnglishHint(item.word);
    hintBox.classList.remove('hidden');
  } else {
    hintBox.textContent = '';
    hintBox.classList.add('hidden');
  }

  answerBox.classList.toggle('hidden', !session.showAnswer);
  ratingWrap.classList.toggle('hidden', !session.showAnswer);
  preActions.classList.toggle('hidden', session.showAnswer);
  answerWord.textContent = item.word;
  answerMeaning.textContent = item.meaning;
  answerExample.textContent = item.example || '—';
  answerExampleMeaning.textContent = item.exampleMeaning || '';
  answerExampleMeaningRow.classList.toggle('hidden', !item.exampleMeaning);
  echoRow.classList.toggle('hidden', session.phase !== 2);
  attemptResult.textContent = session.inputValue || '未输入';
  autoJudge.textContent = '';
  autoJudge.className = 'judge-text';

  let check = null;
  if (session.phase === 2) {
    check = getEnglishCheckResult(session.inputValue, item.word);
    if (session.showAnswer) {
      autoJudge.textContent = check.text;
      autoJudge.classList.add(check.checked ? (check.isCorrect ? 'judge-ok' : 'judge-bad') : 'judge-bad');
      session.autoAgainReady = !check.isCorrect;
    }
  }

  document.getElementById('hintBtn').onclick = () => {
    if (reviewSubmitting) return;
    session.usedHint = true;
    persistNormalReviewSession();
    renderReview();
  };
  document.getElementById('showAnswerBtn').onclick = () => {
    if (reviewSubmitting) return;
    session.showAnswer = true;
    session.inputValue = document.getElementById('reviewInputEnglish').value.trim();
    session.autoAgainReady = session.phase === 2 && !getEnglishCheckResult(session.inputValue, item.word).isCorrect;
    persistNormalReviewSession();
    renderReview();
  };
  document.getElementById('giveUpBtn').onclick = () => {
    if (reviewSubmitting) return;
    session.forcedAgain = true;
    session.showAnswer = true;
    session.inputValue = document.getElementById('reviewInputEnglish').value.trim();
    session.autoAgainReady = true;
    persistNormalReviewSession();
    renderReview();
  };

  const apply = rating => runReviewSubmission('normal', async () => {
    const finalRating = capRatingForHint(rating, session.usedHint);
    await finishNormalReviewStep(finalRating, finalRating === 'Again');
  });

  if (!session.showAnswer) return;

  if (session.forcedAgain || session.autoAgainReady) {
    ratingWrap.innerHTML = `
      <div class="small" style="color:#be123c">${session.forcedAgain ? '已选择“不会”，本题判为 Again。' : '拼写不匹配，本题自动判为 Again。'}</div>
      <div class="button-row wrap"><button class="btn again" data-action="again">已判 Again，下一题</button></div>
    `;
    ratingWrap.querySelector('[data-action="again"]').onclick = () => apply('Again');
    return;
  }

  if (session.usedHint) {
    ratingWrap.innerHTML = `
      <div class="small muted">本题使用了轻提示，最高只能判 Hard。</div>
      <div class="button-row wrap">
        <button class="btn hard" data-action="hard">Hard</button>
        <button class="btn again" data-action="again">Again</button>
      </div>
    `;
    ratingWrap.querySelector('[data-action="hard"]').onclick = () => apply('Hard');
    ratingWrap.querySelector('[data-action="again"]').onclick = () => apply('Again');
    return;
  }

  ratingWrap.innerHTML = `
    <div class="small muted">Easy：完整迅速；Good：主要义项掌握；Hard：回忆困难或遗漏重要义项；Again：核心义项失败。</div>
    <div class="button-row wrap">
      <button class="btn easy" data-action="easy">Easy</button>
      <button class="btn good" data-action="good">Good</button>
      <button class="btn hard" data-action="hard">Hard</button>
      <button class="btn again" data-action="again">Again</button>
    </div>
  `;
  ratingWrap.querySelector('[data-action="easy"]').onclick = () => apply('Easy');
  ratingWrap.querySelector('[data-action="good"]').onclick = () => apply('Good');
  ratingWrap.querySelector('[data-action="hard"]').onclick = () => apply('Hard');
  ratingWrap.querySelector('[data-action="again"]').onclick = () => apply('Again');
}

async function finishNormalReviewStep(rating, addToWrongBook) {
  const session = reviewSession;
  const { batches, batch, item } = getSessionBatch(session);
  if (!item || !rating) return;
  const key = item.id;
  const prev = session.roundRatings[key] || {};
  if (session.phase === 1) {
    prev.phase1 = rating;
    prev.hint1 = Boolean(session.usedHint);
    prev.forced1 = Boolean(session.forcedAgain);
  } else {
    prev.phase2 = rating;
    prev.hint2 = Boolean(session.usedHint);
    prev.forced2 = Boolean(session.forcedAgain);
  }
  session.roundRatings[key] = prev;

  state.logs.unshift({
    id: uuid(), ts: new Date().toLocaleString('zh-CN'), wordId: item.id, word: item.word,
    source: reviewContext.type === 'batch' ? '日历批次复习' : getReviewModeLabel(),
    pass: session.phase === 1 ? '英→中' : '中→英', rating,
    addedToWrongBook: addToWrongBook, inputValue: session.inputValue,
    usedHint: Boolean(session.usedHint), forcedAgain: Boolean(session.forcedAgain),
  });

  const isLastWordInBatch = session.wordIndex >= batch.length - 1;
  const isLastBatch = session.batchIndex >= batches.length - 1;
  session.showAnswer = false;
  session.autoAgainReady = false;
  session.inputValue = '';
  session.usedHint = false;
  session.forcedAgain = false;

  if (!isLastWordInBatch) {
    session.wordIndex += 1;
    persistNormalReviewSession();
    return;
  }
  if (!isLastBatch) {
    session.batchIndex += 1;
    session.wordIndex = 0;
    persistNormalReviewSession();
    return;
  }

  // 整个队列的英→中全部结束后，才统一开始中→英。
  if (session.phase === 1) {
    session.phase = 2;
    session.batchIndex = 0;
    session.wordIndex = 0;
    persistNormalReviewSession();
    return;
  }

  const failedIds = [];
  (session.currentPoolIds || []).forEach(id => {
    const result = session.roundRatings[id] || {};
    const word = state.words.find(w => w.id === id);
    if (!word) return;
    const usedHint = Boolean(result.hint1 || result.hint2);
    const hadAgain = result.phase1 === 'Again' || result.phase2 === 'Again';
    let finalRating = capRatingForHint(worseRating(result.phase1, result.phase2), usedHint);
    if (hadAgain) finalRating = 'Again';
    word.lastReviewDate = todayStr();
    word.lastFinalRating = finalRating || word.lastFinalRating;
    if (['Hard', 'Again'].includes(finalRating)) recordWeakOrError(id, finalRating, usedHint);
    if (hadAgain) {
      failedIds.push(id);
      return;
    }
    if (normalReviewMode === 'backlog' || normalReviewMode === 'weak') {
      settleRecoveryReview(id, finalRating, usedHint);
      return;
    }
    if (normalReviewMode === 'due') {
      const info = getCoreDueInfo(word, todayStr());
      if (info) {
        word.scheduleStage = info.stageIndex;
        word.stageIndex = info.stageIndex;
      }
    }
    advanceNormalSchedule(word, finalRating, usedHint);
  });

  session.roundRatings = {};
  session.batchIndex = 0;
  session.wordIndex = 0;
  if (failedIds.length) {
    session.currentPoolIds = session.currentPoolIds.filter(id => failedIds.includes(id));
    session.remedialRound = (session.remedialRound || 0) + 1;
    session.phase = 1;
    persistNormalReviewSession();
    return;
  }
  session.completed = true;
  clearStoredNormalReviewSession(session.contextKey);
}

function renderWrongBook() {
  const allItems = getWrongBookItems();
  const dueItems = getWrongBookItems({ dueOnly: true });
  renderWrongBookList(allItems);
  ensureWrongBookSession();
  const done = document.getElementById('wrongbookDone');
  const roundDone = document.getElementById('wrongbookRoundDone');
  const box = document.getElementById('wrongbookReviewBox');
  const session = wrongBookSession;

  if (allItems.length === 0) {
    done.textContent = '当前没有活跃薄弱词。历史错误记录仍保留在词条统计中。';
    done.classList.remove('hidden');
    roundDone.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  done.classList.add('hidden');
  if (session.roundCompleted) {
    roundDone.classList.remove('hidden');
    const nextDates = allItems.map(item => item.nextReviewDate).filter(Boolean).sort();
    roundDone.innerHTML = `今天的薄弱词复习已完成。当前仍有 <strong>${allItems.length}</strong> 个活跃词。${nextDates.length ? `下一批日期：${escapeHtml(nextDates[0])}` : ''}`;
    box.innerHTML = '';
    return;
  }

  roundDone.classList.add('hidden');
  const { queue, batches, batch, item } = getSessionBatch(session);
  if (queue.length === 0 || !item) {
    box.innerHTML = `<div class="muted">今天没有到期的薄弱词。当前活跃词 ${allItems.length} 个，已按计划分散到后续日期。</div>`;
    return;
  }

  const check = session.phase === 2 ? getEnglishCheckResult(session.inputValue, item.word) : null;
  if (session.phase === 2 && session.showAnswer) session.autoAgainReady = !check.isCorrect;
  const hintText = session.usedHint ? (session.phase === 1 ? makeMeaningHint(item.meaning) : makeEnglishHint(item.word)) : '';
  const sourceText = item.source === 'recent' ? '近期薄弱词' : '历史积压词';
  box.innerHTML = `
    <div class="summary-pill">${session.remedialRound ? `当天补强第 ${session.remedialRound} 轮 · ` : ''}小批次 ${Math.min(session.batchIndex + 1, batches.length)}/${batches.length} · 第 ${session.phase} 轮 · ${Math.min(session.wordIndex + 1, batch.length)}/${batch.length}</div>
    <p class="muted">${session.phase === 1 ? '第一轮：英文 → 中文' : '第二轮：中文 → 英文'} <span class="source-badge">${sourceText}</span></p>
    <div class="prompt-row">
      <div class="prompt">${escapeHtml(session.phase === 1 ? item.word : item.meaning)}</div>
      ${session.phase === 1 ? '<button class="icon-btn" id="wrongbookSpeakBtn" type="button" aria-label="播放发音">🔊</button>' : ''}
    </div>
    ${hintText ? `<div class="hint-box">${escapeHtml(hintText)}</div>` : ''}
    ${session.phase === 2 ? `<label for="wrongbookInputEnglish">输入你回忆出的英文</label><input id="wrongbookInputEnglish" value="${escapeHtml(session.inputValue)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" data-gramm="false" />` : ''}
    ${!session.showAnswer ? `
      <div class="button-row wrap">
        <button class="btn" id="wrongbookHintBtn">轻提示</button>
        <button class="btn primary" id="wrongbookShowAnswerBtn">核对答案</button>
        <button class="btn again" id="wrongbookGiveUpBtn">不会，显示答案</button>
      </div>
    ` : `
      <div class="answer-box">
        <div class="word-title-row"><p style="margin:0;"><strong>答案：</strong>${escapeHtml(item.word)}</p><button class="icon-btn" id="wrongbookAnswerSpeakBtn" type="button" aria-label="播放发音">🔊</button></div>
        <p><strong>释义：</strong>${escapeHtml(item.meaning)}</p>
        <p><strong>例句：</strong>${escapeHtml(item.example || '—')}</p>
        ${item.exampleMeaning ? `<p><strong>例句中文：</strong>${escapeHtml(item.exampleMeaning)}</p>` : ''}
        <p><strong>累计错误次数：</strong>${Number(item.errorCount || 0)}</p>
        <p><strong>当前连续掌握：</strong>${Number(item.masteryStreak || 0)} / 3</p>
        ${session.phase === 2 ? `<p><strong>你的拼写：</strong>${escapeHtml(session.inputValue || '未输入')}</p><p class="judge-text ${check?.checked ? (check.isCorrect ? 'judge-ok' : 'judge-bad') : 'judge-bad'}">${escapeHtml(check?.text || '')}</p>` : ''}
      </div>
      <div id="wrongbookActions"></div>
    `}
  `;

  if (session.showAnswer) {
    const answerSpeakBtn = document.getElementById('wrongbookAnswerSpeakBtn');
    if (answerSpeakBtn) answerSpeakBtn.onclick = () => { unlockPronunciationAudio(); speakWord(item.word); };
  }

  if (session.phase === 1) {
    document.getElementById('wrongbookSpeakBtn').onclick = () => { unlockPronunciationAudio(); speakWord(item.word); };
    maybeAutoSpeak(item.word, `wrong:${item.id}:${session.remedialRound}:${session.batchIndex}:${session.phase}:${session.wordIndex}`);
  } else {
    if (!session.showAnswer) stopPronunciationPlayback();
    document.getElementById('wrongbookInputEnglish').oninput = e => {
      session.inputValue = e.target.value;
      if (session.showAnswer) renderWrongBook();
    };
  }

  if (!session.showAnswer) {
    document.getElementById('wrongbookHintBtn').onclick = () => {
      if (reviewSubmitting) return;
      session.usedHint = true;
      renderWrongBook();
    };
    document.getElementById('wrongbookShowAnswerBtn').onclick = () => {
      if (reviewSubmitting) return;
      session.showAnswer = true;
      session.autoAgainReady = session.phase === 2 && !getEnglishCheckResult(session.inputValue, item.word).isCorrect;
      renderWrongBook();
    };
    document.getElementById('wrongbookGiveUpBtn').onclick = () => {
      if (reviewSubmitting) return;
      session.forcedAgain = true;
      session.showAnswer = true;
      session.autoAgainReady = true;
      renderWrongBook();
    };
    return;
  }

  const actions = document.getElementById('wrongbookActions');
  const submit = rating => runReviewSubmission('wrongbook', async () => {
    await finishWrongBookReviewStep(capRatingForHint(rating, session.usedHint));
  });

  if (session.forcedAgain || session.autoAgainReady) {
    actions.innerHTML = `<div class="small" style="color:#be123c">${session.forcedAgain ? '已选择“不会”，本题判为 Again。' : '拼写不匹配，本题自动判为 Again。'}</div><div class="button-row wrap"><button class="btn again" data-action="again">已判 Again，下一题</button></div>`;
    actions.querySelector('[data-action="again"]').onclick = () => submit('Again');
  } else if (session.usedHint) {
    actions.innerHTML = `<div class="small muted">使用轻提示后最高只能判 Hard。</div><div class="button-row wrap"><button class="btn hard" data-action="hard">Hard</button><button class="btn again" data-action="again">Again</button></div>`;
    actions.querySelector('[data-action="hard"]').onclick = () => submit('Hard');
    actions.querySelector('[data-action="again"]').onclick = () => submit('Again');
  } else {
    actions.innerHTML = `<div class="small muted">两个方向完成后统一安排下次复习；连续 3 次掌握后退出活跃队列。</div><div class="button-row wrap"><button class="btn easy" data-action="easy">Easy</button><button class="btn good" data-action="good">Good</button><button class="btn hard" data-action="hard">Hard</button><button class="btn again" data-action="again">Again</button></div>`;
    actions.querySelector('[data-action="easy"]').onclick = () => submit('Easy');
    actions.querySelector('[data-action="good"]').onclick = () => submit('Good');
    actions.querySelector('[data-action="hard"]').onclick = () => submit('Hard');
    actions.querySelector('[data-action="again"]').onclick = () => submit('Again');
  }
}

async function finishWrongBookReviewStep(rating) {
  const session = wrongBookSession;
  const { batches, batch, item } = getSessionBatch(session);
  if (!item || !rating) return;
  const result = session.roundRatings[item.id] || {};
  if (session.phase === 1) {
    result.phase1 = rating;
    result.hint1 = Boolean(session.usedHint);
    result.forced1 = Boolean(session.forcedAgain);
  }
  if (session.phase === 2) {
    result.phase2 = rating;
    result.hint2 = Boolean(session.usedHint);
    result.forced2 = Boolean(session.forcedAgain);
  }
  session.roundRatings[item.id] = result;

  state.logs.unshift({
    id: uuid(),
    ts: new Date().toLocaleString('zh-CN'),
    word: item.word,
    source: session.remedialRound ? '错词本当天补强' : '错词本复习',
    pass: session.phase === 1 ? '英→中' : '中→英',
    rating,
    addedToWrongBook: false,
    inputValue: session.inputValue,
    usedHint: Boolean(session.usedHint),
    forcedAgain: Boolean(session.forcedAgain),
  });

  const isLastWordInBatch = session.wordIndex >= batch.length - 1;
  const isLastBatch = session.batchIndex >= batches.length - 1;
  session.showAnswer = false;
  session.autoAgainReady = false;
  session.inputValue = '';
  session.usedHint = false;
  session.forcedAgain = false;

  if (session.phase === 1) {
    if (!isLastWordInBatch) session.wordIndex += 1;
    else {
      session.phase = 2;
      session.wordIndex = 0;
    }
    return;
  }

  const usedHint = Boolean(result.hint1 || result.hint2);
  const hadAgain = result.phase1 === 'Again' || result.phase2 === 'Again';
  let finalRating = capRatingForHint(worseRating(result.phase1, result.phase2), usedHint);
  if (hadAgain) finalRating = 'Again';
  settleRecoveryReview(item.id, finalRating, usedHint);
  if (finalRating === 'Again') session.remedialIds.push(item.id);
  delete session.roundRatings[item.id];

  if (!isLastWordInBatch) {
    session.wordIndex += 1;
  } else if (!isLastBatch) {
    session.batchIndex += 1;
    session.phase = 1;
    session.wordIndex = 0;
  } else {
    const remedialIds = [...new Set(session.remedialIds)];
    if (remedialIds.length && session.remedialRound < 2) {
      const remedialQueue = remedialIds.map(id => {
        const word = state.words.find(w => w.id === id);
        const entry = state.wrongBook.find(row => row.wordId === id);
        return word ? { ...word, ...(entry || {}), id: word.id } : null;
      }).filter(Boolean);
      startWrongBookSession(remedialQueue, session.remedialRound + 1);
    } else {
      session.roundCompleted = true;
    }
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
  const activeRecoveryIds = getWrongBookIds();
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
    const due = getPlannedCoreReviewCount(ds);
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
  const entry = getWrongEntry(word.id);
  const wrongCount = Number(entry?.errorCount ?? word.errorCount ?? word.totalErrorCount ?? 0);
  const editable = options.editable !== false;
  const deletable = options.deletable !== false;
  const swipeable = Boolean(options.swipeable && (editable || deletable));
  const stage = Math.min(Number(word.scheduleStage || word.stageIndex || 0), state.settings.intervals.length - 1);
  const interval = state.settings.intervals[stage] ?? state.settings.intervals.at(-1) ?? 0;
  const recoveryHtml = entry ? ` · <span class="recovery-meta">薄弱词下次：${escapeHtml(entry.nextReviewDate || '待安排')}</span>` : '';
  const bodyHtml = `
      <div class="word-head">
        <div>
          <div class="word-title-row"><strong>${escapeHtml(word.word)}</strong><button class="icon-btn" data-action="speak" type="button" aria-label="播放发音">🔊</button></div>
          <div>${escapeHtml(word.meaning)}</div>
        </div>
        <div class="small muted">阶段 ${stage}（${interval} 天）</div>
      </div>
      <div style="margin-top:8px;">${escapeHtml(word.example || '—')}</div>
      ${word.exampleMeaning ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(word.exampleMeaning)}</div>` : ''}
      <div class="pills">${(word.tags || []).map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="small muted" style="margin-top:8px;">录入：${escapeHtml(word.createdAt || '')} · 正常下次：${escapeHtml(word.nextReviewDate || '未安排')}${wrongCount ? ` · 累计错误：${wrongCount}` : ''}${recoveryHtml}${extraHtml}</div>
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
    const speakBtn = card.querySelector('[data-action="speak"]');
    if (speakBtn) speakBtn.onclick = (e) => { e.stopPropagation(); unlockPronunciationAudio(); speakWord(word.word); };
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
    words = words.filter(word => [word.word, word.meaning, word.example, word.exampleMeaning, ...(word.tags || [])].some(value => String(value || '').toLowerCase().includes(q)));
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
  attachWordCardEvents(container);
}


function renderLog() {
  const container = document.getElementById('logList');
  const visible = state.logs.slice(0, logDisplayLimit);
  const cards = visible.map(log => `
    <div class="list-item">
      <div class="word-head"><strong>${escapeHtml(log.word)}</strong><div>${escapeHtml(log.rating || '')}</div></div>
      <div class="small muted">${escapeHtml(log.ts || '')}</div>
      <div class="small">来源：${escapeHtml(log.source || '')} ｜ 回忆方向：${escapeHtml(log.pass || '')}</div>
      <div class="small">加入错词本：${log.addedToWrongBook ? '是' : '否'}${log.usedHint ? ' ｜ 使用提示：是' : ''}${log.forcedAgain ? ' ｜ 主动放弃：是' : ''}</div>
      ${log.inputValue ? `<div class="small">输入：${escapeHtml(log.inputValue)}</div>` : ''}
    </div>`).join('');
  container.innerHTML = state.logs.length
    ? `${cards}${state.logs.length > visible.length ? `<button class="btn" id="loadMoreLogsBtn">加载更多（已显示 ${visible.length} / ${state.logs.length}）</button>` : `<div class="small muted">共 ${state.logs.length} 条记录。</div>`}`
    : '<div class="muted">暂无记录。</div>';
  document.getElementById('loadMoreLogsBtn')?.addEventListener('click', () => {
    logDisplayLimit += 200;
    renderLog();
  });
}

function renderSettings() {
  document.getElementById('dailyQuotaSelect').value = String(state.settings.dailyQuota);
  document.getElementById('intervalInput').value = state.settings.intervals.join(',');
  document.getElementById('backlogDailyLimitSelect').value = String(state.settings.backlogDailyLimit);
  document.getElementById('longTermDailyLimitSelect').value = String(state.settings.longTermDailyLimit);
  document.getElementById('weakDailyLimitSelect').value = String(state.settings.weakDailyLimit ?? 10);
  document.getElementById('pronunciationLocaleSelect').value = state.settings.pronunciationLocale || 'en-US';
  document.getElementById('autoPronounceCheckbox').checked = Boolean(state.settings.autoPronounce);
  document.getElementById('cachePronunciationOnAddCheckbox').checked = state.settings.cachePronunciationOnAdd !== false;

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
      const importedState = sanitizeImportedState(pendingImportState);
      await saveState(importedState, { allowLargeDecrease: true, snapshotReason: 'import-before' });
      pendingImportState = null;
      pendingImportPreview = null;
      exportPreviewText = '';
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

  const storageStatus = document.getElementById('storageStatus');
  if (storageStatus) {
    storageStatus.innerHTML = `<div>IndexedDB：<strong>${escapeHtml(storageHealth.indexedDB)}</strong></div><div>localStorage 镜像：<strong>${escapeHtml(storageHealth.localStorage)}</strong></div><div>当前修订号：${currentRevision}</div><div>最近成功保存：${escapeHtml(lastKnownMeta?.savedAt || '—')}</div>${storageHealth.warning ? `<div style="color:#b45309">${escapeHtml(storageHealth.warning)}</div>` : ''}`;
  }
  const snapshotList = document.getElementById('snapshotList');
  if (snapshotList) {
    snapshotList.innerHTML = snapshotSummaries.length ? snapshotSummaries.map(item => `<div class="list-item"><div><strong>${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))}</strong></div><div class="small muted">${escapeHtml(item.reason || '')} ｜ ${item.wordCount} 词 ｜ ${item.logCount} 条记录</div><div class="button-row wrap compact-row"><button class="btn small-btn restore-snapshot-btn" data-id="${escapeHtml(item.id)}">恢复</button><button class="btn small-btn export-snapshot-btn" data-id="${escapeHtml(item.id)}">导出</button></div></div>`).join('') : '<div class="small muted">暂时没有自动快照。</div>';
  }
}

function switchTab(tabId) {
  if (document.getElementById('review')?.classList.contains('active') && tabId !== 'review') persistNormalReviewSession();
  if (!['review', 'wrongbook'].includes(tabId)) stopPronunciationPlayback();
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  if (tabId === 'review') {
    renderReview();
  }
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
  autoResizeTextarea(document.getElementById('editMeaningInput'));
  document.getElementById('editExampleInput').value = word.example || '';
  document.getElementById('editExampleMeaningInput').value = word.exampleMeaning || '';
  document.getElementById('editExampleLookupStatus').textContent = '';
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
  target.exampleMeaning = document.getElementById('editExampleMeaningInput').value.trim();
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
  if (state.settings.cachePronunciationOnAdd !== false && nextWord) {
    setTimeout(() => prefetchPronunciation(nextWord), 0);
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
  if (state.settings.cachePronunciationOnAdd !== false && entry.word) {
    setTimeout(() => prefetchPronunciation(entry.word), 0);
  }
  return { ok: true };
}

async function handleAddTodayWord() {
  const word = document.getElementById('wordInput').value.trim();
  const meaning = document.getElementById('meaningInput').value.trim();
  const example = document.getElementById('exampleInput').value.trim();
  const exampleMeaning = document.getElementById('exampleMeaningInput').value.trim();
  const tags = document.getElementById('tagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!word || !meaning) return showToast('请填写单词和释义');
  const result = await addWord({ word, meaning, example, exampleMeaning, tags, createdAt: todayStr(), stageIndex: 0, scheduleStage: 0, nextReviewDate: todayStr() });
  if (!result?.ok) return showToast(result.saveFailed ? '保存失败，请重试，草稿已保留' : `该单词已在词库中，未重复录入（${result.duplicate.word}）`);
  document.getElementById('wordInput').value = '';
  document.getElementById('meaningInput').value = '';
  autoResizeTextarea(document.getElementById('meaningInput'));
  document.getElementById('exampleInput').value = '';
  document.getElementById('exampleMeaningInput').value = '';
  document.getElementById('exampleLookupStatus').textContent = '';
  document.getElementById('tagInput').value = '';
  clearDraft('today');
  showToast('已添加到今天');
}

async function handleAddWordToSelectedDate() {
  const word = document.getElementById('calendarWordInput').value.trim();
  const meaning = document.getElementById('calendarMeaningInput').value.trim();
  const example = document.getElementById('calendarExampleInput').value.trim();
  const exampleMeaning = document.getElementById('calendarExampleMeaningInput').value.trim();
  const tags = document.getElementById('calendarTagInput').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!word || !meaning) return showToast('请填写单词和释义');
  const result = await addWord({ word, meaning, example, exampleMeaning, tags, createdAt: selectedDate, stageIndex: 0, scheduleStage: 0, nextReviewDate: selectedDate <= todayStr() ? todayStr() : selectedDate });
  if (!result?.ok) return showToast(result.saveFailed ? '保存失败，请重试，草稿已保留' : `该单词已在词库中，未重复录入（${result.duplicate.word}）`);
  document.getElementById('calendarWordInput').value = '';
  document.getElementById('calendarMeaningInput').value = '';
  autoResizeTextarea(document.getElementById('calendarMeaningInput'));
  document.getElementById('calendarExampleInput').value = '';
  document.getElementById('calendarExampleMeaningInput').value = '';
  document.getElementById('calendarExampleLookupStatus').textContent = '';
  document.getElementById('calendarTagInput').value = '';
  clearDraft('calendar');
  showToast(`已添加到 ${selectedDate}`);
}

function buildExportPayload() {
  const prepared = sanitizeImportedState(cloneValue(state));
  return {
    ...prepared,
    exportMetadata: {
      appVersion: APP_VERSION_NUMBER,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      revision: currentRevision,
      wordCount: prepared.words.length,
      logCount: prepared.logs.length,
      checksum: checksumState(prepared),
    },
  };
}

function bindEvents() {
  document.querySelectorAll('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'review' && !document.getElementById('review')?.classList.contains('active')) {
        activateNormalReviewTask('due', { type: 'today', sourceDate: null });
      }
      switchTab(btn.dataset.tab);
    });
  });

  document.getElementById('addWordBtn').addEventListener('click', handleAddTodayWord);
  ['wordInput', 'meaningInput', 'exampleInput', 'exampleMeaningInput', 'tagInput'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => captureDraftFromInputs('today'));
  });
  const meaningInputEl = document.getElementById('meaningInput');
  if (meaningInputEl) {
    meaningInputEl.addEventListener('input', () => autoResizeTextarea(meaningInputEl));
    autoResizeTextarea(meaningInputEl);
  }
  document.getElementById('speakAddWordBtn').addEventListener('click', () => { unlockPronunciationAudio(); speakWord(document.getElementById('wordInput').value); });
  document.getElementById('generateExampleBtn').addEventListener('click', () => autoFillExample({
    wordInputId: 'wordInput',
    meaningInputId: 'meaningInput',
    exampleInputId: 'exampleInput',
    exampleMeaningInputId: 'exampleMeaningInput',
    statusId: 'exampleLookupStatus',
  }));

  document.getElementById('addBatchDemoBtn').addEventListener('click', async () => {
    await createSnapshot('batch-add-before', state);
    const demo = [
      ['negotiate', '谈判；协商', 'We need to negotiate a better price.', '我们需要协商一个更好的价格。', ['工作', '口语']],
      ['commute', '通勤', 'My commute takes about forty minutes.', '我通勤大约需要四十分钟。', ['口语']],
      ['itinerary', '行程安排', 'I shared the itinerary with the team.', '我把行程安排分享给了团队。', ['旅行', '工作']],
      ['hesitate', '犹豫', 'Don’t hesitate to ask questions.', '有问题不要犹豫，尽管提问。', ['口语']],
      ['accurate', '准确的', 'Your pronunciation is quite accurate.', '你的发音很准确。', ['口语']],
    ];
    let added = 0;
    let skipped = 0;
    for (const [word, meaning, example, exampleMeaning, tags] of demo) {
      if (findDuplicateWord(word)) {
        skipped += 1;
        continue;
      }
      state.words.push(normalizeWord({ id: uuid(), word, meaning, example, exampleMeaning, tags, createdAt: todayStr(), stageIndex: 0, scheduleStage: 0, nextReviewDate: todayStr() }));
      added += 1;
    }
    await saveState();
    resetNormalReviewSession();
    resetWrongBookSession();
    renderAll();
    showToast(skipped ? `已导入 ${added} 个示例，跳过 ${skipped} 个重复单词` : `已导入 ${added} 个示例`);
  });

  document.getElementById('addWordToSelectedDateBtn').addEventListener('click', handleAddWordToSelectedDate);
  ['calendarWordInput', 'calendarMeaningInput', 'calendarExampleInput', 'calendarExampleMeaningInput', 'calendarTagInput'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => captureDraftFromInputs('calendar'));
  });
  const calendarMeaningInputEl = document.getElementById('calendarMeaningInput');
  if (calendarMeaningInputEl) {
    calendarMeaningInputEl.addEventListener('input', () => autoResizeTextarea(calendarMeaningInputEl));
    autoResizeTextarea(calendarMeaningInputEl);
  }
  document.getElementById('speakCalendarWordBtn').addEventListener('click', () => { unlockPronunciationAudio(); speakWord(document.getElementById('calendarWordInput').value); });
  document.getElementById('generateCalendarExampleBtn').addEventListener('click', () => autoFillExample({
    wordInputId: 'calendarWordInput',
    meaningInputId: 'calendarMeaningInput',
    exampleInputId: 'calendarExampleInput',
    exampleMeaningInputId: 'calendarExampleMeaningInput',
    statusId: 'calendarExampleLookupStatus',
  }));

  const editMeaningInputEl = document.getElementById('editMeaningInput');
  if (editMeaningInputEl) editMeaningInputEl.addEventListener('input', () => autoResizeTextarea(editMeaningInputEl));
  document.getElementById('speakEditWordBtn').addEventListener('click', () => { unlockPronunciationAudio(); speakWord(document.getElementById('editWordInput').value); });
  document.getElementById('generateEditExampleBtn').addEventListener('click', () => autoFillExample({
    wordInputId: 'editWordInput',
    meaningInputId: 'editMeaningInput',
    exampleInputId: 'editExampleInput',
    exampleMeaningInputId: 'editExampleMeaningInput',
    statusId: 'editExampleLookupStatus',
  }));

  document.getElementById('librarySearchInput').addEventListener('input', e => {
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
    activateNormalReviewTask('due', { type: 'batch', sourceDate: selectedDate });
    switchTab('review');
  });

  document.getElementById('skipBtn').addEventListener('click', () => {
    ensureNormalReviewSession();
    runReviewSubmission('normal', async () => {
      await finishNormalReviewStep('Again', true);
      showToast('跳过已按 Again 处理');
    });
  });
  document.getElementById('reviewInputEnglish').addEventListener('input', e => {
    ensureNormalReviewSession();
    reviewSession.inputValue = e.target.value;
    persistNormalReviewSession();
    if (reviewSession.showAnswer) renderReview();
  });

  document.getElementById('calendarYearSelect').addEventListener('change', e => {
    calendarCursor = new Date(Number(e.target.value), calendarCursor.getMonth(), 1);
    renderCalendar();
  });
  document.getElementById('calendarMonthSelect').addEventListener('change', e => {
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
    const nextIntervals = ensureLongIntervals(normalizeIntervalsFromText(document.getElementById('intervalInput').value));
    if (!nextIntervals.length) {
      settingsMessage = '复习间隔不能为空。';
      renderSettings();
      return showToast('复习间隔不能为空');
    }
    const oldIntervals = state.settings.intervals;
    state.settings.dailyQuota = dailyQuota;
    state.settings.batchSize = dailyQuota;
    state.settings.intervals = nextIntervals;
    state.settings.backlogDailyLimit = Number(document.getElementById('backlogDailyLimitSelect').value) || 8;
    state.settings.longTermDailyLimit = Math.min(999, Math.max(0, Number(document.getElementById('longTermDailyLimitSelect').value) || 0));
    state.settings.weakDailyLimit = Math.min(999, Math.max(0, Number(document.getElementById('weakDailyLimitSelect').value) || 0));
    state.settings.pronunciationLocale = document.getElementById('pronunciationLocaleSelect').value || 'en-US';
    state.settings.autoPronounce = document.getElementById('autoPronounceCheckbox').checked;
    state.settings.cachePronunciationOnAdd = document.getElementById('cachePronunciationOnAddCheckbox').checked;
    state.settings.pronunciationSettingsVersion = PRONUNCIATION_SETTINGS_VERSION;
    state.words = state.words.map(word => {
      const nextStage = remapStageIndex(oldIntervals, nextIntervals, word.scheduleStage || word.stageIndex || 0);
      return { ...word, scheduleStage: nextStage, stageIndex: nextStage };
    });
    reschedulePendingLegacyBacklog();
    reschedulePendingNormalCatchup();
    settingsMessage = `已保存：正常间隔 ${nextIntervals.join(', ')} 天；历史积压每天 ${state.settings.backlogDailyLimit} 个；长期巩固每天最多 ${state.settings.longTermDailyLimit} 个；薄弱词每天最多 ${state.settings.weakDailyLimit} 个。`;
    await saveState();
    resetNormalReviewSession();
    resetWrongBookSession();
    lastAutoSpokenKey = '';
    renderAll();
    showToast('设置已保存');
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const jsonText = JSON.stringify(buildExportPayload(), null, 2);
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
    dataMessage = '已生成 JSON 下载。';
    renderSettings();
    showToast('已生成导出数据');
  });
  document.getElementById('showExportBtn').addEventListener('click', () => {
    exportPreviewText = JSON.stringify(buildExportPayload(), null, 2);
    dataMessage = '已在下方显示导出 JSON 内容。';
    renderSettings();
  });
  document.getElementById('copyExportBtn').addEventListener('click', async () => {
    try {
      const text = exportPreviewText || JSON.stringify(buildExportPayload(), null, 2);
      await navigator.clipboard.writeText(text);
      exportPreviewText = text;
      dataMessage = 'JSON 内容已复制到剪贴板。';
    } catch {
      dataMessage = '复制失败，请先显示 JSON，再手动复制。';
    }
    renderSettings();
  });

  document.getElementById('importInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rawImported = parsed?.state && parsed?.metadata ? parsed.state : parsed;
      const shape = validateRawStateShape(rawImported);
      if (!shape.ok) throw new Error(shape.error);
      const normalized = sanitizeImportedState(rawImported);
      const words = normalized.words || [];
      const suspiciousCount = words.reduce((acc, word) => {
        const fields = [word.word, word.meaning, word.example, word.exampleMeaning, ...(Array.isArray(word.tags) ? word.tags : [])];
        return acc + (fields.some(value => looksLikeMojibake(value)) ? 1 : 0);
      }, 0);
      pendingImportState = normalized;
      pendingImportPreview = {
        fileName: file.name,
        wordCount: words.length,
        wrongBookCount: (normalized.wrongBook || []).filter(item => item.active !== false).length,
        logCount: (normalized.logs || []).length,
        hasSettings: Boolean(normalized.settings),
        intervals: Array.isArray(normalized.settings?.intervals) ? normalized.settings.intervals.join(', ') : '无',
        dailyQuota: normalized.settings?.dailyQuota ?? '无',
        suspiciousCount,
        sampleWords: words.slice(0, 5).map(word => ({ word: word.word || '', meaning: word.meaning || '' })),
      };
      dataMessage = '已读取 JSON，请先查看导入前预检结果。';
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

  document.getElementById('createSnapshotBtn')?.addEventListener('click', async () => {
    await createSnapshot('manual', state);
    renderSettings();
    showToast('已创建快照');
  });
  document.getElementById('snapshotList')?.addEventListener('click', async event => {
    const restoreBtn = event.target.closest('.restore-snapshot-btn');
    const exportBtn = event.target.closest('.export-snapshot-btn');
    const id = restoreBtn?.dataset.id || exportBtn?.dataset.id;
    if (!id) return;
    const snapshot = await getSnapshotById(id);
    if (!snapshot) return showToast('未找到快照');
    if (restoreBtn) {
      if (!confirm(`确定恢复该快照吗？快照包含 ${snapshot.wordCount} 个词。恢复前会再保存当前状态。`)) return;
      try {
        await restoreSnapshot(id);
        renderSettings();
        showToast('快照恢复成功');
      } catch (error) {
        showToast(`恢复失败：${error?.message || error}`);
      }
    } else {
      downloadJSONFile({ ...snapshot.state, snapshotMetadata: { id: snapshot.id, reason: snapshot.reason, createdAt: snapshot.createdAt, checksum: snapshot.checksum } }, `word_recall_snapshot_${snapshot.createdAt.slice(0, 10)}.json`);
    }
  });

  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('确定清空所有本地数据吗？')) return;
    const emptyState = structuredClone(defaultState);
    await saveState(emptyState, { allowLargeDecrease: true, snapshotReason: 'clear-all-before' });
    clearDraft('today');
    clearDraft('calendar');
    resetNormalReviewSession();
    resetWrongBookSession();
    reviewContext = { type: 'today', sourceDate: null };
    selectedDate = todayStr();
    calendarCursor = new Date();
    renderAll();
    showToast('已清空');
  });

  document.getElementById('saveEditBtn').addEventListener('click', saveEditModal);
  document.getElementById('cancelEditBtn').addEventListener('click', closeEditModal);
  document.getElementById('editBackdrop').addEventListener('click', closeEditModal);
}

window.addEventListener('pagehide', () => persistNormalReviewSession());
window.addEventListener('beforeunload', () => persistNormalReviewSession());

async function cleanupLegacyPronunciationCaches() {
  if (!('caches' in window)) return;
  try {
    await Promise.all(LEGACY_AUDIO_CACHE_NAMES.map(name => name === AUDIO_CACHE_NAME ? Promise.resolve(false) : caches.delete(name)));
  } catch {
    // Old audio caches are non-critical.
  }
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js?v=6.0.0-beta.4.4');
    } catch {
      // ignore
    }
  }
}

(async function init() {
  try {
    db = await openDB();
    dbOpenError = null;
  } catch (error) {
    db = null;
    dbOpenError = error;
  }
  await cleanupLegacyPronunciationCaches();
  const loaded = await loadState();
  selectedDate = todayStr();
  calendarCursor = new Date();
  if (!loaded) {
    renderFatalDataError();
    bindFatalRecoveryEvents();
    registerSW();
    return;
  }
  bindEvents();
  applyDraftToInputs('today');
  applyDraftToInputs('calendar');
  renderAll();
  switchTab('dashboard');
  registerSW();
})();
