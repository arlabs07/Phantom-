#!/usr/bin/env bash
set -o errexit

echo "🔧 Installing dependencies..."

# Set Puppeteer cache directory
export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# Install dependencies
npm ci --only=production

echo "🌐 Installing Chromium for Puppeteer..."

# Install Chrome browser
npx puppeteer browsers install chrome

# Cache Chromium
if [[ ! -d $PUPPETEER_CACHE_DIR/chrome ]]; then
  echo "📦 Caching Chromium..."
  cp -R /opt/render/project/src/.cache/puppeteer/chrome/ $PUPPETEER_CACHE_DIR/ || true
else
  echo "✅ Using cached Chromium"
fi

echo "✅ Build complete!"
