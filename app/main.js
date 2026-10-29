// BoxUp Labels desktop app (fast version)
// The tool, its libraries (barcode, PDF, Excel) and fonts are stored inside the app, so it opens and
// prints without waiting for GitHub or the CDNs. In the background it checks GitHub for a newer
// version of the tool, saves it, and offers to switch to it. Google Sheet calls still go online.
const { app, BrowserWindow, shell, Menu, session, dialog, ipcMain, Notification, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CORE_VERSION = '1.1.0';                  // the part that can update itself, without reinstalling
const SITE_BUILT = 1793214649153;             // when the copy inside this app was made
const LIVE_URL = 'https://logisticsboxup.github.io/boxup-labels/';
const FEED = 'https://logisticsboxup.github.io/boxup-labels/latest.json';
const BUNDLED_SITE = path.join(__dirname, 'site', 'index.html');
const VENDOR = path.join(__dirname, 'vendor');
let win = null;

/* ---------------- small helpers ---------------- */
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const cmpVer = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const SET_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function getSet() { try { return JSON.parse(fs.readFileSync(SET_FILE(), 'utf8')); } catch (e) { return {}; } }
function saveSet(patch) { const s = Object.assign(getSet(), patch); try { fs.mkdirSync(path.dirname(SET_FILE()), { recursive: true }); fs.writeFileSync(SET_FILE(), JSON.stringify(s, null, 2)); } catch (e) {} return s; }
const fmtD = t => { try { return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

/* the newest copy of the label tool: the one saved from GitHub, unless the copy inside
   the app is newer (that is what used to bring the old template back after an update) */
const SAVED_SITE = () => path.join(app.getPath('userData'), 'site', 'index.html');
function dropStaleSaved() {
  try {
    const f = SAVED_SITE();
    if (!fs.existsSync(f)) return;
    const s = getSet();
    const savedAt = s.siteSavedAt || fs.statSync(f).mtimeMs;
    if (savedAt < SITE_BUILT) {                 // older than the copy that came with this app
      fs.rmSync(f, { force: true });
      saveSet({ siteSavedAt: null, siteFrom: null, siteSha: null });
    }
  } catch (e) {}
}
function sitePath() { const f = SAVED_SITE(); return fs.existsSync(f) ? f : BUNDLED_SITE; }
function siteInfo() {
  const saved = fs.existsSync(SAVED_SITE());
  const s = getSet();
  const when = saved ? (s.siteSavedAt || fs.statSync(SAVED_SITE()).mtimeMs) : SITE_BUILT;
  let sha = '';
  try { sha = sha256(fs.readFileSync(sitePath())); } catch (e) {}
  return { from: saved ? 'downloaded from GitHub' : 'included with the app', when: when, sha: sha };
}

/* CDN files and fonts served from inside the app */
const LOCAL = [
  [/JsBarcode\.all\.min\.js/i, 'JsBarcode.all.min.js', 'application/javascript'],
  [/html2canvas\.min\.js/i, 'html2canvas.min.js', 'application/javascript'],
  [/jspdf\.umd\.min\.js/i, 'jspdf.umd.min.js', 'application/javascript'],
  [/xlsx\.full\.min\.js/i, 'xlsx.full.min.js', 'application/javascript'],
  [/pdf\.js\/3\.11\.174\/pdf\.worker\.min\.js/i, 'pdf.worker.min.js', 'application/javascript'],
  [/pdf\.js\/3\.11\.174\/pdf\.min\.js/i, 'pdf.min.js', 'application/javascript'],
  [/^https:\/\/fonts\.googleapis\.com\/css2/i, 'fonts.css', 'text/css']
];
function setupLocalFiles() {
  const ses = session.defaultSession;
  ses.protocol.handle('https', async (req) => {
    const url = req.url;
    try {
      // the tool page itself
      if (req.method === 'GET' && url.split('?')[0].split('#')[0] === LIVE_URL) {
        return new Response(fs.readFileSync(sitePath()), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (url.startsWith('https://boxup-app.local/fonts/')) {
        const f = path.join(VENDOR, 'fonts', path.basename(new URL(url).pathname));
        if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' } });
      }
      for (const [re, file, type] of LOCAL) {
        if (re.test(url)) return new Response(fs.readFileSync(path.join(VENDOR, file)), { headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
      }
    } catch (e) { /* fall through to the network */ }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

/* ---------------- updates ----------------
   latest.json on GitHub says what the newest label tool, core and installer are.
   The label tool and the core install themselves; a new installer is offered as a download. */
async function fetchBuf(url, timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const r = await net.fetch(url, { bypassCustomProtocolHandlers: true, cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}
async function getFeed() {
  try { return JSON.parse((await fetchBuf(FEED + '?t=' + Date.now(), 20000)).toString('utf8')); } catch (e) { return null; }
}
async function liveSite() {
  const buf = await fetchBuf(LIVE_URL + '?t=' + Date.now(), 45000);
  if (buf.length < 50000 || !/Shipping Label Generator/i.test(buf.toString('utf8', 0, 4000))) throw new Error('that page does not look like the label tool');
  return buf;
}
function saveSite(buf, from) {
  const dir = path.join(app.getPath('userData'), 'site');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), buf);
  saveSet({ siteSavedAt: Date.now(), siteFrom: from || 'GitHub', siteSha: sha256(buf) });
}
async function installCore(core) {
  const dir = path.join(app.getPath('userData'), 'core', String(core.version)), tmp = dir + '.part';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of (core.files || [])) {
    const buf = await fetchBuf(LIVE_URL + 'app/' + f.path + '?v=' + core.version, 45000);
    if (f.sha256 && sha256(buf) !== f.sha256) throw new Error('File check failed: ' + f.path);
    const out = path.join(tmp, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  saveSet({ coreVersion: String(core.version) });
}
let updateShown = false, checking = false;
async function checkForUpdate(manual) {
  if (checking) { if (manual) dialog.showMessageBox(win, { type: 'info', title: 'BoxUp Labels', message: 'Already checking\u2026', detail: 'Give it a moment.' }); return; }
  checking = true;
  const done = [];
  try {
    const feed = await getFeed();
    saveSet({ lastCheck: Date.now(), latestSeen: feed || null });

    /* 1. the label tool itself (the template) */
    let siteNew = false;
    try {
      const buf = await liveSite();
      const cur = fs.readFileSync(sitePath());
      if (md5(buf) !== md5(cur)) { saveSite(buf, 'GitHub'); siteNew = true; done.push('the label tool'); }
    } catch (e) { if (manual) throw e; }

    /* 2. the core of the app (menus, printing, updates) */
    let coreNew = false;
    const haveCore = getSet().coreVersion || CORE_VERSION;
    if (feed && feed.core && feed.core.version && cmpVer(feed.core.version, CORE_VERSION) > 0 && cmpVer(feed.core.version, haveCore) > 0) {
      await installCore(feed.core);
      coreNew = true; done.push('the app core (version ' + feed.core.version + ')');
    }

    /* 3. a whole new installer */
    const newSetup = feed && feed.app && cmpVer(feed.app, app.getVersion()) > 0 && feed.setup && feed.setup.url;

    if (coreNew) {
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
        title: 'BoxUp Labels', message: 'Updated ' + done.join(' and ') + '.', detail: 'The app restarts to finish. Anything typed in the form will be cleared.' });
      if (r.response === 0) { app.relaunch(); app.exit(0); return; }
      return;
    }
    if (siteNew) {
      if (manual) { win && win.reload(); if (!newSetup) { dialog.showMessageBox(win, { type: 'info', title: 'BoxUp Labels', message: 'Updated the label tool.', detail: 'The newest version from GitHub is now loaded.' }); } }
      else if (!updateShown && win) {
        updateShown = true;
        const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Reload now', 'Later'], defaultId: 0, cancelId: 1,
          title: 'BoxUp Labels', message: 'A newer version of the label tool was downloaded.', detail: 'Reload now to use it (anything typed in the form will be cleared), or it will be used next time the app opens.' });
        if (r.response === 0) win.reload();
      }
    }
    if (newSetup) {
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Download it', 'Not now'], defaultId: 0, cancelId: 1,
        title: 'BoxUp Labels', message: 'A new version of the app is available: ' + feed.app, detail: 'You have ' + app.getVersion() + '. The download opens in your browser; run it to install, there is no need to uninstall first.' });
      if (r.response === 0) shell.openExternal(feed.setup.url);
      return;
    }
    if (manual && !siteNew && !coreNew) {
      dialog.showMessageBox(win, { type: 'info', title: 'BoxUp Labels', message: 'Everything is up to date.',
        detail: 'App ' + app.getVersion() + ' \u00b7 core ' + CORE_VERSION + '\nThe label tool matches the one on GitHub.' });
    }
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: 'warning', title: 'BoxUp Labels', message: 'Could not check for an update.', detail: String(e.message || e) + '\n\nCheck the internet and try again.' });
  } finally { checking = false; }
}

/* Help > About: what is installed here and what is on GitHub right now */
async function aboutBox() {
  const si = siteInfo();
  const feed = await getFeed();
  let live = '';
  try { const buf = await liveSite(); live = sha256(buf); } catch (e) {}
  const s = getSet();
  const sameSite = live && live === si.sha;
  const newCore = feed && feed.core && cmpVer(feed.core.version, CORE_VERSION) > 0;
  const newApp = feed && feed.app && cmpVer(feed.app, app.getVersion()) > 0;
  const lines = [
    'Installed',
    '   App          ' + app.getVersion(),
    '   Core         ' + CORE_VERSION + (s.coreVersion && cmpVer(s.coreVersion, CORE_VERSION) > 0 ? '  (version ' + s.coreVersion + ' is ready, restart the app)' : ''),
    '   Label tool   ' + fmtD(si.when) + ', ' + si.from,
    '',
    'On GitHub right now',
    '   App          ' + (feed && feed.app ? feed.app : 'not published yet'),
    '   Core         ' + (feed && feed.core ? feed.core.version : 'not published yet'),
    '   Label tool   ' + (live ? (sameSite ? 'same as yours' : 'newer than yours') : 'could not be checked'),
    '',
    (newApp || newCore || (live && !sameSite))
      ? 'An update is waiting. Use File > Check for update.'
      : (live ? 'Everything matches. You are up to date.' : 'Could not reach GitHub to compare.'),
    '',
    'Last checked: ' + (s.lastCheck ? fmtD(s.lastCheck) : 'never')
  ];
  dialog.showMessageBox(win, { type: 'info', title: 'About BoxUp Labels', message: 'BoxUp Labels ' + app.getVersion(),
    detail: lines.join('\n') + '\n\nShipping label generator for BoxUp Luxury Gifting.\nData is shared through the BoxUp Label Log Google Sheet.',
    buttons: ['Close', 'Check for update'], defaultId: 0, cancelId: 0 }).then(r => { if (r.response === 1) checkForUpdate(true); });
}

const APP_ID = 'com.boxupgifting.labels';
const PROTO = 'boxuplabels';
app.setAppUserModelId(APP_ID);                 // needed for Windows notifications
app.setAsDefaultProtocolClient(PROTO);         // notification buttons talk to the app through boxuplabels://

/* boxuplabels://open?p=<file>  or  boxuplabels://folder?p=<file> */
function handleAppLink(argv) {
  const link = (argv || []).find(a => typeof a === 'string' && a.toLowerCase().startsWith(PROTO + '://'));
  if (!link) return false;
  try {
    const u = new URL(link);
    const p = u.searchParams.get('p');
    if (!p) return true;
    if (u.hostname === 'folder') shell.showItemInFolder(p); else shell.openPath(p);
  } catch (e) { /* ignore a bad link */ }
  return true;
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', (e, argv) => {
  if (handleAppLink(argv)) return;            // a notification button was clicked
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i})${ext}`); i++; }
  return p;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 650,
    title: 'BoxUp Labels', icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#16311F', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });

  // links that open a new tab (Log Sheet, tracking links, reprint links) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // the tool opens from the copy inside the app (instant); updates are checked in the background
  win.loadURL(LIVE_URL + '?app=1');
  win.webContents.once('did-finish-load', () => setTimeout(() => checkForUpdate(false), 4000));
}

// PDFs and Excel files go straight to the Downloads folder, and a "Saved" pop-up shows in the app
function toast(file, ok) {
  if (!win) return;
  const js = `(() => {
    const id = 'boxup-dl-toast';
    let box = document.getElementById(id);
    if (!box) {
      box = document.createElement('div'); box.id = id;
      box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;display:flex;flex-direction:column;gap:8px;font-family:Inter,Arial,sans-serif';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.style.cssText = 'background:#16311F;color:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.3);font-size:13px;min-width:300px;max-width:420px';
    const name = ${JSON.stringify(path.basename(file || ''))};
    const p = ${JSON.stringify(file || '')};
    t.innerHTML = ${ok ? "'<div style=\"font-weight:700;margin-bottom:4px\">&#10003; Saved to Downloads</div>'" : "'<div style=\"font-weight:700;margin-bottom:4px;color:#ffb4ae\">Download failed</div>'"}
      + '<div style="opacity:.85;word-break:break-all;margin-bottom:8px"></div>'
      + ${ok ? "'<div style=\"display:flex;gap:8px\"><button data-a=\"open\" style=\"background:#fff;color:#16311F;border:none;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer\">Open</button><button data-a=\"folder\" style=\"background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer\">Show in folder</button><button data-a=\"x\" style=\"margin-left:auto;background:none;border:none;color:#fff;opacity:.7;cursor:pointer;font-size:16px\">&#10005;</button></div>'" : "''"};
    t.children[1].textContent = name;
    t.addEventListener('click', e => {
      const a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'open') window.boxupApp && window.boxupApp.openFile(p);
      if (a === 'folder') window.boxupApp && window.boxupApp.showInFolder(p);
      if (a) t.remove();
    });
    box.appendChild(t);
    setTimeout(() => t.remove(), 15000);
  })()`;
  win.webContents.executeJavaScript(js).catch(() => {});
}
/* Windows notification at the bottom right of the screen */
let iconOnDisk = '';
function notifyIcon() {
  // Windows needs the picture as a normal file (not inside the app package)
  if (iconOnDisk && fs.existsSync(iconOnDisk)) return iconOnDisk;
  try {
    iconOnDisk = path.join(app.getPath('userData'), 'notify-icon.png');
    fs.writeFileSync(iconOnDisk, fs.readFileSync(path.join(__dirname, 'build', 'icon.png')));
  } catch (e) { iconOnDisk = ''; }
  return iconOnDisk;
}
const xml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function notifyDownload(file, ok) {
  const name = path.basename(file || '');
  const kind = /\.xlsx?$/i.test(name) ? 'Excel file' : 'PDF';
  const title = ok ? `\u2713 ${kind} saved to Downloads` : 'Download failed';
  if (!Notification.isSupported()) { toast(file, ok); return; }
  let n;
  if (process.platform === 'win32' && ok) {
    const enc = encodeURIComponent(file);
    const openLink = `${PROTO}://open?p=${enc}`, folderLink = `${PROTO}://folder?p=${enc}`;
    const icon = notifyIcon();
    const toastXml = `<toast activationType="protocol" launch="${xml(openLink)}">
  <visual><binding template="ToastGeneric">
    ${icon ? `<image placement="appLogoOverride" src="${xml(require('url').pathToFileURL(icon).href)}"/>` : ''}
    <text>${xml(title)}</text>
    <text>${xml(name)}</text>
    <text>Click to open the ${xml(kind)}</text>
  </binding></visual>
  <actions>
    <action content="Open" activationType="protocol" arguments="${xml(openLink)}"/>
    <action content="Show in folder" activationType="protocol" arguments="${xml(folderLink)}"/>
  </actions>
</toast>`;
    n = new Notification({ toastXml });
  } else {
    n = new Notification({ title, body: ok ? name + '\nClick to open' : name, icon: path.join(__dirname, 'build', 'icon.png') });
    n.on('click', () => { if (ok) shell.openPath(file); });
  }
  n.on('failed', () => toast(file, ok));
  try { n.show(); } catch (e) { toast(file, ok); }
}

