const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Limit increased for base64 screenshots if needed
app.use(bodyParser.urlencoded({ extended: true }));

// 1. Serve the Main "Dashboard" App (The Editor)
app.use(express.static('public'));

// 2. Serve the "User's Website" (The Real Deployment)
// This directory will hold the files the user creates
const USER_SITE_DIR = path.join(__dirname, 'user_site');

// Ensure user_site directory exists
if (!fs.existsSync(USER_SITE_DIR)){
    fs.mkdirSync(USER_SITE_DIR);
    // Create a default file so it's not empty
    fs.writeFileSync(path.join(USER_SITE_DIR, 'index.html'), '<h1>Welcome to your new site!</h1>');
}

// Serve user content at a specific route, e.g., /site
app.use('/site', express.static(USER_SITE_DIR));

// API: Save User Code
app.post('/api/deploy', (req, res) => {
    const { html, css, js } = req.body;

    // We will combine them into a single HTML file for simplicity in this version,
    // but you could split them if you wanted.
    // We inject a special script to capture console logs and handle screenshots.
    
    const combinedHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Deployed Site</title>
    <style>${css || ''}</style>
    <!-- Screen Capture Library -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
</head>
<body>
    ${html || ''}

    <script>
        // --- INJECTED HOST CODE START ---
        
        // 1. Capture Console Logs
        const originalLog = console.log;
        const originalError = console.error;

        function sendToHost(type, args) {
            // Convert args to string
            const message = Array.from(args).map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');

            // Send to parent window (The Editor)
            window.parent.postMessage({
                type: 'console',
                level: type,
                content: message
            }, '*');
            
            // Also log locally
            if(type === 'error') originalError.apply(console, args);
            else originalLog.apply(console, args);
        }

        console.log = function() { sendToHost('log', arguments); };
        console.error = function() { sendToHost('error', arguments); };

        // 2. Listen for Screenshot Command from Host
        window.addEventListener('message', (event) => {
            if (event.data.action === 'takeScreenshot') {
                html2canvas(document.body).then(canvas => {
                    const dataUrl = canvas.toDataURL();
                    window.parent.postMessage({
                        type: 'screenshot',
                        image: dataUrl
                    }, '*');
                });
            }
        });
        
        // --- INJECTED HOST CODE END ---
    </script>

    <script>
        try {
            ${js || ''}
        } catch (err) {
            console.error(err);
        }
    </script>
</body>
</html>`;

    // Write to disk
    fs.writeFile(path.join(USER_SITE_DIR, 'index.html'), combinedHTML, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ status: 'error', message: 'Failed to write file' });
        }
        res.json({ status: 'success', url: '/site/index.html' });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Editor available at http://localhost:${PORT}`);
    console.log(`User site available at http://localhost:${PORT}/site`);
});

