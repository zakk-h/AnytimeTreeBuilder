const { app, BrowserWindow, dialog, Menu, screen, session } = require('electron');
const { join } = require('node:path');
const { NativeEngine } = require('./engine.cjs');

app.setName('AnytimeTreeBuilder');
app.enableSandbox();
let window;
let engine;
let quitting = false;
let cleanedUp = false;

async function fail(error) {
  if (quitting) return;
  dialog.showErrorBox('AnytimeTreeBuilder', `${error.message}\n\n${engine?.logs.slice(-12).join('\n') ?? ''}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!quitting && window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (window && !window.isDestroyed()) window.hide();
    Promise.resolve(engine?.stop()).finally(() => { cleanedUp = true; app.quit(); });
  });
  app.whenReady().then(async () => {
    const executable = process.platform === 'win32' ? 'AnytimeTreeBuilder.exe' : 'AnytimeTreeBuilder';
    const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..');
    engine = new NativeEngine(join(resources, 'native', executable));
    engine.on('exit', ({ code, signal }) => {
      if (!quitting) void fail(new Error(`The native engine stopped unexpectedly (${code ?? signal}). Please reopen the app.`));
    });
    const origin = await engine.start();
    if (quitting) return;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    const area = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({
      title: 'AnytimeTreeBuilder',
      width: Math.min(1600, area.width), height: Math.min(1050, area.height),
      minWidth: Math.min(960, area.width), minHeight: Math.min(640, area.height),
      backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: process.platform !== 'darwin',
      icon: join(__dirname, 'icon.png'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') void fail(new Error('The application window stopped responding. Please reopen the app.'));
    });
    const menus = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
    window.once('ready-to-show', () => { if (!quitting) window.show(); });
    await window.loadURL(origin);
  }).catch(fail);
}
