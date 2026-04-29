FROM node:20-slim

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Auth and data live in mounted volumes so they persist across restarts
ENV AUTH_DIR=/data/auth
ENV DATA_DIR=/data/db
VOLUME ["/data"]

CMD ["npm", "start"]
