const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
const extract = require('extract-zip');

const projectRoot = path.join(__dirname, '..', '..');
const pythonPath = path.join(projectRoot, 'python_embedded');

// 3.12, not 3.13+: pydub needs audioop, which 3.13 removed.
const PYTHON_VERSION = '3.12.10';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

async function downloadFile(url, dest) {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(dest);

    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirect
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log(`Downloaded to ${dest}`);
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {}); // Delete the file on error
            reject(err);
        });
    });
}

async function setupEmbeddedPython() {
    console.log('Setting up embedded Python...');

    // Delete existing directory
    if (fs.existsSync(pythonPath)) {
        fs.rmSync(pythonPath, { recursive: true, force: true });
        console.log('Deleted existing Python directory');
    }

    fs.mkdirSync(pythonPath, { recursive: true });
    console.log('Created Python directory');

    // Download Python
    const pythonZip = path.join(projectRoot, path.basename(PYTHON_URL));
    if (!fs.existsSync(pythonZip)) {
        await downloadFile(PYTHON_URL, pythonZip);
    }

    // Extract Python
    console.log('Extracting Python...');
    await extract(pythonZip, { dir: pythonPath });
    console.log('Python extracted successfully');

    // Update pythonXY._pth to include the app directory and enable site packages
    const [major, minor] = PYTHON_VERSION.split('.');
    const pthFile = path.join(pythonPath, `python${major}${minor}._pth`);
    const pthContent = fs.readFileSync(pthFile, 'utf8');
    fs.writeFileSync(pthFile, pthContent + '\n../app\nimport site\n');
    console.log(`Updated ${path.basename(pthFile)}`);

    // Download get-pip.py
    const getPipPath = path.join(pythonPath, 'get-pip.py');
    await downloadFile(PIP_URL, getPipPath);

    // Install pip
    console.log('Installing pip...');
    try {
        execSync(`"${path.join(pythonPath, 'python.exe')}" "${getPipPath}"`, {
            stdio: 'inherit',
            cwd: pythonPath
        });
        console.log('pip installed successfully');
    } catch (error) {
        console.error('Failed to install pip:', error);
        process.exit(1);
    }

    // Clean up
    fs.unlinkSync(getPipPath);

    console.log('Embedded Python setup complete!');
}

// Run the setup
setupEmbeddedPython().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});

