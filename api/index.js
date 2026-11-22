const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { applyAdMobIntegration } = require('../lib/admob-injector');
// [NEW] R2 Integration ke liye AWS SDK imports
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

// ============================================================
// CORS CONFIGURATION
// - Vercel par deployment protection ke saath preflight 401
//   ho sakta hai; isliye explicit OPTIONS handling add ki.
// - Origin ko env var se configure karo taake production
//   domain hardcode na ho.
// ============================================================
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*';

app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

// Explicit OPTIONS preflight handler (Vercel par zaroori)
app.options('*', (req, res) => {
    res.status(204).end();
});

// [CHANGE 1] JSON body limit 50mb -> 100mb
// NOTE: Vercel par ye kaam NAHI karega jab tak
// VERCEL_SUPPORT_LARGE_REQUEST_BODY=1 set na ho.
// 4.5 MB default limit Vercel khud enforce karta hai.
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
    // [CHANGE 2] 30s -> 60s (bade projects ke liye)
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
// [CHANGE 3] BINARY FILE DETECTION
// Images/fonts ko UTF-8 se encode karne par bytes corrupt
// ho jate hain. Ye helpers base64 payload ko lossless
// transfer karte hain.
// ============================================================

function isBinaryContent(content) {
    if (typeof content !== 'string' || !content) return false;

    if (/^data:(image|font|application)\/[a-zA-Z0-9.+-]+;base64,/i.test(content)) {
        return true;
    }

    if (
        content.length > 40 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(content) &&
        content.length % 4 === 0
    ) {
        return true;
    }

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
// [NEW] R2 SECURE UPLOAD URL GENERATOR
// Ye endpoint frontend ko ek secure temporary link dega
// ============================================================

const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    // Cloudflare R2 S3 API works reliably with path-style bucket addressing.
    forcePathStyle: true,
    // Avoid SDK-injected checksum requirements on browser-side presigned PUT uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

app.post('/api/r2-upload-url', async (req, res) => {
    try {
        const requiredEnv = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
        const missingEnv = requiredEnv.filter((name) => !process.env[name]);
        if (missingEnv.length) {
            return res.status(500).json({
                success: false,
                error: `Missing R2 environment variables: ${missingEnv.join(', ')}`
            });
        }

        const { buildId } = req.body || {};

        if (!buildId) {
            return res.status(400).json({ success: false, error: 'buildId is required' });
        }

        // File ka naam R2 mein kaisa hoga (e.g. uploads/1234-5678.zip)
        const fileKey = `uploads/${buildId}.zip`;

        // Ek temporary upload link banayein jo 10 minute tak valid ho
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileKey,
            ContentType: 'application/zip',
        });

        const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 600 });

        return res.json({
            success: true,
            uploadUrl: uploadUrl,
            fileKey: fileKey
        });

    } catch (error) {
        console.error('R2 Upload URL Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================================
// [NEW] R2 UPLOAD COMPLETE & TRIGGER BUILD
// Frontend upload complete hone ke baad ye chhoti request bhejega
// ============================================================

app.post('/api/r2-upload-complete', async (req, res) => {
    try {
        const { buildId, fileKey, appName, packageName, adMob } = req.body;

        if (!buildId || !fileKey) {
            return res.status(400).json({ success: false, error: 'buildId and fileKey are required' });
        }

        if (!GITHUB_TOKEN) {
            return res.status(500).json({ success: false, error: 'GITHUB_TOKEN is not configured.' });
        }

        const config = {
            buildId,
            appName: String(appName || 'App').slice(0, 60),
            packageName: packageName || 'com.example.app',
            adMob: adMob || { enabled: false },
            r2ZipKey: fileKey
        };

        // GitHub dispatch trigger karein
        await github.post(`${API}/dispatches`, {
            event_type: 'build_apk',
            client_payload: {
                buildId,
                config,
                source: 'r2'
            }
        });

        return res.json({
            success: true,
            buildId,
            message: 'APK build started successfully.'
        });

    } catch (error) {
        console.error('R2 Complete Error:', error.response?.data || error.message);
        return res.status(500).json({ 
            success: false, 
            error: error.response?.data?.message || error.message 
        });
    }
});


// ============================================================
// APK BUILD ENDPOINT (Legacy - Direct files)
// ============================================================

app.post('/api/cloud-build-apk', async (req, res) => {
    let branch = null;
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
        // [CHANGE 4] 50 MB -> 100 MB
        const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

        // Upload project files.
        for (const file of projectFiles) {
            let blobContent;
            let byteLength;

            if (isBinaryContent(file.content)) {
                // Binary asset: decode -> re-encode base64 (lossless)
                const base64 = extractBase64Content(file.content);
                const buffer = Buffer.from(base64, 'base64');
                byteLength = buffer.length;
                blobContent = buffer.toString('base64');
            } else {
                // Text asset
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
        const githubError = error.response?.data;

        // Detailed logging taake actual reason pata chale
        console.error('APK BUILD ERROR:', {
            message: error.message,
            status: error.response?.status,
            githubError: githubError,
            buildId: buildId || null
        });

        // [CHANGE 5] Meaningful HTTP status
        let statusCode = 500;
        let errorMessage =
            error.response?.data?.message ||
            error.message ||
            'Could not start APK build.';

        if (error.response?.status === 401 || error.response?.status === 403) {
            statusCode = 502;
            errorMessage = 'GitHub authentication failed. Check GITHUB_TOKEN permissions.';
        } else if (error.response?.status === 404) {
            statusCode = 502;
            errorMessage = 'GitHub repository not found. Check GITHUB_REPO.';
        } else if (error.response?.status === 422) {
            statusCode = 502;
            errorMessage = 'GitHub rejected the request. The repository may be empty or the token lacks permissions.';
        } else if (error.message?.includes('too large')) {
            statusCode = 413;
        }

        const payload = {
            success: false,
            error: errorMessage
        };

        if (buildId) {
            payload.buildId = buildId;
        }

        return res.status(statusCode).json(payload);
    }
});

// ============================================================
// APK BUILD STATUS
// ORIGINAL IMPLEMENTATION PRESERVED - NO CHANGES
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
// GROQ CHAT ENDPOINT
// EXISTING SERVER-KEY ENDPOINT PRESERVED
// ============================================================

app.post('/api/ai-chat', async (req, res) => {
    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;

        if (!GROQ_API_KEY) {
            return res.status(500).json({
                error: 'GROQ_API_KEY is not configured on server.',
                provider: 'groq'
            });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: 'Messages are required.',
                provider: 'groq'
            });
        }

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'openai/gpt-oss-120b',
                messages,
                temperature: 0.7,
                max_tokens: 8192
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                timeout: 120000
            }
        );

        return res.json({
            ...response.data,
            provider: 'groq',
            fallback: false
        });

    } catch (error) {
        console.error(
            'GROQ AI ERROR:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            error:
                error.response?.data?.error?.message ||
                error.message ||
                'AI request failed.',
            provider: 'groq',
            fallback: false
        });
    }
});

