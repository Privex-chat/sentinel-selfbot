FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production=false

COPY . .
RUN npm run build

RUN mkdir -p /data

ENV NODE_ENV=production
ENV API_PORT=48923
ENV DB_PATH=/data/sentinel.db

EXPOSE 48923

CMD ["node", "dist/index.js"]
