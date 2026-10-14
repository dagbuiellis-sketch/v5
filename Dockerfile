FROM node:22-slim

# Install sqlite3 build tools & certificates
RUN apt-get update && apt-get install -y python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy project code
COPY . .

# Build Vite frontend and server bundle
RUN npm run build

# Ensure persistent data directory exists with write permissions
RUN mkdir -p /app/data && chmod 777 /app/data

# Expose web dashboard port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["node", "dist/server.cjs"]
