const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { applyAdMobIntegration } = require('../lib/admob-injector');

const app = express();

app.use(cors());
// [CHANGE 1] JSON body limit 50mb -> 100mb
// Offline dependency bundling ke liye bade projects support.
// NOTE: Hosting platform ka apna body limit check karein
// (Vercel = 4.5 MB hard limit, Railway/Render = configurable).
app.use(express.json({ limit: '100mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'mrihtisham98-ops/apk-builder-backend';
const API = `https://api.github.com/repos/${GITHUB_REPO}`;

const github = axios.create({
    headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    },
    // [CHANGE 2] 30s -> 60s
    // Bade projects mein sequential blob uploads 30s se zyada le sakte hain.
    timeout: 60000
});

// ============================================================
// PROJECT FILE HELPERS
// ============================================================

function flattenFiles(obj, prefix = '', output = []) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Invalid project files.');
    }

    for (const [name, value] of Object.entries(obj)) {
        if (
            !name ||
            name.includes('/') ||
            name.includes('\\') ||
            name === '.' ||
            name === '..'
        ) {
            throw new Error('Invalid file name: ' + name);
        }

        const relative = prefix ? `${prefix}/${name}` : name;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenFiles(value, relative, output);
        } else if (typeof value === 'string') {
            output.push({ path: relative, content: value });
        } else {
            throw new Error('Invalid file content: ' + relative);
        }
    }

    return output;
}

async function createBlob(content, encoding = 'utf-8') {
    const response = await github.post(`${API}/git/blobs`, {
        content,
        encoding
    });

    return response.data.sha;
}

// ============================================================
// [CHANGE 3] BINARY FILE DETECTION HELPERS
// Offline dependency bundling ka actual kaam build.yml mein hota hai.
// Backend sirf images/fonts/binary assets ko lossless transfer karta hai.
// ============================================================

function isBinaryContent(content) {
    if (typeof content !== 'string' || !content) return false;

    // Data URI binary asset (image/font/icon)
    if (/^data:(image|font|application)\/[a-zA-Z0-9.+-]+;base64,/i.test(content)) {
        return true;
    }

    // Pure base64 string without whitespace/newlines
    if (
        content.length > 40 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(content) &&
        content.length % 4 === 0
    ) {
        return true;
    }

    // NUL byte => definitely binary
    if (content.includes('\u0000')) {
        return true;
    }

    return false;
}

function extractBase64Content(content) {
    const dataUri = content.match(
        /^data:(image|font|application)\/[a-zA-Z0-9.+-]+;base64,(.+)$/i
    );
    if (dataUri) return dataUri[2];
    return content;
}

// ============================================================
// APK BUILD ENDPOINT
// ORIGINAL IMPLEMENTATION PRESERVED
// Changes: 100 MB limits, binary-safe upload, buildId in error
// ============================================================

