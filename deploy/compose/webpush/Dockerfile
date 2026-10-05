FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
# A fresh named volume inherits this ownership.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
