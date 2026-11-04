const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "mrihtisham98-ops/apk-builder-backend";

app.post('/api/cloud-build-apk', async (req, res) => {
    const { appName, files } = req.body;
    try {
        const response = await axios.post(
            `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
            {
                event_type: 'build_apk',
                client_payload: { appName, files }
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );
        res.json({ success: true, message: "APK Build initiated on GitHub Actions!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
