FROM node:18-slim
RUN apt-get update&&apt-get install -y wget gnupg ca-certificates procps libxss1 libxtst6 libnss3 libasound2 libatk-bridge2.0-0 libgtk-3-0&&rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
RUN npx playwright install --with-deps chromium
COPY . .
EXPOSE 3000
CMD ["npm","start"]
