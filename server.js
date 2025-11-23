const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const MAX_SESSIONS = 50;
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// Session management
const sessions = new Map();
const sessionTimers = new Map();

// Browser pool configuration
let browserInstance = null;
let browserRestartInProgress = false;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    browserConnected: browserInstance?.isConnected() || false
  });
});

// Initialize browser with error handling
async function getBrowser() {
  try {
    if (!browserInstance || !browserInstance.isConnected()) {
      console.log('Launching new browser instance...');
      
      browserInstance = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process',
          '--window-size=412,915',
          '--disable-web-security',
          '--disable-features=site-per-process',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-extensions',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService,NetworkServiceInProcess',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--mute-audio'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
                       process.env.CHROME_BIN || 
                       undefined,
        ignoreHTTPSErrors: true
      });

      // Handle browser disconnect
      browserInstance.on('disconnected', () => {
        console.warn('Browser disconnected unexpectedly');
        browserInstance = null;
        restartBrowser();
      });

      console.log('Browser launched successfully');
    }
    
    return browserInstance;
  } catch (error) {
    console.error('Failed to launch browser:', error);
    throw new Error('Browser initialization failed');
  }
}

// Restart browser with exponential backoff
async function restartBrowser() {
  if (browserRestartInProgress) return;
  
  browserRestartInProgress = true;
  console.log('Restarting browser...');
  
  try {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    await getBrowser();
    
    console.log('Browser restarted successfully');
  } catch (error) {
    console.error('Browser restart failed:', error);
  } finally {
    browserRestartInProgress = false;
  }
}

// Retry logic wrapper
async function retryOperation(operation, retries = MAX_RETRIES, delay = RETRY_DELAY) {
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`Operation failed (attempt ${i + 1}/${retries}):`, error.message);
      
      if (i === retries - 1) throw error;
      
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
}

