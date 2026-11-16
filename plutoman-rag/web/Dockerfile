# ---------------------------------------------------------------------------
# plutoman-rag demo UI: Angular production build served by nginx.
# nginx also proxies /api/* to the API container, so the browser talks to one
# origin (no CORS) and the API port does not need to be reachable directly.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
