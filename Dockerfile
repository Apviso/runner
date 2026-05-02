FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli ca-certificates

ENV NODE_ENV=production
ENV APVISO_RUNNER_CONFIG=/root/.apviso-runner/config.json

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY dist ./dist

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
