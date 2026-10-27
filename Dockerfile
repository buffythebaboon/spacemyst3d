# Builds the client, then runs the game server, which serves both the game and /ws on $PORT.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8080
# Run node directly so it gets the stop signal and saves the world before it exits.
CMD ["node", "--import", "tsx", "server/index.ts"]
