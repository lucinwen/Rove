FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/index.html /app/rove-overview.html /app/pieeg-feasibility.html /app/pieeg-supplement.html /app/rove_scenario_4steps.png ./
COPY --from=build --chown=node:node /app/papers ./papers
USER node
EXPOSE 8080
CMD ["npm", "start"]
