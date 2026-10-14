const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs').promises;
const yaml = require('js-yaml');
const { spawn } = require('child_process');
const { CONFIG_SCHEMA, getDefaultConfig } = require('./config-schema.js');

// Detect if we're running in development or production
const isDev = !app.isPackaged;
const APP_ROOT = isDev
  ? path.join(__dirname, '..')  // Development: go up from ui/ to project root
  : process.resourcesPath;       // Production: use Electron's resource path

const CONFIG_PATH = path.join(APP_ROOT, 'config.yaml');

let mainWindow;
let runningProcess = null; // Track the running Python process

// Helper function to get the correct Python executable from embedded python
function getVenvPython() {
  const pythonPath = path.join(APP_ROOT, 'python', 'python.exe');
  return pythonPath;
}

// Helper function to send Python output to renderer
function sendPythonOutput(message, type = 'stdout') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('python-output', { message, type });
  }
}

// Helper function to create a minimal Python environment. CUDA DLLs come from
// pip wheels; app/stt.py puts them on PATH.
function createPythonEnvironment() {
  const binPath = path.join(APP_ROOT, 'python', 'Scripts');
  const env = {};
  env.PATH = binPath;
  env.HF_HUB_DISABLE_SYMLINKS_WARNING = '1';
  return env;
}

function shouldFilterMessage(message) {
  // Filter out pydub ffmpeg/avconv warning. It does not actually matter.
  if (message.includes("Couldn't find ffmpeg or avconv - defaulting to ffmpeg, but may not work")) {
    return true;
  }
  return false;
}

// Helper function to setup process event handlers
function setupProcessHandlers(process) {
  process.stdout.on('data', (data) => {
    const text = data.toString();
    sendPythonOutput(text.trimEnd(), 'stdout');
  });

  process.stderr.on('data', (data) => {
    const text = data.toString();
    if (!shouldFilterMessage(text)) {
      sendPythonOutput(text.trimEnd(), 'stderr');
    }
  });

  process.on('error', (error) => {
    sendPythonOutput(`Process error: ${error.message}`, 'stderr');
    runningProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-stopped');
    }
  });

  process.on('close', (code) => {
    sendPythonOutput(`Process exited with code ${code}`, 'info');
    runningProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-stopped');
    }
  });
}

