#!/usr/bin/env bash
set -o errexit

echo "🔧 Installing dependencies..."
npm ci --only=production

echo "🌐 Installing Chromium for Puppeteer..."
npx puppeteer browsers install chrome

echo "✅ Build complete!"
