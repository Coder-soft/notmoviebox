# notmoviebox — container image.
#
# Runs the Node server (static SPA + API proxy + media proxy). No dependencies,
# so this image is tiny and starts instantly.

FROM node:20-alpine

WORKDIR /app

# Only what the server needs at runtime.
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

# Non-root.
USER node

CMD ["node", "server/index.mjs"]
