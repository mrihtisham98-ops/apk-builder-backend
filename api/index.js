
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
// APK BUILD ENDPOINT
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

        // Upload project files.
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
// APK BUILD STATUS
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
// WEB APP STUDIO - AI CODING AGENT
// ============================================================

const AGENT_MAX_STEPS = 5;
const AGENT_MAX_FILES = 100;
const AGENT_MAX_FILE_SIZE = 1024 * 1024;
const AGENT_MAX_TOTAL_SIZE = 5 * 1024 * 1024;
const AGENT_MAX_ACTIONS = 30;

// Validate paths to prevent directory traversal.
function agentSafePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('Invalid file path.');
    }

    const normalized = filePath
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    const parts = normalized.split('/');

    if (
        parts.some(part =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.includes('\0')
        )
    ) {
        throw new Error('Unsafe file path: ' + filePath);
    }

    return normalized;
}

// Prepare a nested project object for the agent.
function agentPrepareFiles(files) {
    const flattened = flattenFiles(files);
    const result = {};
    let totalSize = 0;

    if (flattened.length > AGENT_MAX_FILES) {
        throw new Error(
            `Maximum ${AGENT_MAX_FILES} project files are supported.`
        );
    }

    for (const file of flattened) {
        const safePath = agentSafePath(file.path);
        const size = Buffer.byteLength(file.content, 'utf8');

        if (size > AGENT_MAX_FILE_SIZE) {
            throw new Error(`File is too large: ${safePath}`);
        }

        totalSize += size;

        if (totalSize > AGENT_MAX_TOTAL_SIZE) {
            throw new Error('AI Agent project limit is 5 MB.');
        }

        result[safePath] = file.content;
    }

    return result;
}

// Convert a flat project map back into a nested object.
function agentNestedFiles(flatFiles) {
    const nested = {};

    for (const [filePath, content] of Object.entries(flatFiles)) {
        const safePath = agentSafePath(filePath);
        const parts = safePath.split('/');
        let current = nested;

        for (let index = 0; index < parts.length - 1; index++) {
            const part = parts[index];

            if (
                !current[part] ||
                typeof current[part] !== 'object' ||
                Array.isArray(current[part])
            ) {
                current[part] = {};
            }

            current = current[part];
        }

        current[parts[parts.length - 1]] = content;
    }

    return nested;
}

// Parse the JSON returned by the AI.
function agentParseJSON(text) {
    if (typeof text !== 'string') {
        throw new Error('AI returned an invalid response.');
    }

    let cleaned = text.trim();

    cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (_) {
        const first = cleaned.indexOf('{');
        const last = cleaned.lastIndexOf('}');

        if (first !== -1 && last > first) {
            return JSON.parse(cleaned.slice(first, last + 1));
        }

        throw new Error(
            'AI did not return valid agent instructions. Please try again.'
        );
    }
}

// Call the selected AI provider for agent work.
async function agentCallProvider(provider, messages) {
    if (provider === 'openai') {
        const key = process.env.OPENAI_API_KEY;

        if (!key) {
            throw new Error('OPENAI_API_KEY is not configured.');
        }

        const model = (
            process.env.OPENAI_MODEL || 'gpt-6-luna'
        ).trim();

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model,
                messages,
                max_completion_tokens: 8192
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${key}`
                },
                timeout: 120000
            }
        );

        const answer = response.data?.choices?.[0]?.message?.content;

        if (!answer) {
            throw new Error('OpenAI returned an empty response.');
        }

        return {
            text: answer,
            provider: 'openai',
            fallback: false
        };
    }

    if (provider === 'groq') {
        const key = process.env.GROQ_API_KEY;

        if (!key) {
            throw new Error('GROQ_API_KEY is not configured.');
        }

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'openai/gpt-oss-120b',
                messages,
                temperature: 0.2,
                max_tokens: 8192
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${key}`
                },
                timeout: 120000
            }
        );

        const answer = response.data?.choices?.[0]?.message?.content;

        if (!answer) {
            throw new Error('Groq returned an empty response.');
        }

        return {
            text: answer,
            provider: 'groq',
            fallback: false
        };
    }

    if (provider === 'gemini') {
        const key = process.env.GEMINI_API_KEY;

        if (!key) {
            throw new Error('GEMINI_API_KEY is not configured.');
        }

        const model = (
            process.env.GEMINI_MODEL || 'gemini-3.8-flash'
        ).trim().replace(/^models\//, '');

        const systemMessages = [];
        const input = [];

        for (const message of messages) {
            if (
                message.role === 'system' ||
                message.role === 'developer'
            ) {
                systemMessages.push(message.content);
            } else {
                input.push({
                    type: message.role === 'assistant'
                        ? 'model_output'
                        : 'user_input',
                    content: [{
                        type: 'text',
                        text: message.content
                    }]
                });
            }
        }

        const requestBody = {
            model,
            input,
            store: false
        };

        if (systemMessages.length) {
            requestBody.system_instruction =
                systemMessages.join('\n\n');
        }

        const response = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/interactions',
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': key
                },
                timeout: 120000
            }
        );

        const data = response.data || {};

        let answer = data.output_text || '';

        if (!answer && Array.isArray(data.steps)) {
            answer = data.steps
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
        }

        if (!answer) {
            throw new Error('Gemini returned an empty response.');
        }

        return {
            text: answer,
            provider: 'gemini',
            fallback: false
        };
    }

    throw new Error('Unsupported AI provider.');
}

