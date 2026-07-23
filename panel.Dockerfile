# CS 1.6 Panel – Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY server.js ./
COPY queryHelper.js ./
COPY containerFsHelper.js ./
COPY panelDb.js ./
COPY poolService.js ./
COPY fastdlService.js ./
COPY serverProtection.js ./
COPY routes/ ./routes/
COPY public/ ./public/

# Ensure uploads directory exists (for payment receipts)
RUN mkdir -p /app/uploads

# Expose panel port
EXPOSE 3000

CMD ["node", "server.js"]