function setupDownloads() {
  ipcMain.on('open-file', (e, p) => { if (p) shell.openPath(p); });
  ipcMain.on('show-in-folder', (e, p) => { if (p) shell.showItemInFolder(p); });
  session.defaultSession.on('will-download', (event, item) => {
    const target = uniquePath(path.resolve(app.getPath('downloads')), item.getFilename());
    item.setSavePath(target);
    item.on('updated', () => {
      const total = item.getTotalBytes();
      if (win && total > 0) win.setProgressBar(item.getReceivedBytes() / total);
    });
    item.once('done', (e, state) => {
      if (win) win.setProgressBar(-1);
      notifyDownload(target, state === 'completed');
    });
  });
}

function buildMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'Check for update', accelerator: 'Ctrl+U', click: () => checkForUpdate(true) },
      { type: 'separator' },
      { label: 'Order Tracker', click: () => shell.openExternal('https://logisticsboxup.github.io/boxup-sales/') },
      { type: 'separator' },
      { label: 'Open Downloads folder', click: () => shell.openPath(app.getPath('downloads')) },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' } ] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'F5', click: () => win && win.reload() },
      { label: 'Check for update', accelerator: 'Ctrl+F5', click: () => checkForUpdate(true) },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' }, { role: 'togglefullscreen' } ] },
    { label: 'Help', submenu: [
      { label: 'Open in browser', click: () => shell.openExternal(LIVE_URL) },
      { label: 'About BoxUp Labels', click: () => aboutBox() },
      { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  handleAppLink(process.argv);
  if (process.env.BOXUP_DL_DIR) app.setPath('downloads', process.env.BOXUP_DL_DIR);
  dropStaleSaved(); setupLocalFiles(); setupDownloads(); buildMenu(); createWindow();
});
app.on('window-all-closed', () => app.quit());
