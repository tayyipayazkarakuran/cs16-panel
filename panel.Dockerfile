# CS 1.6 Panel – Node.js management panel
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install exactly the locked dependency tree.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY *.js ./
COPY routes/ ./routes/
COPY public/ ./public/
COPY php-templates/ ./php-templates/

# Payment receipts
RUN mkdir -p /app/uploads

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
