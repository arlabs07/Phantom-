#!/usr/bin/env bash
set -o errexit

echo "🔧 Installing dependencies..."

# Set Puppeteer download base URL for Chrome
export PUPPETEER_DOWNLOAD_BASE_URL="https://storage.googleapis.com/chrome-for-testing-public"

# Install dependencies (npm is more reliable than yarn on Render)
npm install

echo "🌐 Ensuring Chromium is installed..."

# Install Chrome browser for Puppeteer
npx puppeteer browsers install chrome

echo "✅ Build complete!"