// ============================================================
// OPENAI CHAT ENDPOINT
// EXISTING SERVER-KEY ENDPOINT PRESERVED
// ============================================================

app.post('/api/openai-chat', async (req, res) => {
    try {
        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        const OPENAI_MODEL = (
            process.env.OPENAI_MODEL || 'gpt-6-luna'
        ).trim();

        if (!OPENAI_API_KEY) {
            return res.status(500).json({
                error: 'OPENAI_API_KEY is not configured on server.',
                provider: 'openai'
            });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: 'Messages are required.',
                provider: 'openai'
            });
        }

        if (messages.length > 40) {
            return res.status(400).json({
                error: 'Too many messages. Maximum 40 messages allowed.',
                provider: 'openai'
            });
        }

        for (const message of messages) {
            if (
                !message ||
                typeof message.content !== 'string' ||
                !['system', 'developer', 'user', 'assistant'].includes(message.role)
            ) {
                return res.status(400).json({
                    error: 'Invalid message format.',
                    provider: 'openai'
                });
            }

            if (message.content.length > 30000) {
                return res.status(400).json({
                    error: 'A message is too large.',
                    provider: 'openai'
                });
            }
        }

        console.log(`[OpenAI] Sending request using ${OPENAI_MODEL}`);

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: OPENAI_MODEL,
                messages,
                max_completion_tokens: 8192
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                timeout: 120000
            }
        );

        const answer = response.data?.choices?.[0]?.message?.content;

        if (!answer) {
            console.error('[OpenAI] Empty response:', response.data);

            return res.status(502).json({
                error: 'OpenAI returned an empty response.',
                provider: 'openai'
            });
        }

        console.log('[OpenAI] Request successful.');

        return res.json({
            ...response.data,
            provider: 'openai',
            fallback: false
        });

    } catch (error) {
        const apiError =
            error.response?.data?.error?.message ||
            error.response?.data?.message ||
            error.message ||
            'OpenAI request failed.';

        console.error(
            '[OpenAI AI ERROR]:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            error: apiError,
            provider: 'openai',
            fallback: false
        });
    }
});

// ============================================================
// GEMINI CHAT ENDPOINT WITH GROQ FALLBACK
// EXISTING SERVER-KEY ENDPOINT PRESERVED
// ============================================================

