# Use Playwright's official Docker image with browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set working directory
WORKDIR /app

# Install ALL dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Prune to production dependencies only
RUN npm prune --production

# Create directories for logs and screenshots
RUN mkdir -p /app/logs /app/screenshots

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3100
ENV HEADLESS=true
ENV SCREENSHOTS_PATH=/app/screenshots

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

# Expose port
EXPOSE 3100

# Run the server
CMD ["node", "dist/server.js"]
