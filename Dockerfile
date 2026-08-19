# Public landing deployment (crossexboros.com): the Fastify server in PUBLIC_MODE
# serving the prebuilt landing SPA. The frontend is built by deploy/deploy.sh
# before the image — this image never runs tsc/vite (the VM is small on purpose).
# The container holds ZERO secrets: no .env, no keys, and PUBLIC_MODE registers
# only the credential-free routes (src/server/app.ts).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PUBLIC_MODE=1 HOST=0.0.0.0 PORT=6688

COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

COPY tsconfig.json ./
COPY src ./src
COPY web/dist ./web/dist

EXPOSE 6688
USER node
CMD ["npx", "tsx", "src/server/index.ts"]
