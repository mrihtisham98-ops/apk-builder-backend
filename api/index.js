
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { applyAdMobIntegration } = require('../lib/admob-injector');

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

// Convert nested project files into individual paths.
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

// Start a cloud APK build.
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

        // ===== AdMob Integration START =====

        // Convert flattened files into the format required by the injector.
        const admobFiles = {};

        for (const file of projectFiles) {
            admobFiles[file.path] = file.content;
        }

        // Apply AdMob integration.
        const adMobResult = applyAdMobIntegration(admobFiles, adMob);

        console.log('[AdMob]', adMobResult.reason);

        // Convert modified files back into upload format.
        projectFiles = Object.entries(admobFiles).map(([path, content]) => ({
            path,
            content
        }));

        // ===== AdMob Integration END =====

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

            if (totalBytes > 50 * 1024 * 1024) {
                throw new Error(
                    'Project is too large for this upload endpoint. Maximum supported size is 50 MB.'
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

            if (totalBytes > 50 * 1024 * 1024) {
                throw new Error('Project and icon exceed the 50 MB upload limit.');
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

// Check build status and get the public APK download link.
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

        // First check whether the APK release exists.
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

        // Find the GitHub Actions run for this build.
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

// Secure Groq AI Chat Endpoint
app.post('/api/ai-chat', async (req, res) => {
    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;

        if (!GROQ_API_KEY) {
            return res.status(500).json({
                error: 'GROQ_API_KEY is not configured on server.'
            });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: 'Messages are required.'
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

// ===== Gemini AI Chat Endpoint START =====
// Gemini Interactions API with automatic retry and Groq fallback.

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
                error: 'GEMINI_API_KEY is not configured on server.'
            });
        }

        const { messages } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: 'Messages are required.'
            });
        }

        if (messages.length > 40) {
            return res.status(400).json({
                error: 'Too many messages. Maximum 40 messages allowed.'
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
                    error: 'Invalid message format.'
                });
            }

            if (message.content.length > 30000) {
                return res.status(400).json({
                    error: 'A message is too large.'
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
                error: 'At least one user or assistant message is required.'
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

        // Extract text from Gemini response.
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

        // Retry temporary Gemini errors.
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

        // Gemini succeeded: return its response.
        if (geminiResponse) {
            const answer = extractGeminiText(geminiResponse.data);

            if (!answer) {
                console.error(
                    'GEMINI EMPTY RESPONSE:',
                    geminiResponse.data
                );

                return res.status(502).json({
                    error: 'Gemini returned an empty response.'
                });
            }

            return res.json({
                id: geminiResponse.data.id || 'gemini-response',
                object: 'chat.completion',
                model: geminiResponse.data.model || GEMINI_MODEL,
                provider: 'gemini',
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

        // Gemini failed: use existing Groq model automatically.
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
                'Gemini AI request failed.'
        });
    }
});

// ===== Gemini AI Chat Endpoint END =====

module.exports = app;
