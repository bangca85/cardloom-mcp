FROM node:24-alpine

RUN apk add --no-cache git su-exec

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY docker-entrypoint.sh /usr/local/bin/

# node:24-alpine already ships a "node" user/group at uid/gid 1000 — reuse it instead of
# creating appuser/appgroup (that gid is now taken and addgroup would fail).
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV KNOWLEDGE_STORE_PATH=/data/knowledge-store
ENV INDEX_DB_PATH=/data/metadata/index.db

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