// Execute AI file actions in a virtual project.
function agentExecuteActions(files, actions) {
    const results = [];
    const changedFiles = [];
    const deletedFiles = [];

    if (!Array.isArray(actions)) {
        throw new Error('AI returned invalid actions.');
    }

    if (actions.length > AGENT_MAX_ACTIONS) {
        throw new Error(
            `Maximum ${AGENT_MAX_ACTIONS} actions allowed per step.`
        );
    }

    for (const action of actions) {
        if (!action || typeof action.type !== 'string') {
            throw new Error('Invalid agent action.');
        }

        if (action.type === 'list_files') {
            results.push({
                type: action.type,
                files: Object.keys(files)
            });

            continue;
        }

        if (action.type === 'read_file') {
            const path = agentSafePath(action.path);

            results.push({
                type: action.type,
                path,
                content: files[path] ?? null,
                exists: Object.prototype.hasOwnProperty.call(files, path)
            });

            continue;
        }

        if (action.type === 'search_files') {
            const query = String(action.query || '');

            if (!query || query.length > 500) {
                throw new Error('Invalid search query.');
            }

            const matches = [];

            for (const [path, content] of Object.entries(files)) {
                const lines = content.split('\n');

                lines.forEach((line, index) => {
                    if (
                        line.toLowerCase().includes(query.toLowerCase())
                    ) {
                        matches.push({
                            path,
                            line: index + 1,
                            content: line.slice(0, 500)
                        });
                    }
                });

                if (matches.length >= 100) break;
            }

            results.push({
                type: action.type,
                matches
            });

            continue;
        }

        if (action.type === 'write_file') {
            const path = agentSafePath(action.path);

            if (typeof action.content !== 'string') {
                throw new Error('File content must be text.');
            }

            const size = Buffer.byteLength(action.content, 'utf8');

            if (size > AGENT_MAX_FILE_SIZE) {
                throw new Error(`Edited file is too large: ${path}`);
            }

            files[path] = action.content;

            changedFiles.push(path);

            results.push({
                type: action.type,
                path,
                success: true
            });

            continue;
        }

        if (action.type === 'delete_file') {
            const path = agentSafePath(action.path);

            if (!Object.prototype.hasOwnProperty.call(files, path)) {
                results.push({
                    type: action.type,
                    path,
                    success: false,
                    message: 'File does not exist.'
                });

                continue;
            }

            delete files[path];

            deletedFiles.push(path);

            results.push({
                type: action.type,
                path,
                success: true
            });

            continue;
        }

        throw new Error('Unsupported agent action: ' + action.type);
    }

    let totalSize = 0;

    for (const content of Object.values(files)) {
        totalSize += Buffer.byteLength(content, 'utf8');
    }

    if (Object.keys(files).length > AGENT_MAX_FILES) {
        throw new Error('Agent exceeded the maximum project file count.');
    }

    if (totalSize > AGENT_MAX_TOTAL_SIZE) {
        throw new Error('Agent exceeded the 5 MB project limit.');
    }

    return {
        results,
        changedFiles: [...new Set(changedFiles)],
        deletedFiles: [...new Set(deletedFiles)]
    };
}

// ============================================================
// AI AGENT ENDPOINT
// ============================================================

