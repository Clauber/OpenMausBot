FROM node:20-slim

# Install real Google Chrome (not Chromium) for authentic TLS/JA3 fingerprint
# plus common fonts (to match real browser font fingerprints),
# system deps, and curl/wget for healthchecks
RUN npx playwright install --with-deps chrome \
    && apt-get install -y --no-install-recommends \
       curl wget ffmpeg \
       fonts-liberation fonts-noto-cjk fonts-dejavu-core \
       fonts-freefont-ttf fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*

# Optional: gifski for higher-quality GIFs. Falls back to ffmpeg if install fails.
RUN curl -sSL https://github.com/ImageOptim/gifski/releases/download/1.32.0/gifski-1.32.0.tar.xz -o /tmp/gifski.tar.xz \
    && (tar -xJf /tmp/gifski.tar.xz -C /tmp \
        && cp /tmp/gifski-1.32.0/linux/gifski /usr/local/bin/gifski \
        && chmod +x /usr/local/bin/gifski \
        && rm -rf /tmp/gifski-1.32.0 /tmp/gifski.tar.xz) \
    || echo "gifski install failed — ffmpeg fallback only"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --production

EXPOSE 9377
CMD ["node", "dist/server.js"]