app.post('/api/gemini-chat', async (req, res) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        const GROQ_API_KEY = process.env.GROQ_API_KEY;

        const GEMINI_MODEL = (
            process.env.GEMINI_MODEL || 'gemini-3.8-flash'
        ).trim().replace(/^models\//, '');

        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                error: 'GEMINI_API_KEY is not configured on server.',
                provider: 'gemini',
                fallback: false
            });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: 'Messages are required.',
                provider: 'gemini'
            });
        }

        if (messages.length > 40) {
            return res.status(400).json({
                error: 'Too many messages. Maximum 40 messages allowed.',
                provider: 'gemini'
            });
        }

        const systemMessages = [];
        const input = [];

        for (const message of messages) {
            if (
                !message ||
                typeof message.content !== 'string' ||
                !['system', 'developer', 'user', 'assistant'].includes(message.role)
            ) {
                return res.status(400).json({
                    error: 'Invalid message format.',
                    provider: 'gemini'
                });
            }

            if (message.content.length > 30000) {
                return res.status(400).json({
                    error: 'A message is too large.',
                    provider: 'gemini'
                });
            }

            if (
                message.role === 'system' ||
                message.role === 'developer'
            ) {
                systemMessages.push(message.content);
                continue;
            }

            input.push({
                type: message.role === 'assistant' ? 'model_output' : 'user_input',
                content: [{
                    type: 'text',
                    text: message.content
                }]
            });
        }

        if (input.length === 0) {
            return res.status(400).json({
                error: 'At least one user or assistant message is required.',
                provider: 'gemini'
            });
        }

        const requestBody = {
            model: GEMINI_MODEL,
            input,
            store: false
        };

        if (systemMessages.length > 0) {
            requestBody.system_instruction = systemMessages.join('\n\n');
        }

        function extractGeminiText(data) {
            const responseSteps = Array.isArray(data.steps)
                ? data.steps
                : [];

            const answerFromSteps = responseSteps
                .filter(step => step.type === 'model_output')
                .flatMap(step =>
                    Array.isArray(step.content) ? step.content : []
                )
                .filter(part =>
                    part.type === 'text' &&
                    typeof part.text === 'string'
                )
                .map(part => part.text)
                .join('');

            return (
                (typeof data.output_text === 'string'
                    ? data.output_text
                    : '') || answerFromSteps
            );
        }

        let geminiResponse = null;
        let geminiError = null;

        const retryDelays = [2000, 4000, 8000];

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
            try {
                console.log(
                    `[Gemini] Request attempt ${attempt + 1}/${retryDelays.length + 1}`
                );

                geminiResponse = await axios.post(
                    'https://generativelanguage.googleapis.com/v1beta/interactions',
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': GEMINI_API_KEY
                        },
                        timeout: 120000
                    }
                );

                geminiError = null;
                break;

            } catch (error) {
                geminiError = error;

                const status = error.response?.status;

                const temporaryError =
                    !error.response ||
                    [408, 429, 500, 502, 503, 504].includes(status);

                console.error(
                    `[Gemini] Attempt ${attempt + 1} failed:`,
                    error.response?.data || error.message
                );

                if (
                    !temporaryError ||
                    attempt >= retryDelays.length
                ) {
                    break;
                }

                const delay = retryDelays[attempt];

                console.log(
                    `[Gemini] Retrying after ${delay / 1000} seconds...`
                );

                await sleep(delay);
            }
        }

        if (geminiResponse) {
            const answer = extractGeminiText(geminiResponse.data);

            if (!answer) {
                console.error(
                    'GEMINI EMPTY RESPONSE:',
                    geminiResponse.data
                );

                return res.status(502).json({
                    error: 'Gemini returned an empty response.',
                    provider: 'gemini',
                    fallback: false
                });
            }

            return res.json({
                id: geminiResponse.data.id || 'gemini-response',
                object: 'chat.completion',
                model: geminiResponse.data.model || GEMINI_MODEL,
                provider: 'gemini',
                fallback: false,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: answer
                    },
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens:
                        geminiResponse.data.usage?.total_input_tokens || 0,
                    completion_tokens:
                        geminiResponse.data.usage?.total_output_tokens || 0,
                    total_tokens:
                        geminiResponse.data.usage?.total_tokens || 0
                }
            });
        }

        console.error(
            '[Gemini] All retry attempts failed. Trying Groq fallback.'
        );

        if (!GROQ_API_KEY) {
            const status = geminiError?.response?.status || 503;

            return res.status(status).json({
                error:
                    geminiError?.response?.data?.error?.message ||
                    geminiError?.message ||
                    'Gemini is temporarily unavailable. Groq fallback is not configured.',
                provider: 'gemini',
                fallback: false
            });
        }

        try {
            console.log('[Groq] Starting automatic fallback.');

            const groqResponse = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'openai/gpt-oss-120b',
                    messages,
                    temperature: 0.7,
                    max_tokens: 8192
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    timeout: 120000
                }
            );

            const groqAnswer =
                groqResponse.data?.choices?.[0]?.message?.content;

            if (!groqAnswer) {
                throw new Error('Groq returned an empty response.');
            }

            console.log('[Groq] Fallback successful.');

            return res.json({
                id: groqResponse.data.id || 'groq-fallback-response',
                object: 'chat.completion',
                model: groqResponse.data.model || 'openai/gpt-oss-120b',
                provider: 'groq',
                fallback: true,
                fallback_reason: 'Gemini temporarily unavailable.',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: groqAnswer
                    },
                    finish_reason: 'stop'
                }],
                usage: groqResponse.data.usage || {}
            });

        } catch (groqError) {
            console.error(
                '[Groq Fallback ERROR]:',
                groqError.response?.data || groqError.message
            );

            return res.status(502).json({
                error: 'Gemini is unavailable and Groq fallback also failed.',
                gemini_error:
                    geminiError?.response?.data?.error?.message ||
                    geminiError?.message ||
                    'Gemini request failed.',
                groq_error:
                    groqError.response?.data?.error?.message ||
                    groqError.message ||
                    'Groq request failed.',
                provider: 'gemini',
                fallback: false
            });
        }

    } catch (error) {
        console.error(
            'GEMINI AI ERROR:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            error:
                error.response?.data?.error?.message ||
                error.response?.data?.message ||
                error.message ||
                'Gemini AI request failed.',
            provider: 'gemini',
            fallback: false
        });
    }
});