app.post('/api/cloud-build-apk', async (req, res) => {
    let branch = null;
    // [CHANGE 4] buildId ko try ke bahar declare kiya taake
    // error response mein debug ke liye include ho sake.
    let buildId = null;

    try {
        if (!GITHUB_TOKEN) {
            return res.status(500).json({
                success: false,
                error: 'GITHUB_TOKEN is not configured.'
            });
        }

        const { appName, packageName, iconBase64: appIcon, files } = req.body;
        const adMob = req.body.adMob || { enabled: false };

        if (!appName || !packageName || !files) {
            return res.status(400).json({
                success: false,
                error: 'App name, package name and project files are required.'
            });
        }

        if (
            !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Invalid package name. Example: com.example.myapp'
            });
        }

        let projectFiles = flattenFiles(files);

        if (!projectFiles.some(file => file.path === 'index.html')) {
            return res.status(400).json({
                success: false,
                error: 'Project must contain a root index.html file.'
            });
        }

        // AdMob Integration
        const admobFiles = {};

        for (const file of projectFiles) {
            admobFiles[file.path] = file.content;
        }

        const adMobResult = applyAdMobIntegration(admobFiles, adMob);

        console.log('[AdMob]', adMobResult.reason);

        projectFiles = Object.entries(admobFiles).map(([path, content]) => ({
            path,
            content
        }));

        buildId = crypto.randomUUID();
        branch = `build-${buildId}`;
        const buildFolder = `.build-input/${buildId}`;

        const config = {
            buildId,
            appName: String(appName).slice(0, 60),
            packageName,
            iconPath: null
        };

        const entries = [];
        let totalBytes = 0;
        // [CHANGE 5] 50 MB -> 100 MB
        const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

        // Upload project files.
        for (const file of projectFiles) {
            let blobContent;
            let byteLength;

            if (isBinaryContent(file.content)) {
                // [CHANGE 6] Binary asset (image, font, base64 payload)
                // ko decode -> re-encode base64 taake bytes lossless rahen.
                // Offline bundler build.yml mein hota hai; backend sirf transfer.
                const base64 = extractBase64Content(file.content);
                const buffer = Buffer.from(base64, 'base64');
                byteLength = buffer.length;
                blobContent = buffer.toString('base64');
            } else {
                // Text asset (HTML, CSS, JS, JSON, SVG, etc.)
                byteLength = Buffer.byteLength(file.content, 'utf8');
                blobContent = Buffer.from(file.content, 'utf8').toString('base64');
            }

            totalBytes += byteLength;

            if (totalBytes > MAX_UPLOAD_BYTES) {
                throw new Error(
                    'Project is too large for this upload endpoint. Maximum supported size is 100 MB.'
                );
            }

            const sha = await createBlob(blobContent, 'base64');

            entries.push({
                path: `${buildFolder}/project/${file.path}`,
                mode: '100644',
                type: 'blob',
                sha
            });
        }

        // Upload optional app icon.
        if (appIcon && typeof appIcon === 'string') {
            const match = appIcon.match(
                /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/
            );

            if (!match) {
                throw new Error('App icon must be PNG, JPG or WebP.');
            }

            const iconBuffer = Buffer.from(match[2], 'base64');

            // [CHANGE 7] Size check pehle, phir totalBytes update
            if (totalBytes + iconBuffer.length > MAX_UPLOAD_BYTES) {
                throw new Error(
                    'Project and icon exceed the 100 MB upload limit.'
                );
            }

            totalBytes += iconBuffer.length;

            const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
            const iconPath = `${buildFolder}/app-icon.${extension}`;

            const iconSha = await createBlob(
                iconBuffer.toString('base64'),
                'base64'
            );

            entries.push({
                path: iconPath,
                mode: '100644',
                type: 'blob',
                sha: iconSha
            });

            config.iconPath = `app-icon.${extension}`;
        }

        // Save build configuration.
        const configSha = await createBlob(
            Buffer.from(JSON.stringify(config), 'utf8').toString('base64'),
            'base64'
        );

        entries.push({
            path: `${buildFolder}/build-config.json`,
            mode: '100644',
            type: 'blob',
            sha: configSha
        });

        // Get repository default branch.
        const repoInfo = await github.get(API);
        const defaultBranch = repoInfo.data.default_branch;

        const refResponse = await github.get(
            `${API}/git/ref/heads/${defaultBranch}`
        );

        const parentSha = refResponse.data.object.sha;

        const commitResponse = await github.get(
            `${API}/git/commits/${parentSha}`
        );

        // Create temporary build tree.
        const treeResponse = await github.post(`${API}/git/trees`, {
            base_tree: commitResponse.data.tree.sha,
            tree: entries
        });

        // Create temporary commit.
        const commit = await github.post(`${API}/git/commits`, {
            message: `Temporary APK build ${buildId}`,
            tree: treeResponse.data.sha,
            parents: [parentSha]
        });

        // Create temporary branch.
        await github.post(`${API}/git/refs`, {
            ref: `refs/heads/${branch}`,
            sha: commit.data.sha
        });

        // Trigger GitHub Actions.
        await github.post(`${API}/dispatches`, {
            event_type: 'build_apk',
            client_payload: {
                buildId,
                ref: branch
            }
        });

        return res.json({
            success: true,
            buildId,
            message: 'APK build started successfully.'
        });

    } catch (error) {
        console.error(
            'APK BUILD ERROR:',
            error.response?.data || error.message
        );

        // [CHANGE 8] Debug ke liye buildId include karo (agar ban chuka hai)
        const payload = {
            success: false,
            error:
                error.response?.data?.message ||
                error.message ||
                'Could not start APK build.'
        };

        if (buildId) {
            payload.buildId = buildId;
        }

        return res.status(500).json(payload);
    }
});
