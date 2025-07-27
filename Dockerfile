FROM imbios/bun-node:1.2.3-22.14-slim AS build
WORKDIR /build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY main.ts tsconfig.json build.mjs ./
RUN pnpm build

FROM gcr.io/distroless/nodejs22-debian12 AS final
WORKDIR /app
COPY --from=build /build/dist ./
CMD ["/app/main.js"]