// ============================================================
// MULTI-PROVIDER BYOK SYSTEM
// ============================================================

const BYOK_PROVIDERS = {
    openai: {
        label: 'OpenAI',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        models: [
            'gpt-6-luna',
            'gpt-5.4-mini',
            'gpt-4.1-mini'
        ],
        defaultModel: 'gpt-5.4-mini'
    },

    groq: {
        label: 'Groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        models: [
            'openai/gpt-oss-120b',
            'openai/gpt-oss-20b',
            'llama-3.3-70b-versatile'
        ],
        defaultModel: 'openai/gpt-oss-120b'
    },

    gemini: {
        label: 'Google Gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/',
        models: [
            'gemini-2.5-flash',
            'gemini-2.5-pro'
        ],
        defaultModel: 'gemini-2.5-flash'
    },

    deepseek: {
        label: 'DeepSeek',
        endpoint: 'https://api.deepseek.com/chat/completions',
        models: [
            'deepseek-flash',
            'deepseek-v4-pro'
        ],
        defaultModel: 'deepseek-flash'
    }
};

function byokValidateKey(apiKey) {
    if (
        typeof apiKey !== 'string' ||
        !apiKey.trim() ||
        apiKey.length > 512 ||
        /[\r\n]/.test(apiKey)
    ) {
        throw new Error('A valid API key is required.');
    }

    return apiKey.trim();
}

function byokNormalizeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('Messages are required.');
    }

    if (messages.length > 40) {
        throw new Error('Maximum 40 messages are allowed.');
    }

    return messages.map(message => {
        if (
            !message ||
            typeof message.content !== 'string' ||
            !['system', 'developer', 'user', 'assistant'].includes(message.role)
        ) {
            throw new Error('Invalid message format.');
        }

        if (message.content.length > 30000) {
            throw new Error('A message is too large.');
        }

        return {
            role: message.role,
            content: message.content
        };
    });
}

function byokBuildGeminiBody(messages, maxTokens, temperature) {
    const systemMessages = [];
    const contents = [];

    for (const message of messages) {
        if (
            message.role === 'system' ||
            message.role === 'developer'
        ) {
            systemMessages.push(message.content);
            continue;
        }

        contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
        });
    }

    const body = {
        contents,
        generationConfig: {
            maxOutputTokens: maxTokens || 4096,
            temperature: temperature ?? 0.7
        }
    };

    if (systemMessages.length) {
        body.systemInstruction = {
            parts: [{ text: systemMessages.join('\n\n') }]
        };
    }

    return body;
}

async function byokCallProvider(providerKey, apiKey, model, messages, options = {}) {
    const provider = BYOK_PROVIDERS[providerKey];

    if (!provider) {
        throw new Error('Unsupported AI provider.');
    }

    const key = byokValidateKey(apiKey);
    const selectedModel = String(model || provider.defaultModel).trim();

    if (
        !selectedModel ||
        selectedModel.length > 150 ||
        !/^[a-zA-Z0-9._:/-]+$/.test(selectedModel)
    ) {
        throw new Error('Invalid model name.');
    }

    const maxTokens = Math.min(
        Math.max(Number(options.maxTokens) || 4096, 1),
        16384
    );

    const temperature =
        typeof options.temperature === 'number'
            ? Math.max(0, Math.min(2, options.temperature))
            : 0.7;

    let url;
    let body;
    let headers;

    if (providerKey === 'gemini') {
        url = `${provider.endpoint}${encodeURIComponent(selectedModel)}:generateContent`;

        body = byokBuildGeminiBody(
            messages,
            maxTokens,
            temperature
        );

        headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
        };

    } else {
        url = provider.endpoint;

        body = {
            model: selectedModel,
            messages,
            max_tokens: maxTokens,
            temperature
        };

        if (providerKey === 'openai') {
            delete body.max_tokens;
            body.max_completion_tokens = maxTokens;
        }

        if (providerKey === 'deepseek') {
            body.stream = false;
        }

        headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        };
    }

    const response = await axios.post(
        url,
        body,
        {
            headers,
            timeout: 120000
        }
    );

    let content = '';
    let usage = response.data?.usage || null;

    if (providerKey === 'gemini') {
        content = response.data?.candidates?.[0]?.content?.parts
            ?.map(part => part.text || '')
            .join('') || '';

        usage = response.data?.usageMetadata || null;
    } else {
        content =
            response.data?.choices?.[0]?.message?.content || '';
    }

    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`${provider.label} returned an empty response.`);
    }

    return {
        content,
        provider: providerKey,
        model: response.data?.model ||
            response.data?.modelVersion ||
            selectedModel,
        usage
    };
}

function byokGetError(error, providerKey) {
    const status = error.response?.status || error.status || 502;

    const provider = BYOK_PROVIDERS[providerKey];
    const label = provider?.label || providerKey;

    const original =
        error.response?.data?.error?.message ||
        error.response?.data?.error?.status ||
        error.response?.data?.message ||
        error.message ||
        'AI request failed.';

    let message = String(original);

    if (status === 401) {
        message = `Invalid ${label} API key. Please check your key.`;
    } else if (status === 403) {
        message = `${label} access forbidden. Check API permissions and billing.`;
    } else if (status === 404) {
        message = `Model or endpoint not found for ${label}. Check your model name.`;
    } else if (status === 429) {
        message = `${label} rate limit or quota exceeded. Check your API usage and billing.`;
    } else if ([500, 502, 503, 504].includes(status)) {
        message = `${label} is temporarily unavailable. Please try again later.`;
    } else if (status === 408) {
        message = `${label} request timed out.`;
    }

    return { status, message };
}