app.post('/api/ai-agent', async (req, res) => {
    try {
        const {
            provider = 'groq',
            task,
            files: submittedFiles
        } = req.body || {};

        if (!['openai', 'groq', 'gemini'].includes(provider)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid AI provider.'
            });
        }

        if (
            typeof task !== 'string' ||
            !task.trim() ||
            task.length > 12000
        ) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a task. Maximum 12000 characters.'
            });
        }

        if (
            !submittedFiles ||
            typeof submittedFiles !== 'object' ||
            Array.isArray(submittedFiles)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Project files are required.'
            });
        }

        const virtualFiles = agentPrepareFiles(submittedFiles);

        if (!Object.keys(virtualFiles).length) {
            return res.status(400).json({
                success: false,
                error: 'The project contains no files.'
            });
        }

        const systemPrompt = `
You are the Web App Studio autonomous coding agent.

Your job is to understand and modify the user's submitted project.

You can inspect files and make changes using the actions below.

You MUST return ONLY valid JSON. Do not use Markdown fences.

JSON format:
{
  "message": "Short explanation of your progress",
  "actions": [],
  "done": false
}

Available actions:

1. Read a file:
{"type":"read_file","path":"index.html"}

2. List files:
{"type":"list_files"}

3. Search project:
{"type":"search_files","query":"function renderApp"}

4. Create or completely update a file:
{"type":"write_file","path":"index.html","content":"FULL FILE CONTENT"}

5. Delete a file:
{"type":"delete_file","path":"old-file.js"}

Rules:

- Work only with the submitted project files.
- Never access server files or run operating-system commands.
- Preserve existing features and code wherever possible.
- Do not delete unrelated code.
- When modifying a file, return its complete updated content.
- You may edit multiple files in one step.
- Read or search files when you need more information.
- Do not delete files unless the user explicitly requests deletion.
- Never claim code was tested unless it was actually tested.
- Do not make unrelated design changes.
- If the task is unclear, ask a question in message and set done=true.
- When all requested changes are prepared, set done=true.
- If another step is needed, set done=false.
- Keep actions focused on the user's task.
`;

        let conversation = [
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'user',
                content:
                    `USER TASK:\n${task}\n\n` +
                    `PROJECT FILES:\n${JSON.stringify(virtualFiles)}`
            }
        ];

        let actualProvider = provider;
        let usedFallback = false;
        let finalMessage = '';
        let completed = false;

        const allChangedFiles = new Set();
        const allDeletedFiles = new Set();
        const actionHistory = [];

        for (let step = 0; step < AGENT_MAX_STEPS; step++) {
            let modelResult;

            try {
                modelResult = await agentCallProvider(
                    actualProvider,
                    conversation
                );
            } catch (providerError) {
                if (
                    actualProvider === 'gemini' &&
                    process.env.GROQ_API_KEY
                ) {
                    console.error(
                        '[AI Agent] Gemini failed; trying Groq:',
                        providerError.message
                    );

                    actualProvider = 'groq';
                    usedFallback = true;

                    modelResult = await agentCallProvider(
                        'groq',
                        conversation
                    );
                } else {
                    throw providerError;
                }
            }

            actualProvider = modelResult.provider;
            usedFallback = usedFallback || modelResult.fallback;

            const instruction = agentParseJSON(modelResult.text);

            finalMessage = String(
                instruction.message || ''
            ).slice(0, 5000);

            const execution = agentExecuteActions(
                virtualFiles,
                instruction.actions || []
            );

            execution.changedFiles.forEach(path =>
                allChangedFiles.add(path)
            );

            execution.deletedFiles.forEach(path =>
                allDeletedFiles.add(path)
            );

            actionHistory.push({
                step: step + 1,
                actions: execution.results
            });

            if (instruction.done === true) {
                completed = true;
                break;
            }

            conversation.push({
                role: 'assistant',
                content: modelResult.text
            });

            conversation.push({
                role: 'user',
                content:
                    'Execute the next step. Previous action results:\n' +
                    JSON.stringify(execution.results) +
                    '\n\nCurrent project files:\n' +
                    JSON.stringify(virtualFiles) +
                    '\n\nReturn the required JSON only.'
            });
        }

        if (!completed) {
            finalMessage +=
                '\nAgent reached its maximum step limit. Some tasks may remain incomplete.';
        }

        return res.json({
            success: true,
            completed,
            message: finalMessage,
            provider: actualProvider,
            fallback: usedFallback,
            changedFiles: [...allChangedFiles],
            deletedFiles: [...allDeletedFiles],
            files: agentNestedFiles(virtualFiles),
            steps: actionHistory.length,
            history: actionHistory,
            note:
                'Changes are prepared in the returned project snapshot. ' +
                'The frontend must apply these files to the editor.'
        });

    } catch (error) {
        console.error(
            '[AI AGENT ERROR]:',
            error.response?.data || error.message
        );

        return res.status(error.response?.status || 500).json({
            success: false,
            error:
                error.response?.data?.error?.message ||
                error.response?.data?.message ||
                error.message ||
                'AI Agent request failed.'
        });
    }
});

// ============================================================
// END AI CODING AGENT
// ============================================================

module.exports = app;