// Helper function to execute Python commands using embedded python
function executePythonCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const pythonPath = getVenvPython();
    const commandStr = `${pythonPath} ${args.join(' ')}`;
    sendPythonOutput(`> ${commandStr}`, 'info');

    const spawnOptions = {
      ...options,
      env: createPythonEnvironment()
    };

    const pythonProcess = spawn(pythonPath, args, spawnOptions);

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      sendPythonOutput(text.trimEnd(), 'stdout');
    });

    pythonProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      // Filter out specific warning messages
      if (!shouldFilterMessage(text)) {
        sendPythonOutput(text.trimEnd(), 'stderr');
      }
    });

    pythonProcess.on('error', (error) => {
      sendPythonOutput(`Failed to start Python process: ${error.message}`, 'stderr');
      reject({ error: error.message, stdout, stderr });
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        sendPythonOutput(`Process exited with code ${code}`, 'stderr');
        reject({ code, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: path.join(APP_ROOT, 'Images', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
}

// Replace the DEFAULT_CONFIG constant with:
const DEFAULT_CONFIG = getDefaultConfig();

// IPC handlers
ipcMain.handle('load-config', async () => {
  try {
    const fileContent = await fs.readFile(CONFIG_PATH, 'utf8');
    return yaml.load(fileContent);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist, create it with defaults
      console.error('Config file not found, creating with defaults...');
      try {
        const yamlContent = yaml.dump(DEFAULT_CONFIG, { lineWidth: -1 });
        await fs.writeFile(CONFIG_PATH, yamlContent, 'utf8');
        console.error('Created config.yaml with default values');
        return DEFAULT_CONFIG;
      } catch (writeError) {
        console.error('Error creating default config:', writeError);
        // Return defaults even if we can't write the file
        return DEFAULT_CONFIG;
      }
    }
    console.error('Error loading config:', error);
    throw error;
  }
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    const yamlContent = yaml.dump(config, { lineWidth: -1 });
    await fs.writeFile(CONFIG_PATH, yamlContent, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
});

ipcMain.handle('reset-config', async () => {
  try {
    // Check if the file exists first
    try {
      await fs.access(CONFIG_PATH);
      // File exists, delete it
      await fs.unlink(CONFIG_PATH);
      console.error('Config file deleted successfully');
      return { success: true, message: 'Configuration reset to defaults' };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Config file doesn't exist, that's fine
        return { success: true, message: 'Configuration already at defaults' };
      }
      throw error;
    }
  } catch (error) {
    console.error('Error resetting config:', error);
    throw new Error(`Failed to reset configuration: ${error.message}`);
  }
});

ipcMain.handle('deleteVenvIndicatorFile', async () => {
  const venvMarkerPath = path.join(APP_ROOT, '.venv_is_set_up');
  try {
    await fs.unlink(venvMarkerPath);
    return { success: true, message: '.venv_is_set_up deleted successfully.' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { success: true, message: '.venv_is_set_up not found.' };
    }
    console.error('Error deleting .venv_is_set_up file:', error);
    sendPythonOutput(`Error deleting .venv_is_set_up: ${error.message}`, 'stderr');
    throw error;
  }
});

// Update the install-requirements handler
ipcMain.handle('install-requirements', async () => {
  const requirementsPath = path.join(APP_ROOT, 'app', 'requirements.txt');
  const venvMarkerPath = path.join(APP_ROOT, '.venv_is_set_up');

  try {
    // Check if venv is already set up
    try {
      await fs.access(venvMarkerPath);
      return { success: true, message: 'Virtual environment already set up' };
    } catch (error) {
      // Marker doesn't exist, proceed with setup
    }

    // Check if requirements.txt exists
    await fs.access(requirementsPath);

    await executePythonCommand(['-m', 'pip', 'install', '-r', requirementsPath]);

    await fs.mkdir(path.join(APP_ROOT, 'Models'), { recursive: true });

    await fs.writeFile(venvMarkerPath, new Date().toISOString(), 'utf8');
    sendPythonOutput('Created .venv_is_set_up marker file', 'info');

    return { success: true, message: 'Requirements and dependencies installed successfully' };
  } catch (error) {
    console.error('Error installing requirements:', error);
    if (error.code === 'ENOENT') {
      throw new Error('requirements.txt not found');
    }

    const errorDetails = error.stderr || error.stdout || error.message || error.error || 'Unknown error';
    throw new Error(`Installation failed: ${errorDetails}`);
  }
});

ipcMain.handle('get-microphones', async () => {
  const scriptPath = path.join(APP_ROOT, 'app', 'list_microphones.py');

  try {
    const result = await executePythonCommand([scriptPath]);
    const microphones = JSON.parse(result.stdout.trim());
    return microphones;
  } catch (error) {
    console.error('Failed to get microphones:', error);
    throw new Error(`Failed to get microphones: ${error.stderr || error.error || 'Unknown error'}`);
  }
});

// Helper function to safely delete directory contents
async function clearDirectory(dirPath, dirName) {
  try {
    await fs.access(dirPath);
    sendPythonOutput(`Clearing ${dirName} directory...`, 'info');

    const files = await fs.readdir(dirPath);
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      try {
        await fs.rm(filePath, { recursive: true, force: true });
        sendPythonOutput(`✗ Deleted file ${file}`, 'info');

        deletedCount++;
      } catch (deleteError) {
        sendPythonOutput(`Warning: Could not delete ${file}: ${deleteError.message}`, 'stderr');
        // Continue with other files even if one fails
      }
    }

    sendPythonOutput(`${dirName} directory cleared`, 'info');
    return deletedCount;
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendPythonOutput(`${dirName} directory doesn't exist, skipping`, 'info');
      return 0;
    } else {
      sendPythonOutput(`Error clearing ${dirName} directory: ${error.message}`, 'stderr');
      throw error;
    }
  }
}

ipcMain.handle('reset-venv', async () => {
  const venvMarkerPath = path.join(APP_ROOT, '.venv_is_set_up');

  try {
    sendPythonOutput('Starting virtual environment reset...', 'info');

    // Delete the venv marker file first
    try {
      await fs.unlink(venvMarkerPath);
      sendPythonOutput('Deleted .venv_is_set_up marker file', 'info');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        sendPythonOutput(`Warning: Could not delete marker file: ${error.message}`, 'stderr');
      }
    }

    // Get list of installed packages
    sendPythonOutput('Getting list of installed packages...', 'info');
    const freezeResult = await executePythonCommand(['-m', 'pip', 'freeze']);
    const installedPackages = freezeResult.stdout.trim();

    let uninstalledPackages = [];

    if (!installedPackages) {
      sendPythonOutput('No packages found to uninstall', 'info');
    } else {
      // Parse package names and filter out core packages
      const packageLines = installedPackages.split('\n').filter(line => line.trim());
      const packageNames = packageLines
        .map(line => line.split('==')[0].trim())
        .filter(name => name && !name.startsWith('#'));

      const corePackages = ['pip', 'setuptools', 'wheel'];
      const packagesToUninstall = packageNames.filter(name => !corePackages.includes(name.toLowerCase()));

      if (packagesToUninstall.length === 0) {
        sendPythonOutput('Only core packages found, nothing to uninstall', 'info');
      } else {
        sendPythonOutput(`Uninstalling ${packagesToUninstall.length} packages...`, 'info');

        const uninstallArgs = ['-m', 'pip', 'uninstall', '-y', ...packagesToUninstall];
        await executePythonCommand(uninstallArgs);
        uninstalledPackages = packagesToUninstall;
      }
    }

    // Clear downloaded files
    sendPythonOutput('Clearing downloaded files...', 'info');

    const modelsPath = path.join(APP_ROOT, 'Models');
    const binPath = path.join(APP_ROOT, 'bin');

    const deletedModels = await clearDirectory(modelsPath, 'Models');
    const deletedBins = await clearDirectory(binPath, 'Binary');

    const totalDeletedFiles = deletedModels + deletedBins;

    sendPythonOutput('Virtual environment reset successfully!', 'info');

    return {
      success: true,
      message: `Virtual environment reset complete. Uninstalled ${uninstalledPackages.length} packages and deleted ${totalDeletedFiles} downloaded files.`,
      uninstalledPackages,
      deletedFiles: {
        models: deletedModels,
        binaries: deletedBins,
        total: totalDeletedFiles
      }
    };
  } catch (error) {
    console.error('Error resetting virtual environment:', error);
    throw new Error(`Virtual environment reset failed: ${error.message}`);
  }
});

