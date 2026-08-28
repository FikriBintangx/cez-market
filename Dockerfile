FROM node:20-slim

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/
COPY bot/package*.json ./bot/

# Install dependencies
RUN cd backend && npm install --production
RUN cd bot && npm install --production

# Copy source code
COPY backend ./backend
COPY bot ./bot

# Environment defaults
ENV PORT=4000
ENV NODE_ENV=production

EXPOSE 4000

# Script start backend & bot simultaneously
CMD ["sh", "-c", "node bot/bot.js & node backend/server.js"]
