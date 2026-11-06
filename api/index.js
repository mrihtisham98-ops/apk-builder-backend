const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'mrihtisham98-ops/apk-builder-backend';
const API = `https://api.github.com/repos/${GITHUB_REPO}`;

const github = axios.create({
    headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    },
    timeout: 30000
});

// ============================================================
// TOKEN BUDGET (Groq TPM 8000 se neeche rehne ke liye)
// ============================================================
// 1 token ≈ 3.5 chars (mixed code + English) — conservative.
const MAX_INPUT_TOKENS = 5500;                    // total input budget
const MAX_INPUT_CHARS = Math.floor(MAX_INPUT_TOKENS * 3.5); // ~19250
const MAX_SYSTEM_TOKENS = 1200;
const MAX_SYSTEM_CHARS = Math.floor(MAX_SYSTEM_TOKENS * 3.5); // 4200
const MAX_FILE_TOKENS = 2500;
const MAX_FILE_CHARS = Math.floor(MAX_FILE_TOKENS * 3.5); // 8750
const MAX_HISTORY_MESSAGES = 3;                   // last 3 older messages
const MAX_OUTPUT_TOKENS = 2048;                   // output reservation

function estimateTokens(str) {
    if (!str) return 0;
    return Math.ceil(String(str).length / 3.5);
}

// Smart-truncate: keep head (imports/config) + tail (main logic/exports)
function smartTruncate(code, maxChars) {
    if (!code) return '';
    const s = String(code);
    if (s.length <= maxChars) return s;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.floor(maxChars * 0.35);
    return (
        s.slice(0, headLen) +
        '\n\n/* ... [middle truncated to fit token limit] ... */\n\n' +
        s.slice(s.length - tailLen)
    );
}

// Extract file content block from incoming systemPrompt (frontend format)
function extractFileFromPrompt(systemPrompt) {
    if (!systemPrompt) return { header: '', fileContent: '' };
    const match = systemPrompt.match(
        /CURRENT FILE CONTENT[\s\S]*?```\s*([\s\S]*?)```/i
    );
    if (!match) {
        return { header: String(systemPrompt), fileContent: '' };
    }
    const header = String(systemPrompt).replace(match[0], '').trim();
    return { header, fileContent: match[1] || '' };
}

// ============================================================
// Convert nested project files into individual paths.
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

// GitHub API: create a Git blob.
async function createBlob(content, encoding = 'utf-8') {
    const response = await github.post(`${API}/git/blobs`, {
        content,
        encoding
    });

    return response.data.sha;
}