// ============================================================
// BYOK CHAT ENDPOINT
// ============================================================

app.post('/api/ai/providers/:provider/chat', async (req, res) => {
    const providerKey = String(req.params.provider || '').toLowerCase();

    try {
        if (!BYOK_PROVIDERS[providerKey]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported AI provider.',
                provider: providerKey
            });
        }

        const {
            apiKey,
            model,
            messages,
            temperature,
            maxTokens
        } = req.body || {};

        const normalized = byokNormalizeMessages(messages);

        const result = await byokCallProvider(
            providerKey,
            apiKey,
            model,
            normalized,
            { temperature, maxTokens }
        );

        return res.json({
            success: true,
            provider: result.provider,
            model: result.model,
            content: result.content,
            usage: result.usage,
            fallback: false,
            billing: 'user_api_key'
        });

    } catch (error) {
        const result = byokGetError(error, providerKey);

        console.error('[BYOK CHAT ERROR]', {
            provider: providerKey,
            status: result.status,
            message: result.message.slice(0, 500)
        });

        return res.status(result.status).json({
            success: false,
            error: result.message,
            provider: providerKey,
            fallback: false,
            billing: 'user_api_key'
        });
    }
});

// ============================================================
// BYOK API KEY + MODEL TEST ENDPOINT
// ============================================================

app.post('/api/ai/providers/:provider/test', async (req, res) => {
    const providerKey = String(req.params.provider || '').toLowerCase();

    try {
        if (!BYOK_PROVIDERS[providerKey]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported AI provider.'
            });
        }

        const { apiKey, model } = req.body || {};
        const provider = BYOK_PROVIDERS[providerKey];

        const result = await byokCallProvider(
            providerKey,
            apiKey,
            model || provider.defaultModel,
            [{
                role: 'user',
                content: 'Reply with exactly: OK'
            }],
            {
                temperature: 0,
                maxTokens: 16
            }
        );

        return res.json({
            success: true,
            message: 'API connection successful.',
            provider: providerKey,
            model: result.model
        });

    } catch (error) {
        const result = byokGetError(error, providerKey);

        console.error('[BYOK TEST ERROR]', {
            provider: providerKey,
            status: result.status,
            message: result.message.slice(0, 500)
        });

        return res.status(result.status).json({
            success: false,
            error: result.message,
            provider: providerKey
        });
    }
});

// ============================================================
// LIVE PROVIDER MODELS API
// GET /api/ai/providers/:provider/models
// API KEY IS SENT IN REQUEST BODY
// ============================================================