// Clean up session
async function cleanupSession(socketId) {
  const session = sessions.get(socketId);
  
  if (session) {
    try {
      // Clear timeout
      if (sessionTimers.has(socketId)) {
        clearTimeout(sessionTimers.get(socketId));
        sessionTimers.delete(socketId);
      }
      
      // Close CDP session
      if (session.client) {
        await session.client.detach().catch(() => {});
      }
      
      // Close page
      if (session.page && !session.page.isClosed()) {
        await session.page.close().catch(() => {});
      }
      
      sessions.delete(socketId);
      console.log(`Session cleaned up: ${socketId} (${sessions.size} active)`);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
}

// Reset session timeout
function resetSessionTimeout(socketId) {
  if (sessionTimers.has(socketId)) {
    clearTimeout(sessionTimers.get(socketId));
  }
  
  const timer = setTimeout(() => {
    console.log(`Session timeout: ${socketId}`);
    cleanupSession(socketId);
  }, SESSION_TIMEOUT);
  
  sessionTimers.set(socketId, timer);
}

// Sanitize HTML to prevent XSS
function sanitizeHTML(html) {
  // Remove potentially dangerous scripts and event handlers
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript:/gi, '');
  
  return sanitized;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id} (${sessions.size + 1} active)`);
  
  // Check session limit
  if (sessions.size >= MAX_SESSIONS) {
    socket.emit('error', { 
      message: 'Server at capacity. Please try again later.',
      code: 'MAX_SESSIONS_REACHED'
    });
    socket.disconnect();
    return;
  }

  // Initialize session
  socket.on('init', async () => {
    try {
      const browser = await retryOperation(() => getBrowser());
      const page = await browser.newPage();
      
      // Set viewport for mobile
      await page.setViewport({ 
        width: 412, 
        height: 915, 
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2
      });
      
      // Set user agent
      await page.setUserAgent(
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      );
      
      // Create CDP session for advanced control
      const client = await page.target().createCDPSession();
      
      // Enable necessary CDP domains
      await Promise.all([
        client.send('Network.enable'),
        client.send('Page.enable'),
        client.send('DOM.enable'),
        client.send('Runtime.enable')
      ]);
      
      // Block unnecessary resources to save bandwidth and memory
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        const blockResources = ['font', 'media'];
        
        if (blockResources.includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      // Handle page crashes
      page.on('error', (error) => {
        console.error('Page error:', error);
        socket.emit('error', { 
          message: 'Page encountered an error',
          code: 'PAGE_ERROR'
        });
      });
      
      // Handle console messages
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          console.error('Page console error:', msg.text());
        }
      });
      
      // Handle navigation
      page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
          try {
            const url = page.url();
            const title = await page.title().catch(() => 'Untitled');
            socket.emit('navigation', { url, title });
          } catch (error) {
            console.error('Navigation event error:', error);
          }
        }
      });
      
      // Store session
      sessions.set(socket.id, { page, browser, client });
      resetSessionTimeout(socket.id);
      
      socket.emit('ready');
      console.log(`Session initialized: ${socket.id}`);
      
    } catch (error) {
      console.error('Session init error:', error);
      socket.emit('error', { 
        message: 'Failed to initialize browser session',
        code: 'INIT_ERROR'
      });
    }
  });

  // Navigate to URL
  socket.on('navigate', async ({ url }) => {
    const session = sessions.get(socket.id);
    if (!session) {
      socket.emit('error', { message: 'No active session', code: 'NO_SESSION' });
      return;
    }

    try {
      resetSessionTimeout(socket.id);
      const { page } = session;
      
      // Validate and normalize URL
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL provided');
      }
      
      let normalizedUrl = url.trim();
      
      // Add protocol if missing
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        // Check if it's a search query or domain
        if (normalizedUrl.includes(' ') || !normalizedUrl.includes('.')) {
          normalizedUrl = `https://www.google.com/search?q=${encodeURIComponent(normalizedUrl)}`;
        } else {
          normalizedUrl = 'https://' + normalizedUrl;
        }
      }
      
      socket.emit('loading', { status: true });
      
      // Navigate with timeout and retry
      await retryOperation(async () => {
        await page.goto(normalizedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
      });
      
      // Wait a bit for dynamic content
      await page.waitForTimeout(1000);
      
      // Get page content with error handling
      const [html, title, currentUrl] = await Promise.all([
        page.content().catch(() => '<html><body>Failed to load content</body></html>'),
        page.title().catch(() => 'Untitled'),
        Promise.resolve(page.url())
      ]);
      
      // Sanitize HTML
      const sanitizedHTML = sanitizeHTML(html);
      
      // Inject base tag for relative URLs
      const modifiedHTML = sanitizedHTML.replace(
        /<head>/i,
        `<head><base href="${currentUrl}">`
      );
      
      socket.emit('page-content', {
        html: modifiedHTML,
        url: currentUrl,
        title: title
      });
      
      socket.emit('loading', { status: false });
      
    } catch (error) {
      console.error('Navigation error:', error);
      
      let errorMessage = 'Failed to load page';
      
      if (error.message.includes('timeout')) {
        errorMessage = 'Page load timeout - site may be slow or unavailable';
      } else if (error.message.includes('net::ERR')) {
        errorMessage = 'Network error - check your connection';
      }
      
      socket.emit('error', { 
        message: errorMessage,
        code: 'NAVIGATION_ERROR'
      });
      socket.emit('loading', { status: false });
    }
  });

  // Handle browser actions (back, forward, refresh)
  socket.on('browser-action', async ({ action }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    try {
      resetSessionTimeout(socket.id);
      const { page } = session;
      
      socket.emit('loading', { status: true });
      
      switch (action) {
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
          break;
        case 'forward':
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
          break;
        case 'refresh':
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          break;
        default:
          throw new Error('Invalid action');
      }
      
      await page.waitForTimeout(500);
      
      const [html, title, url] = await Promise.all([
        page.content(),
        page.title(),
        Promise.resolve(page.url())
      ]);
      
      const sanitizedHTML = sanitizeHTML(html);
      const modifiedHTML = sanitizedHTML.replace(
        /<head>/i,
        `<head><base href="${url}">`
      );
      
      socket.emit('page-content', {
        html: modifiedHTML,
        url: url,
        title: title
      });
      
      socket.emit('loading', { status: false });
      
    } catch (error) {
      console.error('Browser action error:', error);
      socket.emit('error', { 
        message: `Failed to ${action}`,
        code: 'ACTION_ERROR'
      });
      socket.emit('loading', { status: false });
    }
  });

  // Handle clicks
  socket.on('click', async ({ selector, x, y }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    try {
      resetSessionTimeout(socket.id);
      const { page } = session;
      
      if (selector) {
        // Wait for selector with timeout
        await page.waitForSelector(selector, { timeout: 5000 }).catch(() => {});
        await page.click(selector);
      } else if (x !== undefined && y !== undefined) {
        await page.mouse.click(x, y);
      }
      
      // Wait for potential navigation
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }),
        page.waitForTimeout(1000)
      ]).catch(() => {});
      
      const [html, url, title] = await Promise.all([
        page.content(),
        Promise.resolve(page.url()),
        page.title()
      ]);
      
      const sanitizedHTML = sanitizeHTML(html);
      const modifiedHTML = sanitizedHTML.replace(
        /<head>/i,
        `<head><base href="${url}">`
      );
      
      socket.emit('page-content', {
        html: modifiedHTML,
        url: url,
        title: title
      });
      
    } catch (error) {
      console.error('Click error:', error);
    }
  });

  // Handle scrolling
  socket.on('scroll', async ({ deltaY }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    try {
      const { page } = session;
      await page.evaluate((delta) => {
        window.scrollBy(0, delta);
      }, deltaY);
    } catch (error) {
      console.error('Scroll error:', error);
    }
  });

  // Handle form input
  socket.on('input', async ({ selector, value }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    try {
      resetSessionTimeout(socket.id);
      const { page } = session;
      
      await page.waitForSelector(selector, { timeout: 5000 }).catch(() => {});
      await page.type(selector, value, { delay: 50 });
      
    } catch (error) {
      console.error('Input error:', error);
    }
  });

  // Keep alive ping
  socket.on('ping', () => {
    resetSessionTimeout(socket.id);
    socket.emit('pong');
  });

  // Disconnect handling
  socket.on('disconnect', async (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    await cleanupSession(socket.id);
  });
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  
  // Close all sessions
  for (const [socketId] of sessions) {
    await cleanupSession(socketId);
  }
  
  // Close browser
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown();
});

// Start server
server.listen(PORT, () => {
  console.log(`✅ Cloud VPN Browser running on port ${PORT}`);
  console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
  console.log(`⏱️  Session timeout: ${SESSION_TIMEOUT / 1000}s`);
});