// Add handlers for starting and stopping the process
ipcMain.handle('start-process', async () => {
  if (runningProcess) {
    throw new Error('Process is already running');
  }

  const scriptPath = path.join(APP_ROOT, 'app', 'hi.py');
  const args = [scriptPath, '--config', CONFIG_PATH];

  try {
    const pythonPath = getVenvPython();
    sendPythonOutput(`Starting process: ${path.basename(pythonPath)} ${args.join(' ')}`, 'info');

    runningProcess = spawn(pythonPath, args, { env: createPythonEnvironment() });
    setupProcessHandlers(runningProcess);

    return { success: true };
  } catch (error) {
    runningProcess = null;
    throw error;
  }
});

ipcMain.handle('stop-process', async () => {
  if (!runningProcess) {
    sendPythonOutput('No process to stop', 'info');
    return { success: true, forcefullyKilled: false };
  }

  return new Promise((resolve) => {
    let forcefullyKilled = false;

    // Set up a timeout to force kill after 10 seconds
    const killTimeout = setTimeout(() => {
      if (runningProcess) {
        sendPythonOutput('Process did not stop gracefully, forcing termination...', 'stderr');
        forcefullyKilled = true;
        runningProcess.kill('SIGKILL');
      }
    }, 10000);

    // Listen for the process to exit
    runningProcess.once('exit', (code, signal) => {
      clearTimeout(killTimeout);
      runningProcess = null;

      if (forcefullyKilled) {
        sendPythonOutput('Process forcefully terminated', 'info');
      } else {
        sendPythonOutput('Process stopped gracefully', 'info');
      }

      resolve({ success: true, forcefullyKilled });
    });

    // Send termination signal
    sendPythonOutput('Stopping process gracefully...', 'info');
    runningProcess.kill('SIGTERM');
  });
});

ipcMain.handle('get-process-state', () => {
  return { isRunning: runningProcess !== null };
});

// Clean up on app quit
app.on('before-quit', () => {
  if (runningProcess) {
    runningProcess.kill();
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  app.quit();
});