app.post('/api/ai/providers/:provider/models', async (req, res) => {
    const providerKey = String(req.params.provider || '').toLowerCase();

    try {
        if (!BYOK_PROVIDERS[providerKey]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported AI provider.'
            });
        }

        const apiKey = byokValidateKey(req.body?.apiKey);

        let models = [];

        if (providerKey === 'openai') {
            const response = await axios.get(
                'https://api.openai.com/v1/models',
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`
                    },
                    timeout: 30000
                }
            );

            models = (response.data?.data || [])
                .filter(item => item.id)
                .map(item => ({
                    id: item.id,
                    name: item.id
                }))
                .sort((a, b) => a.id.localeCompare(b.id));

        } else if (providerKey === 'groq') {
            const response = await axios.get(
                'https://api.groq.com/openai/v1/models',
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`
                    },
                    timeout: 30000
                }
            );

            models = (response.data?.data || [])
                .filter(item => item.id)
                .map(item => ({
                    id: item.id,
                    name: item.id
                }))
                .sort((a, b) => a.id.localeCompare(b.id));

        } else if (providerKey === 'gemini') {
            const response = await axios.get(
                'https://generativelanguage.googleapis.com/v1beta/models',
                {
                    headers: {
                        'x-goog-api-key': apiKey
                    },
                    params: {
                        pageSize: 1000
                    },
                    timeout: 30000
                }
            );

            models = (response.data?.models || [])
                .filter(item =>
                    item.name &&
                    (
                        !item.supportedGenerationMethods ||
                        item.supportedGenerationMethods.includes('generateContent')
                    )
                )
                .map(item => ({
                    id: item.name.replace(/^models\//, ''),
                    name: item.displayName || item.name,
                    description: item.description || ''
                }))
                .sort((a, b) => a.id.localeCompare(b.id));

        } else if (providerKey === 'deepseek') {
            const response = await axios.get(
                'https://api.deepseek.com/models',
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`
                    },
                    timeout: 30000
                }
            );

            models = (response.data?.data || [])
                .filter(item => item.id)
                .map(item => ({
                    id: item.id,
                    name: item.id
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
        }

        return res.json({
            success: true,
            provider: providerKey,
            count: models.length,
            models
        });

    } catch (error) {
        const result = byokGetError(error, providerKey);

        console.error('[LIVE MODELS ERROR]', {
            provider: providerKey,
            status: result.status,
            message: result.message.slice(0, 500)
        });

        return res.status(result.status).json({
            success: false,
            provider: providerKey,
            error: result.message,
            models: []
        });
    }
});

// ============================================================
// PROVIDER + MODEL LIST
// GET /api/ai/providers
// ============================================================

app.get('/api/ai/providers', (req, res) => {
    const providers = Object.entries(BYOK_PROVIDERS).map(([id, provider]) => ({
        id,
        label: provider.label,
        models: provider.models,
        defaultModel: provider.defaultModel
    }));

    return res.json({
        success: true,
        providers
    });
});

// ============================================================
// AI CODING AGENT
// ============================================================

const AGENT_MAX_STEPS = 5;
const AGENT_MAX_FILES = 200;
const AGENT_MAX_FILE_SIZE = 2 * 1024 * 1024;
const AGENT_MAX_TOTAL_SIZE = 10 * 1024 * 1024;

// ------------------------------------------------------------
// SAFE FILE PATH
// ------------------------------------------------------------

function agentSafePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('Invalid file path.');
    }

    let normalized = filePath
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .trim();

    if (
        normalized.includes('\0') ||
        normalized.split('/').some(part => part === '..') ||
        normalized.startsWith('../')
    ) {
        throw new Error('Unsafe file path rejected.');
    }

    normalized = normalized.replace(/\/+/g, '/');

    if (!normalized || normalized === '.') {
        throw new Error('Invalid file path.');
    }

    return normalized;
}

// ------------------------------------------------------------
// NORMALIZE PROJECT FILES
// ------------------------------------------------------------

function agentPrepareFiles(inputFiles) {
    const result = {};

    if (!inputFiles) {
        return result;
    }

    if (Array.isArray(inputFiles)) {
        for (const file of inputFiles) {
            if (!file || typeof file !== 'object') continue;

            const filePath = agentSafePath(
                file.path || file.name || file.filename
            );

            const content =
                typeof file.content === 'string'
                    ? file.content
                    : '';

            result[filePath] = content;
        }
    } else if (typeof inputFiles === 'object') {
        for (const [filePath, content] of Object.entries(inputFiles)) {
            const safePath = agentSafePath(filePath);

            if (typeof content === 'string') {
                result[safePath] = content;
            } else if (
                content &&
                typeof content === 'object' &&
                typeof content.content === 'string'
            ) {
                result[safePath] = content.content;
            }
        }
    } else {
        throw new Error('Project files must be an object or array.');
    }

    const entries = Object.entries(result);

    if (entries.length > AGENT_MAX_FILES) {
        throw new Error(
            `Maximum ${AGENT_MAX_FILES} project files are allowed.`
        );
    }

    let totalSize = 0;

    for (const [filePath, content] of entries) {
        const size = Buffer.byteLength(content, 'utf8');

        if (size > AGENT_MAX_FILE_SIZE) {
            throw new Error(
                `File is too large: ${filePath}`
            );
        }

        totalSize += size;
    }

    if (totalSize > AGENT_MAX_TOTAL_SIZE) {
        throw new Error('Total project file size is too large.');
    }

    return result;
}

// ------------------------------------------------------------
// CONVERT FLAT FILES TO NESTED OBJECT
// ------------------------------------------------------------

function agentNestedFiles(files) {
    const output = {};

    for (const [filePath, content] of Object.entries(files || {})) {
        const safePath = agentSafePath(filePath);
        const parts = safePath.split('/');

        let current = output;

        for (let i = 0; i < parts.length - 1; i++) {
            if (
                !current[parts[i]] ||
                typeof current[parts[i]] !== 'object'
            ) {
                current[parts[i]] = {};
            }

            current = current[parts[i]];
        }

        current[parts[parts.length - 1]] = content;
    }

    return output;
}

// ------------------------------------------------------------
// PARSE AI JSON RESPONSE
// ------------------------------------------------------------

function agentParseJSON(content) {
    if (typeof content !== 'string') {
        throw new Error('AI returned an empty response.');
    }

    let cleaned = content.trim();

    cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace > firstBrace) {
            return JSON.parse(
                cleaned.substring(firstBrace, lastBrace + 1)
            );
        }

        throw new Error(
            'AI response JSON format mein nahi hai.'
        );
    }
}

// ------------------------------------------------------------
// VALIDATE USER API KEY
// ------------------------------------------------------------

function agentValidateApiKey(provider, apiKey) {
    const allowedProviders = [
        'openai',
        'groq',
        'gemini',
        'deepseek'
    ];

    if (!allowedProviders.includes(provider)) {
        throw new Error('Unsupported AI provider.');
    }

    if (
        typeof apiKey !== 'string' ||
        apiKey.trim().length < 10 ||
        apiKey.length > 500
    ) {
        throw new Error('Valid API key required.');
    }

    return true;
}

// ------------------------------------------------------------
// CALL SELECTED AI PROVIDER
// ------------------------------------------------------------

async function agentCallProvider(
    provider,
    apiKey,
    model,
    messages
) {
    agentValidateApiKey(provider, apiKey);

    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('AI messages are required.');
    }

    const timeout = 120000;

    try {
        // OPENAI
        if (provider === 'openai') {
            const response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: model || 'gpt-4.1-mini',
                    messages,
                    temperature: 0.2
                },
                {
                    timeout,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data?.choices?.[0]?.message?.content || '';
        }

        // GROQ
        if (provider === 'groq') {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: model || 'openai/gpt-oss-20b',
                    messages,
                    temperature: 0.2
                },
                {
                    timeout,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data?.choices?.[0]?.message?.content || '';
        }

        // DEEPSEEK
        if (provider === 'deepseek') {
            const response = await axios.post(
                'https://api.deepseek.com/chat/completions',
                {
                    model: model || 'deepseek-chat',
                    messages,
                    temperature: 0.2
                },
                {
                    timeout,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data?.choices?.[0]?.message?.content || '';
        }

        // GEMINI
        if (provider === 'gemini') {
            const selectedModel = (
                model || 'gemini-2.5-flash'
            ).replace(/^models\//, '');

            const systemMessages = messages
                .filter(message => message.role === 'system')
                .map(message => message.content)
                .join('\n\n');

            const contents = messages
                .filter(message =>
                    message.role !== 'system'
                )
                .map(message => ({
                    role:
                        message.role === 'assistant'
                            ? 'model'
                            : 'user',
                    parts: [
                        {
                            text: String(message.content || '')
                        }
                    ]
                }));

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`,
                {
                    systemInstruction: systemMessages
                        ? {
                            parts: [{ text: systemMessages }]
                        }
                        : undefined,
                    contents,
                    generationConfig: {
                        temperature: 0.2,
                        responseMimeType: 'application/json'
                    }
                },
                {
                    timeout,
                    headers: {
                        'x-goog-api-key': apiKey,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return (
                response.data?.candidates?.[0]
                    ?.content?.parts
                    ?.map(part => part.text || '')
                    .join('') || ''
            );
        }

        throw new Error('Unsupported AI provider.');

    } catch (error) {
        const providerMessage =
            error.response?.data?.error?.message ||
            error.response?.data?.error ||
            error.response?.data?.message ||
            error.message;

        throw new Error(
            `${provider.toUpperCase()} API Error: ${String(providerMessage).slice(0, 1000)}`
        );
    }
}

// ------------------------------------------------------------
// EXECUTE AI FILE ACTIONS
// ------------------------------------------------------------

function agentExecuteActions(files, actions) {
    const changedFiles = [];
    const deletedFiles = [];
    const results = [];

    if (!Array.isArray(actions)) {
        throw new Error('AI actions must be an array.');
    }

    if (actions.length > AGENT_MAX_STEPS) {
        throw new Error(
            `AI can perform maximum ${AGENT_MAX_STEPS} actions per request.`
        );
    }

    for (const action of actions) {
        if (!action || typeof action !== 'object') {
            continue;
        }

        const type = String(
            action.type || action.action || ''
        ).toLowerCase();

        // LIST FILES
        if (type === 'list' || type === 'list_files') {
            results.push({
                action: type,
                files: Object.keys(files)
            });

            continue;
        }

        // READ FILE
        if (type === 'read' || type === 'read_file') {
            const filePath = agentSafePath(
                action.path || action.file
            );

            if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
                results.push({
                    action: type,
                    path: filePath,
                    error: 'File not found.'
                });

                continue;
            }

            results.push({
                action: type,
                path: filePath,
                content: files[filePath]
            });

            continue;
        }

        // SEARCH PROJECT
        if (type === 'search' || type === 'search_files') {
            const query = String(
                action.query || action.search || ''
            );

            if (!query) {
                results.push({
                    action: type,
                    error: 'Search query required.'
                });

                continue;
            }

            const matches = [];

            for (const [filePath, content] of Object.entries(files)) {
                const lines = content.split('\n');

                lines.forEach((line, index) => {
                    if (
                        line.toLowerCase().includes(query.toLowerCase())
                    ) {
                        matches.push({
                            path: filePath,
                            line: index + 1,
                            content: line.trim().slice(0, 500)
                        });
                    }
                });

                if (matches.length >= 100) break;
            }

            results.push({
                action: type,
                query,
                matches
            });

            continue;
        }

        // CREATE OR UPDATE FILE
        if (
            type === 'write' ||
            type === 'write_file' ||
            type === 'create_file' ||
            type === 'update_file'
        ) {
            const filePath = agentSafePath(
                action.path || action.file
            );

            if (typeof action.content !== 'string') {
                results.push({
                    action: type,
                    path: filePath,
                    error: 'File content must be a string.'
                });

                continue;
            }

            const newSize = Buffer.byteLength(
                action.content,
                'utf8'
            );

            if (newSize > AGENT_MAX_FILE_SIZE) {
                throw new Error(
                    `Generated file is too large: ${filePath}`
                );
            }

            const isNew = !Object.prototype.hasOwnProperty.call(
                files,
                filePath
            );

            files[filePath] = action.content;

            if (!changedFiles.includes(filePath)) {
                changedFiles.push(filePath);
            }

            results.push({
                action: type,
                path: filePath,
                status: isNew ? 'created' : 'updated'
            });

            continue;
        }

        // DELETE FILE
        if (type === 'delete' || type === 'delete_file') {
            const filePath = agentSafePath(
                action.path || action.file
            );

            if (
                Object.prototype.hasOwnProperty.call(files, filePath)
            ) {
                delete files[filePath];

                deletedFiles.push(filePath);

                results.push({
                    action: type,
                    path: filePath,
                    status: 'deleted'
                });
            } else {
                results.push({
                    action: type,
                    path: filePath,
                    error: 'File not found.'
                });
            }

            continue;
        }

        results.push({
            action: type || 'unknown',
            error: 'Unsupported action.'
        });
    }

    const totalSize = Object.values(files).reduce(
        (total, content) =>
            total + Buffer.byteLength(content, 'utf8'),
        0
    );

    if (Object.keys(files).length > AGENT_MAX_FILES) {
        throw new Error('Maximum project file count exceeded.');
    }

    if (totalSize > AGENT_MAX_TOTAL_SIZE) {
        throw new Error('Total project size limit exceeded.');
    }

    return {
        files,
        nestedFiles: agentNestedFiles(files),
        changedFiles,
        deletedFiles,
        results
    };
}

// ------------------------------------------------------------
// AI CODING AGENT ENDPOINT
// ------------------------------------------------------------

app.post('/api/ai-agent', async (req, res) => {
    try {
        const {
            provider,
            apiKey,
            model,
            prompt,
            message,
            files: inputFiles,
            history
        } = req.body || {};

        // Validate provider and user's own API key
        agentValidateApiKey(provider, apiKey);

        const userPrompt = String(
            prompt || message || ''
        ).trim();

        if (!userPrompt) {
            return res.status(400).json({
                success: false,
                error: 'Please enter your coding instruction.'
            });
        }

        if (userPrompt.length > 30000) {
            return res.status(400).json({
                success: false,
                error: 'Prompt is too long.'
            });
        }

        // Prepare project files
        const projectFiles = agentPrepareFiles(inputFiles);

        // Limit conversation history
        const safeHistory = Array.isArray(history)
            ? history
                .filter(item =>
                    item &&
                    ['user', 'assistant'].includes(item.role) &&
                    typeof item.content === 'string'
                )
                .slice(-10)
                .map(item => ({
                    role: item.role,
                    content: item.content.slice(0, 12000)
                }))
            : [];

        const systemPrompt = `
You are an expert AI Coding Agent working inside Web App Studio.

YOUR MAIN JOB:
Understand the user's instruction, inspect the provided project files,
and make the requested code changes.

IMPORTANT RULES:

1. Preserve existing code and project structure.
2. Do not delete existing code unless the user explicitly asks.
3. Do not rewrite an entire file when a small change is enough.
4. Do not remove existing features, buttons, functions, styles,
   event listeners, integrations, or working logic.
5. Keep existing IDs, class names, variable names, and function names
   unless changing them is necessary for the requested task.
6. When updating a file, return its complete updated content.
7. Never use placeholder comments instead of actual implementation.
8. Do not claim that a change was made unless you provide the
   corresponding write action.
9. If the user asks a question without requesting a code change,
   explain the answer and do not modify files.
10. If required information is missing, ask a clear question instead
    of inventing project requirements.
11. Do not create unnecessary files.
12. Do not delete files unless the user clearly requested deletion.

AVAILABLE ACTIONS:

- list: List project files.
- read: Read a project file.
- search: Search text inside project files.
- write: Create or update a project file.
- delete: Delete a file only when explicitly requested.

RESPONSE FORMAT:

Return ONLY valid JSON. Do not use Markdown code fences.

Use this structure:

{
  "message": "Explain what you did or answer the user.",
  "actions": [
    {
      "type": "read",
      "path": "index.html"
    },
    {
      "type": "write",
      "path": "index.html",
      "content": "Complete updated file content"
    }
  ]
}

If no file changes are required, return an empty actions array.

Maximum ${AGENT_MAX_STEPS} actions in one response.

The project files supplied by the user are the source of truth.
Do not assume files or code exist unless they are provided.
`;

        const fileContext = JSON.stringify(
            projectFiles,
            null,
            2
        );

        const messages = [
            {
                role: 'system',
                content: systemPrompt
            },
            ...safeHistory,
            {
                role: 'user',
                content:
                    `PROJECT FILES:\n${fileContext}\n\n` +
                    `USER INSTRUCTION:\n${userPrompt}`
            }
        ];

        // Call only the provider and API key selected by the user
        const aiResponse = await agentCallProvider(
            provider,
            apiKey,
            model,
            messages
        );

        const parsed = agentParseJSON(aiResponse);

        const agentMessage =
            typeof parsed.message === 'string'
                ? parsed.message
                : 'AI Coding Agent completed the request.';

        const actions = Array.isArray(parsed.actions)
            ? parsed.actions
            : [];

        // Apply the requested file actions
        const execution = agentExecuteActions(
            projectFiles,
            actions
        );

        return res.json({
            success: true,
            provider,
            model: model || null,
            message: agentMessage,
            files: execution.files,
            nestedFiles: execution.nestedFiles,
            changedFiles: execution.changedFiles,
            deletedFiles: execution.deletedFiles,
            results: execution.results
        });

    } catch (error) {
        console.error(
            'AI Coding Agent Error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            error: error.message || 'AI Coding Agent request failed.'
        });
    }
});

// ============================================================
// FINAL EXPORT
// ============================================================

module.exports = app;