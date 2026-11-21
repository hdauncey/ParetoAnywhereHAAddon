FROM node:22-alpine

# Version of the pareto-anywhere npm package to run. Override at build time to upgrade.
ARG PARETO_ANYWHERE_VERSION=1.18.1

RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers eudev-dev libusb-dev \
    && npm install -g --no-audit --no-fund pareto-anywhere@${PARETO_ANYWHERE_VERSION} \
    && apk del .build-deps \
    && npm cache clean --force

WORKDIR /opt/manager
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY app/ ./

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    DATA_DIR=/data \
    SSL_DIR=/ssl

EXPOSE 3001/tcp 50001/udp 8099/tcp

CMD ["node", "/opt/manager/server.js"]