// ============================================================
// Start a cloud APK build. (UNCHANGED)
// ============================================================
app.post('/api/cloud-build-apk', async (req, res) => {
    let branch = null;

    try {
        if (!GITHUB_TOKEN) {
            return res.status(500).json({
                success: false,
                error: 'GITHUB_TOKEN is not configured.'
            });
        }

        const { appName, packageName, iconBase64: appIcon, files } = req.body;

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

        const projectFiles = flattenFiles(files);

        if (!projectFiles.some(file => file.path === 'index.html')) {
            return res.status(400).json({
                success: false,
                error: 'Project must contain a root index.html file.'
            });
        }

        const buildId = crypto.randomUUID();
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

        // Upload project files as GitHub blobs.
        for (const file of projectFiles) {
            const bytes = Buffer.byteLength(file.content, 'utf8');
            totalBytes += bytes;

            if (totalBytes > 4 * 1024 * 1024) {
                throw new Error(
                    'Project is too large for this upload endpoint. Maximum supported size is 4 MB.'
                );
            }

            const sha = await createBlob(
                Buffer.from(file.content, 'utf8').toString('base64'),
                'base64'
            );

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
            totalBytes += iconBuffer.length;

            if (totalBytes > 4 * 1024 * 1024) {
                throw new Error('Project and icon exceed the 4 MB upload limit.');
            }

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

        // Get repository's default branch.
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

        // Trigger GitHub Actions with a small payload.
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

        return res.status(500).json({
            success: false,
            error:
                error.response?.data?.message ||
                error.message ||
                'Could not start APK build.'
        });
    }
});

// ============================================================
// Check build status. (UNCHANGED)
// ============================================================
app.get('/api/build-status/:buildId', async (req, res) => {
    try {
        const buildId = req.params.buildId;

        if (!/^[a-f0-9-]{36}$/i.test(buildId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid build ID.'
            });
        }

        const tag = `apk-${buildId}`;

        try {
            const releaseResponse = await github.get(
                `${API}/releases/tags/${tag}`
            );

            const apk = releaseResponse.data.assets.find(asset =>
                asset.name.endsWith('.apk')
            );

            if (apk) {
                return res.json({
                    success: true,
                    status: 'completed',
                    downloadUrl: apk.browser_download_url,
                    fileName: apk.name
                });
            }
        } catch (error) {
            if (error.response?.status !== 404) throw error;
        }

        const runsResponse = await github.get(
            `${API}/actions/runs`,
            { params: { per_page: 100 } }
        );

        const run = runsResponse.data.workflow_runs.find(item =>
            item.display_title === `Build APK ${buildId}`
        );

        if (!run) {
            return res.json({
                success: true,
                status: 'queued',
                message: 'Your APK build is being prepared.'
            });
        }

        if (run.status !== 'completed') {
            return res.json({
                success: true,
                status: 'building',
                message: 'Your APK is being generated.'
            });
        }

        return res.json({
            success: true,
            status: 'failed',
            message: 'APK build failed. Please check the build logs.'
        });

    } catch (error) {
        console.error(
            'BUILD STATUS ERROR:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================
// Secure Groq AI Chat Endpoint — Token-budgeted
// ============================================================
app.post('/api/ai-chat', async (req, res) => {
    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY
            || process.env.Ai_Api_key; // fallback to existing var name

        if (!GROQ_API_KEY) {
            return res.status(500).json({
                error: 'GROQ_API_KEY is not configured on server.'
            });
        }

        const body = req.body || {};
        let messages = body.messages;
        let systemPrompt = body.systemPrompt || '';

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'Messages are required.' });
        }

        // ---------- Extract latest user message (NEVER truncate) ----------
        let latestUserMessage = '';
        let latestUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i] && messages[i].role === 'user' && messages[i].content) {
                latestUserMessage = String(messages[i].content);
                latestUserIndex = i;
                break;
            }
        }
        if (!latestUserMessage) {
            return res.status(400).json({ error: 'No user message provided.' });
        }

        const latestUserTokens = estimateTokens(latestUserMessage);
        if (latestUserTokens > MAX_INPUT_TOKENS - 500) {
            return res.status(413).json({
                error: `Your latest message is too large (${latestUserTokens} tokens). Please shorten it. Server limit is ~${MAX_INPUT_TOKENS} tokens.`
            });
        }

        // ---------- Build system prompt (≤1200 tokens) ----------
        // Frontend sends: header + "CURRENT FILE CONTENT:\n```...```"
        const { header, fileContent } = extractFileFromPrompt(systemPrompt);
        const trimmedFile = smartTruncate(fileContent, MAX_FILE_CHARS);

        let systemText = header
            ? header
            : 'You are an expert coding assistant inside a web IDE.';

        if (trimmedFile) {
            systemText +=
                '\n\nCURRENT FILE CONTENT (may be partially truncated to fit token limit):\n```\n' +
                trimmedFile + '\n```';
        }

        if (systemText.length > MAX_SYSTEM_CHARS) {
            systemText = systemText.slice(0, MAX_SYSTEM_CHARS)
                + '\n... [system prompt truncated]';
        }

        // ---------- Build history: last 3 older messages only ----------
        // Exclude the latest user message (we append it explicitly at end).
        const olderMessages = messages
            .slice(0, latestUserIndex)
            .filter(m => m && typeof m.content === 'string' && m.content.length > 0);

        const recentHistory = olderMessages.slice(-MAX_HISTORY_MESSAGES).map(m => {
            const cap = m.role === 'assistant' ? 1800 : 2500;
            const content = m.content.length > cap
                ? m.content.slice(0, cap) + '\n... [truncated]'
                : m.content;
            return { role: m.role, content };
        });

        // ---------- Assemble final messages ----------
        const finalMessages = [
            { role: 'system', content: systemText },
            ...recentHistory,
            { role: 'user', content: latestUserMessage }
        ];

        // ---------- Enforce total input budget (~5500 tokens) ----------
        let totalChars = finalMessages.reduce(
            (s, m) => s + (m.content ? m.content.length : 0), 0
        );

        while (
            totalChars > MAX_INPUT_CHARS &&
            finalMessages.length > 2 // keep system + latest user
        ) {
            // Remove oldest non-system, non-latest message
            const idx = finalMessages.findIndex(
                (m, i) => i > 0 && i < finalMessages.length - 1
            );
            if (idx === -1) break;
            const removed = finalMessages.splice(idx, 1)[0];
            totalChars -= removed.content.length;
        }

        const estimatedInput = estimateTokens(
            finalMessages.map(m => m.content).join('\n')
        );

        // Safety: if still over budget, shrink file block harder
        if (estimatedInput > MAX_INPUT_TOKENS) {
            const smallerFile = smartTruncate(trimmedFile, Math.floor(MAX_FILE_CHARS * 0.6));
            const rebuiltSystem = (header || 'You are an expert coding assistant inside a web IDE.')
                + '\n\nCURRENT FILE CONTENT (truncated):\n```\n' + smallerFile + '\n```';
            finalMessages[0].content = rebuiltSystem.slice(0, MAX_SYSTEM_CHARS);
        }

        const finalEstimate = estimateTokens(
            finalMessages.map(m => m.content).join('\n')
        );

        console.log(
            `[ai-chat] msgs=${finalMessages.length} chars=${totalChars} ` +
            `est_input_tokens=${finalEstimate} max_out=${MAX_OUTPUT_TOKENS}`
        );

        // ---------- Call Groq ----------
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'openai/gpt-oss-120b',
                messages: finalMessages,
                temperature: 0.7,
                max_tokens: MAX_OUTPUT_TOKENS
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                timeout: 120000
            }
        );

        return res.json(response.data);

    } catch (error) {
        console.error(
            'GROQ AI ERROR:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            error:
                error.response?.data?.error?.message ||
                error.message ||
                'AI request failed.'
        });
    }
});

module.exports = app;