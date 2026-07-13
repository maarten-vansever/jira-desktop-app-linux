const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// ---------------------------------------------------------------------------
// Settings (site URL + email stored plain, API token encrypted when possible)
// ---------------------------------------------------------------------------

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return null;
  }
}

function loadSettings() {
  const raw = readSettingsFile();
  if (!raw) return null;
  let token = '';
  try {
    if (raw.tokenEncrypted && safeStorage.isEncryptionAvailable()) {
      token = safeStorage.decryptString(Buffer.from(raw.token, 'base64'));
    } else {
      token = Buffer.from(raw.token || '', 'base64').toString('utf8');
    }
  } catch {
    token = '';
  }
  return { baseUrl: raw.baseUrl || '', email: raw.email || '', token };
}

function saveSettings({ baseUrl, email, token }) {
  baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const stored = {
    baseUrl,
    email: String(email || '').trim(),
    tokenEncrypted: canEncrypt,
    token: canEncrypt
      ? safeStorage.encryptString(String(token || '')).toString('base64')
      : Buffer.from(String(token || '')).toString('base64'),
  };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
  return { baseUrl: stored.baseUrl, email: stored.email, token: String(token || '') };
}

// ---------------------------------------------------------------------------
// Jira REST proxy
// ---------------------------------------------------------------------------

async function jiraRequest({ method = 'GET', path: apiPath, query, body }) {
  const settings = loadSettings();
  if (!settings || !settings.baseUrl || !settings.email || !settings.token) {
    return { ok: false, status: 0, error: 'Not configured. Open Settings and add your Jira URL, email and API token.' };
  }
  const url = new URL(settings.baseUrl + apiPath);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const auth = Buffer.from(`${settings.email}:${settings.token}`).toString('base64');
  let res;
  try {
    // Node's fetch, not Electron's net.fetch: Chromium adds an Origin header
    // to POSTs that Jira Cloud rejects with 403 "XSRF check failed".
    res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && typeof data === 'object') {
      const parts = []
        .concat(data.errorMessages || [])
        .concat(data.errors ? Object.entries(data.errors).map(([f, m]) => `${f}: ${m}`) : []);
      if (parts.length) msg = parts.join(' · ');
      else if (data.message) msg = data.message;
    }
    if (res.status === 401) msg = 'Authentication failed (401). Check your email and API token in Settings.';
    if (res.status === 403) msg = 'Access denied (403). ' + msg;
    return { ok: false, status: res.status, error: msg, data };
  }
  return { ok: true, status: res.status, data };
}

async function jiraUpload({ path: apiPath, filename, mimeType, data }) {
  const settings = loadSettings();
  if (!settings || !settings.baseUrl || !settings.email || !settings.token) {
    return { ok: false, status: 0, error: 'Not configured. Open Settings and add your Jira URL, email and API token.' };
  }
  const auth = Buffer.from(`${settings.email}:${settings.token}`).toString('base64');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(data)], { type: mimeType || 'application/octet-stream' }), String(filename || 'file'));
  let res;
  try {
    res = await fetch(settings.baseUrl + apiPath, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Network error: ${err.message}` };
  }
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) {
    let msg = `Upload failed (HTTP ${res.status})`;
    if (res.status === 403) msg += '. Attachments may be disabled or you lack permission on this issue.';
    if (res.status === 413) msg += '. File exceeds the attachment size limit.';
    return { ok: false, status: res.status, error: msg, data: payload };
  }
  return { ok: true, status: res.status, data: payload };
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

async function jiraDownload(url) {
  const settings = loadSettings();
  if (!settings || !settings.baseUrl) return { ok: false, error: 'Not configured.' };
  // Only fetch from the configured Jira instance so credentials can't leak elsewhere.
  if (typeof url !== 'string' || !url.startsWith(settings.baseUrl + '/')) {
    return { ok: false, error: 'Blocked: URL is outside the configured Jira site.' };
  }
  const auth = Buffer.from(`${settings.email}:${settings.token}`).toString('base64');
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, error: 'File too large to preview.' };
  const type = res.headers.get('content-type') || 'application/octet-stream';
  return { ok: true, dataUrl: `data:${type};base64,${buf.toString('base64')}` };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  if (!s) return { configured: false, baseUrl: '', email: '', hasToken: false };
  return {
    configured: Boolean(s.baseUrl && s.email && s.token),
    baseUrl: s.baseUrl,
    email: s.email,
    hasToken: Boolean(s.token),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle('settings:save', async (_e, incoming) => {
  const current = loadSettings();
  const token = incoming.token || (current ? current.token : '');
  saveSettings({ baseUrl: incoming.baseUrl, email: incoming.email, token });
  const probe = await jiraRequest({ path: '/rest/api/3/myself' });
  if (!probe.ok) return { ok: false, error: probe.error };
  return { ok: true, myself: probe.data };
});

ipcMain.handle('jira:request', (_e, opts) => jiraRequest(opts));

ipcMain.handle('jira:upload', (_e, opts) => jiraUpload(opts));

ipcMain.handle('jira:download', (_e, url) => jiraDownload(url));

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
