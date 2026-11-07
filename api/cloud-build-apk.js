const { applyAdMobIntegration } = require('../lib/admob-injector');
const axios = require('axios');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'mrihtisham98-ops/apk-builder-backend';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
const DEFAULT_BRANCH = 'main';

const githubHeaders = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
};

// Nested virtual file system ko flat files mein convert karta hai.
function flattenFiles(input, prefix = '', output = {}) {
    if (!input || typeof input !== 'object') return output;

    for (const [key, value] of Object.entries(input)) {
        const filePath = prefix ? `${prefix}/${key}` : key;

        if (typeof value === 'string') {
            output[filePath] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenFiles(value, filePath, output);
        }
    }

    return output;
}

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Only POST requests are allowed.'
        });
    }

    if (!GITHUB_TOKEN) {
        return res.status(500).json({
            success: false,
            error: 'GITHUB_TOKEN is missing in Vercel environment variables.'
        });
    }

    let buildBranch = null;

    try {
        const {
            appName,
            packageName,
            appIcon,
            iconBase64,
            files,
            adMob
        } = req.body || {};

        if (!appName || !packageName || !files) {
            return res.status(400).json({
                success: false,
                error: 'App name, package name and project files are required.'
            });
        }

        if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Android package name.'
            });
        }

        // Project files flatten karo.
        const projectFiles = flattenFiles(files);

        if (!projectFiles['index.html']) {
            return res.status(400).json({
                success: false,
                error: 'Root index.html file was not found.'
            });
        }

        // AdMob integration.
        const adMobResult = applyAdMobIntegration(
            projectFiles,
            adMob || { enabled: false }
        );

        // Unique build ID aur temporary branch.
        const buildId = crypto.randomUUID();
        buildBranch = `build-${buildId}`;
        const buildFolder = `.build-input/${buildId}`;

        // Build configuration.
        const buildConfig = {
            buildId,
            appName,
            packageName,
            appIcon: appIcon || iconBase64 || null,
            adMob: adMobResult.resolved || { enabled: false }
        };

        // GitHub par main branch ka latest commit lo.
        const mainRef = await axios.get(
            `${GITHUB_API}/git/ref/heads/${DEFAULT_BRANCH}`,
            { headers: githubHeaders }
        );

        const parentSha = mainRef.data.object.sha;

        const parentCommit = await axios.get(
            `${GITHUB_API}/git/commits/${parentSha}`,
            { headers: githubHeaders }
        );

        const baseTreeSha = parentCommit.data.tree.sha;

        // Build configuration ko GitHub blob mein upload karo.
        const configBlob = await axios.post(
            `${GITHUB_API}/git/blobs`,
            {
                content: JSON.stringify(buildConfig, null, 2),
                encoding: 'utf-8'
            },
            { headers: githubHeaders }
        );

        const treeItems = [
            {
                path: `${buildFolder}/build-config.json`,
                mode: '100644',
                type: 'blob',
                sha: configBlob.data.sha
            }
        ];

        // Project ki tamam files GitHub blobs mein upload karo.
        const fileEntries = Object.entries(projectFiles);

        const uploadedFiles = await Promise.all(
            fileEntries.map(async ([filePath, content]) => {
                const blob = await axios.post(
                    `${GITHUB_API}/git/blobs`,
                    {
                        content,
                        encoding: 'utf-8'
                    },
                    { headers: githubHeaders }
                );

                return {
                    path: `${buildFolder}/files/${filePath}`,
                    mode: '100644',
                    type: 'blob',
                    sha: blob.data.sha
                };
            })
        );

        treeItems.push(...uploadedFiles);

        // GitHub tree create karo.
        const newTree = await axios.post(
            `${GITHUB_API}/git/trees`,
            {
                base_tree: baseTreeSha,
                tree: treeItems
            },
            { headers: githubHeaders }
        );

        // Temporary commit create karo.
        const newCommit = await axios.post(
            `${GITHUB_API}/git/commits`,
            {
                message: `APK build ${buildId}`,
                tree: newTree.data.sha,
                parents: [parentSha]
            },
            { headers: githubHeaders }
        );

        // Temporary branch create karo.
        await axios.post(
            `${GITHUB_API}/git/refs`,
            {
                ref: `refs/heads/${buildBranch}`,
                sha: newCommit.data.sha
            },
            { headers: githubHeaders }
        );

        // GitHub Actions workflow start karo.
        await axios.post(
            `${GITHUB_API}/dispatches`,
            {
                event_type: 'build_apk',
                client_payload: {
                    buildId,
                    ref: buildBranch
                }
            },
            { headers: githubHeaders }
        );

        return res.status(200).json({
            success: true,
            buildId,
            message: 'APK build request submitted successfully.',
            artifactsUrl: `https://github.com/${GITHUB_REPO}/actions`,
            adMob: {
                enabled: !!adMobResult.applied,
                reason: adMobResult.reason
            }
        });

    } catch (error) {
        console.error(
            'Cloud APK Build Error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            error:
                error.response?.data?.message ||
                error.response?.data?.error ||
                error.message ||
                'Cloud APK build failed.'
        });
    }
};