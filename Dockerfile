FROM node:22.14-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY main.ts tsconfig.json ./
CMD ["pnpm", "tsx", "main.ts"]